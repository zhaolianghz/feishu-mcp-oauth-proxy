// OAuth 2.1 + PKCE + Dynamic Client Registration middleware for ChatGPT custom MCP connector
// Flow:
//   ChatGPT → GET /.well-known/oauth-authorization-server → discover endpoints
//   ChatGPT → POST /register → DCR (we auto-approve any UUID)
//   ChatGPT → GET /authorize?... → browser login (GitHub OAuth or demo) → issue auth code → redirect
//   ChatGPT → POST /token (code + code_verifier) → access_token
//   ChatGPT → POST /mcp (Authorization: Bearer <access_token>) → proxy to feishu-mcp:3000
//
// Storage: in-memory (ChatGPT re-runs OAuth on restart; production should use Redis/DB).
// Security: trusts CF proxy (X-Forwarded-Proto); GitHub login limited to ALLOWED_GITHUB_USERS whitelist.

import express from 'express';
import crypto from 'node:crypto';
import session from 'express-session';
import helmet from 'helmet';
import http from 'node:http';
import { mountBrowserConnect, internalIdentityClient } from './browser-connect.js';

const PORT = parseInt(process.env.PORT || '3011', 10);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://mcp.example.com';
// Host 白名单：OAuth 元数据（issuer / endpoints）按请求 Host 动态生成，
// 这样多域名都能自洽工作，同时不会被伪造的 Host 头带偏。
//
// ⚠️ 域名必须是合法主机名 —— RFC 1123 不允许 "_"。
//    下划线域名会让新版 OpenSSL 拒绝 *.example.com 的通配符匹配（RFC 6125），
//    严格 TLS 客户端全部握手失败。新增域名时务必先确认不含下划线。
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || 'mcp.example.com')
  .split(',').map(function(s) { return s.trim().toLowerCase(); }).filter(Boolean);

/** 按请求推导本次使用的 base URL；Host 不在白名单则退回 PUBLIC_BASE_URL。 */
function baseUrlFor(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0].toLowerCase();
  if (!host || ALLOWED_HOSTS.indexOf(host) === -1) return PUBLIC_BASE_URL;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return proto + '://' + host;
}

const UPSTREAM = process.env.UPSTREAM || 'http://feishu-mcp:3000';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || (PUBLIC_BASE_URL + '/oauth/github/callback');
const ALLOWED_GITHUB_USERS = (process.env.ALLOWED_GITHUB_USERS || '<GITHUB_USER>').split(',').map(function(s){return s.trim();}).filter(Boolean);
// 未配 GitHub OAuth 时，用「共享密码」把关。为空则退化为纯用户名表单（仅限本机/内网，勿上公网）。
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const MCP_HTTP_TOKEN = process.env.MCP_HTTP_TOKEN || '';

const app = express();
app.set('trust proxy', true);

// ===== 0. Raw body capture for /mcp =====
// 关键：express.json() 会消费 req 的流，导致后面反代 pipe 出去的是空 body。
// 所以必须在 express.json 之前，给 /mcp 单独抓一份原始字节。
app.use(function(req, res, next) {
  if (req.path !== '/mcp') return next();
  const chunks = [];
  req.on('data', function(c) { chunks.push(c); });
  req.on('end', function() {
    req.rawBody = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
    next();
  });
  req.on('error', function(err) { next(err); });
});

app.use(helmet({ contentSecurityPolicy: false }));

// body parser 必须跳过 /mcp（它的流已被上面 raw capture 消费，再解析会 500 stream is not readable）
const jsonParser = express.json({ limit: '64kb' });
const urlencParser = express.urlencoded({ extended: true });
app.use(function(req, res, next) {
  if (req.path === '/mcp') return next();
  jsonParser(req, res, function(err) {
    if (err) return next(err);
    urlencParser(req, res, next);
  });
});

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    maxAge: 30 * 60 * 1000,
  },
}));

// ===== in-memory stores =====
const clients = new Map();
const authCodes = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();
const userSessions = new Map();

const TOKEN_TTL = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days
const AUTH_CODE_TTL = 10 * 60;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomToken(bytes) {
  if (!bytes) bytes = 32;
  return b64url(crypto.randomBytes(bytes));
}

setInterval(function() {
  const now = Date.now();
  for (const [k, v] of authCodes) if (v.expires_at < now) authCodes.delete(k);
  for (const [k, v] of accessTokens) if (v.expires_at < now) accessTokens.delete(k);
}, 60 * 1000).unref();

// ===== CORS for ChatGPT browser =====
app.use(function(req, res, next) {
  const origin = req.headers.origin;
  if (origin === 'https://chatgpt.com' || origin === 'https://chat.openai.com') {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ===== 1. OAuth 2.0 Authorization Server Metadata (RFC 8414) =====

/**
 * 生成 AS 元数据。
 *
 * ⚠️ 三个入口必须返回**完全相同**的内容（抽成函数而非各写一份）：
 *   1) /.well-known/oauth-authorization-server          （RFC 8414 标准路径）
 *   2) /.well-known/oauth-authorization-server/<path>   （RFC 8414 带 issuer 路径段）
 *   3) /.well-known/openid-configuration                （OIDC 兼容别名）
 *
 * 注意：ChatGPT 建 connector 时会**并发探测**多个发现路径，拿到 401 后
 * 读 WWW-Authenticate 里的 resource_metadata，再去取 AS 元数据。
 * 任一路径返回 Express 默认 404（**text/html** 而非 JSON）就会被严格解析器
 * 判定整个发现流程失败 → UI 报"无法创建 MCP 应用"，表现为 POST /register
 * 能成功(201) 但**从不请求 /authorize**，反复重试。
 * 结论：这类客户端要**所有**探测路径都返回合法 JSON，缺一个就整体失败。
 */
function asMetadata(base) {
  return {
    issuer: base,
    authorization_endpoint: base + '/authorize',
    token_endpoint: base + '/token',
    registration_endpoint: base + '/register',
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    // ChatGPT 的 DCR 请求不带 scope，授权时会回落到这里声明的值 → 必须包含它要的
    scopes_supported: ['mcp:read', 'mcp:write', 'openid', 'profile', 'email', 'offline_access'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    service_documentation: 'https://modelcontextprotocol.io',
    ui_locales_supported: ['en', 'zh'],
  };
}

// 标准路径
app.get('/.well-known/oauth-authorization-server', function(req, res) {
  res.json(asMetadata(baseUrlFor(req)));
});

// RFC 8414 带 issuer 路径段的形式：/.well-known/oauth-authorization-server/mcp.example.com
// （issuer 含 scheme 时客户端可能拼成 /https/mcp.example.com，用通配兜住两种）
app.get(/^\/\.well-known\/oauth-authorization-server(\/.*)?$/, function(req, res) {
  res.json(asMetadata(baseUrlFor(req)));
});

// OIDC 兼容别名 —— 部分客户端（含 ChatGPT connector）只探这一个
app.get('/.well-known/openid-configuration', function(req, res) {
  res.json(asMetadata(baseUrlFor(req)));
});

// OAuth 授权服务器元数据也可能在 PRM 里以 authorization_servers 指向根路径，
// 补 /.well-known/oauth-protected-resource/mcp 形式（RFC 9728 允许带资源路径）
app.get('/.well-known/oauth-protected-resource/mcp', function(req, res) {
  const base = baseUrlFor(req);
  res.json({
    resource: base + '/mcp',
    authorization_servers: [base],
    scopes_supported: ['mcp:read', 'mcp:write'],
    bearer_methods_supported: ['header'],
    resource_documentation: 'OAuth 2.1 + PKCE + DCR protected MCP endpoint.',
  });
});

// ===== 2. Dynamic Client Registration (RFC 7591) =====
app.post('/register', function(req, res) {
  const body = req.body || {};
  // [DEBUG-PROBE 2026-09-30] 排查 ChatGPT connector 创建失败：记录 DCR 原始入参
  if (process.env.DEBUG_PROBE === '1') {
    console.log('[probe] /register body=' + JSON.stringify(body));
    console.log('[probe] /register ua=' + String(req.headers['user-agent'] || ''));
  }
  const clientId = body.client_id || randomToken(16);
  const clientSecret = body.client_secret || (body.token_endpoint_auth_method === 'none' ? null : randomToken(32));
  const redirectUris = body.redirect_uris || [
    'https://chatgpt.com/oauth/callback',
    'https://chat.openai.com/oauth/callback',
    'https://chatgpt.com/connector_platform_oauth_redirect',
  ];
  const grantTypes = body.grant_types || ['authorization_code', 'refresh_token'];
  const client = {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    token_endpoint_auth_method: body.token_endpoint_auth_method || 'none',
    client_name: body.client_name || 'Unknown',
    created_at: Date.now(),
  };
  clients.set(clientId, client);

  // RFC 7591 §3.2.1 响应构造：
  //   client_id_issued_at / client_secret_expires_at 必须是 JSON number（整数秒），
  //   **绝不能是 null**。public client（token_endpoint_auth_method=none）应**省略**
  //   client_secret 与 client_secret_expires_at，而不是给 null。
  //
  // ⚠️ 踩坑（2026-09-30）：曾返回 "client_secret": null 且缺 client_secret_expires_at，
  // ChatGPT connector 的严格解析器在处理 null 过期时间戳时抛错 → 放弃流程，
  // 表现为 DCR 返回 201 却**从不请求 /authorize**，UI 报"无法创建 MCP 应用"。
  const isPublic = client.token_endpoint_auth_method === 'none';
  const resp = {
    client_id: client.client_id,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    response_types: body.response_types || ['code'],
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    client_id_issued_at: Math.floor(client.created_at / 1000),
  };
  if (!isPublic) {
    resp.client_secret = client.client_secret;
    // 0 = 永不过期（RFC 7591 明确允许）
    resp.client_secret_expires_at = 0;
  }
  res.status(201).json(resp);
});

// ===== 3. Authorize =====
// ChatGPT can reuse a cached client_id after this in-memory DCR store restarts.
// Accept only known callback routes on exact OpenAI hosts in that recovery case.
function isChatGPTCallback(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
      ['chatgpt.com', 'chat.openai.com'].includes(url.hostname) &&
      (['/oauth/callback', '/connector_platform_oauth_redirect'].includes(url.pathname) ||
        /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname));
  } catch { return false; }
}

const browserConnect = mountBrowserConnect(app, {
  identity: internalIdentityClient(UPSTREAM, MCP_HTTP_TOKEN),
  finish: issueAuthCodeAndRedirect,
  login(req, res, flowId) {
    if (!GITHUB_CLIENT_ID) return res.redirect('/login?flow=' + encodeURIComponent(flowId));
    const state = randomToken(24);
    req.session.github_flows ??= {};
    req.session.github_flows[state] = flowId;
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', GITHUB_CALLBACK_URL);
    url.searchParams.set('scope', 'read:user');
    url.searchParams.set('state', state);
    return res.redirect(url.href);
  },
});

app.get('/authorize', function(req, res) {
  const q = req.query;
  const client_id = q.client_id;
  const redirect_uri = q.redirect_uri;
  const response_type = q.response_type;
  const scope = q.scope;
  const state = q.state;
  const code_challenge = q.code_challenge;
  const code_challenge_method = q.code_challenge_method;
  // RFC 8707 资源指示器：MCP 规范要求客户端 MUST 在授权请求中携带。
  // 规范 URI 取 RFC 9728 的 resource 字段值（https://<host>/mcp）。
  const resource = q.resource || (baseUrlFor(req) + '/mcp');

  const errors = [];
  if (!client_id) errors.push('missing client_id');
  if (response_type !== 'code') errors.push('response_type must be code');
  if (!redirect_uri) errors.push('missing redirect_uri');
  if (!code_challenge) errors.push('PKCE required: missing code_challenge');
  if (code_challenge_method && code_challenge_method !== 'S256' && code_challenge_method !== 'plain') errors.push('code_challenge_method must be S256 or plain');
  if (errors.length) return res.status(400).send('invalid_request: ' + errors.join('; '));

  // Auto-register any unknown client_id (ChatGPT uses UUIDs or 'chatgpt')
  if (!clients.has(client_id)) {
    if (!isChatGPTCallback(redirect_uri)) return res.status(400).send('invalid redirect_uri');
    clients.set(client_id, {
      client_id: client_id,
      client_secret: null,
      redirect_uris: [redirect_uri],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      client_name: 'auto-registered',
      created_at: Date.now(),
    });
  }
  const client = clients.get(client_id);
  const allowed = client.redirect_uris.some(function(uri) { return redirect_uri === uri; });
  if (!allowed) return res.status(400).send('invalid redirect_uri: ' + redirect_uri);

  return browserConnect.begin(req, res, { client_id, redirect_uri, scope, state, resource, code_challenge, code_challenge_method });
});

// ===== 3.5 Demo login (no GitHub configured) =====
app.get('/login', function(req, res) {
  const flow = typeof req.query.flow === 'string' ? req.query.flow : '';
  if (req.session.user_id && flow) return browserConnect.resume(req, res, flow);
  req.session.login_csrf ??= randomToken(24);
  res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
  res.set('Content-Type', 'text/html; charset=utf-8');
  const pwdMode = !!LOGIN_PASSWORD;
  const statusLine = GITHUB_CLIENT_ID
    ? 'GitHub OAuth configured'
    : (pwdMode ? 'Password gate enabled' : 'WARNING: no GitHub OAuth, no password - demo login only');
  const userField = pwdMode
    ? ''
    : '<label>GitHub username (whitelisted):</label>' +
      '<input name="username" placeholder="' + ALLOWED_GITHUB_USERS[0] + '" required autofocus>';
  const pwdField = pwdMode
    ? '<label>Password:</label><input name="password" type="password" required autofocus>'
    : '';
  // 品牌名按请求 Host 推导，与用户实际访问的域名一致
  const brand = baseUrlFor(req).replace(/^https?:\/\//, '');
  const html = '<!DOCTYPE html><html><head><title>' + brand + ' - Login</title>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:420px;margin:80px auto;padding:20px;color:#222;background:#fff}' +
    'h1{font-size:18px;margin:0 0 16px}input,button{font-size:14px;padding:8px 12px;width:100%;box-sizing:border-box;margin:6px 0;border:1px solid #ccc;border-radius:6px}' +
    'button{background:#41D87E;color:#fff;border:none;cursor:pointer}button:hover{background:#36b56a}' +
    '.meta{font-size:12px;color:#888;margin-top:20px}</style></head>' +
    '<body><h1>Authorize access to ' + brand + '</h1>' +
    '<form method="POST" action="/login/demo">' +
    '<input type="hidden" name="csrf" value="' + req.session.login_csrf + '">' +
    '<input type="hidden" name="flow" value="' + (/^[A-Za-z0-9_-]+$/.test(flow) ? flow : '') + '">' +
    userField + pwdField +
    '<button type="submit">Authorize &amp; Continue</button>' +
    '</form>' +
    '<p class="meta">' + statusLine + '</p></body></html>';
  res.send(html);
});

app.post('/login/demo', function(req, res) {
  if (GITHUB_CLIENT_ID) return res.status(403).send('请使用 GitHub 登录。');
  if (!req.session.login_csrf || req.body.csrf !== req.session.login_csrf) return res.status(403).send('invalid login CSRF');
  // 密码模式：密码必须匹配（timing-safe），用户名取白名单首位
  const username = (req.body.username || '').trim() || ALLOWED_GITHUB_USERS[0];
  if (LOGIN_PASSWORD) {
    const supplied = Buffer.from(String(req.body.password || ''));
    const expected = Buffer.from(LOGIN_PASSWORD);
    const ok = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    if (!ok) {
      return res.status(403).send('<h1>Denied</h1><p>Wrong password.</p><p><a href="/login">Back</a></p>');
    }
  }
  if (!ALLOWED_GITHUB_USERS.includes(username)) {
    return res.status(403).send('<h1>Denied</h1><p>User ' + username + ' not in whitelist. Allowed: ' + ALLOWED_GITHUB_USERS.join(', ') + '</p><p><a href="/login">Back</a></p>');
  }
  req.session.user_id = 'github:' + username;
  userSessions.set(req.session.user_id, { github_login: username, name: username, avatar_url: '', last_seen: Date.now() });
  if (req.body.flow) return browserConnect.resume(req, res, req.body.flow);
  res.redirect('/');
});

// ===== 4. GitHub OAuth callback =====
app.get('/oauth/github/callback', async function(req, res) {
  const code = req.query.code;
  const state = req.query.state;
  const flowId = req.session.github_flows?.[state];
  if (!flowId) return res.status(400).send('invalid state; please retry.');
  delete req.session.github_flows[state];
  if (!code) return res.status(400).send('missing code');
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code: code,
        redirect_uri: GITHUB_CALLBACK_URL,
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error('GitHub token error: ' + (tokenData.error_description || tokenData.error));
    const userRes = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': 'Bearer ' + tokenData.access_token, 'Accept': 'application/vnd.github+json' },
    });
    const userData = await userRes.json();
    if (!userData.login) throw new Error('failed to get GitHub user');
    if (!ALLOWED_GITHUB_USERS.includes(userData.login)) {
      return res.status(403).send('<h1>Denied</h1><p>GitHub user ' + userData.login + ' not in whitelist. Allowed: ' + ALLOWED_GITHUB_USERS.join(', ') + '</p>');
    }
    req.session.user_id = 'github:' + userData.login;
    userSessions.set(req.session.user_id, { github_login: userData.login, name: userData.name || userData.login, avatar_url: userData.avatar_url || '', last_seen: Date.now() });
    return browserConnect.resume(req, res, flowId);
  } catch (err) {
    console.error('GitHub OAuth callback error:', err);
    res.status(500).send('OAuth error: ' + err.message);
  }
});

function issueAuthCodeAndRedirect(req, res, pending) {
  if (!pending.feishu_account_id || !pending.connection_id) return res.status(400).send('请选择飞书账号。');
  const code = randomToken(32);
  authCodes.set(code, {
    client_id: pending.client_id,
    user_id: req.session.user_id,
    feishu_account_id: pending.feishu_account_id,
    connection_id: pending.connection_id,
    redirect_uri: pending.redirect_uri,
    scope: pending.scope || 'mcp:read mcp:write',
    // RFC 8707 资源指示器（MCP 规范要求 MUST 出现在授权与 token 请求中）
    resource: pending.resource || (baseUrlFor(req) + '/mcp'),
    code_challenge: pending.code_challenge,
    code_challenge_method: pending.code_challenge_method || 'plain',
    expires_at: Date.now() + AUTH_CODE_TTL * 1000,
  });
  const url = new URL(pending.redirect_uri);
  url.searchParams.set('code', code);
  if (pending.state) url.searchParams.set('state', pending.state);
  res.redirect(303, url.toString());
}

// ===== 5. Token endpoint =====
app.post('/token', function(req, res) {
  const body = req.body || {};
  const grant_type = body.grant_type;
  if (grant_type === 'authorization_code') {
    const code = body.code;
    const redirect_uri = body.redirect_uri;
    const client_id = body.client_id;
    const code_verifier = body.code_verifier;
    const entry = authCodes.get(code);
    if (!entry) return res.status(400).json({ error: 'invalid_grant', error_description: 'invalid code' });
    if (entry.expires_at < Date.now()) { authCodes.delete(code); return res.status(400).json({ error: 'invalid_grant', error_description: 'code expired' }); }
    if (entry.client_id !== client_id) return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
    if (entry.redirect_uri !== redirect_uri) return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    if (entry.code_challenge) {
      if (!code_verifier) return res.status(400).json({ error: 'invalid_grant', error_description: 'missing code_verifier' });
      let challenge;
      if (entry.code_challenge_method === 'S256') challenge = b64url(crypto.createHash('sha256').update(code_verifier).digest());
      else challenge = code_verifier;
      if (challenge !== entry.code_challenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
    authCodes.delete(code);
    return res.json(issueTokens(entry.client_id, entry.user_id, entry.scope, entry.resource, entry.feishu_account_id, entry.connection_id));
  }
  if (grant_type === 'refresh_token') {
    const refresh_token = body.refresh_token;
    const client_id = body.client_id;
    const entry = refreshTokens.get(refresh_token);
    if (!entry) return res.status(400).json({ error: 'invalid_grant', error_description: 'invalid refresh_token' });
    if (entry.expires_at < Date.now()) { refreshTokens.delete(refresh_token); return res.status(400).json({ error: 'invalid_grant', error_description: 'expired refresh_token' }); }
    if (entry.client_id !== client_id) return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
    refreshTokens.delete(refresh_token);
    return res.json(issueTokens(entry.client_id, entry.user_id, entry.scope, entry.resource, entry.feishu_account_id, entry.connection_id));
  }
  res.status(400).json({ error: 'unsupported_grant_type' });
});

function issueTokens(client_id, user_id, scope, resource, feishu_account_id, connection_id) {
  const access = randomToken(32);
  const refresh = randomToken(32);
  const expires_at = Date.now() + TOKEN_TTL * 1000;
  // 绑定 resource（RFC 8707）：MCP 规范要求 access token 必须限定受众，
  // 服务端需校验「该 token 是否为自己签发」，防 token 转发（token passthrough）
  const binding = { client_id, user_id, scope, resource: resource || null, feishu_account_id, connection_id };
  accessTokens.set(access, { ...binding, expires_at });
  refreshTokens.set(refresh, { ...binding, expires_at: expires_at + REFRESH_TOKEN_TTL * 1000 });
  return { access_token: access, token_type: 'Bearer', expires_in: TOKEN_TTL, refresh_token: refresh, scope: scope };
}

// ===== 6. Token introspect =====
app.post('/introspect', function(req, res) {
  const token = req.body && req.body.token;
  if (!token) return res.json({ active: false });
  const entry = accessTokens.get(token);
  if (!entry || entry.expires_at < Date.now()) return res.json({ active: false });
  res.json({ active: true, client_id: entry.client_id, username: entry.user_id, scope: entry.scope, exp: Math.floor(entry.expires_at / 1000) });
});

// ===== 7. /mcp reverse proxy with OAuth Bearer =====
//
// 用 node:http 自己实现 reverse proxy（不依赖 http-proxy-middleware，避免 mount path 行为问题）
// 流程：OAuth Bearer 校验 → 原样转发到 feishu-mcp:3000/mcp
const mcpTarget = new URL(UPSTREAM);

app.all('/mcp', function(req, res) {
  const auth = req.headers.authorization;
  let token = null;
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token && req.query && req.query.token) token = String(req.query.token);
  const base = baseUrlFor(req);
  if (!token) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="feishu-mcp", resource_metadata="' + base + '/.well-known/oauth-protected-resource"');
    return res.status(401).json({ error: 'unauthorized: missing access_token' });
  }
  const entry = accessTokens.get(token);
  if (!entry || entry.expires_at < Date.now()) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="feishu-mcp", error="invalid_token", resource_metadata="' + base + '/.well-known/oauth-protected-resource"');
    return res.status(401).json({ error: 'unauthorized: access_token invalid or expired' });
  }
  // 把 access_token 替换为 MCP_HTTP_TOKEN（feishu-mcp 自己不知道 OAuth 这层）
  const forwardHeaders = Object.assign({}, req.headers);
  delete forwardHeaders.host;
  delete forwardHeaders.authorization;
  delete forwardHeaders['content-length'];
  forwardHeaders.authorization = 'Bearer ' + MCP_HTTP_TOKEN;
  forwardHeaders['x-oauth-user'] = entry.user_id;
  // OAuth client_id identifies the client, not an individual account grant.
  forwardHeaders['x-oauth-connection'] = entry.connection_id || entry.client_id || '';
  delete forwardHeaders['x-oauth-account'];
  if (entry.feishu_account_id) forwardHeaders['x-oauth-account'] = entry.feishu_account_id;

  const opts = {
    hostname: mcpTarget.hostname,
    port: mcpTarget.port || 80,
    path: req.originalUrl || req.url,  // /mcp（包含 query string）
    method: req.method,
    headers: forwardHeaders,
  };

  const rawBody = req.rawBody || Buffer.alloc(0);
  if (rawBody.length) forwardHeaders['content-length'] = String(rawBody.length);

  console.log('[oauth-proxy] forwarding ' + req.method + ' ' + opts.path + ' for user ' + entry.user_id + ' (' + rawBody.length + ' bytes)');

  const proxyReq = http.request(opts, function(proxyRes) {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', function(err) {
    console.error('[oauth-proxy] upstream error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'upstream error: ' + err.message });
  });
  // 用抓到的原始字节发出，不要 pipe 已消费的 req
  proxyReq.end(rawBody);
});

// ===== 8. RFC 9728 protected resource metadata =====
app.get('/.well-known/oauth-protected-resource', function(req, res) {
  const base = baseUrlFor(req);
  res.json({
    resource: base + '/mcp',
    authorization_servers: [base],
    scopes_supported: ['mcp:read', 'mcp:write'],
    bearer_methods_supported: ['header'],
    resource_documentation: 'OAuth 2.1 + PKCE + DCR protected MCP endpoint. Login with GitHub OAuth (whitelisted users).',
  });
});

app.get('/', function(req, res) {
  const base = baseUrlFor(req);
  res.json({
    service: 'feishu-mcp oauth-proxy',
    status: 'running',
    base_url: base,
    upstream: UPSTREAM,
    github_oauth_configured: !!GITHUB_CLIENT_ID,
    password_gate: !!LOGIN_PASSWORD,
    allowed_hosts: ALLOWED_HOSTS,
    allowed_github_users: ALLOWED_GITHUB_USERS,
    endpoints: {
      metadata: base + '/.well-known/oauth-authorization-server',
      protected_resource: base + '/.well-known/oauth-protected-resource',
      register: base + '/register',
      authorize: base + '/authorize',
      token: base + '/token',
      mcp: base + '/mcp',
    },
  });
});

app.get('/healthz', function(req, res) { res.status(200).send('ok\n'); });

app.listen(PORT, '0.0.0.0', function() {
  console.log('[oauth-proxy] listening on :' + PORT);
  console.log('[oauth-proxy] public base URL: ' + PUBLIC_BASE_URL);
  console.log('[oauth-proxy] upstream MCP: ' + UPSTREAM);
  console.log('[oauth-proxy] GitHub OAuth: ' + (GITHUB_CLIENT_ID ? 'configured' : 'NOT configured (demo login only)'));
  console.log('[oauth-proxy] allowed GitHub users: ' + ALLOWED_GITHUB_USERS.join(', '));
});
