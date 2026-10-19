/**
 * 多账号状态持久化（JSON 单文件 + 原子写）。
 *
 * PRD 技术设计给的是 SQL 表结构，但 V2.0 是单实例、凭证本来就以文件落在磁盘
 * （lark-cli keychain），引入 sqlite/DB 只会多一个原生依赖和迁移负担。这里用一个
 * 与表结构一一对应的 JSON 状态文件，等 V3 上 KMS/多实例时再换 DB。字段命名沿用
 * PRD 的 snake_case，方便日后无痛迁表。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AccountRecord } from "./context.js";

export interface BindingRecord {
  user_id: string;
  connection_id?: string;
  feishu_account_id: string;
  updated_at: string;
}

export interface OAuthSession {
  id: string;
  user_id: string;
  device_code: string;
  verification_url: string;
  credential_namespace: string;
  alias?: string;
  /** 使用的飞书应用（多组织）；缺省=base 默认应用 */
  app_alias?: string;
  app_id?: string;
  /** 完成后实际绑定的账号；浏览器凭据据此固定身份。 */
  account_id?: string;
  expires_at?: string;
  domains: string[];
  status: "pending" | "ready" | "failed" | "expired";
  error?: string;
  created_at: string;
  updated_at: string;
}

interface State {
  version: number;
  /** 旧 base 登录是否已迁移进多账号体系（全局一次） */
  migrated: boolean;
  accounts: AccountRecord[];
  bindings: BindingRecord[];
  oauth_sessions: OAuthSession[];
}

const EMPTY: State = { version: 1, migrated: false, accounts: [], bindings: [], oauth_sessions: [] };

let cache: State | undefined;

export function dataDir(): string {
  return process.env.FEISHU_DATA_DIR || "/data";
}

function stateFile(): string {
  return path.join(dataDir(), "identity.json");
}

function now(): string {
  return new Date().toISOString();
}

export function newAccountId(): string {
  return "fa_" + crypto.randomBytes(6).toString("hex");
}

export function newSessionId(): string {
  return "fas_" + crypto.randomBytes(6).toString("hex");
}

function load(): State {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(stateFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    // 缺字段的旧文件补齐，避免升级后 undefined.map 崩
    cache = {
      version: parsed.version ?? 1,
      migrated: parsed.migrated ?? false,
      accounts: parsed.accounts ?? [],
      bindings: parsed.bindings ?? [],
      oauth_sessions: parsed.oauth_sessions ?? [],
    };
  } catch {
    cache = structuredClone(EMPTY);
  }
  return cache;
}

function save(): void {
  const st = load();
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = stateFile() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, stateFile());
}

/** 仅供测试重置内存缓存 */
export function _resetCache(): void {
  cache = undefined;
}

// ===== accounts =====

export function listAccounts(userId: string): AccountRecord[] {
  return load()
    .accounts.filter((a) => a.user_id === userId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function getAccount(userId: string, accountId: string): AccountRecord | undefined {
  return load().accounts.find((a) => a.user_id === userId && a.id === accountId);
}

export function findAccount(userId: string, aliasOrId: string): AccountRecord | undefined {
  const key = aliasOrId.trim();
  const mine = listAccounts(userId);
  return (
    mine.find((a) => a.id === key) ||
    mine.find((a) => a.alias === key) ||
    // 退化匹配：用户说「台州传媒」而 alias 是「客户-台州传媒」
    mine.find((a) => a.alias.includes(key) || key.includes(a.alias))
  );
}

export function upsertAccount(acc: AccountRecord): AccountRecord {
  const st = load();
  const idx = st.accounts.findIndex((a) => a.id === acc.id);
  if (idx >= 0) st.accounts[idx] = acc;
  else st.accounts.push(acc);
  save();
  return acc;
}

export function touchAccount(accountId: string): void {
  const st = load();
  const acc = st.accounts.find((a) => a.id === accountId);
  if (acc) {
    acc.last_used_at = now();
    acc.updated_at = now();
    save();
  }
}

export function removeAccount(userId: string, accountId: string): void {
  const st = load();
  st.accounts = st.accounts.filter((a) => !(a.user_id === userId && a.id === accountId));
  st.bindings = st.bindings.filter((b) => b.feishu_account_id !== accountId);
  save();
}

// ===== active binding =====

function findBinding(userId: string, connectionId?: string): BindingRecord | undefined {
  const binds = load().bindings;
  if (connectionId) {
    const scoped = binds.find((b) => b.user_id === userId && b.connection_id === connectionId);
    if (scoped) return scoped;
  }
  return binds.find((b) => b.user_id === userId && !b.connection_id);
}

/**
 * 解析当前账号（PRD §10）：
 *   connection 级绑定 → user 默认绑定 → 只有一个账号则自动选中 → 否则未选择。
 */
export function resolveCurrentAccount(userId: string, connectionId?: string): AccountRecord | undefined {
  const bind = findBinding(userId, connectionId);
  if (bind) {
    const acc = getAccount(userId, bind.feishu_account_id);
    if (acc) return acc;
  }
  const mine = listAccounts(userId);
  return mine.length === 1 ? mine[0] : undefined;
}

export function setActiveAccount(userId: string, accountId: string, connectionId?: string): void {
  const st = load();
  if (connectionId) {
    const i = st.bindings.findIndex((b) => b.user_id === userId && b.connection_id === connectionId);
    const rec: BindingRecord = { user_id: userId, connection_id: connectionId, feishu_account_id: accountId, updated_at: now() };
    if (i >= 0) st.bindings[i] = rec;
    else st.bindings.push(rec);
    // 同时也更新 user 默认绑定：新连接继承最近一次选择，避免每开新连接都要重选
    const j = st.bindings.findIndex((b) => b.user_id === userId && !b.connection_id);
    if (j >= 0) st.bindings[j] = { user_id: userId, feishu_account_id: accountId, updated_at: now() };
    else st.bindings.push({ user_id: userId, feishu_account_id: accountId, updated_at: now() });
  } else {
    const j = st.bindings.findIndex((b) => b.user_id === userId && !b.connection_id);
    if (j >= 0) st.bindings[j] = { user_id: userId, feishu_account_id: accountId, updated_at: now() };
    else st.bindings.push({ user_id: userId, feishu_account_id: accountId, updated_at: now() });
  }
  save();
}

// ===== migration flag =====

export function isMigrated(): boolean {
  return load().migrated;
}

export function markMigrated(): void {
  load().migrated = true;
  save();
}

// ===== oauth sessions =====

export function saveOAuthSession(s: OAuthSession): void {
  const st = load();
  const i = st.oauth_sessions.findIndex((x) => x.id === s.id);
  if (i >= 0) st.oauth_sessions[i] = s;
  else st.oauth_sessions.push(s);
  // 只保留最近 20 条，防止无限增长
  st.oauth_sessions = st.oauth_sessions.slice(-20);
  save();
}

export function updateOAuthSession(id: string, patch: Partial<OAuthSession>): void {
  const st = load();
  const s = st.oauth_sessions.find((x) => x.id === id);
  if (!s) return;
  Object.assign(s, patch, { updated_at: now() });
  save();
}

export function getOAuthSession(id: string): OAuthSession | undefined {
  return load().oauth_sessions.find((s) => s.id === id);
}

export function listOAuthSessions(userId: string): OAuthSession[] {
  return load().oauth_sessions.filter((s) => s.user_id === userId);
}
