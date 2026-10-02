/**
 * list_feishu_folder：列出 Drive 文件夹的直接子项，可选递归展开子目录树。
 * 底层 drive files list（原生 API）：folder_token / page_token 都必须放进 --params JSON。
 *
 * 飞书接口只返回**直接子项**，所以 recursive=true 时本工具负责自己下钻：
 * 每个目录独立翻页到 has_more=false，只对 type=folder 的项继续递归。
 * 达到 max_items / max_calls / max_depth 上限时**不静默截断**，而是返回
 * truncated=true 与 pending_folders，调用方拿 pending_folders 续跑即可。
 */
import { runLarkCli, envelopeData } from "../larkCli.js";
import { jsonResult, type ToolDef } from "./types.js";
import { z } from "zod";

interface DriveFileItem {
  token?: string;
  name?: string;
  type?: string;
  url?: string;
  owner_id?: string;
  created_time?: string;
  modified_time?: string;
  [key: string]: unknown;
}

interface FilesListPayload {
  files?: DriveFileItem[];
  has_more?: boolean;
  next_page_token?: string;
  [key: string]: unknown;
}

interface QueueEntry {
  folderToken: string;
  path: string;
  depth: number;
}

interface ListedItem {
  path: string;
  name: string;
  type: string;
  token: string;
  url?: string;
  owner_id?: string;
  created_time?: string;
  modified_time?: string;
  depth: number;
}

/** 拉完一个目录的全部分页；受 maxItems 预算约束，可能提前返回 has_more */
async function listOneFolder(
  folderToken: string,
  pageSize: number,
  budget: { left: number },
): Promise<{ items: DriveFileItem[]; exhausted: boolean; pageToken?: string }> {
  const items: DriveFileItem[] = [];
  let pageToken: string | undefined;

  for (;;) {
    if (budget.left <= 0) return { items, exhausted: false, pageToken };

    const params: Record<string, unknown> = { folder_token: folderToken, page_size: pageSize };
    if (pageToken) params.page_token = pageToken;

    budget.left -= 1;
    const data = envelopeData<FilesListPayload>(
      await runLarkCli(["drive", "files", "list", "--params", JSON.stringify(params), "--format", "json"]),
    );

    items.push(...(data.files ?? []));
    if (!data.has_more || !data.next_page_token) return { items, exhausted: true };
    pageToken = data.next_page_token;
  }
}

export const listFolderTool: ToolDef = {
  name: "list_feishu_folder",
  title: "列出飞书云空间文件夹内容",
  description:
    "列出飞书云空间（我的空间）某个文件夹的直接子项，返回名称、类型、token、URL、更新时间。folder_token 省略或传空串即列根目录。" +
    "飞书接口只返回直接子项，不会自动展开子文件夹：recursive=true 时本工具会自己逐层下钻并拼出完整 path，" +
    "适合批量盘点目录树。达到 max_items / max_calls / max_depth 上限时返回 truncated=true 与 pending_folders，" +
    "拿 pending_folders 的 folder_token 续调即可继续，**不要把被截断的结果当成已经盘完**。" +
    "注意区分同名目录：同名文件夹的 path 相同但 token 不同，移动/重命名前请以 token 为准。",
  inputSchema: {
    folder_token: z.string().optional().describe("文件夹 token 或 /drive/folder/ 完整 URL；省略或空串表示根目录"),
    recursive: z.boolean().default(false).describe("是否递归展开所有子文件夹（默认只列一层）"),
    max_depth: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3)
      .describe("recursive 时的最大展开层数，起点目录算第 0 层（1-10，默认 3）"),
    max_items: z.number().int().min(1).max(2000).default(500).describe("最多收集多少个子项，超出则截断并报告（1-2000）"),
    max_calls: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(60)
      .describe("最多发起多少次分页请求，用于给墙钟时间兜底（1-200，默认 60）"),
    page_size: z.number().int().min(1).max(200).default(200).describe("单页条数（1-200，默认 200）"),
  },
  handler: async (args) => {
    const startToken = args.folder_token ? String(args.folder_token).trim() : "";
    const recursive = args.recursive === true;
    const maxDepth = recursive ? Number(args.max_depth ?? 3) : 0;
    const maxItems = Number(args.max_items ?? 500);
    const maxCalls = Number(args.max_calls ?? 60);
    const pageSize = Number(args.page_size ?? 200);
    const budget = { left: maxCalls };

    const items: ListedItem[] = [];
    const pending: Array<{ folder_token: string; path: string; reason: string }> = [];
    const queue: QueueEntry[] = [{ folderToken: startToken, path: "", depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift() as QueueEntry;
      if (items.length >= maxItems) {
        pending.push({ folder_token: current.folderToken, path: current.path, reason: "max_items" });
        continue;
      }
      if (budget.left <= 0) {
        pending.push({ folder_token: current.folderToken, path: current.path, reason: "max_calls" });
        continue;
      }

      const { items: raw, exhausted } = await listOneFolder(current.folderToken, pageSize, budget);
      if (!exhausted) {
        pending.push({ folder_token: current.folderToken, path: current.path, reason: "max_calls（该目录未翻完）" });
      }

      for (const file of raw) {
        if (items.length >= maxItems) {
          pending.push({ folder_token: current.folderToken, path: current.path, reason: "max_items" });
          break;
        }
        const name = file.name ?? "";
        const path = current.path ? `${current.path}/${name}` : name;
        items.push({
          path,
          name,
          type: file.type ?? "",
          token: file.token ?? "",
          url: file.url,
          owner_id: file.owner_id,
          created_time: file.created_time,
          modified_time: file.modified_time,
          depth: current.depth + 1,
        });

        // 只对文件夹继续下钻；深度到达上限的文件夹留进 pending，交给调用方续跑
        if (recursive && file.type === "folder" && file.token) {
          if (current.depth + 1 < maxDepth) {
            queue.push({ folderToken: file.token, path, depth: current.depth + 1 });
          } else {
            pending.push({ folder_token: file.token, path, reason: "max_depth" });
          }
        }
      }
    }

    return jsonResult({
      root_folder_token: startToken,
      root_path: "",
      recursive,
      max_depth: maxDepth,
      items_count: items.length,
      pages_fetched: maxCalls - budget.left,
      truncated: pending.length > 0,
      pending_folders: pending,
      items,
    });
  },
};
