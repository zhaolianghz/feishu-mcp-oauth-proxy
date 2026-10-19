/**
 * 工具调用中间件：所有 MCP 工具（上游 + 本仓库叠加）都从这里过。
 *
 * 职责（PRD §12 / §13 / §11）：
 *   1. 从请求头解析 ChatGPT 用户 / 连接身份（oauth-proxy 透传 x-oauth-user）
 *   2. 解析当前飞书账号，放进请求级上下文（凭证隔离的基础）
 *   3. 写工具：target_account_hint 与当前账号不一致时直接拒绝（V2.0 写入保护）
 *   4. 写操作统一返回 executed_as（代表谁、写到哪）
 */
import { z } from "zod";
import type { ToolDef, ToolResult } from "../tools/types.js";
import { runWithContext } from "./context.js";
import { findAccount, getAccount, resolveCurrentAccount, touchAccount } from "./store.js";
import { ensureMigrated } from "./oauth.js";
import { appendAudit } from "./audit.js";

/** 需要身份保护的写操作（PRD §10）。 */
const WRITE_TOOLS = new Set([
  "write_feishu_doc",
  "write_feishu_sheet",
  "write_feishu_base_records",
  "create_feishu_folder",
  "move_feishu_file",
  "rename_feishu_file",
]);

/** 账号管理工具：不需要「已有当前账号」，但要能读到 userId。 */
const ACCOUNT_TOOL_NAMES = new Set([
  "feishu_account_list",
  "feishu_account_current",
  "feishu_account_connect",
  "feishu_account_switch",
  "feishu_account_disconnect",
  "feishu_auth_status",
  "feishu_app_list",
  "feishu_get_profile",
]);

function headersOf(extra: unknown): Record<string, string> {
  const e = extra as
    | { requestInfo?: { headers?: Record<string, string | string[] | undefined> } }
    | undefined;
  const h = e?.requestInfo?.headers;
  if (!h) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k.toLowerCase()] = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
  }
  return out;
}

function errorResult(code: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: code, message, ...extra }, null, 2) }],
    isError: true,
  };
}

/** 给写工具的 inputSchema 追加可选 target_account_hint；其它工具原样返回。 */
export function augmentInputSchema(name: string, shape: z.ZodRawShape): z.ZodRawShape {
  if (!WRITE_TOOLS.has(name) || shape.target_account_hint) return shape;
  return {
    ...shape,
    target_account_hint: z
      .string()
      .optional()
      .describe(
        "可选：明确指定写入目标飞书账号（别名或 account_id）。若与当前账号不一致，本版本会拒绝写入，需先调用 feishu_account_switch 切换。",
      ),
  };
}

export async function dispatchTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  extra?: unknown,
): Promise<ToolResult> {
  const headers = headersOf(extra);
  const userId = headers["x-oauth-user"] || "local";
  const connectionId = headers["x-oauth-connection"] || undefined;
  const lockedAccountId = headers["x-oauth-account"] || undefined;

  // 旧单账号登录态首次请求时自动迁移
  if (!lockedAccountId) await ensureMigrated(userId);

  const account = lockedAccountId ? getAccount(userId, lockedAccountId) : resolveCurrentAccount(userId, connectionId);
  if (lockedAccountId && !account) {
    return errorResult("ACCOUNT_NOT_FOUND", "此连接绑定的飞书账号已断开，请从 ChatGPT 重新连接。");
  }
  if (lockedAccountId && tool.name === "feishu_account_switch") {
    return errorResult("ACCOUNT_CONNECTION_LOCKED", "此 ChatGPT 连接固定使用已授权账号。请在 ChatGPT 中选择另一个连接，或连接另一个账户。");
  }
  if (lockedAccountId && tool.name === "feishu_account_connect") {
    return errorResult("CONNECT_IN_CHATGPT_SETTINGS", "请在 ChatGPT 的 feishu-mcp 设置中点击「连接另一个账户」，通过浏览器完成应用接入和账号授权。当前连接保持原身份，账号备注不能决定组织归属。");
  }

  if (ACCOUNT_TOOL_NAMES.has(tool.name)) {
    return runWithContext({ userId, connectionId, lockedAccountId, account }, () => tool.handler(args));
  }

  if (!account) {
    return errorResult(
      "ACCOUNT_NOT_SELECTED",
      "当前未选择飞书账号。请先调用 feishu_account_connect 连接一个账号，或用 feishu_account_switch 切换。",
    );
  }

  if (WRITE_TOOLS.has(tool.name)) {
    const hint = typeof args.target_account_hint === "string" ? args.target_account_hint.trim() : "";
    if (hint) {
      const target = findAccount(userId, hint);
      if (!target) return errorResult("ACCOUNT_NOT_FOUND", `找不到目标账号：${hint}`);
      if (target.id !== account.id) {
        return errorResult("ACCOUNT_MISMATCH", "当前账号与指定的目标账号不一致，已阻止写入。请先切换账号。", {
          current_account: { account_id: account.id, alias: account.alias },
          requested_account: { account_id: target.id, alias: target.alias },
        });
      }
    }
  }

  const result = await runWithContext({ userId, connectionId, lockedAccountId, account }, () => tool.handler(args));
  touchAccount(account.id);

  if (WRITE_TOOLS.has(tool.name) && !result.isError) {
    appendAudit({
      user_id: userId,
      feishu_account_id: account.id,
      action: tool.name,
      success: true,
    });
    const executedAs = {
      account_id: account.id,
      alias: account.alias,
      user_name: account.user_name,
      tenant_name: account.tenant_name,
      tenant_key: account.tenant_key,
      app_id: account.app_id,
      open_id: account.open_id,
    };
    result.content = [
      ...result.content,
      { type: "text" as const, text: `\n\nexecuted_as: ${JSON.stringify(executedAs)}` },
    ];
  }
  return result;
}
