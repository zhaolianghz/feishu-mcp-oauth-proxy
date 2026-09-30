#!/bin/bash
# 注入飞书 App Secret 到容器（从 stdin 读，不入 shell history、不进进程列表）
#
# 用法：
#   sudo bash scripts/01-inject-app-secret.sh
#   sudo bash scripts/01-inject-app-secret.sh --from-file <路径>
#
# FEISHU_APP_ID 来源（按优先级）：
#   1. 环境变量 FEISHU_APP_ID
#   2. 仓库根目录的 .env
#   3. --app-id <值> 显式传入
#
# 注意：lark-cli 会顺手校验一次 secret。校验失败会返回非零退出码，
#       但配置本身已经落盘（keychain 已持久化），换正确的 secret 重跑即可。

set -uo pipefail

# 自动定位仓库根目录（脚本在 <root>/feishu-mcp-oauth/scripts/ 下）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
KEYCHAIN_DIR="${ROOT}/lark-keychain"
CONTAINER="${FEISHU_MCP_CONTAINER:-feishu-mcp}"

APP_ID="${FEISHU_APP_ID:-}"
if [ -f "${ROOT}/.env" ]; then
  from_env=$(grep -E '^FEISHU_APP_ID=' "${ROOT}/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')
  [ -z "$APP_ID" ] && APP_ID="$from_env"
fi

# --app-id 覆盖
if [ "${1:-}" = "--app-id" ] && [ -n "${2:-}" ]; then
  APP_ID="$2"
fi

if [ -z "$APP_ID" ]; then
  echo "错误：拿不到 FEISHU_APP_ID，三种方式任选一种：" >&2
  echo "  1) 在仓库根目录 .env 里加一行 FEISHU_APP_ID=cli_xxxxxxxx" >&2
  echo "  2) 导出环境变量：export FEISHU_APP_ID=cli_xxxxxxxx" >&2
  echo "  3) 显式传入：bash $0 --app-id cli_xxxxxxxx" >&2
  exit 1
fi

if [ "${1:-}" = "--from-file" ] && [ -n "${2:-}" ]; then
  SECRET="$(tr -d '\r\n' < "$2")"
else
  echo "从 https://open.feishu.cn/app/${APP_ID}/baseinfo 复制 App Secret"
  echo
  printf '粘贴 App Secret 后回车: '
  read -rs SECRET
  echo
fi

if [ -z "$SECRET" ]; then
  echo "空 secret，退出" >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "错误：容器 ${CONTAINER} 没在运行，先执行 sudo bash deploy/deploy.sh" >&2
  exit 1
fi

echo "=== 写入配置 ==="
printf '%s' "$SECRET" | docker exec -i -u node "$CONTAINER" \
  lark-cli config init --app-id "$APP_ID" --app-secret-stdin --brand feishu 2>&1
unset SECRET

echo
echo "=== 当前配置 ==="
docker exec -u node "$CONTAINER" lark-cli config show 2>&1

echo
echo "=== keychain 持久化目录 ==="
ls -la "$KEYCHAIN_DIR" 2>/dev/null || echo "（目录不存在，配置可能没落盘）"

echo
echo "下一步: sudo bash ${SCRIPT_DIR}/02-start-feishu-login.sh"
