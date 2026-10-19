#!/bin/bash
# Build the deployment overlay in a disposable upstream checkout and run local tests.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
test_workspace=$(mktemp -d)
trap 'rm -rf "$test_workspace"' EXIT
if [ -n "${FEISHU_UPSTREAM_DIR:-}" ]; then
  mkdir -p "$test_workspace/upstream"
  git -C "$FEISHU_UPSTREAM_DIR" archive HEAD | tar -x -C "$test_workspace/upstream"
else
  git clone --depth 1 https://github.com/feifan2024/feishu_mcp.git "$test_workspace/upstream"
fi
cp -R "$repo_root/feishu-mcp/local-src/src/." "$test_workspace/upstream/src/"
bash "$repo_root/deploy/patch-local-tools.sh" "$test_workspace/upstream/src/index.ts"
# Second application must be a no-op, including the incremental browser patches.
before=$(shasum "$test_workspace/upstream/src/index.ts" "$test_workspace/upstream/src/httpServer.ts" "$test_workspace/upstream/src/larkCli.ts")
bash "$repo_root/deploy/patch-local-tools.sh" "$test_workspace/upstream/src/index.ts"
after=$(shasum "$test_workspace/upstream/src/index.ts" "$test_workspace/upstream/src/httpServer.ts" "$test_workspace/upstream/src/larkCli.ts")
[ "$before" = "$after" ] || { echo "Patch is not idempotent" >&2; exit 1; }
npm install --ignore-scripts --no-package-lock --prefix "$test_workspace/upstream"
npm run build --prefix "$test_workspace/upstream"
npm install --ignore-scripts --no-package-lock --prefix "$repo_root/feishu-mcp-oauth"
FEISHU_BUILD_DIR="$test_workspace/upstream/dist" node --test "$repo_root"/tests/*.test.mjs
node "$test_workspace/upstream/dist/identity/selfcheck.js"
npm test --prefix "$repo_root/feishu-mcp-oauth"
