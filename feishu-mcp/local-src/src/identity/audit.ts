/**
 * 审计日志：JSONL 追加写。只记「谁、代表哪个账号、做了什么、成没成」，
 * 绝不记文档正文、prompt、access/refresh token（PRD §14.3 / §23）。
 */
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./store.js";

export interface AuditEvent {
  user_id: string;
  feishu_account_id?: string;
  action: string;
  resource_type?: string;
  resource_id?: string;
  success: boolean;
  error_code?: string;
}

export function appendAudit(ev: AuditEvent): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const line = JSON.stringify({ ...ev, created_at: new Date().toISOString() }) + "\n";
    fs.appendFileSync(path.join(dataDir(), "audit.jsonl"), line, { mode: 0o600 });
  } catch {
    // 审计失败不能影响主流程
  }
}
