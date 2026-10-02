#!/bin/bash
# 给上游 feishu_mcp 打补丁：注册 local-src 的工具，并让启动日志显示真实工具数。
#
# 为什么需要它：上游 src/ 每次部署都由 deploy.sh 从 GitHub 重新克隆，
# 直接改 index.ts 会在下次部署被无声覆盖 —— MCP 不会报错，只是工具少了。
# 这里用「锚点唯一命中 + 失败即退出」的方式打补丁：上游一旦改了结构，
# 宁可部署失败，也不要悄悄少几个工具。
#
# 刻意不用 node：deploy.sh 跑在宿主机上，而本项目的部署前置条件只有
# Docker / Compose / nginx，不应该为了一次字符串替换引入 node 依赖。
#
# 幂等：已打过补丁的文件原样跳过。
#
# 用法：bash deploy/patch-local-tools.sh [index.ts 路径]
#       不带参数时用本仓库默认路径 <repo>/feishu-mcp/src/index.ts；
#       httpServer.ts 从 index.ts 同目录推导。
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
index_ts="${1:-$repo_root/feishu-mcp/src/index.ts}"
http_ts="$(dirname "$index_ts")/httpServer.ts"

if [ ! -f "$index_ts" ]; then
  echo "❌ 找不到 $index_ts" >&2
  echo "   本仓库部署请先跑 deploy/deploy.sh 的第 2 步（拉取上游代码）。" >&2
  echo "   手动指定用法：bash deploy/patch-local-tools.sh <index.ts 路径>" >&2
  exit 1
fi

# 用 awk 改写一个文件。锚点命中数必须为 1，否则退出非 0 且不碰原文件。
# $1=目标文件  $2=awk 程序  $3=脚本名  $4=已打补丁的标记字符串
patch_file() {
  local target="$1" prog="$2" label="$3" done_mark="$4"
  if [ ! -f "$target" ]; then
    echo "❌ 找不到 $target" >&2
    exit 1
  fi
  if grep -qF "$done_mark" "$target"; then
    echo "  ℹ️  $(basename "$target") 已打过补丁，跳过"
    return 0
  fi

  local out
  out=$(mktemp)
  if ! awk "$prog" "$target" > "$out"; then
    rm -f "$out"
    echo "❌ 无法给上游 $(basename "$target") 打补丁。" >&2
    echo "   上游可能改了源码结构，请打开 $target 手工对齐 $label 里的锚点。" >&2
    exit 1
  fi
  mv "$out" "$target"
  # 注意 ${label} 必须带花括号：紧跟全角括号时 bash 会把「）」的首字节并进变量名。
  echo "  ✅ $(basename "$target") 补丁完成（${label}）"
}

# ---------- index.ts ----------
# A1 引入 localTools  import
# A2 把 LOCAL_TOOLS 展开进 ALL_TOOLS
# A4 把工具数传给 startHttpServer
# A3 stdio 启动日志里的工具数 —— 可选，匹配不到只告警
patch_file "$index_ts" '
BEGIN {
  A1 = "import type { ToolDef } from \"./tools/types.js\";"
  B1 = "import { LOCAL_TOOLS } from \"./localTools.js\";"
  A2 = "  checkAuthTool,"
  B2 = "  ...LOCAL_TOOLS,"
  A3 = "console.error(\"[feishu-mcp] stdio 服务已启动（9 个工具已注册）\");"
  B3 = "console.error(`[feishu-mcp] stdio 服务已启动（${ALL_TOOLS.length} 个工具已注册）`);"
  A4 = "    await startHttpServer(createServer(), config);"
  B4 = "    await startHttpServer(createServer(), config, ALL_TOOLS.length);"
  n1 = 0; n2 = 0; n3 = 0; n4 = 0
}
{
  if (index($0, A1) > 0) { print; print B1; n1++; next }
  if (index($0, A2) > 0) { print; print B2; n2++; next }
  if (index($0, A3) > 0) { print B3; n3++; next }
  if (index($0, A4) > 0) { print B4; n4++; next }
  print
}
END {
  if (n1 != 1) { print "  · 引入 LOCAL_TOOLS 的 import：命中 " n1 " 次（期望 1 次）" > "/dev/stderr"; exit 1 }
  if (n2 != 1) { print "  · 展开 LOCAL_TOOLS 进 ALL_TOOLS：命中 " n2 " 次（期望 1 次）" > "/dev/stderr"; exit 1 }
  if (n4 != 1) { print "  · 把工具数传给 startHttpServer：命中 " n4 " 次（期望 1 次）" > "/dev/stderr"; exit 1 }
  if (n3 != 1) { print "  ⚠️ stdio 工具数量日志锚点命中 " n3 " 次，工具注册不受影响，仅该行日志保持上游原样" > "/dev/stderr" }
}
' "deploy/patch-local-tools.sh" "localTools.js"

# ---------- httpServer.ts ----------
# 生产用的是 HTTP 传输，这行日志才是运维实际看到的，
# 上游把 9 写死了，叠加本地工具后会误导排查。
# H1 给 startHttpServer 加一个 toolCount 形参，H2 打印它。
patch_file "$http_ts" '
BEGIN {
  A1 = "export async function startHttpServer(server: McpServer, config: FeishuMcpConfig): Promise<void> {"
  B1 = "export async function startHttpServer(server: McpServer, config: FeishuMcpConfig, toolCount?: number): Promise<void> {"
  A2 = "9 个工具已注册）"
  B2 = "${toolCount ?? 0} 个工具已注册）"
  n1 = 0; n2 = 0
}
{
  if (index($0, A1) > 0) { print B1; n1++; next }
  if (index($0, A2) > 0) { sub(A2, B2); print; n2++; next }
  print
}
END {
  if (n1 != 1) { print "  · startHttpServer 加 toolCount 形参：命中 " n1 " 次（期望 1 次）" > "/dev/stderr"; exit 1 }
  if (n2 != 1) { print "  · HTTP 启动日志显示真实工具数：命中 " n2 " 次（期望 1 次）" > "/dev/stderr"; exit 1 }
}
' "deploy/patch-local-tools.sh" "toolCount?: number"
