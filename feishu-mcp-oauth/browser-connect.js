import crypto from 'node:crypto';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const random = () => crypto.randomBytes(24).toString('base64url');
const identityDetails = (a) => `<small>飞书用户：${escape(a.user_name)}<br>
  组织：${escape(a.tenant_name || (a.tenant_key ? '组织标识 ' + a.tenant_key : '尚未取得组织信息'))}<br>
  应用：${escape(a.app_id || '尚未取得应用信息')}</small>`;
const FEISHU_HOSTS = new Set(['accounts.feishu.cn', 'open.feishu.cn']);

function officialURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !FEISHU_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
    throw new Error('Invalid Feishu verification URL');
  }
  return url.href;
}

function page(title, body, refresh = false) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    ${refresh ? '<meta http-equiv="refresh" content="4">' : ''}<title>${escape(title)}</title>
    <style>body{font-family:system-ui,sans-serif;background:#f7f8fa;color:#19232d;margin:0;padding:40px 20px}
    main{max-width:520px;margin:auto;background:white;border:1px solid #e2e5e9;border-radius:16px;padding:28px}
    h1{font-size:24px}h2{font-size:18px;margin-top:28px}p{line-height:1.7;color:#53616f}
    form{margin:16px 0}button,.link{display:inline-block;padding:12px 18px;border:0;border-radius:8px;
    background:#1769e0;color:white;font-size:15px;cursor:pointer;text-decoration:none}
    input{display:block;box-sizing:border-box;width:100%;padding:11px;border:1px solid #cad0d7;border-radius:6px;margin:10px 0}
    .secondary{background:#edf0f4;color:#344350}small{display:block;color:#637282;margin-top:8px}
    details{margin:16px 0}label{display:block;margin-top:14px}</style></head>
    <body><main><h1>${escape(title)}</h1>${body}</main></body></html>`;
}

/** Browser transactions are independent of OAuth clients and scoped to a session. */
export function mountBrowserConnect(app, { identity, finish, login, now = Date.now }) {
  const flows = new Map();
  const timer = setInterval(() => {
    for (const [id, flow] of flows) if (flow.expiresAt < now()) flows.delete(id);
  }, 60_000).unref();
  app.on?.('close', () => clearInterval(timer));

  function find(req, id) {
    const flow = flows.get(id);
    if (!flow || flow.sessionId !== req.sessionID || flow.expiresAt < now()) return;
    if (flow.userId && flow.userId !== req.session.user_id) return;
    return flow;
  }
  const hidden = (flow) => `<input type="hidden" name="csrf" value="${flow.csrf}">`;
  const cancel = (id, flow) => `<form method="post" action="/connect/${id}/cancel">${hidden(flow)}
    <button class="secondary">取消连接</button></form>`;
  function secure(res) {
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
  }
  function route(handler, { mutate = false } = {}) {
    return async (req, res) => {
      secure(res);
      const flow = find(req, req.params.id);
      if (!flow) return res.status(404).send(page('连接已失效', '<p>请返回 ChatGPT，重新点击连接另一个账户。</p>'));
      if (!req.session.user_id) return login(req, res, req.params.id);
      flow.userId ??= req.session.user_id;
      if (mutate && (typeof req.body.csrf !== 'string' || req.body.csrf !== flow.csrf)) {
        return res.status(403).send(page('请求未通过验证', '<p>请返回连接页面重试。</p>'));
      }
      if (flow.busy) return res.status(409).send(page('正在连接', '<p>请稍后刷新此页面。</p>'));
      flow.busy = true;
      try { await handler(req, res, flow); }
      catch (error) {
        // Neither CLI errors nor provider payloads may leak secrets into HTML.
        const status = error.status === 404 ? 404 : 502;
        res.status(status).send(page('暂时无法完成连接', `<p>请检查飞书授权是否完成，稍后重试。</p>
          <a class="link" href="/connect/${req.params.id}">返回连接页面</a>${cancel(req.params.id, flow)}`));
      } finally { flow.busy = false; }
    };
  }

  app.get('/connect/:id', route(async (req, res, flow) => {
    const id = req.params.id;
    if (flow.backendId) {
      const state = await identity({ action: 'status', user_id: flow.userId, flow_id: flow.backendId });
      if (state.status === 'ready') {
        flow.readyAccountId = state.account.account_id;
        return res.send(page('确认连接飞书账号', `<p>即将连接：<strong>${escape(state.account.alias || state.account.user_name)}</strong></p>
          ${identityDetails(state.account)}
          ${state.account.already_connected ? '<p><strong>这是已连接过的同一飞书身份，不会新增个人或其他组织身份。</strong>若你要连接个人飞书，请取消并重新选择个人身份。</p>' : ''}
          ${state.account.same_organization_as?.length ? `<p>与 ${escape(state.account.same_organization_as.join('、'))} 属于同一组织。</p>` : ''}
          <form method="post" action="/connect/${id}/select">${hidden(flow)}
          <input type="hidden" name="account_id" value="${escape(flow.readyAccountId)}"><button>连接并返回 ChatGPT</button></form>${cancel(id, flow)}`));
      }
      if (state.status === 'failed' || state.status === 'expired') {
        flow.backendId = undefined;
        return res.send(page('飞书授权未完成', `<p>授权被取消、已过期或未能完成。可以重新开始。</p>
          <a class="link" href="/connect/${id}">重新选择账号</a>${cancel(id, flow)}`));
      }
      const url = officialURL(state.verification_url);
      return res.send(page(state.status === 'registering' ? '接入你的飞书应用' : '授权你的飞书账号',
        `<p>${state.status === 'registering' ? '在飞书页面选择个人或企业身份，接入你已有的应用。' : '在飞书页面确认要连接的身份及权限。'}</p>
        <a class="link" href="${escape(url)}" target="_blank" rel="noopener noreferrer">打开飞书并继续</a>
        <p>确认后回到此页，会自动显示下一步。</p>${cancel(id, flow)}`, true));
    }
    const data = await identity({ action: 'list', user_id: flow.userId });
    const incomplete = (data.incomplete || []).map((s) => `<form method="post" action="/connect/${id}/start">${hidden(flow)}
      <input type="hidden" name="oauth_session_id" value="${escape(s.session_id)}">
      <button>继续 ${escape(s.alias || '未完成账号')} 授权</button><small>应用 ${escape(s.app_id)}：尚未完成用户授权，不是已连接账号。</small></form>`).join('');
    const choices = data.accounts.filter((a) => !a.same_identity_as).map((a) => `<form method="post" action="/connect/${id}/select">${hidden(flow)}
      <input type="hidden" name="account_id" value="${escape(a.account_id)}">
      <button>连接 ${escape(a.alias || a.user_name)}</button>${identityDetails(a)}</form>
      <form method="post" action="/connect/${id}/start">${hidden(flow)}
      <input type="hidden" name="account_id" value="${escape(a.account_id)}"><button class="secondary">重新授权 ${escape(a.alias || a.user_name)}</button></form>`).join('');
    const apps = data.apps.map((a) => `<form method="post" action="/connect/${id}/start">${hidden(flow)}
      <input type="hidden" name="app_alias" value="${escape(a.alias)}"><button class="secondary">用 ${escape(a.alias || '默认应用')} 登录飞书</button><small>应用 ${escape(a.app_id)} 的所属组织固定。</small></form>`).join('');
    res.send(page('选择要连接的飞书账号', `<p>请核对组织归属；填写“个人飞书”备注不会切换飞书身份。</p>${incomplete}${choices}
      ${data.accounts.some((a) => a.same_identity_as) ? '<p>已合并展示同一飞书身份的重复记录，重复记录不代表另一个组织。</p>' : ''}
      <h2>连接个人或其他飞书账号</h2><p>在飞书官方页面选择身份并确认应用接入，无需复制密钥。</p>
      <form method="post" action="/connect/${id}/start">${hidden(flow)}
      <label>账号备注（可选）<input name="alias" maxlength="80" placeholder="例如：个人飞书"></label>
      <details><summary>指定已有应用（可选）</summary><label>App ID<input name="app_id" placeholder="cli_…" pattern="cli_[A-Za-z0-9]+"></label></details>
      <button>前往飞书连接账号</button></form><details><summary>使用已配置应用登录</summary>${apps}</details>${cancel(id, flow)}`));
  }));
  app.post('/connect/:id/start', route(async (req, res, flow) => {
    if (flow.backendId) return res.redirect(303, '/connect/' + req.params.id);
    const state = await identity({ action: 'begin', user_id: flow.userId,
      alias: req.body.alias, app_id: req.body.app_id, app_alias: req.body.app_alias, account_id: req.body.account_id,
      oauth_session_id: req.body.oauth_session_id });
    flow.backendId = state.flow_id;
    res.redirect(303, '/connect/' + req.params.id);
  }, { mutate: true }));
  app.post('/connect/:id/select', route(async (req, res, flow) => {
    const accountId = req.body.account_id;
    if (flow.backendId && accountId !== flow.readyAccountId) return res.status(409).send(page('请先完成飞书授权', ''));
    const { account } = await identity({ action: 'verify', user_id: flow.userId, account_id: accountId });
    flows.delete(req.params.id);
    return finish(req, res, { ...flow.pending, feishu_account_id: account.account_id, connection_id: random() });
  }, { mutate: true }));
  app.post('/connect/:id/cancel', route(async (req, res, flow) => {
    if (flow.backendId) {
      try { await identity({ action: 'cancel', user_id: flow.userId, flow_id: flow.backendId }); }
      catch { /* A lost backend flow must not prevent cancelling the outer OAuth grant. */ }
    }
    flows.delete(req.params.id);
    const url = new URL(flow.pending.redirect_uri);
    url.searchParams.set('error', 'access_denied');
    if (flow.pending.state) url.searchParams.set('state', flow.pending.state);
    res.redirect(303, url.href);
  }, { mutate: true }));

  return {
    begin(req, res, pending) {
      const id = random();
      req.session.connect_started = true;
      flows.set(id, { pending, csrf: random(), sessionId: req.sessionID,
        expiresAt: now() + 30 * 60_000, userId: req.session.user_id });
      return res.redirect('/connect/' + id);
    },
    resume(req, res, id) {
      if (!find(req, id)) return res.status(404).send('连接已失效，请从 ChatGPT 重新连接。');
      return res.redirect('/connect/' + id);
    },
  };
}

export function internalIdentityClient(upstream, bearer) {
  return async (body) => {
    const response = await fetch(new URL('/internal/identity', upstream), { method: 'POST',
      headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(body.action === 'cancel' ? 5000 : 65_000), redirect: 'error' });
    if (!response.ok) { const error = new Error('Identity request failed'); error.status = response.status; throw error; }
    return response.json();
  };
}
