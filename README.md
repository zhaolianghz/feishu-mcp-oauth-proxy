# feishu-mcp · ChatGPT OAuth 2.1 中间件

> 让 [feishu-mcp](https://github.com/feifan2024/feishu_mcp) 能被 **ChatGPT 自定义连接器**接入。
>
> ChatGPT 的自定义连接器只支持 **OAuth 2.1 + DCR** 或 **No Auth**，不接受静态 token
> （`?token=xxx` 会直接拒）。本项目补上中间这层 OAuth。

```
ChatGPT ──HTTPS──> Cloudflare ──> nginx:443 ──> oauth-proxy:3011 ──> feishu-mcp:3000 ──> 飞书 API
                                          (OAuth 2.1 + PKCE + DCR + 密码门)
```

---

## ⚠️ 本仓库是脱敏版

所有凭证均已替换为占位符，**部署时填入你自己的值**：

| 占位符 | 含义 | 真实值来源 |
|---|---|---|
| `.env` 的 `LOGIN_PASSWORD` | 登录门密码 | 你自己设（ChatGPT 登录页要输入） |
| `.env` 的 `MCP_HTTP_TOKEN` | oauth-proxy 调上游的 Bearer | `openssl rand -hex 32` |
| `.env` 的 `SESSION_SECRET` | session 密钥 | `openssl rand -hex 32` |
| `docs/feishu-app-setup.md` 里的 App ID | 飞书应用 ID | 飞书开放平台 |

`.env` 已被 `.gitignore` 忽略。**不要把真实凭证提交到版本库。**

---

## 前置条件

- 一台有公网 IP 的 Linux 服务器（Docker + Compose v2 + nginx）
- 一个域名，**A 记录指向服务器，且不要含下划线**（见踩坑 1）
- TLS 证书（Cloudflare Origin CA 或 Let's Encrypt 均可）
- 一个飞书自建应用（见 [docs/feishu-app-setup.md](docs/feishu-app-setup.md)）

---

## 快速开始

```bash
git clone <this-repo> feishu-mcp && cd feishu-mcp

# 1. 配置
cp .env.example .env
vim .env          # 至少填 DOMAIN / MCP_HTTP_TOKEN / LOGIN_PASSWORD / SESSION_SECRET

# 2. 飞书应用（必须，见 docs/feishu-app-setup.md）

# 3. 部署（自动做前置检查 → 拉上游 → 构建 → 验证）
sudo bash deploy/deploy.sh

# 4. 飞书授权
sudo bash feishu-mcp-oauth/scripts/01-inject-app-secret.sh
sudo bash feishu-mcp-oauth/scripts/02-start-feishu-login.sh
# 浏览器授权后：
sudo bash feishu-mcp-oauth/scripts/03-complete-feishu-login.sh <device_code>

# 5. nginx
cp feishu-mcp-oauth/nginx-feishu-mcp.conf /etc/nginx/conf.d/
sed -i 's/mcp\.example\.com/你的域名/g' /etc/nginx/conf.d/feishu-mcp.conf
sudo nginx -t && sudo nginx -s reload
```

**然后在 ChatGPT 里添加连接器：**

| 项 | 值 |
|---|---|
| URL | `https://你的域名/mcp` |
| 认证方式 | **OAuth** |
| 登录密码 | `.env` 里的 `LOGIN_PASSWORD` |

> ChatGPT 设置 → Apps（Connectors）→ Advanced settings → 打开 **Developer Mode**，
> 才能创建自定义连接器。仅付费方案支持。

---

## 目录结构

```
.
├── docker-compose.yml           # 双服务编排（凭证全走 .env）
├── .env.example                 # 配置模板
├── deploy/
│   ├── preflight.sh             # 前置检查：把常见坑变成明确报错
│   └── deploy.sh                # 一键部署：检查→拉上游→构建→验证
├── feishu-mcp/
│   ├── Dockerfile               # ⚠️ 修正版（上游原版构建会失败，见踩坑 8）
│   └── Dockerfile.upstream-original   # 原版留档，供对比
├── feishu-mcp-oauth/
│   ├── oauth-proxy-server.js     # OAuth 2.1 中间件（单文件）
│   ├── Dockerfile
│   ├── package.json
│   ├── nginx-feishu-mcp.conf    # nginx 模板（改域名/证书路径）
│   ├── flow-test.py             # 30 项全链路验证
│   ├── live-tools-test.py       # 走完 OAuth 后真实调飞书工具
│   └── scripts/                 # 01~04 运维脚本（无硬编码路径）
└── docs/
    ├── feishu-app-setup.md      # 飞书应用创建 + 权限清单（必读）
    └── deployment-notes.md      # 原始部署交接笔记
```

---

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
| `GET /login` · `POST /login/demo` | — | 密码门 |
| `ALL /mcp` | Streamable HTTP | 反代到上游 MCP |

---

## 踩坑记录

全部为实测踩出，不是抄规范。

### 1. 域名绝不能带下划线 ⚠️

`_` 不是合法主机名字符（RFC 1123）。CF 边缘证书是通配符 `*.example.com`，
理论上覆盖任意子域，但**新版 OpenSSL 按 RFC 6125 做通配符匹配时直接判不匹配**
→ 严格 TLS 客户端全部握手失败。

同一张证书的对照实验：

| 域名 | Python 3.13 / OpenSSL 3.5 | Node 22 |
|---|---|---|
| `a.example.com` | ✅ | ✅ |
| `b.example.com` | ✅ | ✅ |
| `bad_name.example.com` | ❌ Hostname mismatch | ✅（侥幸宽松） |

**Node 22 侥幸能连，Python 不能** —— 所以本地 curl 通了不代表 ChatGPT 能连
（ChatGPT connector 后端是 Python `aiohttp`）。这就是必须用**真实客户端流量**验收的原因。

### 2. `express.json()` 会吃掉 `/mcp` 的请求体

`app.all('/mcp')` 里用 `req.pipe(proxyReq)` 反代时，**body 永远是空的** ——
全局 `express.json()` 已经消费了流。修法两处必须同时改：

1. 在 `express.json` **之前**给 `/mcp` 单独抓原始字节 → `req.rawBody`
2. body parser **跳过 `/mcp`**（否则报 `stream is not readable` 500）
3. 反代改成 `proxyReq.end(req.rawBody)` + 重设 `content-length`

### 3. DCR 响应不能返回 `client_secret: null` ⚠️

RFC 7591 §3.2.1 要求 `client_id_issued_at` / `client_secret_expires_at`
是 **JSON number**，绝不能是 `null`。public client（`token_endpoint_auth_method: none`）
应**省略** secret 相关字段，而不是给 `null`。

**症状极具迷惑性**：`POST /register` 返回 **201 成功**，
但 ChatGPT **从不请求 `/authorize`**，UI 报「无法创建 MCP 应用」。

### 4. `resource` 参数是 MUST

MCP 规范要求客户端在**授权请求和 token 请求中都**携带 `resource`
（RFC 8707 资源指示器），且 access token 需绑定受众，防 token 转发。

### 5. 所有发现端点都必须返回合法 JSON

客户端会**并发探测**多个发现路径，任一返回 404（尤其是 `text/html` 的 404 页）
就判定**整体发现流程失败**。`/.well-known/openid-configuration` 是最高频缺失项。

### 6. `nginx -s reload`，别用 systemctl

若 `nginx.service` 处于 `failed`（常见于 80 端口被 docker 占用），
`systemctl reload nginx` 会报 `Unit cannot be reloaded because it is inactive`。
用 `sudo nginx -s reload` 直接对运行中的 master 发 HUP。

### 7. 凭证目录必须 bind mount

lark-cli 的密钥环落在 `~/.local/share/lark-cli/`，**不是** `~/.lark-cli/`。
不挂出来 → 凭证落容器可写层 → 重建即丢 → App Secret 和 user token 一起没。

用 **bind mount 而非 named volume**：镜像里该目录不存在，named volume
首次挂载建成 `root:root`，uid 1000 的 node 用户写不进去。

### 8. 上游 Dockerfile 原版构建会失败 ⚠️

本仓库的 `feishu-mcp/Dockerfile` 修了两个上游 bug（原版留档在
`Dockerfile.upstream-original`）：

1. `node:22-slim` **不含 curl**，而 lark-cli 的 postinstall 用 curl 拉二进制
   → 加 `apt-get install curl ca-certificates`
2. `npm install --omit=dev` 跳过了 typescript（它在 devDependencies）
   → `npm run build` 报 `tsc: not found`
   → 改成全量 install → build → `npm prune --omit=dev`

**直接用上游原版 Dockerfile 部署会卡在构建阶段。**

### 9. 改了后端代码必须 `--build`

`docker compose up -d` **不重建镜像**，build cache 会命中旧层，跑的还是旧代码。

```bash
sudo docker compose up -d --build oauth-proxy
```

### 10. shell 变量紧跟中文标点会炸 ⚠️

写中文提示信息时，`"$d」"` 这种写法在 `set -u` 下会直接报
`d?: unbound variable` —— bash 会把后面的**多字节字符当成变量名的一部分**。

```bash
echo "「$d」"        # ❌ set -u 下崩：d?: unbound variable
echo "「${d}」"      # ✅ 一律用花括号
```

本仓库所有脚本已统一用 `${VAR}`。如果你要改脚本，**改完务必 `bash -n` 过一遍**，
并注意 `bash -n` 抓不到这个错（它是运行时才炸）。

### 11. `set -u` 下 `.env` 不存在时，间接变量为空

`preflight.sh` 早期版本在没有 `.env` 时崩在 TLS 检查：
`DOMAIN: unbound variable`。凡是 `set -u` 的脚本，
**用到的变量都要先给兜底值**（`DOMAIN=""`），再在逻辑分支里判断是否为空。

---

## ⚠️ 自测 ≠ 第三方客户端能连

**自研测试脚本全绿，不代表真实客户端能连。** 自己的脚本证明的只是
"服务端配置自洽"，第三方客户端有自己的探测序列和严格度。

必须看**真实客户端的 User-Agent 流量**：

```bash
# ChatGPT connector 后端是 Python aiohttp
grep "aiohttp" /var/log/nginx/<site>.access.log \
  | sed -E 's/.*"(GET|POST) ([^ ]+) [^"]*" ([0-9]+).*/\3 \1 \2/' | sort | uniq -c
```

典型的失败形态：

```
  8 404 GET /.well-known/openid-configuration   ← 致命项
  8 200 GET /.well-known/oauth-authorization-server
  5 401 POST /mcp
  5 200 GET /.well-known/oauth-protected-resource
  3 201 POST /register      ← DCR 成功，却从不进 /authorize
```

**判据：发现端点必须「NOT a 404 or 401」。**
**「DCR 201 成功但不请求 `/authorize`」= 发现流程失败**，而非认证失败。

---

## 已知限制

- **refresh token 7 天到期**，需重新跑 device flow 授权。lark-cli 没有可用的
  `auth refresh` 子命令，自动续期需要自己实现。
- **token 与 client 存在内存里**，容器重启后 ChatGPT 需重新走 OAuth。
- **单用户**：密码门是共用密码，知道密码的人都能以你的飞书身份操作。
  需要多用户隔离得自己加账号体系。
- **未在全新环境做过从零到端到端的完整演练**：本项目源自一台机器的生产部署，
  配置项已参数化，但没在干净环境验证过「clone → 部署 → ChatGPT 出现插件」全流程。
  欢迎反馈问题。

---

## License

MIT
