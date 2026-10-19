/**
 * 账号管理 MCP 工具（PRD §7）：list / current / connect / switch / disconnect /
 * auth_status。这些工具本身不调飞书业务接口，只操作账号绑定与凭证目录。
 */
import { z } from "zod";
import { jsonResult, type ToolDef } from "../tools/types.js";
import { getContext, type AccountRecord } from "./context.js";
import {
  getAccount,
  listAccounts,
  removeAccount,
  resolveCurrentAccount,
  setActiveAccount,
  upsertAccount,
} from "./store.js";
import { removeNamespace } from "./namespaces.js";
import { LOGIN_DOMAINS, runAuthStatus, startConnect } from "./oauth.js";
import { listApps } from "./apps.js";
import { appendAudit } from "./audit.js";

function ctx() {
  const c = getContext();
  if (!c) throw new Error("缺少请求上下文（内部错误）");
  return c;
}

/** PRD §8：账号展示至少包含 alias / user_name / tenant / open_id。 */
function present(a: AccountRecord, isActive: boolean) {
  return {
    account_id: a.id,
    alias: a.alias,
    user_name: a.user_name,
    open_id: a.open_id,
    tenant_key: a.tenant_key,
    tenant_name: a.tenant_name,
    account_type: a.account_type,
    app_alias: a.app_alias,
    app_id: a.app_id,
    is_active: isActive,
    status: a.status,
    token_expires_at: a.token_expires_at,
  };
}

export const accountListTool: ToolDef = {
  name: "feishu_account_list",
  title: "列出已连接的飞书账号",
  description:
    "列出当前 ChatGPT 用户已绑定的所有飞书账号，并标出当前账号。切换/写入前先用它确认 account_id 与 alias，避免写错组织。",
  inputSchema: {},
  handler: async () => {
    const c = ctx();
    const current = c.account ?? resolveCurrentAccount(c.userId, c.connectionId);
    const accounts = listAccounts(c.userId).map((a) => present(a, a.id === current?.id));
    return jsonResult({ count: accounts.length,
      organization_count: new Set(accounts.map((a) => a.tenant_key).filter(Boolean)).size,
      identity_note: "账号记录数不代表组织数。请根据 tenant_key 判断组织，根据 app_id、open_id 和 tenant_key 判断是否同一身份；账号备注不是身份凭据。",
      current_account_id: current?.id, accounts });
  },
};

export const accountCurrentTool: ToolDef = {
  name: "feishu_account_current",
  title: "当前飞书账号",
  description:
    "实时解析并返回当前所有飞书工具真正会使用的身份（不是缓存）。执行读写前可用它确认「我现在代表谁」。",
  inputSchema: {},
  handler: async () => {
    const c = ctx();
    const current = c.account ?? resolveCurrentAccount(c.userId, c.connectionId);
    if (!current) {
      return jsonResult({
        error: "ACCOUNT_NOT_SELECTED",
        message: "当前未选择飞书账号。请用 feishu_account_connect 连接，或 feishu_account_switch 切换。",
      });
    }
    return jsonResult({ current_account: present(current, true) });
  },
};

export const accountConnectTool: ToolDef = {
  name: "feishu_account_connect",
  title: "连接新的飞书账号",
  description:
    "ChatGPT 中请在 feishu-mcp 设置点击「连接另一个账户」，通过浏览器接入应用并授权个人或企业身份。此工具只供未固定身份的旧客户端发起 device flow；省略 app 会使用默认应用，账号备注不会改变组织。",
  inputSchema: {
    domains: z
      .array(z.string())
      .optional()
      .describe(`要申请的权限域，默认 ${LOGIN_DOMAINS.join(",")}；可选值见 lark-cli auth login --help`),
    alias: z.string().optional().describe("可选：给该账号起个别名，如「个人飞书」「公司飞书」"),
    app: z
      .string()
      .optional()
      .describe("可选：用哪个已注册的飞书应用（组织）授权，取值见 feishu_app_list；缺省用默认应用"),
  },
  handler: async (args) => {
    const c = ctx();
    const domains = Array.isArray(args.domains) ? (args.domains as string[]) : undefined;
    const alias = typeof args.alias === "string" ? args.alias : undefined;
    const app = typeof args.app === "string" ? args.app : undefined;
    const r = await startConnect(c.userId, domains, alias, app);
    return jsonResult({
      auth_session_id: r.session_id,
      verification_url: r.verification_url,
      expires_at: r.expires_at,
      next: "把 verification_url 发给用户，在浏览器完成授权；随后 feishu_account_list 即可看到新账号。",
    });
  },
};

export const accountSwitchTool: ToolDef = {
  name: "feishu_account_switch",
  title: "切换当前飞书账号",
  description:
    "把当前账号切换为指定 account_id（来自 feishu_account_list）。切换后所有飞书读写都代表该身份；写入前务必确认，防止跨组织误写。",
  inputSchema: {
    account_id: z.string().describe("目标账号 account_id（feishu_account_list 返回）"),
  },
  handler: async (args) => {
    const c = ctx();
    const accountId = String(args.account_id);
    const target = getAccount(c.userId, accountId);
    if (!target) {
      return jsonResult({ error: "ACCOUNT_NOT_FOUND", message: `账号不存在：${accountId}` });
    }
    setActiveAccount(c.userId, accountId, c.connectionId);
    // 二次读取验证（PRD §5.3）
    const verified = resolveCurrentAccount(c.userId, c.connectionId);
    appendAudit({ user_id: c.userId, feishu_account_id: accountId, action: "account_switch", success: true });
    return jsonResult({
      success: verified?.id === accountId,
      current_account: verified ? present(verified, true) : undefined,
    });
  },
};

export const accountDisconnectTool: ToolDef = {
  name: "feishu_account_disconnect",
  title: "断开飞书账号",
  description:
    "断开并删除指定账号：移除绑定、删除其独立凭证目录与 refresh token。断开后该账号的飞书读写立即失效。",
  inputSchema: {
    account_id: z.string().describe("要断开的 account_id"),
  },
  handler: async (args) => {
    const c = ctx();
    const accountId = String(args.account_id);
    const target = getAccount(c.userId, accountId);
    if (!target) {
      return jsonResult({ error: "ACCOUNT_NOT_FOUND", message: `账号不存在：${accountId}` });
    }
    const wasCurrent = resolveCurrentAccount(c.userId, c.connectionId)?.id === accountId;
    removeAccount(c.userId, accountId);
    removeNamespace(target.credential_namespace.split(/[\\/]/).pop()!);
    if (target.credential_namespace.split(/[\\/]/).pop() !== accountId) removeNamespace(accountId);
    // 若断开的正是当前账号，从剩余账号里重新选一个，避免悬空绑定
    const remaining = listAccounts(c.userId);
    if (wasCurrent && remaining.length) setActiveAccount(c.userId, remaining[0].id, c.connectionId);
    appendAudit({ user_id: c.userId, feishu_account_id: accountId, action: "account_disconnect", success: true });
    return jsonResult({ success: true, disconnected: present(target, false), remaining: remaining.length });
  },
};

export const authStatusTool: ToolDef = {
  name: "feishu_auth_status",
  title: "飞书授权状态",
  description:
    "查看某个账号（默认当前账号）的 OAuth 授权是否可用：token 是否有效、权限范围、过期时间、用户与组织。授权失效时用 feishu_account_connect 重新授权。",
  inputSchema: {
    account_id: z.string().optional().describe("要查询的 account_id，省略则查当前账号"),
  },
  handler: async (args) => {
    const c = ctx();
    const accountId = typeof args.account_id === "string" ? args.account_id : undefined;
    const account = accountId
      ? getAccount(c.userId, accountId)
      : c.account ?? resolveCurrentAccount(c.userId, c.connectionId);
    if (!account) {
      return jsonResult({
        error: accountId ? "ACCOUNT_NOT_FOUND" : "ACCOUNT_NOT_SELECTED",
        message: accountId ? `账号不存在：${accountId}` : "当前未选择飞书账号。",
      });
    }
    try {
      const status = await runAuthStatus(account.credential_namespace, true);
      const user = status.identities?.user;
      const ready = !!user && (user.status === "ready" || user.status === "needs_refresh");
      // 回写最新状态
      const fresh = getAccount(c.userId, account.id);
      if (fresh) {
        fresh.status = ready ? "ready" : "expired";
        fresh.scopes = (user?.scope ?? "").split(/\s+/).filter(Boolean);
        fresh.token_expires_at = user?.expiresAt;
        fresh.updated_at = new Date().toISOString();
        upsertAccount(fresh);
      }
      return jsonResult({
        account: present(fresh ?? account, true),
        oauth_available: ready,
        token_status: user?.status,
        token_expires_at: user?.expiresAt,
        scope: user?.scope,
        app_id: status.appId,
        brand: status.brand,
        fix: ready
          ? undefined
          : "该账号授权已失效，请调用 feishu_account_connect 重新授权。",
      });
    } catch (err) {
      return jsonResult({
        account: present(account, true),
        oauth_available: false,
        error: "AUTH_INVALID",
        message: (err as Error).message,
        fix: "该账号授权不可用，请调用 feishu_account_connect 重新授权。",
      });
    }
  },
};

export const appListTool: ToolDef = {
  name: "feishu_app_list",
  title: "已注册的飞书应用（组织）",
  description:
    "列出旧客户端已配置的飞书应用模板（不含密钥）；不是所有浏览器接入应用的完整列表。ChatGPT 连接个人或其他组织时，请使用设置中的「连接另一个账户」，无需在服务器运行脚本。",
  inputSchema: {},
  handler: async () => jsonResult({ apps: listApps() }),
};

export const ACCOUNT_TOOLS: ToolDef[] = [
  accountListTool,
  accountCurrentTool,
  accountConnectTool,
  accountSwitchTool,
  accountDisconnectTool,
  authStatusTool,
  appListTool,
  {
    name: "feishu_get_profile",
    title: "当前连接的飞书身份",
    description: "返回此连接所代表的唯一飞书账号，供 ChatGPT 区分个人与企业账户。",
    inputSchema: {},
    handler: async () => {
      const c = ctx();
      const a = c.account ?? resolveCurrentAccount(c.userId, c.connectionId);
      if (!a) return { ...jsonResult({ error: "ACCOUNT_NOT_SELECTED" }), isError: true };
      const profile = { id: a.id, name: a.user_name || a.alias, nickname: a.alias };
      return { ...jsonResult(profile), structuredContent: profile };
    },
  },
];
