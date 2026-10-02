/**
 * create_feishu_folder：在云空间（我的空间）创建文件夹。
 * 底层 drive +create-folder：--folder-token 省略时建在调用用户的根目录。
 */
import { runLarkCli, envelopeData } from "../larkCli.js";
import { jsonResult, type ToolDef } from "./types.js";
import { z } from "zod";

interface CreateFolderPayload {
  folder_token?: string;
  url?: string;
  name?: string;
  parent_folder_token?: string;
  [key: string]: unknown;
}

export const createFolderTool: ToolDef = {
  name: "create_feishu_folder",
  title: "创建飞书云空间文件夹",
  description:
    "在飞书云空间（我的空间）创建文件夹。不传 parent_folder_token 建在根目录，传了则建在该父文件夹下（父 token 就是文件夹 URL 里 /drive/folder/ 后那段）。" +
    "批量整理目录时先建好顶层文件夹，再用 move_feishu_file 把文件/子文件夹移进去。返回新文件夹的 folder_token 和 url。",
  inputSchema: {
    name: z.string().min(1).describe("文件夹名称，不能为空或纯空白"),
    parent_folder_token: z
      .string()
      .optional()
      .describe("父文件夹 token 或 /drive/folder/ 完整 URL；省略则创建在根目录"),
  },
  handler: async (args) => {
    const name = String(args.name).trim();
    if (!name) throw new Error("文件夹名称不能为空或纯空白");

    const cliArgs = ["drive", "+create-folder", "--name", name];
    const parent = args.parent_folder_token ? String(args.parent_folder_token).trim() : "";
    if (parent) cliArgs.push("--folder-token", parent);

    const data = envelopeData<CreateFolderPayload>(await runLarkCli(cliArgs));
    return jsonResult({
      folder_token: data.folder_token,
      name: data.name ?? name,
      url: data.url,
      parent_folder_token: data.parent_folder_token ?? parent,
    });
  },
};
