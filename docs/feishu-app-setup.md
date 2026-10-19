# 飞书应用创建与授权配置

> 本文保留旧版手工配置与运维排错流程。正常用户现在从 ChatGPT「连接另一个账户」进入
> 浏览器，接入已有飞书应用并确认授权即可，不需要复制 Secret 或执行下列脚本。
> 如果采用旧版预配置方式，可按本文操作。

---

## 一、创建应用

1. 打开 <https://open.feishu.cn/app> → **创建企业自建应用**
2. 名称随意（如 `my-feishu-mcp`），描述随意
3. 创建后进入应用详情页，记下 **App ID**（形如 `cli_xxxxxxxx`）
   - 这就是 `feishu-mcp-oauth/scripts/01-inject-app-secret.sh` 里要填的 `APP_ID`
4. 在「凭证与基础信息」页找到 **App Secret** → 点「查看」→ 复制保存
   - ⚠️ secret 只显示一次

---

## 二、开通权限（最容易漏、也最容易踩坑）

进入「权限管理」，开通以下权限。**建议直接搜索权限名逐个勾选**：

### 必需权限

| 权限名 | 权限标识 | 用途 |
|---|---|---|
| 读取云文档 | `docx:document:readonly` | 读文档 |
| 编辑云文档 | `docx:document` | 写文档 |
| 获取文档基础信息 | `docx:document` | 文档元数据 |
| 查看、评论、编辑和导出新版文档 | `docx:document:readonly` | 读新版文档 |

### 云空间 / 知识库

| 权限名 | 权限标识 |
|---|---|
| 查看、下载、分享云空间文件 | `drive:drive` / `drive:drive:readonly` |
| 查看云空间 | `drive:drive.metadata:readonly` |
| 知识库 | `wiki:wiki:readonly` / `wiki:node:read` |

> **Drive 文件管理工具需要可写的 `drive:drive`**，只有 `:readonly` 不够。
> 本仓库自带的 `create_feishu_folder` / `move_feishu_file` / `rename_feishu_file`
> 都会写云空间；`list_feishu_folder` 只读，`:readonly` + `metadata:readonly` 即可。

### 电子表格

| 权限名 | 权限标识 |
|---|---|
| 查看、编辑电子表格 | `sheets:spreadsheet` |
| 查看电子表格 | `sheets:spreadsheet:readonly` |

### 多维表格（Base）

| 权限名 | 权限标识 |
|---|---|
| 查看、编辑多维表格 | `base:app` / `base:table` |
| 多维表格记录 | `base:record` |

> **授权时勾选「读取」通常就够了**。本项目默认 `LARK_IDENTITY=user`，
> 以你的身份访问你有权限的文档 —— 不会越权读到别人的东西。
> 但**多维表格的写入权限要显式勾**，否则会报权限错误。

### 用户身份信息

| 权限名 | 权限标识 |
|---|---|
| 获取用户基本信息 | `contact:user.base:readonly` |

> `lark-cli` 的 device flow 需要它来确认「你是谁」。

### 可选：更多能力

按需开通：`im:`（消息）、`calendar:`（日历）、`task:`（任务）、`mail:`（邮件）。

**不开也能跑**，只是对应工具不可用。建议**先只开必需的**，跑通了再按需加。

---

## 三、发布应用

⚠️ **这一步不做，device flow 会报权限错误。**

1. 左上角「版本管理与发布」→ **创建版本**
2. 填版本号（如 `1.0.0`）和更新说明
3. 选**可用范围** —— 至少包含你自己（否则你自己也调不动）
4. 提交，可能需要企业管理员审核
   - **个人版飞书通常自己就是管理员，立即通过**
   - 企业账号可能需要等审批

---

## 四、注入凭证并授权

回到本项目目录：

```bash
# 1. 注入 App Secret（交互输入，不进 shell history、不进进程列表）
sudo bash feishu-mcp-oauth/scripts/01-inject-app-secret.sh

# 2. 发起 device authorization，拿到授权链接
sudo bash feishu-mcp-oauth/scripts/02-start-feishu-login.sh

# 3. 浏览器打开链接完成授权，然后：
sudo bash feishu-mcp-oauth/scripts/03-complete-feishu-login.sh <上一步输出的 device_code>

# 4. 体检
sudo bash feishu-mcp-oauth/scripts/04-check-feishu-auth.sh
```

预期输出：`user: ready` + `bot: ready`。

---

## 五、常见失败与对应原因

| 报错 / 现象 | 原因 | 解决 |
|---|---|---|
| `missing a required parameter: client_secret` | App Secret 没注入 | 跑 `01-inject-app-secret.sh` |
| `invalid_client`（code 20002） | App Secret 错误 | 后台重新复制，注意不要带空格 |
| 授权后立刻掉线，token 反复失效 | **两个服务共用了同一个飞书 App** | 见下方「重要」 |
| 提示无权限访问某文档 | 该文档不在你的可用范围内 | 检查文档归属，或用应用管理员身份 |
| `token_missing` 间歇性报错 | 同上，共用 App 导致 refresh token 互相作废 | 见下方「重要」 |
| 授权成功但工具调用报 403 | 权限没开全 | 回第二节补权限，**并重新发布版本** |

---

## ⚠️ 重要：不要和别的服务共用同一个飞书 App

飞书的设计是：**同一个 App + 同一个用户 = 同一份 token**。

如果你的 MCP 服务和别的工具（比如另一个 CLI、某个 Hermes 实例）用了**同一个 App**：

- 两边各跑一次授权会**互相覆盖** `refresh_token`
- 任一方刷新后，另一方的 token 立刻作废
- 表现为**间歇性、随机的 `token_missing`**，极难排查

**结论：每个独立服务用各自的 App。** 多建一个应用的成本，远低于排查这个问题的成本。

---

## 六、凭证会被容器重建清空 —— 关键配置

lark-cli 的密钥环落在 `~/.local/share/lark-cli/`（`master.key` + `*.enc`），
而**不是** `~/.lark-cli/`（那里只存 `config.json`）。

`docker-compose.yml` 里这行是**命脉**，不能删：

```yaml
    volumes:
      - ./lark-keychain:/home/node/.local/share/lark-cli
```

不挂的话，凭证落在容器可写层，`docker compose up -d` 重建就全丢 ——
**App Secret 和 user token 一起没了，连重新登录都做不了**
（device authorization 会报 `missing client_secret`）。

用 **bind mount 而非 named volume**：镜像里该目录不存在，named volume 首次挂载
会建成 `root:root`，uid 1000 的 node 用户写不进去。

验证持久化生效：

```bash
sudo docker compose up -d --force-recreate feishu-mcp
sudo docker exec feishu-mcp lark-cli auth status   # 应仍显示 ready
```

---

## 七、token 会过期 —— 这是固有成本

| 凭证 | 有效期 | 过期后 |
|---|---|---|
| user access token | 2 小时 | 自动刷新，无需干预 |
| **user refresh token** | **7 天** | **必须重新跑第二~三步授权** |

refresh token 7 天到期后，本服务就无法调用飞书 API 了（工具会报权限/认证错误）。
重新授权即可，App Secret 不用动。

**要根治**就得自己实现 refresh token 自动续期（lark-cli 的 `auth refresh`
不是有效子命令），或者接受每 7 天手工授权一次。
