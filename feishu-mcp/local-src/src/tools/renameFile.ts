/**
 * rename_feishu_file：重命名云空间里的文件 / 文件夹 / 在线文档 / 知识库节点。
 * 底层 drive +update-title：传 url 时 CLI 自动识别类型，裸 token 必须配 type。
 */
import { runLarkCli, envelopeData } from "../larkCli.js";
import { jsonResult, type ToolDef } from "./types.js";
import { z } from "zod";

interface UpdateTitlePayload {
  updated?: boolean;
  file_token?: string;
  type?: string;
  title?: string;
  url?: string;
  previous_title?: string;
  extension_appended?: boolean;
  [key: string]: unknown;
}

export const renameFileTool: ToolDef = {
  name: "rename_feishu_file",
  title: "重命名飞书文件或文件夹",
  description:
    "重命名飞书云空间里的文件、文件夹、在线文档或知识库节点。推荐直接传目标 URL（CLI 自动识别类型）；" +
    "只有裸 token 时才需要同时传 type。支持 docx / sheet / bitable / file / folder / slides / wiki，" +
    "不支持旧版 doc 和思维笔记（mindnote）。type=file 时标题即完整文件名，后缀不一致会被拦截。",
  inputSchema: {
    title: z.string().min(1).describe("新标题，不能为空或纯空白，首尾空格会被去掉"),
    url: z
      .string()
      .optional()
      .describe("目标 URL（推荐），支持 /docx/ /sheets/ /base/ /bitable/ /slides/ /file/ /drive/folder/ /wiki/"),
    token: z.string().optional().describe("目标 token 或 URL；与 url 二选一，裸 token 必须配 type"),
    type: z
      .enum(["docx", "sheet", "bitable", "base", "slides", "file", "folder", "wiki"])
      .optional()
      .describe("文件类型；传 url 时可省略，裸 token 时必填"),
  },
  handler: async (args) => {
    const title = String(args.title).trim();
    if (!title) throw new Error("新标题不能为空或纯空白");

    const url = args.url ? String(args.url).trim() : "";
    const token = args.token ? String(args.token).trim() : "";
    if (!url && !token) throw new Error("必须提供 url 或 token 之一");
    if (!url && !args.type) throw new Error("传裸 token 时必须同时提供 type（CLI 无法从 token 推断类型）");

    const cliArgs = ["drive", "+update-title", "--title", title];
    if (url) {
      cliArgs.push("--url", url);
    } else {
      cliArgs.push("--token", token);
    }
    if (args.type) cliArgs.push("--type", String(args.type));

    const data = envelopeData<UpdateTitlePayload>(await runLarkCli(cliArgs));
    return jsonResult({
      updated: data.updated ?? true,
      title: data.title ?? title,
      previous_title: data.previous_title,
      file_token: data.file_token,
      type: data.type,
      url: data.url,
      extension_appended: data.extension_appended,
    });
  },
};
