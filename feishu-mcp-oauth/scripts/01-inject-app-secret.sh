#!/bin/bash
# 注入飞书 App Secret 到容器（从 stdin 读，不入 shell history、不进进程列表）
#
# 用法：
#   sudo bash /opt/feishu-mcp/scripts/01-inject-app-secret.sh
#   sudo bash /opt/feishu-mcp/scripts/01-inject-app-secret.sh --from-file <路径>
#
# 注意：lark-cli 会顺手校验一次 secret。校验失败会返回非零退出码，
#       但配置本身已经落盘（keychain 已持久化），换正确的 secret 重跑即可。

APP_ID="<FEISHU_APP_ID>"

if [ "$1" = "--from-file" ] && [ -n "$2" ]; then
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

echo "=== 写入配置 ==="
printf '%s' "$SECRET" | docker exec -i -u node feishu-mcp \
  lark-cli config init --app-id "$APP_ID" --app-secret-stdin --brand feishu 2>&1
unset SECRET

echo
echo "=== 当前配置 ==="
docker exec -u node feishu-mcp lark-cli config show 2>&1

echo
echo "=== keychain 持久化目录 ==="
ls -la /opt/feishu-mcp/lark-keychain

echo
echo "下一步: sudo bash /opt/feishu-mcp/scripts/02-start-feishu-login.sh"
