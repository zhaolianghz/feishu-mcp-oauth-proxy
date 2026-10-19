/**
 * 账号存储/解析的自检（node dist/identity/selfcheck.js 运行）。
 *
 * 覆盖 PRD §26 的 Unit 场景：当前账号解析、同名账号不串号、切换、缺绑定、
 * 连接级绑定优先级。这是纯逻辑测试，不碰网络/飞书。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-identity-selfcheck-"));
process.env.FEISHU_DATA_DIR = tmp;

const store = await import("./store.js");
const { runWithContext, credentialEnv, getContext } = await import("./context.js");

type AccountRecord = import("./context.js").AccountRecord;

function acc(id: string, userId: string, openId: string, alias: string): AccountRecord {
  const ts = new Date().toISOString();
  return {
    id,
    user_id: userId,
    alias,
    open_id: openId,
    tenant_key: "tk_" + openId,
    user_name: alias,
    account_type: "user",
    status: "ready",
    credential_namespace: path.join(tmp, "feishu-auth", id),
    scopes: [],
    created_at: ts,
    updated_at: ts,
  };
}

// 1) 空状态：未选择
assert.equal(store.resolveCurrentAccount("u1"), undefined, "空账号应返回未选择");

// 2) 两个同名「赵亮」，不同 open_id / tenant —— 不能串号
store.upsertAccount(acc("fa_a", "u1", "ou_personal", "赵亮"));
store.upsertAccount(acc("fa_b", "u1", "ou_company", "赵亮"));
assert.equal(store.listAccounts("u1").length, 2, "应有 2 个账号");

// 3) 两个账号且无绑定：未选择（不能瞎猜）
assert.equal(store.resolveCurrentAccount("u1"), undefined, "多账号无绑定应返回未选择");

// 4) user 级切换生效
store.setActiveAccount("u1", "fa_a");
assert.equal(store.resolveCurrentAccount("u1")?.id, "fa_a");

// 5) connection 级绑定：切换会记住为该用户默认，但 connection 级始终优先
store.setActiveAccount("u1", "fa_b", "conn1");
assert.equal(store.resolveCurrentAccount("u1", "conn1")?.id, "fa_b", "连接级绑定应生效");
store.setActiveAccount("u1", "fa_a"); // 显式把 user 默认设回 fa_a
assert.equal(store.resolveCurrentAccount("u1", "conn1")?.id, "fa_b", "连接级绑定应优先于 user 默认");
assert.equal(store.resolveCurrentAccount("u1")?.id, "fa_a", "未带连接的请求用 user 默认");

// 6) 隔离：不同 user 看不到对方账号
assert.equal(store.getAccount("u2", "fa_a"), undefined, "跨用户账号不可见");
assert.equal(store.resolveCurrentAccount("u2"), undefined);

// 7) 单账号自动选中
store.upsertAccount(acc("fa_c", "u2", "ou_x", "个人飞书"));
assert.equal(store.resolveCurrentAccount("u2")?.id, "fa_c", "仅一个账号应自动选中");

// 8) 断开后绑定清理
store.removeAccount("u1", "fa_b");
assert.equal(store.getAccount("u1", "fa_b"), undefined, "账号应被删除");
assert.equal(store.resolveCurrentAccount("u1", "conn1")?.id, "fa_a", "断开后连接绑定应回落 user 默认");

// 9) 凭证隔离：ALS 注入的 HOME 指向账号 namespace，且并发不串
await runWithContext({ userId: "u1", account: store.getAccount("u1", "fa_a") }, async () => {
  assert.equal(credentialEnv()?.HOME, path.join(tmp, "feishu-auth", "fa_a"));
});
const [h1, h2] = await Promise.all([
  runWithContext({ userId: "u1", account: store.getAccount("u1", "fa_a") }, async () => credentialEnv()?.HOME),
  runWithContext({ userId: "u2", account: store.getAccount("u2", "fa_c") }, async () => credentialEnv()?.HOME),
]);
assert.notEqual(h1, h2, "并发请求的凭证目录必须独立");
assert.equal(getContext(), undefined, "runWithContext 结束后上下文应清空");

// ===== 中间件层：身份解析 / 写入保护 / executed_as =====
const { dispatchTool, augmentInputSchema } = await import("./dispatch.js");
const { accountListTool } = await import("./account-tools.js");
import type { ToolDef } from "../tools/types.js";

function fakeExtra(userId: string, connId?: string) {
  const headers: Record<string, string> = { "x-oauth-user": userId };
  if (connId) headers["x-oauth-connection"] = connId;
  return { requestInfo: { headers } };
}

const fakeWrite: ToolDef = {
  name: "write_feishu_doc",
  title: "fake",
  description: "fake",
  inputSchema: {},
  handler: async () => ({ content: [{ type: "text" as const, text: "wrote" }] }),
};

// 当前账号解析：mw 默认 fa_m1
store.upsertAccount(acc("fa_m1", "mw", "ou_m1", "个人飞书"));
store.upsertAccount(acc("fa_m2", "mw", "ou_m2", "公司飞书"));
store.setActiveAccount("mw", "fa_m1");
const listed = await dispatchTool(accountListTool, {}, fakeExtra("mw"));
const listedJson = JSON.parse(listed.content[0].text) as { current_account_id: string; accounts: unknown[] };
assert.equal(listedJson.current_account_id, "fa_m1");
assert.equal(listedJson.accounts.length, 2);

// 写入保护：hint 指向另一个账号 → 拒绝，且不执行 handler
const blocked = await dispatchTool(fakeWrite, { target_account_hint: "fa_m2" }, fakeExtra("mw"));
assert.equal(blocked.isError, true, "不匹配的目标账号必须被拒绝");
assert.match(blocked.content[0].text, /ACCOUNT_MISMATCH/);

// hint 与当前账号一致 → 放行
const ok = await dispatchTool(fakeWrite, { target_account_hint: "fa_m1" }, fakeExtra("mw"));
assert.equal(ok.isError, undefined, "目标与当前一致应放行");

// executed_as 只在写工具成功时追加
const wrote = await dispatchTool(fakeWrite, {}, fakeExtra("mw"));
assert.match(wrote.content[wrote.content.length - 1].text, /executed_as/);

// schema 注入口：写工具加字段，读工具不加
assert.ok(augmentInputSchema("write_feishu_doc", {}).target_account_hint, "写工具应注入 target_account_hint");
assert.equal(Object.keys(augmentInputSchema("read_feishu_doc", {})).length, 0, "读工具不应注入");

// 无账号用户：应提示未选择（ensureMigrated 在无 lark-cli 时静默返回）
const none = await dispatchTool(fakeWrite, {}, fakeExtra("user-no-account"));
assert.equal(none.isError, true);
assert.match(none.content[0].text, /ACCOUNT_NOT_SELECTED/);

// ===== 多组织应用注册表 =====
const apps = await import("./apps.js");
apps.registerApp("公司", "cli_company");
assert.equal(apps.getApp("公司")?.app_id, "cli_company");
assert.equal(apps.listApps().length, 1);
assert.equal(apps.getApp("../etc"), undefined, "路径穿越别名应无效");
assert.throws(() => apps.registerApp("a/b", "x"), "含 / 的别名应被拒绝");
assert.equal(apps.appTemplateDir("公司"), path.join(tmp, "feishu-apps", "公司"));

fs.rmSync(tmp, { recursive: true, force: true });
console.log("✅ identity selfcheck passed");