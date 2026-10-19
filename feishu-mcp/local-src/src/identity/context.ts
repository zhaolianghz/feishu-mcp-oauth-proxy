/**
 * 请求级身份上下文（AsyncLocalStorage）。
 *
 * 为什么不能用模块级全局变量存「当前账号」：MCP HTTP 是并发的，多个 ChatGPT
 * 会话会同时调用工具，全局变量会在并发下串号（PRD §20）。每次工具调用由
 * dispatch 用 runWithContext 包一层；larkCli 从 ALS 取 credential namespace，
 * 注入子进程 HOME，从而让每个账号的 lark-cli 凭证完全隔离。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";

/** 一个已绑定的飞书身份（PRD §5 数据模型 feishu_accounts 的运行时形态）。 */
export interface AccountRecord {
  id: string;
  user_id: string;
  alias: string;
  open_id: string;
  union_id?: string;
  tenant_key?: string;
  tenant_name?: string;
  user_name?: string;
  avatar_url?: string;
  account_type: string;
  status: string;
  /** 该账号用的飞书应用（多组织时每个组织一个自建应用）；缺省=base 默认应用 */
  app_alias?: string;
  app_id?: string;
  /** 该账号独立的 lark-cli HOME 目录，绝对路径 */
  credential_namespace: string;
  scopes: string[];
  token_expires_at?: string;
  created_at: string;
  updated_at: string;
  last_used_at?: string;
}

export interface RequestContext {
  userId: string;
  connectionId?: string;
  /** OAuth grant 固定的账号；不得被工具切换或默认绑定替换。 */
  lockedAccountId?: string;
  account?: AccountRecord;
  /** 显式指定的凭证目录：后台 OAuth 轮询时账号还未创建，只有 namespace */
  credentialNamespace?: string;
}

const als = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext | undefined {
  return als.getStore();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T | Promise<T>): Promise<T> {
  return als.run(ctx, async () => fn());
}

function namespaceOf(ctx: RequestContext | undefined): string | undefined {
  return ctx?.account?.credential_namespace ?? ctx?.credentialNamespace;
}

/**
 * 供 larkCli 注入子进程环境。无活动账号时返回 undefined，spawn 沿用进程默认
 * HOME（首次迁移、base 登录检查等场景需要走默认凭证）。
 */
export function credentialEnv(): NodeJS.ProcessEnv | undefined {
  const ns = namespaceOf(als.getStore());
  if (!ns) return undefined;
  return {
    ...process.env,
    HOME: ns,
    XDG_DATA_HOME: path.join(ns, ".local", "share"),
  };
}

/** 未隔离的基础凭证所在 HOME；迁移旧登录态、复制 App Secret 时用。 */
export const BASE_HOME = process.env.HOME || os.homedir();

/** 凭证根目录：base HOME 下的 lark-cli 数据目录 */
export function baseSecretDir(): string {
  return path.join(process.env.XDG_DATA_HOME || path.join(BASE_HOME, ".local", "share"), "lark-cli");
}
