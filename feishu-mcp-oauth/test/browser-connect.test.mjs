import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

// Removing per-grant account binding, or restoring the session shortcut in
// /authorize, must break these HTTP-level tests.
test('browser account selection isolates two grants for the same OAuth client', async (t) => {
  const accounts = [
    { account_id: 'fa_work', alias: '企业飞书', user_name: '赵亮', app_id: 'cli_work', tenant_key: 'tenant_work' },
    { account_id: 'fa_personal', alias: '个人飞书', user_name: '赵亮', app_id: 'cli_personal', tenant_key: 'tenant_personal' },
    { account_id: 'fa_duplicate', alias: '重复企业', same_identity_as: 'fa_work' },
  ];
  let onboardingState;
  const backend = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/mcp') {
      res.end(JSON.stringify(req.headers));
      return;
    }
    assert.equal(req.url, '/internal/identity');
    assert.equal(req.headers.authorization, 'Bearer internal-test-token');
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    if (input.action === 'list') res.end(JSON.stringify({ accounts, apps: [], incomplete: [
      { session_id: 'session-resume', alias: '个人待完成', app_id: 'cli_resume' },
    ] }));
    else if (input.action === 'begin') {
      if (input.oauth_session_id) assert.equal(input.oauth_session_id, 'session-resume');
      else assert.equal(input.app_id, 'cli_personal');
      onboardingState = { flow_id: 'backend-personal', status: 'registering',
        verification_url: 'https://accounts.feishu.cn/app-authorize' };
      res.end(JSON.stringify(onboardingState));
    } else if (input.action === 'status') res.end(JSON.stringify(onboardingState));
    else if (input.action === 'cancel') res.end(JSON.stringify({ cancelled: true }));
    else if (input.action === 'verify') {
      const account = accounts.find((a) => a.account_id === input.account_id);
      res.writeHead(account ? 200 : 404);
      res.end(JSON.stringify(account ? { account } : { error: 'ACCOUNT_NOT_FOUND' }));
    } else {
      res.writeHead(400);
      res.end('{}');
    }
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  t.after(() => backend.close());
  const portServer = http.createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const proxy = spawn(process.execPath, ['oauth-proxy-server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), ALLOWED_HOSTS: 'localhost',
      PUBLIC_BASE_URL: 'https://localhost', LOGIN_PASSWORD: 'test-password',
      SESSION_SECRET: 'test-only-session-secret', GITHUB_CLIENT_ID: '',
      ALLOWED_GITHUB_USERS: 'tester', MCP_HTTP_TOKEN: 'internal-test-token',
      UPSTREAM: `http://127.0.0.1:${backend.address().port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => proxy.kill());
  let logs = '';
  proxy.stderr.on('data', (b) => { logs += b; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy did not start: ' + logs)), 5000);
    proxy.stdout.on('data', (b) => { if (String(b).includes('listening')) { clearTimeout(timer); resolve(); } });
    proxy.once('exit', () => { clearTimeout(timer); reject(new Error(logs)); });
  });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  async function request(path, options = {}) {
    const response = await fetch(base + path, { redirect: 'manual', ...options,
      headers: { 'x-forwarded-proto': 'https', cookie, ...options.headers } });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  }
  const post = (path, form) => request(path, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  const callback = 'https://chatgpt.com/connector/oauth/test';
  const registration = await request('/register', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: 'none' }) });
  const { client_id } = await registration.json();
  const verifier = 'test-verifier-with-sufficient-entropy-for-pkce-0123456789';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authPath = '/authorize?' + new URLSearchParams({ client_id, redirect_uri: callback,
    response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'outer-state' });
  const cachedAuthorization = { client_id: 'cached-client-after-restart', redirect_uri: 'https://chatgpt.com/connector/oauth/callback-id',
    response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'cached-state' };
  const cached = await request('/authorize?' + new URLSearchParams(cachedAuthorization));
  assert.equal(cached.status, 302, 'an existing ChatGPT client must reconnect after in-memory DCR registration is lost');
  assert.match(cached.headers.get('location'), /^\/connect\//);
  for (const redirect_uri of ['https://chatgpt.com.evil.invalid/connector/oauth/callback-id', 'https://chatgpt.com/unrelated']) {
    const rejected = await request('/authorize?' + new URLSearchParams({ ...cachedAuthorization,
      client_id: 'unknown-' + redirect_uri, redirect_uri }));
    assert.equal(rejected.status, 400);
  }
  const first = await request(authPath);
  let flowPath = first.headers.get('location');
  // The old implementation logs in and immediately returns to ChatGPT.
  if (flowPath.startsWith('/login')) {
    await request(flowPath);
    const login = await post('/login/demo', { password: 'test-password' });
    flowPath = login.headers.get('location');
  } else {
    const loginPage = await request(flowPath);
    const loginPath = loginPage.headers.get('location');
    const loginHTML = await (await request(loginPath)).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(loginHTML)[1];
    const flow = new URL(base + flowPath).pathname.split('/').pop();
    const login = await post('/login/demo', { password: 'test-password', flow, csrf });
    flowPath = login.headers.get('location');
  }
  assert.match(flowPath, /^\/connect\//, 'login must lead to Feishu selection, not issue an OAuth code');

  async function choose(path, account_id) {
    const page = await request(path);
    const html = await page.text();
    assert.match(html, /个人飞书/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(csrf);
    const denied = await post(path + '/select', { csrf: 'wrong', account_id });
    assert.equal(denied.status, 403);
    const selected = await post(path + '/select', { csrf, account_id });
    assert.equal(selected.status, 303);
    const redirect = new URL(selected.headers.get('location'));
    assert.equal(redirect.origin, 'https://chatgpt.com');
    assert.equal(redirect.searchParams.get('state'), 'outer-state');
    const tokenRes = await post('/token', { grant_type: 'authorization_code', client_id,
      code: redirect.searchParams.get('code'), redirect_uri: callback, code_verifier: verifier });
    assert.equal(tokenRes.status, 200);
    return tokenRes.json();
  }
  const work = await choose(flowPath, 'fa_work');
  const second = await request(authPath);
  const personalPath = second.headers.get('location');
  assert.match(personalPath, /^\/connect\//, 'existing browser login must not skip account selection');
  assert.notEqual(personalPath, flowPath);
  const personal = await choose(personalPath, 'fa_personal');
  async function headersFor(token) {
    const r = await request('/mcp', { method: 'POST', body: '{}', headers: {
      authorization: 'Bearer ' + token, 'x-oauth-account': 'fa_forged', 'x-oauth-user': 'attacker' } });
    return r.json();
  }
  const workHeaders = await headersFor(work.access_token);
  const personalHeaders = await headersFor(personal.access_token);
  assert.equal(workHeaders['x-oauth-account'], 'fa_work');
  assert.equal(personalHeaders['x-oauth-account'], 'fa_personal');
  assert.equal(personalHeaders['x-oauth-user'], 'github:tester');
  assert.notEqual(workHeaders['x-oauth-connection'], personalHeaders['x-oauth-connection']);
  const refreshed = await post('/token', { grant_type: 'refresh_token', client_id, refresh_token: work.refresh_token });
  const newWork = await refreshed.json();
  assert.equal((await headersFor(newWork.access_token))['x-oauth-account'], 'fa_work');
  assert.equal((await headersFor(newWork.access_token))['x-oauth-connection'], workHeaders['x-oauth-connection']);
  assert.equal((await post('/token', { grant_type: 'refresh_token', client_id, refresh_token: work.refresh_token })).status, 400);

  const setup = await request(authPath);
  const setupPath = setup.headers.get('location');
  const setupHTML = await (await request(setupPath)).text();
  assert.match(setupHTML, /组织标识 tenant_work/);
  assert.match(setupHTML, /继续 个人待完成 授权/);
  assert.ok(!setupHTML.includes('连接 重复企业'));
  const setupCSRF = /name="csrf" value="([^"]+)"/.exec(setupHTML)[1];
  assert.equal((await post(setupPath + '/start', { csrf: setupCSRF, app_id: 'cli_personal', alias: '个人飞书' })).status, 303);
  assert.match(await (await request(setupPath)).text(), /app-authorize/);
  assert.equal((await post(setupPath + '/select', { csrf: setupCSRF, account_id: 'fa_personal' })).status, 409,
    'an unfinished Feishu flow must not issue an OAuth code');
  onboardingState = { ...onboardingState, status: 'authorizing', verification_url: 'https://accounts.feishu.cn/user-authorize' };
  assert.match(await (await request(setupPath)).text(), /user-authorize/);
  onboardingState = { ...onboardingState, status: 'ready', account: { ...accounts[1], already_connected: true }, client_secret: 'should-never-render' };
  const confirmHTML = await (await request(setupPath)).text();
  assert.match(confirmHTML, /确认连接飞书账号/);
  assert.match(confirmHTML, /已连接过的同一飞书身份/);
  assert.match(confirmHTML, /组织标识 tenant_personal/);
  assert.ok(!confirmHTML.includes('should-never-render'));
  const confirmed = await post(setupPath + '/select', { csrf: setupCSRF, account_id: 'fa_personal' });
  const confirmedCode = new URL(confirmed.headers.get('location')).searchParams.get('code');
  const exchange = { grant_type: 'authorization_code', client_id, code: confirmedCode,
    redirect_uri: callback, code_verifier: verifier };
  assert.equal((await post('/token', { ...exchange, code_verifier: 'wrong' })).status, 400);
  assert.equal((await post('/token', exchange)).status, 200);
  assert.equal((await post('/token', exchange)).status, 400, 'authorization codes must be single use');

  const resumePath = (await request(authPath)).headers.get('location');
  const resumeHTML = await (await request(resumePath)).text();
  const resumeCSRF = /name="csrf" value="([^"]+)"/.exec(resumeHTML)[1];
  assert.equal((await post(resumePath + '/start', { csrf: resumeCSRF, oauth_session_id: 'session-resume' })).status, 303);
  assert.equal((await post(resumePath + '/cancel', { csrf: resumeCSRF })).status, 303);

  const third = await request(authPath);
  const otherPath = third.headers.get('location');
  const savedCookie = cookie;
  cookie = '';
  assert.equal((await request(otherPath)).status, 404, 'a different browser must not access the flow');
  cookie = savedCookie;
  const html = await (await request(otherPath)).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  assert.equal((await post(otherPath + '/select', { csrf, account_id: 'fa_other_user' })).status, 404);
  const cancelled = await post(otherPath + '/cancel', { csrf });
  const cancelURL = new URL(cancelled.headers.get('location'));
  assert.equal(cancelURL.searchParams.get('error'), 'access_denied');
  assert.equal(cancelURL.searchParams.get('state'), 'outer-state');
  assert.equal((await request(otherPath)).status, 404, 'cancelled flows cannot be reused');
});
