#!/bin/bash
# 第二步：用上一步的 device_code 续上轮询，完成授权
# 用法：sudo bash /opt/feishu-mcp/scripts/03-complete-feishu-login.sh <device_code>
set -e

if [ -z "$1" ]; then
  echo "用法: $0 <device_code>   （device_code 由 02-start-feishu-login.sh 输出）" >&2
  exit 1
fi

docker exec -u node feishu-mcp lark-cli auth login --device-code "$1"

echo
echo "--- 授权状态 ---"
docker exec -u node feishu-mcp lark-cli auth status
