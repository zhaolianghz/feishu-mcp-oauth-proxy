import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('deployed HTTP overlay authenticates internal API and resolves real MCP profile per grant', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-real-http-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const accounts = ['work', 'personal'].map((id) => {
    const ns = path.join(tmp, 'feishu-auth', 'fa_' + id);
    fs.mkdirSync(path.join(ns, '.lark-cli'), { recursive: true });
    fs.writeFileSync(path.join(ns, '.lark-cli/config.json'), JSON.stringify({ appId: 'cli_' + id }));
    fs.writeFileSync(path.join(ns, 'authorized'), 'yes');
    return { id: 'fa_' + id, user_id: 'u1', alias: id, open_id: 'ou_' + id,
      app_id: 'cli_' + id, account_type: 'user', status: 'ready', scopes: [],
      credential_namespace: ns, created_at: '2026-10-15', updated_at: '2026-10-15' };
  });
  fs.writeFileSync(path.join(tmp, 'identity.json'), JSON.stringify({ version: 1, migrated: true,
    accounts, bindings: [{ user_id: 'u1', feishu_account_id: 'fa_work' }], oauth_sessions: [] }));
  const listener = http.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, [path.join(process.env.FEISHU_BUILD_DIR, 'index.js')], {
    env: { ...process.env, MCP_TRANSPORT: 'http', MCP_HTTP_HOST: '127.0.0.1', MCP_HTTP_PORT: String(port),
      MCP_HTTP_TOKEN: 'backend-test-token', FEISHU_DATA_DIR: tmp, HOME: path.join(tmp, 'base'),
      LARK_CLI_PATH: fileURLToPath(new URL('./fixtures/lark-cli.mjs', import.meta.url)) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let logs = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(logs)), 5000);
    const data = (b) => { logs += b; if (logs.includes('服务已启动')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', data); child.stderr.on('data', data);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(logs)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const internal = (body, headers = {}) => fetch(base + '/internal/identity', { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await internal({ action: 'list', user_id: 'u1' })).status, 401);
  assert.equal((await internal({ action: 'list', user_id: 'u1' }, { authorization: 'Bearer wrong' })).status, 401);
  const authorized = { authorization: 'Bearer backend-test-token' };
  const list = await internal({ action: 'list', user_id: 'u1' }, authorized);
  assert.equal(list.status, 200);
  const listText = await list.text();
  assert.equal(JSON.parse(listText).accounts.length, 2);
  assert.ok(!listText.includes(tmp), 'private credential paths must stay on the backend');
  assert.equal((await internal({ action: 'verify', user_id: 'other', account_id: 'fa_work' }, authorized)).status, 404);
  const getProfile = async (id) => {
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { ...authorized,
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'x-oauth-user': 'u1', 'x-oauth-account': id, 'x-oauth-connection': 'grant-' + id },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'feishu_get_profile', arguments: {} } }) });
    assert.equal(r.status, 200);
    return r.json();
  };
  const [work, personal] = await Promise.all([getProfile('fa_work'), getProfile('fa_personal')]);
  assert.equal(work.result.structuredContent.id, 'fa_work');
  assert.equal(personal.result.structuredContent.id, 'fa_personal');
  assert.equal((await getProfile('fa_deleted')).result.isError, true);
  const tools = await fetch(base + '/mcp', { method: 'POST', headers: { ...authorized,
    'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  const profile = (await tools.json()).result.tools.find((tool) => tool.name === 'feishu_get_profile');
  assert.equal(profile._meta['openai/profile'], true);
  assert.deepEqual(profile.outputSchema.required, ['id']);
});
