/**
 * move_feishu_file：把文件 / 文件夹移动到云空间的其他位置。
 * 底层 drive +move：--folder-token 省略时移动到根目录（我的空间）。
 * 注意：drive +move 只处理 Drive 文件夹树；Wiki 节点请改用 wiki +move-to-drive。
 */
import { runLarkCli, envelopeData } from "../larkCli.js";
import { jsonResult, type ToolDef } from "./types.js";
import { z } from "zod";

interface MovePayload {
  ready?: boolean;
  timed_out?: boolean;
  task_id?: string;
  status?: string;
  next_command?: string;
  url?: string;
  [key: string]: unknown;
}

export const moveFileTool: ToolDef = {
  name: "move_feishu_file",
  title: "移动飞书文件或文件夹",
  description:
    "把飞书云空间里的文件、文件夹或在线文档移动到另一个位置。target_folder_token 省略即移动到根目录（我的空间）。" +
    "只处理 Drive 文件夹树内部的移动；若源对象是知识库节点，请改用 wiki +move-to-drive，不要把 wiki token 传进来。" +
    "移动文件夹可能是异步的：返回 ready=false 时带 task_id 和 next_command，需要按 next_command 继续查询确认落位。",
  inputSchema: {
    file_token: z.string().min(1).describe("要移动的文件或文件夹 token（不是 URL）"),
    type: z
      .enum(["file", "docx", "doc", "sheet", "bitable", "mindnote", "folder", "slides"])
      .describe("文件类型，必填（CLI 不会推断）"),
    target_folder_token: z
      .string()
      .optional()
      .describe("目标文件夹 token；省略则移动到根目录（我的空间）"),
  },
  handler: async (args) => {
    const fileToken = String(args.file_token).trim();
    if (!fileToken) throw new Error("file_token 不能为空");

    const cliArgs = ["drive", "+move", "--file-token", fileToken, "--type", String(args.type)];
    const target = args.target_folder_token ? String(args.target_folder_token).trim() : "";
    if (target) cliArgs.push("--folder-token", target);

    const data = envelopeData<MovePayload>(await runLarkCli(cliArgs));

    // 文件夹移动内置轮询最多 30 次 × 2 秒，仍未完成时不算失败，需续查确认
    const settled = data.ready !== false;
    return jsonResult({
      moved: settled,
      ready: data.ready ?? true,
      timed_out: data.timed_out ?? false,
      status: data.status,
      task_id: data.task_id,
      next_command: data.next_command,
      url: data.url,
      hint: settled
        ? undefined
        : "文件夹移动尚未完成，任务在服务端异步执行。请按 next_command 继续查询确认落位，不要重复发起移动。",
    });
  },
};
