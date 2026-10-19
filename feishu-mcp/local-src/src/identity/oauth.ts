/**
 * 飞书 OAuth（device flow）与账号接入。
 *
 * 复用 lark-cli 自带的 device flow：
 *   1. 在账号 namespace 下 `auth login --domain ... --no-wait --json` → 拿授权链接
 *   2. 后台 `auth login --device-code <code>` 阻塞轮询，用户浏览器确认后自动完成
 *   3. `api GET /open-apis/authen/v1/user_info` 取 open_id / tenant_key / 昵称
 *   4. 落账号 + 设为当前，写审计
 *
 * 后台轮询用 runWithContext 把 namespace 固定住，不依赖调用时的上下文。
 */
import { runLarkCli, envelopeData } from "../larkCli.js";
import path from "node:path";
import { runWithContext, type AccountRecord } from "./context.js";
import {
  isMigrated,
  getOAuthSession,
  listAccounts,
  markMigrated,
  newAccountId,
  newSessionId,
  saveOAuthSession,
  setActiveAccount,
  updateOAuthSession,
  upsertAccount,
  type OAuthSession,
} from "./store.js";
import { namespaceDir, seedAppConfig, seedFullCredentials, removeNamespace } from "./namespaces.js";
import { appTemplateDir, getApp, listApps } from "./apps.js";
import { appendAudit } from "./audit.js";

interface UserInfo {
  open_id: string;
  union_id?: string;
  tenant_key?: string;
  name?: string;
  avatar_url?: string;
}

interface UserIdentity {
  status?: string;
  openId?: string;
  userName?: string;
  expiresAt?: string;
  scope?: string;
}

export interface AuthStatus {
  appId?: string;
  brand?: string;
  identities?: { user?: UserIdentity; bot?: UserIdentity };
  [key: string]: unknown;
}

const LOGIN_DOMAINS = ["docs", "drive", "base", "sheets", "wiki"];

function nonEmpty<T>(v: T | undefined | null): T | undefined {
  return v === undefined || v === null ? undefined : v;
}

/** 跑一次 lark-cli auth status，返回解析后的对象（失败抛错）。 */
export async function runAuthStatus(namespace: string, verify = false): Promise<AuthStatus> {
  const args = ["auth", "status", "--json"];
  if (verify) args.push("--verify");
  const raw = await runWithContext({ userId: "", credentialNamespace: namespace }, () =>
    runLarkCli(args, { rawOutput: true, noIdentity: true, timeoutMs: 30_000 }),
  );
  return JSON.parse(String(raw)) as AuthStatus;
}

/** Older migrated records may omit app_id; recover it from their own CLI config. */
export async function hydrateAccountAppId(account: AccountRecord): Promise<AccountRecord> {
  if (!account.app_id) {
    try {
      const status = await runAuthStatus(account.credential_namespace);
      if (status.appId) { account.app_id = status.appId; upsertAccount(account); }
    } catch { /* Missing credentials must never be guessed from the default app. */ }
  }
  return account;
}

async function fetchUserInfo(): Promise<UserInfo> {
  const data = envelopeData<UserInfo>(
    await runLarkCli(["api", "GET", "/open-apis/authen/v1/user_info"]),
  );
  return data;
}

function accountFrom(
  info: UserInfo,
  ns: string,
  userId: string,
  alias: string,
  appAlias?: string,
  appId?: string,
): AccountRecord {
  const ts = new Date().toISOString();
  return {
    // id 直接用凭证目录名：两者必须一致，否则 disconnect 会删错目录、留下残留
    id: path.basename(ns),
    user_id: userId,
    alias: alias || info.name || info.open_id,
    open_id: info.open_id,
    union_id: nonEmpty(info.union_id),
    tenant_key: nonEmpty(info.tenant_key),
    tenant_name: undefined,
    user_name: nonEmpty(info.name),
    avatar_url: nonEmpty(info.avatar_url),
    account_type: "user",
    status: "ready",
    app_alias: appAlias,
    app_id: appId,
    credential_namespace: ns,
    scopes: [],
    created_at: ts,
    updated_at: ts,
  };
}

interface NoWait {
  device_code: string;
  verification_url: string;
  expires_at?: string;
  expires_in?: number;
}

function parseNoWait(raw: string): NoWait | undefined {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const d = (obj.data && typeof obj.data === "object" ? obj.data : obj) as Record<string, unknown>;
  const device_code = typeof d.device_code === "string" ? d.device_code : undefined;
  const verification_url = typeof d.verification_url === "string" ? d.verification_url : undefined;
  if (!device_code || !verification_url) return undefined;
  const expires_in = typeof d.expires_in === "number" ? d.expires_in : undefined;
  const expires_at = typeof d.expires_at === "string" && Number.isFinite(Date.parse(d.expires_at)) ? d.expires_at : undefined;
  return { device_code, verification_url, expires_in, expires_at };
}

/**
 * 发起「连接新飞书账号」。返回授权链接后由后台轮询自动完成。
 * domains 为空时用默认身份域（docs/drive/base/sheets/wiki）。
 */
export async function startConnect(
  userId: string,
  domains: string[] | undefined,
  alias?: string,
  appAlias?: string,
  provisioned?: { accountId: string; appId: string },
): Promise<{ session_id: string; verification_url: string; expires_at: string }> {
  const useDomains = domains && domains.length ? domains : LOGIN_DOMAINS;
  if (provisioned && !/^fa_[a-f0-9]{12}$/.test(provisioned.accountId)) throw new Error("Invalid account namespace");
  const accountId = provisioned?.accountId ?? newAccountId();
  const ns = namespaceDir(accountId);

  // 指定应用（多组织）：用该应用模板的配置；否则用 base 默认应用
  let appId: string | undefined;
  if (provisioned) {
    appId = provisioned.appId;
  } else if (appAlias) {
    const app = getApp(appAlias);
    if (!app) {
      const known = listApps().map((a) => a.alias).join(", ") || "（无）";
      throw new Error(
        `未注册的飞书应用别名「${appAlias}」。已注册：${known}。先跑 scripts/05-register-app.sh 注册该组织的自建应用。`,
      );
    }
    seedAppConfig(accountId, appTemplateDir(appAlias));
    appId = app.app_id;
  } else {
    seedAppConfig(accountId);
  }

  const raw = await runWithContext({ userId, credentialNamespace: ns }, () =>
    runLarkCli(["auth", "login", "--domain", useDomains.join(","), "--no-wait", "--json"], {
      rawOutput: true,
      noIdentity: true,
      timeoutMs: 30_000,
    }),
  );
  const parsed = parseNoWait(String(raw));
  if (!parsed) {
    throw new Error(
      "发起飞书授权失败：lark-cli 未返回 verification_url。请确认已执行 01-inject-app-secret.sh 注入 App Secret。",
    );
  }

  const sessionId = newSessionId();
  const expiresAt = parsed.expires_at
    ? parsed.expires_at
    : new Date(Date.now() + (parsed.expires_in ?? 600) * 1000).toISOString();

  const session: OAuthSession = {
    id: sessionId,
    user_id: userId,
    device_code: parsed.device_code,
    verification_url: parsed.verification_url,
    credential_namespace: ns,
    alias: alias || undefined,
    app_alias: appAlias,
    app_id: appId,
    domains: useDomains,
    expires_at: expiresAt,
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  saveOAuthSession(session);
  appendAudit({ user_id: userId, action: "account_connect_start", success: true });

  // 后台轮询：不阻塞本次 MCP 返回
  void completeConnect(session);
  return { session_id: sessionId, verification_url: parsed.verification_url, expires_at: expiresAt };
}

async function completeConnect(session: OAuthSession): Promise<void> {
  const ctx = { userId: session.user_id, credentialNamespace: session.credential_namespace };
  try {
    await runWithContext(ctx, () =>
      runLarkCli(["auth", "login", "--device-code", session.device_code], {
        rawOutput: true,
        noIdentity: true,
        timeoutMs: 660_000,
      }),
    );

    // A cancelled/expired browser flow must not bind a later CLI completion.
    if (getOAuthSession(session.id)?.status !== "pending" || (session.expires_at && Date.parse(session.expires_at) <= Date.now())) {
      if (getOAuthSession(session.id)?.status === "pending") updateOAuthSession(session.id, { status: "expired", device_code: "" });
      removeNamespace(path.basename(session.credential_namespace));
      return;
    }

    const info = await runWithContext(ctx, fetchUserInfo);
    const auth = await runAuthStatus(session.credential_namespace);
    if (getOAuthSession(session.id)?.status !== "pending" || (session.expires_at && Date.parse(session.expires_at) <= Date.now())) {
      if (getOAuthSession(session.id)?.status === "pending") updateOAuthSession(session.id, { status: "expired", device_code: "" });
      removeNamespace(path.basename(session.credential_namespace));
      return;
    }
    const appId = session.app_id ?? auth.appId;

    // 防重复接入：同一 user 下 open_id + tenant_key 已存在则复用，只更新凭证目录
    for (const candidate of listAccounts(session.user_id)) {
      if (candidate.open_id === info.open_id && (candidate.tenant_key ?? "") === (info.tenant_key ?? "")) {
        await hydrateAccountAppId(candidate);
      }
    }
    // Recheck cancellation after potentially slow legacy credential inspection.
    if (getOAuthSession(session.id)?.status !== "pending" || (session.expires_at && Date.parse(session.expires_at) <= Date.now())) {
      if (getOAuthSession(session.id)?.status === "pending") updateOAuthSession(session.id, { status: "expired", device_code: "" });
      removeNamespace(path.basename(session.credential_namespace));
      return;
    }
    const dup = listAccounts(session.user_id).find(
      (a) => a.open_id === info.open_id && (a.tenant_key ?? "") === (info.tenant_key ?? "") && a.app_id === appId,
    );
    if (dup) {
      const previousNamespace = dup.credential_namespace;
      dup.credential_namespace = session.credential_namespace;
      dup.app_alias = session.app_alias;
      dup.app_id = appId;
      dup.status = "ready";
      if (session.alias) dup.alias = session.alias;
      dup.scopes = (auth.identities?.user?.scope ?? "").split(/\s+/).filter(Boolean);
      dup.token_expires_at = auth.identities?.user?.expiresAt;
      dup.updated_at = new Date().toISOString();
      upsertAccount(dup);
      updateOAuthSession(session.id, { status: "ready", account_id: dup.id, device_code: "" });
      if (previousNamespace !== session.credential_namespace) removeNamespace(path.basename(previousNamespace));
      return;
    }

    const acc = accountFrom(
      info,
      session.credential_namespace,
      session.user_id,
      session.alias || "",
      session.app_alias,
      appId,
    );
    acc.scopes = (auth.identities?.user?.scope ?? "").split(/\s+/).filter(Boolean);
    acc.token_expires_at = auth.identities?.user?.expiresAt;
    upsertAccount(acc);
    updateOAuthSession(session.id, { status: "ready", account_id: acc.id, device_code: "" });
    // 首个账号自动设为当前
    if (listAccounts(session.user_id).length === 1) setActiveAccount(session.user_id, acc.id);
    appendAudit({ user_id: session.user_id, feishu_account_id: acc.id, action: "account_connect", success: true });
  } catch (err) {
    updateOAuthSession(session.id, { status: "failed", error: "FEISHU_AUTH_FAILED", device_code: "" });
    removeNamespace(path.basename(session.credential_namespace));
    appendAudit({ user_id: session.user_id, action: "account_connect", success: false, error_code: "OAUTH_FAILED" });
  }
}

/**
 * 旧单账号登录态迁移：首次有请求进来时，把 base HOME 的登录态完整复制成一个
 * 账号并设为当前，老用户升级后无感（PRD §27）。全局只做一次。
 *
 * 用模块级 in-flight promise 做单飞：ChatGPT 首轮常并发多个请求，否则会同时
 * 迁移出两个同 open_id 的账号。
 */
let migrating: Promise<void> | undefined;

export function ensureMigrated(userId: string): Promise<void> {
  if (isMigrated()) return Promise.resolve();
  // 用户已有账号（自己 connect 过），迁移无意义，也避免每次工具调用都探测 base 登录
  if (listAccounts(userId).length > 0) return Promise.resolve();
  if (!migrating) {
    migrating = doMigrate(userId).finally(() => {
      migrating = undefined;
    });
  }
  return migrating;
}

async function doMigrate(userId: string): Promise<void> {
  if (isMigrated()) return;
  let status: AuthStatus;
  try {
    const raw = await runLarkCli(["auth", "status", "--json"], {
      rawOutput: true,
      noIdentity: true,
      timeoutMs: 15_000,
    });
    status = JSON.parse(String(raw)) as AuthStatus;
  } catch {
    return; // base 没有可用登录态，等用户走 feishu_account_connect
  }
  const user = status.identities?.user;
  if (!user || (user.status !== "ready" && user.status !== "needs_refresh")) return;

  const accountId = newAccountId();
  const ns = namespaceDir(accountId);
  try {
    seedFullCredentials(accountId);
    const info = await runWithContext({ userId, credentialNamespace: ns }, fetchUserInfo);
    const acc = accountFrom(info, ns, userId, "");
    acc.scopes = (user.scope ?? "").split(/\s+/).filter(Boolean);
    acc.token_expires_at = user.expiresAt;
    acc.app_id = status.appId; // 迁移的是 base 默认应用
    upsertAccount(acc);
    setActiveAccount(userId, acc.id);
    markMigrated();
    appendAudit({ user_id: userId, feishu_account_id: acc.id, action: "account_migrate", success: true });
  } catch (err) {
    // 迁移失败不要标记，下次请求再试（例如 base token 刚好过期）
    appendAudit({ user_id: userId, action: "account_migrate", success: false, error_code: "MIGRATE_FAILED" });
  }
}

/** 供 auth status 工具复用 base 登录检查 */
export { LOGIN_DOMAINS };
