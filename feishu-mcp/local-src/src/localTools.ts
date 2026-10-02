/**
 * 本仓库自带的工具（上游 feishu_mcp 之外的新增能力）。
 *
 * 上游 src/ 由 deploy.sh 每次从 GitHub 浅克隆拉取，不进版本库，所以本目录是
 * 「叠加层」：deploy.sh 先铺上游 src，再把 local-src/src 拷上去，最后跑
 * deploy/patch-local-tools.mjs 给上游 index.ts 打两处注册补丁。
 *
 * 改动这里不会丢，更新上游也不会冲掉。
 */
import type { ToolDef } from "./tools/types.js";
import { createFolderTool } from "./tools/createFolder.js";
import { listFolderTool } from "./tools/listFolder.js";
import { moveFileTool } from "./tools/moveFile.js";
import { renameFileTool } from "./tools/renameFile.js";

export const LOCAL_TOOLS: ToolDef[] = [createFolderTool, listFolderTool, moveFileTool, renameFileTool];
