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
- [ ] 飞书账号，以及你要接入的自建应用（已有应用可在浏览器授权接入，无须复制 Secret）
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

### 第 5 步：准备要连接的飞书身份

企业和个人飞书身份可以各自连接。在下一步添加连接器后，浏览器会引导你选择账号、
接入飞书应用并确认用户授权；不需要登录服务器运行授权脚本或复制 App Secret。
旧的脚本方式保留用于运维兼容，见 [应用配置说明](docs/feishu-app-setup.md)。

### 第 6 步：在 ChatGPT 里添加

ChatGPT → 设置 → Apps（Connectors）→ Advanced settings → 打开 **Developer Mode**

然后创建连接器：

| 填什么 | 值 |
|---|---|
| URL | `https://你的域名/mcp` |
| 认证方式 | **OAuth** |
| 登录密码 | `.env` 里的 `LOGIN_PASSWORD` |

浏览器通过登录门后会进入**选择飞书账号**页面：

1. 已连接的企业账号可直接确认使用。
2. 连接个人飞书时，点击「前往飞书连接账号」，在飞书官方页面选择个人身份和已有应用。
3. 确认应用接入后，回到连接页继续确认用户授权；系统自动接收、保存凭据。
4. 核对账号后点击「连接并返回 ChatGPT」。

以后在 ChatGPT 的应用设置点击**连接另一个账户**，也会进入相同流程。
已有应用可展开「指定已有应用」提供 App ID 来定位；不需要提供 Secret。
应用接入和用户授权是两个步骤，可能需要分别确认。企业管理员要求的审批仍由飞书处理。
每条 ChatGPT 连接固定使用自己授权的飞书账号；选择另一条连接即可操作另一个空间。

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

多账号环境下，上述开发者测试需用 `FEISHU_ACCOUNT_ID=fa_…` 指定测试账号，避免选错身份。
本地开发的浏览器流程、账号隔离及部署补丁回归测试：

```bash
bash scripts/test-browser-connect.sh
```

或者用一条命令检查旧默认应用登录态：

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
│   ├── deploy.sh                # 一键部署
│   └── patch-local-tools.sh     # 把本地工具注册进上游 index.ts
├── feishu-mcp/                  # feishu-mcp 服务的镜像定义
│   ├── Dockerfile               # 修过上游的构建问题
│   ├── Dockerfile.upstream-original
│   └── local-src/               # ← 本仓库自带的工具（叠加在上游 src/ 之上）
│       └── src/
│           ├── localTools.ts    #   工具清单
│           └── tools/           #   createFolder / listFolder / moveFile / renameFile
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

## 本仓库自带的工具

上游 feishu-mcp 只注册了 9 个读写的文档类工具，**没有云空间文件管理**。本仓库通过叠加层
补上 4 个，连起来共 **13 个**（再加下面 8 个账号及身份工具，合计 **21 个**）：

| 工具 | 做什么 | 底层命令 |
|---|---|---|
| `create_feishu_folder` | 新建文件夹（不传父目录就是建在根目录） | `drive +create-folder` |
| `list_feishu_folder` | 列目录，支持递归；翻页自动收全 | `drive files list` |
| `move_feishu_file` | 移动文件/文件夹到指定目录 | `drive +move` |
| `rename_feishu_file` | 重命名（传 url 最省事，会自动识别类型） | `drive +update-title` |

配套的权限（可写的 `drive:drive`）见 `docs/feishu-app-setup.md` 第二节。

### 多账号身份（Identity & Multi-Account V2.0）

上游只有**一个全局飞书登录态**：多个 ChatGPT 连接共用同一身份，换组织只能重登服务器。
本仓库的叠加层补了一套多账号身份体系，再加 8 个账号及身份工具，连起来共 **21 个**：

| 工具 | 做什么 |
|---|---|
| `feishu_account_list` | 列出已连接账号，标出当前账号 |
| `feishu_account_current` | 实时返回当前工具会使用的身份 |
| `feishu_account_connect` | 发起新账号 OAuth，返回授权链接（可用 `app` 指定组织） |
| `feishu_account_switch` | 切换当前账号 |
| `feishu_account_disconnect` | 断开账号并删除其凭证 |
| `feishu_auth_status` | 查看某账号授权是否有效 |
| `feishu_app_list` | 列出已注册的飞书应用（组织） |
| `feishu_get_profile` | 向 ChatGPT 返回当前连接的稳定账号身份与显示名称 |

- 每个账号一个独立凭证命名空间（lark-cli 的 `HOME`），**完全隔离、不串号**
- 浏览器 OAuth 凭据固定绑定账号，失效后拒绝访问；旧连接按 `连接 → 用户默认 → 唯一账号` 解析
- 写工具返回 `executed_as`；带 `target_account_hint` 且与当前账号不一致时**拒绝写入**
- 首次部署自动把旧的单账号登录态迁移成第一个账号，老用户无感
- **多组织**：正常入口是 ChatGPT 设置里的「连接另一个账户」，在浏览器接入对应身份下的应用。
  `scripts/05-register-app.sh` 与聊天内 `feishu_account_connect` 保留用于旧接入方式。
  固定账号的 ChatGPT 连接不能通过 `feishu_account_switch` 改成其他身份，需选择相应连接。

架构、存储布局与部署影响见 `docs/multi-account.md`。

### ⚠️ 不要直接改 `feishu-mcp/src/`

`deploy/deploy.sh` 第 2 步每次部署都从 GitHub 重新克隆上游 `src/` 覆盖本地。
你在这个目录里加的工具，**下次部署会被无声冲掉** —— MCP 不会报错，只是工具少了，
等到某天批量整理文件时才发现工具不见了。

所以本仓库的工具放在 `feishu-mcp/local-src/`，部署时按这个顺序处理：

1. 克隆上游 `src/`（可能被覆盖，无所谓）
2. `cp -r feishu-mcp/local-src/src/. feishu-mcp/src/` —— 铺一层本地工具 + 身份模块
3. `bash deploy/patch-local-tools.sh` —— 往 `index.ts` 注入 `...LOCAL_TOOLS` 注册、多账号中间件，
   并给 `larkCli.ts` 注入凭证命名空间

### 想再加一个工具

1. 在 `feishu-mcp/local-src/src/tools/` 下写一个 `ToolDef`，照抄同目录里现成的写法
2. 挂到 `feishu-mcp/local-src/src/localTools.ts` 的 `LOCAL_TOOLS` 数组上
3. **不需要**动 `index.ts`，也不需要改补丁脚本 —— 数组会自动展开

### 补丁脚本失配了怎么办

`patch-local-tools.sh` 靠锚点定位上游 `index.ts` / `httpServer.ts` / `larkCli.ts`。**锚点命中数不等于 1 就直接
退出非 0**，进而让 `deploy.sh` 整个中止 —— 这是故意的：宁可部署失败，也不要悄悄少几个
工具让你在几天后才发现。

多账号相关的补丁用独立的 done_mark（`dispatchTool` / `credentialEnv`），**已部署的旧环境重跑本脚本也能增量打上**，不会因为 `localTools.js` 已存在就整段跳过。

所以看到这条报错：

```
❌ 无法给上游 index.ts 打补丁。
   上游可能改了源码结构，请打开 feishu-mcp/src/index.ts 手工对齐 deploy/patch-local-tools.sh 里的锚点。
```

就是上游 `feifan2024/feishu_mcp` 改了结构。打开 `feishu-mcp/src/index.ts` 找到新的
import 区块和 `ALL_TOOLS` 数组，把 `patch-local-tools.sh` 里的 `A1`/`A2` 换成新的锚点字符串
即可（每行必须是上游里唯一的一行）。

第三处锚点（启动日志里的工具数量）是可选的，匹配不到只会告警，不影响工具注册。

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
- **移动文件夹是异步的**。飞书把「移动」当后台任务，接口可能先返回「还没好」。
  这时 `move_feishu_file` 返回 `moved: false` 加一个 `hint`，按返回里的
  `next_command` 稍后复查即可 —— **超时不是失败，别重复发起**，重复发起会互相打架。
- **知识库（Wiki）节点不能直接移动**。要先用 lark-cli 的 `wiki +move-to-drive`
  把它挪出知识库变成云空间文件，再交给 `move_feishu_file`。
- **重命名不支持旧版文档和思维导图**（`doc` / `mindnote`）。其余类型传 `url` 最省事，
  会自动识别。

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
