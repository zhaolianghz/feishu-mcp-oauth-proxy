/**
 * 多组织应用注册表。
 *
 * 飞书**自建应用只属于一个组织**，所以「一个人不同组织」必须每个组织各建一个
 * 自建应用。这里登记 别名 → appId，并把该 App 的配置**加密**落在模板命名空间
 * 里（由 scripts/05-register-app.sh 调 `lark-cli config init` 生成），连接账号时
 * 复制模板，从而让每个账号用自己组织的 App 授权。
 *
 * 明文 App Secret 从不落到本文件，只在注册时经 stdin 交给 lark-cli 加密存储。
 */
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./store.js";

interface AppEntry {
  app_id: string;
}
interface AppsFile {
  apps: Record<string, AppEntry>;
}

export function appsFile(): string {
  return path.join(dataDir(), "apps.json");
}

/** 别名对应的模板 HOME（内含该 App 的加密配置，可被复制进账号命名空间）。 */
export function appTemplateDir(alias: string): string {
  return path.join(dataDir(), "feishu-apps", alias);
}

function validAlias(alias: string): boolean {
  return alias.length > 0 && !alias.includes("/") && !alias.includes("\\") && !alias.includes("..");
}

function load(): AppsFile {
  try {
    return JSON.parse(fs.readFileSync(appsFile(), "utf8")) as AppsFile;
  } catch {
    return { apps: {} };
  }
}

function save(f: AppsFile): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = appsFile() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, appsFile());
}

export function listApps(): { alias: string; app_id: string }[] {
  return Object.entries(load().apps).map(([alias, e]) => ({ alias, app_id: e.app_id }));
}

export function getApp(alias: string): AppEntry | undefined {
  return validAlias(alias) ? load().apps[alias] : undefined;
}

export function registerApp(alias: string, appId: string): void {
  if (!validAlias(alias)) throw new Error(`应用别名非法：${alias}`);
  if (!appId) throw new Error("app_id 不能为空");
  const f = load();
  f.apps[alias] = { app_id: appId };
  save(f);
}
