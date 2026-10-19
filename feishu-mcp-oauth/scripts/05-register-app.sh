#!/bin/bash
# 为「另一个组织」注册一个飞书自建应用（多组织/多身份接入用）。
#
# 飞书自建应用只属于一个组织，所以接不同组织 = 每组织一个自建应用。本脚本把该
# 应用的配置加密落进模板命名空间，并登记 别名 → appId；之后在 ChatGPT 里调用
# feishu_account_connect(app="<别名>") 即可用该组织授权。
#
# App Secret 只经 stdin 交给容器内 lark-cli 加密存储，不进 shell history、不入聊天记录。
#
# 用法：
#   sudo bash scripts/05-register-app.sh <别名> <app_id>
#   例：sudo bash scripts/05-register-app.sh 公司 cli_xxxxxxxxxxxxxxxx
#
# 别名查看：ChatGPT 里调 feishu_app_list；或重跑本脚本看末尾列表。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTAINER="${FEISHU_MCP_CONTAINER:-feishu-mcp}"
ALIAS="${1:-}"
APP_ID="${2:-}"

if [ -z "$ALIAS" ] || [ -z "$APP_ID" ]; then
  echo "用法: sudo bash $0 <别名> <app_id>" >&2
  echo "  例: sudo bash $0 公司 cli_xxxxxxxxxxxxxxxx" >&2
  exit 1
fi
case "$ALIAS" in
  */*|*..*|*\\*) echo "别名不能包含 / 或 .." >&2; exit 1 ;;
esac
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "错误：容器 ${CONTAINER} 没在运行，先 sudo docker compose up -d" >&2
  exit 1
fi

echo "为组织【${ALIAS}】注册飞书应用 ${APP_ID}"
echo "（在 https://open.feishu.cn 该组织下创建自建应用，复制其 App ID / App Secret）"
echo
printf '粘贴 App Secret 后回车: '
read -rs SECRET
echo
if [ -z "$SECRET" ]; then
  echo "空 secret，退出" >&2
  exit 1
fi

# 1) 在模板命名空间里用 lark-cli 加密落盘该 App 配置（明文 secret 只经 stdin）
INIT_RC=0
printf '%s' "$SECRET" | docker exec -i \
  -e HOME="/data/feishu-apps/${ALIAS}" -e APP_ID="$APP_ID" -u node "$CONTAINER" \
  sh -c 'mkdir -p "$HOME" && lark-cli config init --app-id "$APP_ID" --app-secret-stdin --brand feishu' 2>&1 || INIT_RC=$?
unset SECRET
if [ "$INIT_RC" -ne 0 ]; then
  echo >&2
  echo "⚠️  lark-cli 校验未通过（app_id / app_secret 可能不对，或网络问题）。已登记的配置已落盘；" >&2
  echo "    确认后可直接用正确 secret 重跑本脚本覆盖。" >&2
fi

# 2) 登记 别名 → appId
docker exec -e ALIAS="$ALIAS" -e APP_ID="$APP_ID" -u node "$CONTAINER" \
  node -e "import('/app/dist/identity/apps.js').then(m=>{m.registerApp(process.env.ALIAS, process.env.APP_ID);console.log('✓ 已登记', process.env.ALIAS, process.env.APP_ID)})" 2>&1

echo
echo "== 已注册应用 =="
docker exec -u node "$CONTAINER" \
  node -e "import('/app/dist/identity/apps.js').then(m=>console.log(JSON.stringify(m.listApps(),null,2)))" 2>&1

echo
echo "下一步：在 ChatGPT 里说「连接【${ALIAS}】的飞书账号」"
