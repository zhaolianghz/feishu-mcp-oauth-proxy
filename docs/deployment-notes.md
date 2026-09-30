# feishu-mcp · OAuth 2.1 中间件

> 让 [feishu-mcp](https://github.com/feifan2024/feishu_mcp) 能被 **ChatGPT 自定义连接器**接入。
> ChatGPT 只支持 OAuth 2.1 + DCR 或 No Auth，不接受静态 token —— 本仓库是补上这层 OAuth 的中间件。

> [!NOTE]
> **这是原始部署交接笔记（归档，供参考）。**
> 里面的路径（`/opt/feishu-mcp`）、文件名（`oauth-proxy/server.js`）是原始服务器上的实际布局，
> **与当前仓库的目录结构不一致**。请以根目录 [README](../README.md) 为准。
>
> 已知差异：
> - 中间件源码现为 `feishu-mcp-oauth/oauth-proxy-server.js`（原为 `oauth-proxy/server.js`）
> - 部署目录不固定，脚本会自动向上定位仓库根目录
> - 凭证与密码门统一改由 `.env` 注入

## ⚠️ 关于本仓库的敏感值

本仓库是**脱敏版**，所有凭证均已替换为占位符：

| 占位符 | 含义 | 真实值获取方式 |
|---|---|---|
| `<LOGIN_PASSWORD>` | 登录门密码 | 你的 `docker-compose.yml` |
| `<MCP_HTTP_TOKEN>` | oauth-proxy 调上游的 Bearer | 你的 `docker-compose.yml`（两边须一致） |
| `<SESSION_SECRET>` | session 密钥 | `openssl rand -hex 32` |
| `<FEISHU_APP_ID>` | 飞书应用 ID | 飞书开放平台 |
| `<SERVER_IP>` | 服务器地址 | 你自己的 |
| `mcp.example.com` | 对外域名 | 你自己的 |

**部署时请在 `.env` 或 `docker-compose.yml` 中填入真实值，不要提交到版本库。**

## 快速开始

```bash
cd feishu-mcp-oauth
npm install --omit=dev
LOGIN_PASSWORD=<你的密码> \
SESSION_SECRET=$(openssl rand -hex 32) \
MCP_HTTP_TOKEN=<你的token> \
UPSTREAM=http://127.0.0.1:3000 \
ALLOWED_HOSTS=mcp.example.com \
node server.js
```

反代配置见 `feishu-mcp-oauth/nginx-feishu-mcp.conf`（记得把 `server_name` 和证书路径换成你自己的）。

端到端验证：`python3 flow-test.py`（需 `LOGIN_PASSWORD` 环境变量）。

## 实现的端点

| 端点 | 规范 | 说明 |
|---|---|---|
| `/.well-known/oauth-protected-resource` | RFC 9728 | 受保护资源元数据 |
| `/.well-known/oauth-authorization-server` | RFC 8414 | 授权服务器元数据 |
| `/.well-known/oauth-authorization-server/<path>` | RFC 8414 | 带 issuer 路径段 |
| `/.well-known/openid-configuration` | OIDC | **兼容别名，ChatGPT 会探** |
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 | 带资源路径 |
| `POST /register` | RFC 7591 | 动态客户端注册（DCR） |
| `GET /authorize` | OAuth 2.1 | PKCE 授权（强制 S256） |
| `POST /token` | OAuth 2.1 | 换 token / 刷新 |
| `POST /introspect` | RFC 7662 | token 内省 |
| `GET /login` `POST /login/demo` | - | 密码门 |
| `ALL /mcp` | Streamable HTTP | 反代到上游 MCP |

## ⚠️ 踩坑记录（都是实测踩出来的）

1. **域名绝不能带下划线** —— `_` 违反 RFC 1123，新版 OpenSSL 对 `*.example.com` 的通配符匹配直接判不匹配 → 严格 TLS 客户端全部握手失败（Node 22 侥幸宽松，Python/OpenSSL 3.5 失败）。
2. **`express.json()` 会吃掉 `/mcp` 的请求体** —— 必须在 body parser **之前**抓原始字节并跳过解析，否则反代转发的是空 body。
3. **DCR 响应不能返回 `client_secret: null`** —— RFC 7591 §3.2.1 要求时间戳类字段是 JSON number。public client 应**省略** secret 字段。返回 null 会让 ChatGPT 的严格解析器抛错 → 表现为 DCR 201 成功但**从不请求 /authorize**。
4. **`resource` 参数是 MUST** —— MCP 规范要求客户端在授权与 token 请求中都携带（RFC 8707 资源指示器），token 需绑定受众。
5. **所有发现端点都要返回合法 JSON** —— 客户端会并发探测多个路径，任一返回 404（HTML）就判定整体发现失败。
6. **`nginx -s reload`，别用 systemctl** —— 若 nginx.service 处于 failed 状态，systemctl reload 无效。
7. **上游凭证目录要 bind mount** —— 某些 CLI 的密钥环落在 `~/.local/share/<tool>`，不挂出来重建容器即丢。

## ⚠️ 自测 ≠ 第三方客户端能连

**自研测试脚本全绿不代表兼容真实客户端。** 验收必须看真实客户端的 User-Agent 流量：

```bash
grep "aiohttp" /var/log/nginx/<site>.access.log \
  | sed -E 's/.*"(GET|POST) ([^ ]+) [^"]*" ([0-9]+).*/\3 \1 \2/' | sort | uniq -c
```

ChatGPT connector 后端的 UA 是 `Python/3.14 aiohttp`。**「DCR 201 成功却不请求 /authorize」= 发现流程失败**，而非认证失败。

---

以下为原始部署交接文档（已脱敏）：

---

# 飞书 MCP 接入 ChatGPT — 交接说明

> 服务器 `<SERVER_IP>` · 目录 `/opt/feishu-mcp` · 域名 **`https://mcp.example.com`**

## ✅ 状态：已全部完成，可直接用

| 项 | 状态 |
|---|---|
| OAuth 2.1 + PKCE + DCR 中间件 | ✅ 30/30 全链路测试通过 |
| 飞书授权 | ✅ 赵亮 / `<OPEN_ID>`，且 bot 身份也 ready |
| 真实 API 调用 | ✅ `search_feishu_docs` 搜到 260 条真实文档 |
| 凭证持久化 | ✅ **重建容器后授权仍存活**（已实测） |

**ChatGPT 配置**：URL 填 `https://mcp.example.com/mcp`，认证方式选 **OAuth**，弹出的登录页密码 `<LOGIN_PASSWORD>`。

> 授权 scope 覆盖 docs / drive / base / sheets / wiki / im / calendar / mail / task 等。
> user token 有效期 2h（自动刷新），refresh token 至 2026-09-28。

---

## 一、架构

ChatGPT 只支持 **OAuth 2.1 + 动态客户端注册（DCR）** 或 **No Auth**，不支持静态 token（`?token=xxx` 会被直接拒）。所以自建了一层 OAuth 中间件：

```
ChatGPT ──HTTPS──> Cloudflare ──> nginx:443 ──> oauth-proxy:3011 ──> feishu-mcp:3000 ──> 飞书 API
                                                  (OAuth 2.1 + PKCE + DCR + 密码门)
```

**已验证（30/30）**：metadata 发现、DCR 注册、PKCE 授权、token 交换、PKCE 负向拒绝、`/mcp` 反代到 feishu-mcp、伪造 token 拒绝、refresh_token 刷新。

---

## 二、日常运维

```bash
ssh -i ~/sshkeys/tx.pem ubuntu@<SERVER_IP>
cd /opt/feishu-mcp

sudo docker compose ps                    # 状态
sudo docker compose logs -f oauth-proxy   # 反代日志
sudo docker compose logs -f feishu-mcp    # 上游日志

curl -s https://mcp.example.com/healthz                 # 探活
curl -s https://mcp.example.com/ | python3 -m json.tool  # 服务自述

sudo bash /opt/feishu-mcp/scripts/04-check-feishu-auth.sh      # 体检（授权+持久化+API）
```

**脚本**（`/opt/feishu-mcp/scripts/`）：

| 脚本 | 用途 |
|---|---|
| `01-inject-app-secret.sh` | 注入 App Secret（`read -s` 交互，不进 history/进程列表） |
| `02-start-feishu-login.sh` | 发起 device authorization，拿授权链接 |
| `03-complete-feishu-login.sh <code>` | 用 device_code 收尾 |
| `04-check-feishu-auth.sh` | 体检 |

**oauth-proxy 关键环境变量**（`docker-compose.yml`）：

| 变量 | 值/说明 |
|---|---|
| `PUBLIC_BASE_URL` | `https://mcp.example.com`（OAuth issuer） |
| `ALLOWED_HOSTS` | 域名白名单，OAuth 元数据按请求 Host 动态生成 |
| `LOGIN_PASSWORD` | `<LOGIN_PASSWORD>`（登录门） |
| `SESSION_SECRET` | 已固定，否则重启后要重新登录 |
| `MCP_HTTP_TOKEN` | oauth-proxy 用它调上游 feishu-mcp，外部看不到 |

---

## 三、五个必须记住的坑

### 1. 域名绝不能带下划线 ⚠️

原来是 `bad_name.example.com`。`_` 不是合法主机名字符（RFC 1123），新版 OpenSSL 按 RFC 6125 做通配符匹配时**直接判不匹配** → 严格 TLS 客户端全部握手失败。

同一张 CF 边缘证书（`*.example.com`）的对照实验：

| 域名 | Python / OpenSSL 3.5 | Node 22 |
|---|---|---|
| `wildcard.example.com` | ✅ | ✅ |
| `other.example.com` | ✅ | ✅ |
| `bad_name.example.com` | ❌ Hostname mismatch | ✅（侥幸） |

所以换成了 **`mcp.example.com`**。以后给服务器起子域，一律用连字符。

### 2. lark-cli 的凭证不在 `.lark-cli` 里 ⚠️

真正存凭证的地方是 `~/.local/share/lark-cli/`（`master.key` + `appsecret_*.enc` + `<app>_<openid>.enc`），而 `.lark-cli/` 只存 `config.json`。

之前只挂了前者 → 凭证落在**容器可写层** → 每次重建容器就全丢，连重新登录都做不了（报 `missing client_secret`）。

**已修**：`docker-compose.yml` 里加了 bind mount

```yaml
      - ./lark-keychain:/home/node/.local/share/lark-cli
```

用 bind mount 而非 named volume —— 镜像里这目录不存在，named volume 首次挂载会建成 `root:root`，uid 1000 的 node 用户写不进去。

### 3. 改了后端代码必须 `--build`

`docker compose up -d` **不重建镜像**，build cache 会命中旧层，跑的还是旧代码。

```bash
sudo docker compose up -d --build oauth-proxy   # 改了 oauth-proxy/server.js 时
```

### 4. nginx 用 `nginx -s reload`，别用 systemctl

`nginx.service` 自 2026-06-17 起就是 failed（80 端口被 docker-proxy 占），443 靠手动起的 master 在跑。

```bash
sudo nginx -t && sudo nginx -s reload
```

### 5. 别和 Hermes 共用飞书 App

宿主机上另有 Hermes 用的 App `<HERMES_APP_ID>`（凭证在 `/root/.local/share/lark-cli/`，CLI 版本 v1.0.65）。

飞书里**同一 App + 同一用户 = 同一份 token**。两个服务各跑一次授权会互相覆盖 `refresh_token`，任一方刷新后另一方失效，且 lock 文件跨容器锁不住 → 表现为随机、间歇的 `token_missing`，极难排查。

**所以两个 App 是刻意分开的，别合并。**

---

## 四、文件位置

**服务器**

| 路径 | 说明 |
|---|---|
| `/opt/feishu-mcp/docker-compose.yml` | 双服务编排 |
| `/opt/feishu-mcp/oauth-proxy/server.js` | OAuth 2.1 中间件（ESM，express/express-session/helmet） |
| `/opt/feishu-mcp/scripts/0{1..4}-*.sh` | 运维脚本 |
| `/opt/feishu-mcp/lark-keychain/` | **飞书凭证持久化目录（别删，建议纳入备份）** |
| `/etc/nginx/conf.d/feishu-mcp.conf` | 反代配置 |

**本地项目**

| 文件 | 说明 |
|---|---|
| `feishu-mcp-oauth/oauth-proxy-server.js` | 中间件源码（服务器同版本） |
| `feishu-mcp-oauth/flow-test.py` | 30 项全链路测试 |
| `feishu-mcp-oauth/live-tools-test.py` | 走完 OAuth 后真实调飞书工具 |
| `feishu-mcp-oauth/scripts/` | 运维脚本副本 |

---

## 五、遗留提醒

- **建议去飞书后台重置 App Secret**（`<FEISHU_APP_ID>`）—— 它经过了对话记录。重置不影响已下发的 token，只让泄露的值失效。
- 若日后授权失效（超过 7 天未使用导致 refresh 过期），重跑 `02` → 浏览器授权 → `03` 即可，App Secret 不用再动。

---

## 六、域名规范化收尾（旧域名残留清理）

旧域名 `bad_name.example.com`（下划线）**已彻底下线**，全线只保留 `mcp.example.com`。

**清理明细**

| 位置 | 处理 |
|---|---|
| DNS（Cloudflare） | 旧记录已删；8.8.8.8 / 1.1.1.1 / 223.5.5.5 三处公共解析均无记录 |
| nginx `server_name` | 单域名 `mcp.example.com`（原双域名别名已撤） |
| nginx 证书软链 | `mcp.example.com.{pem,key}` → 共用 `wildcard.example.com.*`；无下划线残留 |
| `oauth-proxy/Dockerfile` | `ENV PUBLIC_BASE_URL` 默认值 → 连字符域名（此行仅兜底，运行时由 compose 覆盖） |
| `docker-compose.yml` | `PUBLIC_BASE_URL` / `ALLOWED_HOSTS` / `GITHUB_CALLBACK_URL` 均为连字符域名 |
| 历史 compose 备份 ×4 | 移至 `/opt/feishu-mcp/archive/` |
| nginx access log | 全量日志中旧域名出现 **0 次** |

**保留的旧域名提及**（刻意保留，非残留）：`server.js` / nginx conf / `flow-test.py` 里的注释 —— 记录下划线坑的成因，防止后人重蹈。

**验证结果**：在服务器侧跑完整全链路测试（走真实 Cloudflare 边缘，非本机隧道）—— **30 通过 / 0 失败**。

**仍需 sky 亲测的一项**：ChatGPT 侧真实连接。服务器日志里目前只有 `oauth-flow-test` 和 `curl` 的访问记录，**尚未见到 ChatGPT 的 User-Agent**，说明 connector 可能还没真正连过。请在 ChatGPT 里按第 14 行的配置添加后，观察 `sudo docker logs -f oauth-proxy` 是否出现实际调用。
