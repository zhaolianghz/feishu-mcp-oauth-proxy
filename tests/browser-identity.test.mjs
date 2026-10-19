import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-browser-backend-'));
process.env.FEISHU_DATA_DIR = tmp;
process.env.HOME = path.join(tmp, 'base');
process.env.LARK_CLI_PATH = fileURLToPath(new URL('./fixtures/lark-cli.mjs', import.meta.url));
fs.chmodSync(process.env.LARK_CLI_PATH, 0o755);
const build = process.env.FEISHU_BUILD_DIR;
const load = (name) => import(pathToFileURL(path.join(build, 'identity', name)));
const { createBrowserIdentityService } = await load('browser-connect.js');
const store = await load('store.js');
const { credentialEnv } = await load('context.js');
store.markMigrated();
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let clock = 10_000;
test.beforeEach(() => { clock = Date.now(); });
let response = { error: 'authorization_pending' };
let pollCount = 0;
const providerFetch = async (url, options) => {
  assert.equal(url, 'https://accounts.feishu.cn/oauth/v1/app/registration');
  const form = new URLSearchParams(options.body);
  if (form.get('action') === 'begin') return Response.json({ device_code: 'reg-device',
    verification_uri_complete: 'https://accounts.feishu.cn/app-authorize?ticket=x', expire_in: 600, interval: 5 });
  assert.equal(form.get('device_code'), 'reg-device');
  pollCount++;
  return Response.json(response);
};
const service = createBrowserIdentityService({ fetchImpl: providerFetch, now: () => clock });
const call = (action, fields = {}, user = 'u1') => service.handle({ action, user_id: user, ...fields });
const pause = () => new Promise((resolve) => setTimeout(resolve, 25));

test('existing app browser setup continues to user OAuth without exposing either device code or secret', async () => {
  const start = await call('begin', { app_id: 'cli_personal', alias: '个人飞书' });
  const url = new URL(start.verification_url);
  assert.equal(url.searchParams.get('clientID'), 'cli_personal');
  assert.equal(url.searchParams.has('createOnly'), false);
  const addons = JSON.parse(gunzipSync(Buffer.from(url.searchParams.get('addons'), 'base64url')));
  assert.ok(addons.scopes.user.includes('offline_access'));
  assert.ok(!JSON.stringify(start).includes('reg-device'));
  assert.equal(start.status, 'registering');
  await assert.rejects(call('status', { flow_id: start.flow_id }, 'other'), /not found/i);
  await call('status', { flow_id: start.flow_id });
  const previousPolls = pollCount;
  await call('status', { flow_id: start.flow_id });
  assert.equal(pollCount, previousPolls, 'rapid browser refreshes must obey provider polling interval');
  response = { client_id: 'cli_personal', client_secret: 'never-show-this-secret' };
  clock += 6000;
  const login = await call('status', { flow_id: start.flow_id });
  assert.equal(login.status, 'authorizing');
  assert.match(login.verification_url, /user-authorize/);
  assert.ok(!JSON.stringify(login).includes('never-show-this-secret'));
  assert.equal(credentialEnv(), undefined);
  let result;
  for (let i = 0; i < 60; i++) {
    await pause();
    result = await call('status', { flow_id: start.flow_id });
    if (result.status === 'ready') break;
  }
  assert.equal(result.status, 'ready');
  assert.equal(result.account.alias, '个人飞书');
  assert.equal(result.account.app_id, 'cli_personal');
  assert.equal(store.listAccounts('u1').length, 1);
  assert.ok(!JSON.stringify(result).includes('device-'));
  assert.ok(!JSON.stringify(result).includes(tmp));
  const verified = await call('verify', { account_id: result.account.account_id });
  assert.equal(verified.account.account_id, result.account.account_id);
  await assert.rejects(call('verify', { account_id: result.account.account_id }, 'other'), /not found/i);
});
test('denied registration creates no account and no usable grant', async () => {
  const count = store.listAccounts('u1').length;
  const started = await call('begin');
  response = { error: 'access_denied', error_description: 'do not expose provider internals' };
  clock += 6000;
  const status = await call('status', { flow_id: started.flow_id });
  assert.equal(status.status, 'failed');
  assert.equal(store.listAccounts('u1').length, count);
  assert.ok(!JSON.stringify(status).includes('provider internals'));
});
test('expired and cancelled browser flows cannot provision credentials', async () => {
  const started = await call('begin');
  clock += 601_000;
  assert.equal((await call('status', { flow_id: started.flow_id })).status, 'expired');
  const cancelled = await call('begin');
  await call('cancel', { flow_id: cancelled.flow_id });
  await assert.rejects(call('status', { flow_id: cancelled.flow_id }), /not found/i);
});
test('wrong app credentials returned by registration cannot replace a requested existing app', async () => {
  const started = await call('begin', { app_id: 'cli_expected' });
  response = { client_id: 'cli_unexpected', client_secret: 'never-show-this-secret' };
  clock += 6000;
  assert.equal((await call('status', { flow_id: started.flow_id })).status, 'failed');
  assert.ok(!store.listAccounts('u1').some((a) => a.app_id === 'cli_unexpected'));
});
test('CLI provisioning failure does not register an app or bind a user', async () => {
  const started = await call('begin', { app_id: 'cli_bad' });
  response = { client_id: 'cli_bad', client_secret: 'never-show-this-secret' };
  clock += 6000;
  assert.equal((await call('status', { flow_id: started.flow_id })).status, 'failed');
  assert.ok(!store.listAccounts('u1').some((a) => a.app_id === 'cli_bad'));
});
test('re-authorizing an existing app preserves the stable account id and isolates the new credentials', async () => {
  const original = store.listAccounts('u1')[0];
  const oldNamespace = original.credential_namespace;
  const started = await call('begin', { account_id: original.id });
  assert.equal(started.status, 'authorizing');
  let state;
  for (let i = 0; i < 60; i++) {
    await pause();
    state = await call('status', { flow_id: started.flow_id });
    if (state.status === 'ready') break;
  }
  assert.equal(state.status, 'ready');
  assert.equal(state.account.account_id, original.id);
  assert.equal(store.listAccounts('u1').length, 1);
  assert.notEqual(store.getAccount('u1', original.id).credential_namespace, oldNamespace);
  assert.equal(fs.existsSync(oldNamespace), false, 'superseded credential copies must be removed');
  await assert.rejects(call('begin', { account_id: original.id }, 'other'), /not found/i);
});
test('legacy accounts without app metadata are verified and reused rather than duplicated', async () => {
  const original = store.listAccounts('u1')[0];
  delete original.app_id;
  store.upsertAccount(original);
  const started = await call('begin', { app_id: 'cli_personal' });
  response = { client_id: 'cli_personal', client_secret: 'never-show-this-secret' };
  await call('status', { flow_id: started.flow_id });
  let state;
  for (let i = 0; i < 80; i++) {
    await pause();
    state = await call('status', { flow_id: started.flow_id });
    if (state.status === 'ready') break;
  }
  assert.equal(state.account.account_id, original.id);
  assert.equal(store.listAccounts('u1').length, 1);
  assert.equal(store.getAccount('u1', original.id).app_id, 'cli_personal');
  assert.equal(state.account.already_connected, true);
});
test('unfinished app setup is recoverable after service restart without entering app credentials', async () => {
  const id = store.newSessionId();
  store.saveOAuthSession({ id, user_id: 'u1', alias: '个人待授权', app_id: 'cli_resume',
    device_code: 'private-device', verification_url: 'private-url', credential_namespace: '/private/missing',
    domains: [], status: 'failed', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const listed = await call('list');
  const candidate = listed.incomplete.find((s) => s.session_id === id);
  assert.equal(candidate.app_id, 'cli_resume');
  assert.ok(!JSON.stringify(listed).includes('private-device'));
  await assert.rejects(call('begin', { oauth_session_id: id }, 'other'), /not found/i);
  const restarted = createBrowserIdentityService({ fetchImpl: providerFetch });
  const recovered = await restarted.handle({ action: 'begin', user_id: 'u1', oauth_session_id: id });
  assert.equal(new URL(recovered.verification_url).searchParams.get('clientID'), 'cli_resume');
  response = { client_id: 'cli_resume', client_secret: 'never-show-this-secret' };
  await restarted.handle({ action: 'status', user_id: 'u1', flow_id: recovered.flow_id });
  let state;
  for (let i = 0; i < 80; i++) {
    await pause();
    state = await restarted.handle({ action: 'status', user_id: 'u1', flow_id: recovered.flow_id });
    if (state.status === 'ready') break;
  }
  assert.equal(state.status, 'ready');
  assert.equal(state.account.alias, '个人待授权');
  assert.notEqual(state.account.tenant_key, store.listAccounts('u1')[0].tenant_key);
});
test('provider slow_down postpones the next poll and user-login denial cannot create an account', async () => {
  const started = await call('begin', { app_id: 'cli_denied' });
  response = { error: 'slow_down' };
  await call('status', { flow_id: started.flow_id });
  const previous = pollCount;
  clock += 6000;
  await call('status', { flow_id: started.flow_id });
  assert.equal(pollCount, previous);
  response = { client_id: 'cli_denied', client_secret: 'never-show-this-secret' };
  clock += 5000;
  assert.equal((await call('status', { flow_id: started.flow_id })).status, 'authorizing');
  let state;
  for (let i = 0; i < 60; i++) {
    await pause();
    state = await call('status', { flow_id: started.flow_id });
    if (state.status === 'failed') break;
  }
  assert.equal(state.status, 'failed');
  assert.ok(!store.listAccounts('u1').some((a) => a.app_id === 'cli_denied'));
});
test('cancelling during user authorization prevents a later CLI completion from binding an account', async () => {
  const started = await call('begin', { app_id: 'cli_slow' });
  response = { client_id: 'cli_slow', client_secret: 'never-show-this-secret' };
  assert.equal((await call('status', { flow_id: started.flow_id })).status, 'authorizing');
  await call('cancel', { flow_id: started.flow_id });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(!store.listAccounts('u1').some((a) => a.app_id === 'cli_slow'));
  await assert.rejects(call('status', { flow_id: started.flow_id }), /not found/i);
});
test('cancelling an in-flight registration poll never provisions returned credentials', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = createBrowserIdentityService({ fetchImpl: async (url, options) => {
    if (new URLSearchParams(options.body).get('action') === 'begin') return Response.json({
      device_code: 'cancel-device', verification_uri_complete: 'https://accounts.feishu.cn/app', expire_in: 600, interval: 5 });
    await gate;
    return Response.json({ client_id: 'cli_cancelled', client_secret: 'never-show-this-secret' });
  } });
  const started = await service.handle({ action: 'begin', user_id: 'u1' });
  const poll = service.handle({ action: 'status', user_id: 'u1', flow_id: started.flow_id });
  await service.handle({ action: 'cancel', user_id: 'u1', flow_id: started.flow_id });
  release();
  const result = await poll;
  assert.notEqual(result.status, 'ready');
  assert.ok(!store.listAccounts('u1').some((a) => a.app_id === 'cli_cancelled'));
});
