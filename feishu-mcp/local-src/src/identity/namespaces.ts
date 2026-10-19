/**
 * 凭证命名空间：每个账号一个独立目录，作为 lark-cli 的 HOME。
 *
 * 已验证 lark-cli 的落盘位置全部相对 $HOME：
 *   ~/.lark-cli/config.json                     （App 配置）
 *   ~/.local/share/lark-cli/master.key          （加密主密钥）
 *   ~/.local/share/lark-cli/appsecret_*.enc     （App Secret，密文）
 *   ~/.local/share/lark-cli/cli_*_<openid>.enc  （用户 token，密文）
 * 所以切 HOME 即完全隔离。
 *
 * 关键：给新账号只复制 App 配置（config.json + master.key + appsecret），
 * **绝不复制 cli_*_<openid>.enc 用户 token** —— 否则新账号会继承旧登录态，
 * 那正是要修的多账号串号（PRD §14.1）。
 */
import fs from "node:fs";
import path from "node:path";
import { BASE_HOME, baseSecretDir } from "./context.js";
import { dataDir } from "./store.js";

export function authRoot(): string {
  return process.env.FEISHU_AUTH_ROOT || path.join(dataDir(), "feishu-auth");
}

export function namespaceDir(accountId: string): string {
  return path.join(authRoot(), accountId);
}

function baseConfigFile(): string {
  return path.join(BASE_HOME, ".lark-cli", "config.json");
}

/** 确保目录存在且权限收紧（token 目录 0700，文件 0600）。 */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* 某些文件系统不支持 chmod，忽略 */
  }
}

function copyFile0600(src: string, dest: string): void {
  fs.copyFileSync(src, dest);
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    /* ignore */
  }
}

/** 复制一个 App 的配置（config.json + master.key + appsecret_*），不含用户 token。 */
function copyAppConfig(sourceHome: string, ns: string, secretDir: string): void {
  const nsData = path.join(ns, ".local", "share", "lark-cli");
  ensureDir(path.join(ns, ".lark-cli"));
  ensureDir(nsData);

  const cfg = path.join(sourceHome, ".lark-cli", "config.json");
  if (fs.existsSync(cfg)) copyFile0600(cfg, path.join(ns, ".lark-cli", "config.json"));

  if (fs.existsSync(secretDir)) {
    for (const f of fs.readdirSync(secretDir)) {
      if (f === "master.key" || f.startsWith("appsecret_")) {
        copyFile0600(path.join(secretDir, f), path.join(nsData, f));
      }
    }
  }
}

/**
 * 为新账号准备 App 配置（不含用户 token）。
 * @param sourceHome 指定时用该 HOME 下的 App 配置（多组织时指向已注册应用模板）；
 *                   缺省用 base 默认应用。
 */
export function seedAppConfig(accountId: string, sourceHome?: string): void {
  const ns = namespaceDir(accountId);
  if (sourceHome) {
    copyAppConfig(sourceHome, ns, path.join(sourceHome, ".local", "share", "lark-cli"));
  } else {
    copyAppConfig(BASE_HOME, ns, baseSecretDir());
  }
}

/**
 * 迁移旧登录态：完整复制 base 凭证（含用户 token），使老用户升级后无需重新授权。
 */
export function seedFullCredentials(accountId: string): void {
  const ns = namespaceDir(accountId);
  const nsData = path.join(ns, ".local", "share", "lark-cli");
  ensureDir(path.join(ns, ".lark-cli"));
  ensureDir(nsData);

  const cfg = baseConfigFile();
  if (fs.existsSync(cfg)) copyFile0600(cfg, path.join(ns, ".lark-cli", "config.json"));

  const base = baseSecretDir();
  if (fs.existsSync(base)) {
    for (const f of fs.readdirSync(base)) {
      const src = path.join(base, f);
      if (fs.statSync(src).isFile()) copyFile0600(src, path.join(nsData, f));
    }
  }
}

/** 删除 namespace 目录。只允许删 authRoot 之下，防路径穿越误删。 */
export function removeNamespace(accountId: string): void {
  const root = path.resolve(authRoot());
  const dir = path.resolve(namespaceDir(accountId));
  if (dir !== root && dir.startsWith(root + path.sep)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
