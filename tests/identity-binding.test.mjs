import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-pinned-test-'));
process.env.FEISHU_DATA_DIR = tmp;
const build = process.env.FEISHU_BUILD_DIR;
if (!build) throw new Error('Set FEISHU_BUILD_DIR to the compiled feishu-mcp dist directory');
const load = (file) => import(pathToFileURL(path.join(build, 'identity', file)));
const store = await load('store.js');
const { dispatchTool } = await load('dispatch.js');
const { credentialEnv } = await load('context.js');
store.markMigrated();
for (const id of ['fa_work', 'fa_personal']) store.upsertAccount({
  id, user_id: 'u1', alias: id, open_id: 'ou_' + id, app_id: 'cli_' + id,
  account_type: 'user', status: 'ready', scopes: [],
  credential_namespace: path.join(tmp, id), created_at: '2026-10-15', updated_at: '2026-10-15',
});
store.setActiveAccount('u1', 'fa_work');
const extra = (id) => ({ requestInfo: { headers: {
  'x-oauth-user': 'u1', 'x-oauth-account': id, 'x-oauth-connection': 'grant-personal',
} } });
const tool = { name: 'read_feishu_doc', title: 'Read', description: '', inputSchema: {},
  handler: async () => ({ content: [{ type: 'text', text: credentialEnv().HOME }] }) };

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
test('grant-bound personal account overrides a different user default', async () => {
  const result = await dispatchTool(tool, {}, extra('fa_personal'));
  assert.equal(result.content[0].text, path.join(tmp, 'fa_personal'));
});
test('deleted or foreign grant-bound account must never fall back to the company account', async () => {
  const result = await dispatchTool(tool, {}, extra('fa_missing'));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ACCOUNT_NOT_FOUND/);
});
test('a fixed ChatGPT connection cannot switch its identity through a tool', async () => {
  const { accountSwitchTool } = await load('account-tools.js');
  const result = await dispatchTool(accountSwitchTool, { account_id: 'fa_work' }, extra('fa_personal'));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ACCOUNT_CONNECTION_LOCKED/);
  assert.equal((await dispatchTool(tool, {}, extra('fa_personal'))).content[0].text, path.join(tmp, 'fa_personal'));
});
test('a fixed ChatGPT connection directs new account onboarding to the browser', async () => {
  const { accountConnectTool } = await load('account-tools.js');
  const result = await dispatchTool(accountConnectTool, { alias: '个人飞书' }, extra('fa_work'));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /CONNECT_IN_CHATGPT_SETTINGS/);
});
test('write receipts identify the actual organization and app, independently of account labels', async () => {
  const a = store.getAccount('u1', 'fa_work');
  a.tenant_key = 'tenant_work';
  store.upsertAccount(a);
  const result = await dispatchTool({ ...tool, name: 'write_feishu_doc' }, {}, extra('fa_work'));
  const receipt = JSON.parse(result.content.at(-1).text.split('executed_as: ')[1]);
  assert.equal(receipt.tenant_key, 'tenant_work');
  assert.equal(receipt.app_id, 'cli_fa_work');
});
test('profile metadata and identity describe exactly the grant-bound account', async () => {
  const { ACCOUNT_TOOLS } = await load('account-tools.js');
  const { identityToolMetadata } = await load('tool-metadata.js');
  const profileTool = ACCOUNT_TOOLS.find((t) => t.name === 'feishu_get_profile');
  assert.equal(identityToolMetadata(profileTool.name)._meta['openai/profile'], true);
  const result = await dispatchTool(profileTool, {}, extra('fa_personal'));
  assert.equal(result.structuredContent.id, 'fa_personal');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  store.getAccount('u1', 'fa_personal').alias = 'renamed';
  assert.equal((await dispatchTool(profileTool, {}, extra('fa_personal'))).structuredContent.id, 'fa_personal');
});
