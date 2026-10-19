# 多账号身份（Identity & Multi-Account V2.0）

解决「一个 ChatGPT 用户绑定多个飞书身份、且互不串号」的问题，对应文档包
`01-多账号-OAuth-PRD` / `02-Identity-技术架构设计`。

## 一句话架构

```
ChatGPT ──OAuth──► oauth-proxy ──x-oauth-user/x-oauth-connection──► feishu-mcp
                                                                      │
                                          identity/dispatch（请求级上下文）
                                                                      │
                                          lark-cli（HOME=该账号的凭证目录）
                                                                      │
                                                                   飞书 API
```

## 代码位置

全部在叠加层 `feishu-mcp/local-src/src/identity/`，不动上游源码：

| 文件 | 职责 |
|---|---|
| `context.ts` | AsyncLocalStorage 请求上下文；`credentialEnv()` 注入子进程 HOME |
| `store.ts` | 账号 / 绑定 / OAuth 会话持久化（JSON 单文件 + 原子写） |
| `namespaces.ts` | 账号凭证目录创建 / 复制 App 配置 / 删除 |
| `oauth.ts` | device flow 接入、后台轮询、旧登录态迁移 |
| `dispatch.ts` | 工具中间件：身份解析、账号解析、写入保护、`executed_as` |
| `account-tools.ts` | 6 个账号管理 MCP 工具 + `feishu_app_list` |
| `apps.ts` | 多组织应用注册表（别名 → appId，模板命名空间） |
| `audit.ts` | JSONL 审计（不记正文/token） |
| `selfcheck.ts` | 纯逻辑自检（`node dist/identity/selfcheck.js`） |

补丁在 `deploy/patch-local-tools.sh`：给 `index.ts` 注入中间件、给 `larkCli.ts`
注入 `HOME`，各自独立 done_mark，旧环境可增量打上。

## 多组织（一个人 / 不同企业）

### 正常入口：ChatGPT 设置 → 连接另一个账户

浏览器登录门后总会出现账号选择页，不会因为已有代理登录态而直接签发 token。
选择已有账号，或前往飞书官方页面接入个人/其他组织下的已有应用；系统通过官方
`/oauth/v1/app/registration` begin/poll 流程接收应用凭据，随后完成用户 device OAuth。
不设置 `createOnly`；可选 App ID 通过 `clientID` 定位已有应用。不向浏览器或聊天返回 Secret。

每个 OAuth grant 单独生成 `connection_id` 并绑定 `feishu_account_id`，刷新保持不变。
代理覆盖 `x-oauth-user`、`x-oauth-connection`、`x-oauth-account`，后端只从校验后的账号
记录读取凭证。固定账号被删除时拒绝访问，不回落另一账号。`feishu_get_profile` 的稳定
ID 与昵称让 ChatGPT 区分连接；账号切换通过 ChatGPT 的连接选择完成。

内部 `POST /internal/identity` 只在上游容器开放，要求服务器 Bearer 凭据；公开代理不转发
此路径。浏览器流程绑定 session/用户/CSRF、处理超时和取消。应用接入凭据仅在服务端
内存及 lark-cli 独立凭证目录中流转。企业审批和实际个人身份可用范围仍由飞书决定。

### 兼容入口：运维预注册应用 + 聊天工具

飞书**自建应用只属于一个组织**，所以接不同组织必须**每组织一个自建应用**：

1. 在目标组织下创建自建应用，拿到 `app_id` / `app_secret`
2. 服务端注册（secret 只经 stdin，不进聊天/历史）：
   ```bash
   sudo bash scripts/05-register-app.sh 公司 cli_xxxxxxxx
   ```
   该脚本在模板命名空间 `/data/feishu-apps/公司/` 用 `lark-cli config init` 把 App 配置
   **加密**落盘，并登记 别名 → appId。
3. ChatGPT 里：`feishu_app_list` 看别名 → `feishu_account_connect({ app: "公司", alias: "公司飞书" })`
   → 打开授权链接（此时登录/选择该组织的账号）→ 完成后账号列表会区分 app 别名。

未指定 `app` 时用 base 默认应用（原行为，向后兼容）。

## 身份来源

oauth-proxy 在反代 `/mcp` 时透传两个请求头：

- `x-oauth-user`：登录门/GitHub 用户（`github:<user>`）
- `x-oauth-connection`：DCR `client_id`，作为 connection id

feishu-mcp 侧从 MCP SDK 的 `extra.requestInfo.headers` 读取（HTTP 传输自动携带）。

## 凭证隔离原理

lark-cli 的落盘位置全部相对 `$HOME`（已在容器内验证）：

```
$HOME/.lark-cli/config.json                  App 配置
$HOME/.local/share/lark-cli/master.key       加密主密钥
$HOME/.local/share/lark-cli/appsecret_*.enc  App Secret（密文）
$HOME/.local/share/lark-cli/cli_*_<openid>.enc  用户 token（密文）
```

所以每个账号给一个独立 `HOME` 即完全隔离。**新账号只复制 App 配置
（`config.json` + `master.key` + `appsecret_*.enc`），绝不复制用户 token** ——
复制了就正好是多账号串号的根因。

## 存储布局（宿主机）

```
feishu-accounts/                 ← bind mount → 容器 /data（uid 1000）
├── identity.json                账号 / 绑定 / OAuth 会话
├── audit.jsonl                  审计
└── feishu-auth/<fa_xxx>/        每个账号一个凭证命名空间（= lark-cli HOME）
```

`docker-compose.yml` 里新增 `./feishu-accounts:/data` 与 `FEISHU_DATA_DIR=/data`；
`deploy.sh` / `preflight.sh` 负责建目录并设 uid 1000。

## 旧连接的当前账号解析顺序

```
connection 级绑定 → user 默认绑定 → 仅一个账号则自动选中 → 否则 ACCOUNT_NOT_SELECTED
```

所有请求从存储解析，不用模块级「当前账号」变量，因此并发不串号。

## 写入保护

写工具（`write_feishu_doc` / `write_feishu_sheet` / `write_feishu_base_records` /
`create_feishu_folder` / `move_feishu_file` / `rename_feishu_file`）的 schema 由
中间件追加可选 `target_account_hint`。hint 解析出的账号与当前账号不一致时返回
`ACCOUNT_MISMATCH` 并拒绝执行；成功写入统一在结果尾部追加：

```
executed_as: {"account_id":"fa_…","alias":"…","user_name":"…","tenant_name":…,"open_id":"ou_…"}
```

## 旧登录态迁移

首次有请求进来且用户还没有任何账号时，把 base HOME 的旧单账号登录态**完整复制**
成一个命名空间并设为当前（含用户 token），老用户升级后无需重新授权。全局只做一次；
用户自行 connect 过则跳过。

## 与 PRD 的差异（有意为之）
- **未用 SQL，改用 JSON 状态文件**：V2.0 单实例、凭证本来就落盘，引入 sqlite 只会多
  原生依赖与迁移负担；PRD 也把 DB/KMS 放在 V3。字段命名沿用 PRD 的 snake_case，
  日后迁表无痛。
- **未做 Web 管理台 / REST API（Phase 6 / §15）**：DoD 未要求 UI，交互全在
  ChatGPT 侧通过 MCP 工具完成。需要时可在此之上加 `GET /api/accounts` 等。
- **`tenant_name` 暂缺**：lark-cli 的 user token 查不到租户名（`tenant/v2/tenant/query`
  需要 tenant token），先存 `tenant_key`，别名由用户或昵称承担展示。

## 自测

完整本地验证（在临时上游 checkout 中构建，不修改部署目录）：

```bash
bash scripts/test-browser-connect.sh
```

覆盖浏览器选择、同客户端多 grant 隔离、刷新、CSRF/session/用户边界、应用接入/用户授权
拒绝与过期、重新授权的稳定 ID、实际 MCP HTTP profile、内部 API 鉴权，以及部署补丁幂等。
飞书外部边界使用可控测试响应；真实个人/企业登录需上线后在浏览器验收。

仅运行原有身份逻辑自检：

```bash
cd feishu-mcp && npx tsc && node dist/identity/selfcheck.js
```

覆盖：当前账号解析、同名账号不串号、连接级绑定优先级、跨用户隔离、并发凭证目录独立、
写入保护（ACCOUNT_MISMATCH）、`executed_as` 注入。

## 验收对照（PRD §17）

| Case | 验证方式 |
|---|---|
| 绑定两个账号 | `feishu_account_list` → 2 条 |
| 切换账号 | `feishu_account_switch` → `feishu_account_current` |
| 分别建文档并归属正确 | 各自 `write_feishu_doc` 看 `executed_as` + 文档落在对应空间 |
| 同名「赵亮」不串号 | 各自 `feishu_account_current` 的 `open_id` 不同 |
| 一个 token 过期不影响另一个 | 各自 `feishu_auth_status` 独立返回 |
| 指定非当前账号写入 | 带 `target_account_hint` 的写工具 → `ACCOUNT_MISMATCH` |
