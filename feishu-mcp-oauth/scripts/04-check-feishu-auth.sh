#!/bin/bash
# 体检：确认凭证持久化 + 飞书授权 + MCP 全链路
# 用法：sudo bash scripts/04-check-feishu-auth.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CONTAINER="${FEISHU_MCP_CONTAINER:-feishu-mcp}"
echo "=== 1. keychain 持久化目录（宿主机）==="
ls -la "${ROOT}/lark-keychain"

echo
echo "=== 2. lark-cli 身份状态 ==="
docker exec -u node "$CONTAINER" lark-cli auth status

echo
echo "=== 3. 真实调飞书 API ==="
docker exec -u node "$CONTAINER" lark-cli api GET /open-apis/authen/v1/user_info 2>&1 | head -20

echo
echo "=== 4. 容器挂载确认 ==="
docker inspect "$CONTAINER" --format '{{range .Mounts}}  {{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
