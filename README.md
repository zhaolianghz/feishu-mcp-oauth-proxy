# 把飞书文档接进 ChatGPT

让 [feishu-mcp](https://github.com/feifan2024/feishu_mcp)（能读写飞书文档、表格、多维表格的 MCP 服务）
被 **ChatGPT 自定义连接器**使用 —— 在 ChatGPT 里直接说"帮我看看我上周的飞书周报"，它就能去查。

ChatGPT 的自定义连接器只接受 **OAuth 2.1** 或 **无认证**两种方式，不接受你在 URL 后面挂
`?token=xxx` 这种静态 token。而 feishu-mcp 本身没有实现 OAuth。

**这个项目就是中间那层**：给它套上 OAuth 2.1（PKCE + 动态客户端注册），
让 ChatGPT 能正常弹授权框、正常连上。

```
ChatGPT ──HTTPS──> Cloudflare ──> nginx:443 ──> oauth-proxy:3011 ──> feishu-mcp:3000 ──> 飞书 API
                                        ↑
                            OAuth 2.1 + PKCE + DCR + 密码门
```

---

## 部署前的 5 分钟确认

你需要准备：

- [ ] 一台有公网 IP 的 Linux 服务器（已装 Docker + Compose v2 + nginx）
- [ ] 一个域名，**A 记录已指向这台服务器**
- [ ] TLS 证书（Cloudflare Origin CA 或 Let's Encrypt 都行）
- [ ] 一个飞书自建应用（[怎么建 →](docs/feishu-app-setup.md)）
- [ ] **ChatGPT 付费账号** —— 自定义连接器是付费功能，且要在设置里手动开开发者模式

> ⚠️ **域名绝对不能用下划线**（`mcp_x.example.com` ✗，`mcp-x.example.com` ✓）。
> 下划线不是合法主机名字符，会导致 ChatGPT 这类严格 TLS 客户端**完全连不上**，
> 而且本地 curl 可能正常，排查起来很痛苦。这是本项目踩过的最坑的一个问题。

---

## 部署

### 第 1 步：拿代码并配置

```bash
git clone https://github.com/zhaolianghz/feishu-mcp-oauth-proxy.git
cd feishu-mcp-oauth-proxy

cp .env.example .env
```

编辑 `.env`，**至少填这 4 项**：

```bash
# 你的域名，不要带 https://，不要用下划线
DOMAIN=mcp-x.你的域名.com

# 生成随机 token：openssl rand -hex 32
MCP_HTTP_TOKEN=

# 登录门密码 —— ChatGPT 弹出的授权页会要你输它，设成你自己的强密码
LOGIN_PASSWORD=

# 同样生成：openssl rand -hex 32
SESSION_SECRET=
```

一键生成那两个随机值：

```bash
echo "MCP_HTTP_TOKEN=$(openssl rand -hex 32)"
echo "SESSION_SECRET=$(openssl rand -hex 32)"
```

### 第 2 步：检查环境

```bash
sudo bash deploy/preflight.sh
```

它会检查 Docker、nginx、端口占用、`.env` 配置、域名合法性、TLS 证书。
有问题会**明确告诉你怎么修**，修完再跑一次，全绿才进下一步。

### 第 3 步：部署

```bash
sudo bash deploy/deploy.sh
```

这条命令会依次完成：前置检查 → 拉取 feishu-mcp 源码 → 构建两个镜像 →
启动容器 → 等待健康检查 → 验证 OAuth 发现端点是否都能返回正确响应 → reload nginx。

### 第 4 步：配置 nginx（如果还没配）

```bash
sudo cp feishu-mcp-oauth/nginx-feishu-mcp.conf /etc/nginx/conf.d/feishu-mcp.conf
sudo sed -i "s/mcp\.example\.com/你的域名/g" /etc/nginx/conf.d/feishu-mcp.conf
# 证书路径也要改成你自己的
sudo sed -i "s|YOUR_DOMAIN|你的域名|g" /etc/nginx/conf.d/feishu-mcp.conf
sudo nginx -t && sudo nginx -s reload
```

> 用 `nginx -s reload`，**不要用 `systemctl reload nginx`**。
> 如果 nginx 不在 systemd 管理下（常见于 80 端口被 Docker 占用时），
> systemctl 会报 `Unit cannot be reloaded because it is inactive`。

### 第 5 步：授权飞书

飞书这步**不能跳**，跳了工具调用会全部失败。

```bash
# 5.1 填入你的飞书 App ID（先编辑 .env，加一行 FEISHU_APP_ID=cli_xxxxxxxx）
sudo bash feishu-mcp-oauth/scripts/01-inject-app-secret.sh
#     然后粘贴 App Secret

# 5.2 发起授权，它会打印一个链接
sudo bash feishu-mcp-oauth/scripts/02-start-feishu-login.sh

# 5.3 浏览器打开上面的链接完成授权，然后：
sudo bash feishu-mcp-oauth/scripts/03-complete-feishu-login.sh <上一步输出的 device_code>
```

### 第 6 步：在 ChatGPT 里添加

ChatGPT → 设置 → Apps（Connectors）→ Advanced settings → 打开 **Developer Mode**

然后创建连接器：

| 填什么 | 值 |
|---|---|
| URL | `https://你的域名/mcp` |
| 认证方式 | **OAuth** |
| 登录密码 | `.env` 里的 `LOGIN_PASSWORD` |

---

## 验证是否真的能用

装完之后跑这两条：

```bash
# OAuth 全链路自检（30 项），只需域名
BASE=https://你的域名 python3 feishu-mcp-oauth/flow-test.py

# 真实调用飞书工具（走完 OAuth 后实际读一次飞书），需要域名 + 登录密码
BASE=https://你的域名 LOGIN_PASSWORD='你的登录门密码' \
  python3 feishu-mcp-oauth/live-tools-test.py
```

或者用一条命令做整体体检：

```bash
sudo bash feishu-mcp-oauth/scripts/04-check-feishu-auth.sh
```

---

## 目录结构

```
.
├── docker-compose.yml           # 双服务编排，配置全从 .env 读
├── .env.example                 # 配置模板
├── deploy/
│   ├── preflight.sh             # 部署前检查
│   └── deploy.sh                # 一键部署
├── feishu-mcp/                  # feishu-mcp 服务的镜像定义
│   ├── Dockerfile               # 修过上游的构建问题
│   └── Dockerfile.upstream-original
├── feishu-mcp-oauth/            # ← OAuth 中间件，本项目核心
│   ├── oauth-proxy-server.js    #   全部逻辑在这一个文件里
│   ├── Dockerfile
│   ├── nginx-feishu-mcp.conf    #   nginx 配置模板
│   ├── flow-test.py             #   OAuth 全链路自检
│   ├── live-tools-test.py       #   真实飞书工具调用测试
│   └── scripts/                 #   飞书授权相关脚本
└── docs/
    └── feishu-app-setup.md      # 飞书应用创建步骤与权限清单
```

---

## 配置项说明

| 变量 | 必填 | 说明 |
|---|---|---|
| `DOMAIN` | ✅ | 对外域名，OAuth issuer 就是它 |
| `MCP_HTTP_TOKEN` | ✅ | 中间件调用 feishu-mcp 的凭据，两边必须一致 |
| `LOGIN_PASSWORD` | ✅ | 授权页密码。**不设等于不设防** —— 知道密码的人可以以你的身份读写飞书 |
| `SESSION_SECRET` | ✅ | 会话密钥。不固定的话每次重启都要重新授权 |
| `FEISHU_APP_ID` | ✅¹ | 飞书应用 ID，授权脚本要用 |
| `OAUTH_PROXY_PORT` | | 中间件在宿主机监听的端口，默认 3011 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_USER` | | 配了就用 GitHub 账号登录，免输密码 |
| `DEBUG_PROBE` | | 排查 ChatGPT 接入问题时设为 1，会打印原始请求内容。**排查完记得关** |

¹ 也可以在执行脚本时用 `--app-id cli_xxx` 传入，或先 `export FEISHU_APP_ID=cli_xxx`

---

## 排错

### ChatGPT 报「无法创建 MCP 应用」

这几乎总是**发现端点缺失**。ChatGPT 会并发探测多个 OAuth 元数据路径，
**任何一个返回 404 就判定整个接入失败**，所以这些路径必须全部可用：

| 路径 | 用途 |
|---|---|
| `/.well-known/oauth-protected-resource` | 受保护资源元数据 |
| `/.well-known/oauth-authorization-server` | 授权服务器元数据 |
| `/.well-known/openid-configuration` | OIDC 兼容别名（最常被遗漏的一个） |
| `/.well-known/oauth-authorization-server/<任意路径>` | 带路径段的变体 |
| `/.well-known/oauth-protected-resource/mcp` | 带资源路径的变体 |

**怎么确认服务器端的真实情况**（不要只信自己的测试脚本，
自研脚本全绿不代表 ChatGPT 能连）：

```bash
# ChatGPT 后端是 Python aiohttp，按 UA 过滤真实流量
sudo grep "aiohttp" /var/log/nginx/feishu-mcp.access.log \
  | sed -E 's/.*"(GET|POST) ([^ ]+) [^"]*" ([0-9]+).*/\3 \1 \2/' \
  | sort | uniq -c | sort -rn
```

你会看到 ChatGPT 真实发起的探测。**判据：这些路径必须是「NOT a 404 or 401」**。

一个典型的失败形态长这样：

```
  8 404 GET /.well-known/openid-configuration   ← 致命，就缺这一个
  8 200 GET /.well-known/oauth-authorization-server
  3 201 POST /register      ← DCR 成功了，但之后从不请求 /authorize
```

**「DCR 返回 201 成功但从不进 `/authorize`」= 发现阶段就失败了**，
不是用户没输密码。别往认证方向排查。

### 授权页能打开，但调用工具报错

那是**飞书授权**的问题，不是 OAuth 层。检查：

```bash
sudo docker exec -u node feishu-mcp lark-cli auth status
```

如果显示 token 过期，重跑第 5 步。

### 容器重建后授权全没了

检查凭证目录有没有挂出来：

```bash
docker inspect feishu-mcp --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

必须能看到 `lark-keychain` 挂到 `/home/node/.local/share/lark-cli`。
**这个目录不能丢** —— 飞书的密钥环在重建容器后会消失，App Secret 和登录态一起没。

### nginx 改完不生效

```bash
sudo nginx -t          # 先看配置有没有语法错误
sudo nginx -s reload   # 用这个，不要用 systemctl
```

---

## 已知限制

- **飞书授权 7 天到期**。lark-cli 没有自动续期命令，到期后所有工具调用会突然失败
  （而 OAuth 层一切正常，很容易误判）。重新跑第 5 步即可。
- **中间件是单用户设计**。`LOGIN_PASSWORD` 是共享密码，知道密码的人都可以
  以你的飞书身份操作。需要多人隔离得自己加账号体系。
- **容器重启需要重新授权 ChatGPT**。access token 存在内存里，没有落盘。
- 只在 Linux + Docker Compose v2 环境验证过。

---

## 常见问题

**Q：为什么不能用官方现成的 MCP 网关方案？**
A：现成方案大多不支持 ChatGPT 要求的 DCR（动态客户端注册），
或者没有针对 ChatGPT 的发现端点做兼容。

**Q：中间件会读到我的飞书数据吗？**
A：会。它在你自己服务器上反向代理，不经过任何第三方。

**Q：能不能不用 Cloudflare？**
A：可以，直连服务器 + 自己的证书也行。只要满足：公网可达、HTTPS 有效、域名合法。

**Q：为什么飞书要单独授权一次，ChatGPT 里不是已经登录了吗？**
A：两套体系。ChatGPT 认证的是"能不能连我的 MCP 服务器"，
飞书认证的是"以哪个飞书账号的身份读写文档"。后者只能走飞书自己的 device flow。

---

## License

MIT
