import crypto from "node:crypto";
import fs from "node:fs";
import type { AccountRecord } from "./context.js";
import { BASE_HOME, runWithContext } from "./context.js";
import { runLarkCli } from "../larkCli.js";
import { listApps } from "./apps.js";
import { namespaceDir, removeNamespace, seedAppConfig } from "./namespaces.js";
import { ensureMigrated, hydrateAccountAppId, runAuthStatus, startConnect } from "./oauth.js";
import { getAccount, getOAuthSession, listAccounts, listOAuthSessions, newAccountId, updateOAuthSession } from "./store.js";
import { registrationClient, verificationURL, type Registration } from "./browser-provider.js";

export class BrowserIdentityError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const fail = (status: number, code: string): never => { throw new BrowserIdentityError(status, code); };
const publicAccount = (a: AccountRecord) => ({ account_id: a.id, alias: a.alias, user_name: a.user_name,
  app_id: a.app_id, app_alias: a.app_alias, tenant_key: a.tenant_key, tenant_name: a.tenant_name, open_id: a.open_id });
const sameIdentity = (a: AccountRecord, b: AccountRecord) => !!a.app_id && a.app_id === b.app_id
  && a.open_id === b.open_id && (a.tenant_key ?? "") === (b.tenant_key ?? "");

interface Flow {
  id: string;
  userId: string;
  alias?: string;
  expectedAppId?: string;
  registration?: Registration;
  nextPoll: number;
  expiresAt: number;
  status: "registering" | "authorizing" | "ready" | "failed" | "expired";
  verificationURL: string;
  oauthSessionId?: string;
  accountId?: string;
  stagingId?: string;
  busy?: boolean;
  cancelled?: boolean;
  initialAccountIds: string[];
}

export function createBrowserIdentityService(options: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const provider = registrationClient(options.fetchImpl);
  const flows = new Map<string, Flow>();
  function owned(id: unknown, user: string): Flow {
    const flow = typeof id === "string" ? flows.get(id) : undefined;
    if (!flow || flow.userId !== user || flow.cancelled) return fail(404, "Flow not found");
    return flow;
  }
  function snapshot(flow: Flow) {
    const account = flow.accountId ? getAccount(flow.userId, flow.accountId) : undefined;
    return { flow_id: flow.id, status: flow.status, verification_url: flow.verificationURL,
      expires_at: new Date(flow.expiresAt).toISOString(), account: account ? { ...publicAccount(account),
        already_connected: flow.initialAccountIds.some((id) => {
          const previous = getAccount(flow.userId, id);
          return previous && sameIdentity(previous, account);
        }),
        same_organization_as: listAccounts(flow.userId).filter((a) => a.id !== account.id
          && !!account.tenant_key && a.tenant_key === account.tenant_key).map((a) => a.alias),
      } : undefined };
  }
  function stop(flow: Flow, status: "failed" | "expired") {
    flow.status = status;
    delete flow.registration;
    if (flow.oauthSessionId && getOAuthSession(flow.oauthSessionId)?.status === "pending") {
      updateOAuthSession(flow.oauthSessionId, { status: "failed", error: "BROWSER_FLOW_ENDED" });
    }
    if (flow.stagingId) { removeNamespace(flow.stagingId); delete flow.stagingId; }
  }
  async function advance(flow: Flow) {
    if (["ready", "failed", "expired"].includes(flow.status)) return snapshot(flow);
    if (flow.expiresAt <= now()) { stop(flow, "expired"); return snapshot(flow); }
    if (flow.busy) return snapshot(flow);
    flow.busy = true;
    try {
      if (flow.status === "registering" && flow.registration && now() >= flow.nextPoll) {
        flow.nextPoll = now() + flow.registration.interval * 1000;
        const data = await provider.poll(flow.registration.deviceCode);
        if (flow.cancelled || flow.expiresAt <= now()) { stop(flow, "expired"); return snapshot(flow); }
        if ((data.user_info as { tenant_brand?: string } | undefined)?.tenant_brand === "lark") {
          stop(flow, "failed");
        } else if (typeof data.client_id === "string" && typeof data.client_secret === "string" && data.client_secret) {
          if (!/^cli_[A-Za-z0-9]+$/.test(data.client_id) || (flow.expectedAppId && flow.expectedAppId !== data.client_id)) {
            stop(flow, "failed"); return snapshot(flow);
          }
          const accountId = newAccountId();
          flow.stagingId = accountId;
          const ns = namespaceDir(accountId);
          fs.mkdirSync(ns, { recursive: true, mode: 0o700 });
          // App Secret stays on the server, out of argv, HTML and MCP results.
          await runWithContext({ userId: flow.userId, credentialNamespace: ns }, () =>
            runLarkCli(["config", "init", "--app-id", String(data.client_id), "--app-secret-stdin", "--brand", "feishu"],
              { stdin: data.client_secret + "\n", noIdentity: true, timeoutMs: 30_000 }));
          if (flow.cancelled) { stop(flow, "failed"); return snapshot(flow); }
          const login = await startConnect(flow.userId, undefined, flow.alias, undefined,
            { accountId, appId: data.client_id });
          delete flow.stagingId;
          delete flow.registration;
          flow.oauthSessionId = login.session_id;
          if (flow.cancelled) { stop(flow, "failed"); return snapshot(flow); }
          flow.verificationURL = verificationURL(login.verification_url);
          flow.expiresAt = Date.parse(login.expires_at);
          flow.status = "authorizing";
          // Show the user authorization step before reporting ready.
          return snapshot(flow);
        } else if (data.error === "slow_down") {
          flow.registration.interval = Math.min(flow.registration.interval + 5, 60);
          flow.nextPoll = now() + flow.registration.interval * 1000;
        } else if (data.error && data.error !== "authorization_pending") {
          stop(flow, data.error === "expired_token" ? "expired" : "failed");
        }
      }
      if (flow.status === "authorizing" && flow.oauthSessionId) {
        const session = getOAuthSession(flow.oauthSessionId);
        if (!session || session.status === "failed" || session.status === "expired") stop(flow, "failed");
        else if (session.status === "ready" && session.account_id) {
          if (!getAccount(flow.userId, session.account_id)) stop(flow, "failed");
          else { flow.status = "ready"; flow.accountId = session.account_id; }
        }
      }
    } catch {
      // Provider/CLI failures can include credentials; expose only a terminal state.
      stop(flow, "failed");
    } finally { flow.busy = false; }
    return snapshot(flow);
  }

  return {
    async handle(input: Record<string, unknown>) {
      const user = typeof input.user_id === "string" && input.user_id ? input.user_id : fail(400, "USER_REQUIRED");
      if (input.action === "list") {
        await ensureMigrated(user);
        const apps = listApps();
        try {
          const base = await runAuthStatus(BASE_HOME);
          if (base.appId) apps.unshift({ alias: "", app_id: base.appId });
        } catch { /* No default app configured. Official onboarding remains available. */ }
        const accounts = await Promise.all(listAccounts(user).map(hydrateAccountAppId));
        const seen = new Set<string>();
        const incomplete = listOAuthSessions(user).slice().reverse().filter((s) => {
          if (s.status === "ready" || !s.app_id || accounts.some((a) => a.app_id === s.app_id) || seen.has(s.app_id)) return false;
          seen.add(s.app_id); return true;
        }).slice(0, 5).map((s) => ({ session_id: s.id, alias: s.alias, app_id: s.app_id }));
        return { accounts: accounts.map((a, i) => ({ ...publicAccount(a),
          same_identity_as: accounts.slice(0, i).find((b) => sameIdentity(a, b))?.id })), apps, incomplete };
      }
      if (input.action === "verify") {
        const a = typeof input.account_id === "string" ? getAccount(user, input.account_id) : undefined;
        if (!a) return fail(404, "Account not found");
        await hydrateAccountAppId(a);
        const status = await runAuthStatus(a.credential_namespace, true);
        const state = status.identities?.user?.status;
        if (state !== "ready" && state !== "needs_refresh") return fail(409, "AUTH_INVALID");
        return { account: publicAccount(a) };
      }
      if (input.action === "status") return advance(owned(input.flow_id, user));
      if (input.action === "cancel") {
        const flow = owned(input.flow_id, user);
        flow.cancelled = true;
        if (!flow.busy) stop(flow, "failed");
        if (flow.oauthSessionId) updateOAuthSession(flow.oauthSessionId, { status: "failed", error: "BROWSER_FLOW_ENDED" });
        flows.delete(flow.id);
        return { cancelled: true };
      }
      if (input.action !== "begin") return fail(400, "UNKNOWN_ACTION");
      // Expire abandoned flows, bound memory use, and avoid unbounded provider jobs.
      for (const [id, flow] of flows) if (flow.expiresAt + 60_000 <= now() && !flow.busy) { stop(flow, "expired"); flows.delete(id); }
      if (flows.size >= 512 || [...flows.values()].filter((f) => f.userId === user && !["ready", "failed", "expired"].includes(f.status)).length >= 5) {
        return fail(429, "TOO_MANY_PENDING_CONNECTIONS");
      }
      const resume = typeof input.oauth_session_id === "string" ? getOAuthSession(input.oauth_session_id) : undefined;
      if (typeof input.oauth_session_id === "string" && (!resume?.app_id || resume.user_id !== user)) return fail(404, "Session not found");
      const appId = resume?.app_id ?? (typeof input.app_id === "string" ? input.app_id.trim() : undefined);
      if (appId && !/^cli_[A-Za-z0-9]+$/.test(appId)) return fail(400, "INVALID_APP_ID");
      const flow: Flow = { id: crypto.randomBytes(24).toString("base64url"), userId: user,
        alias: resume?.alias ?? (typeof input.alias === "string" ? input.alias.trim().slice(0, 80) || undefined : undefined),
        initialAccountIds: listAccounts(user).map((a) => a.id),
        expectedAppId: appId, status: "registering", verificationURL: "", nextPoll: now(), expiresAt: now() + 600_000 };
      if (typeof input.account_id === "string") {
        const account = getAccount(user, input.account_id);
        if (!account?.app_id) return fail(404, "Account not found");
        const accountId = newAccountId();
        seedAppConfig(accountId, account.credential_namespace);
        try {
          const login = await startConnect(user, undefined, flow.alias ?? account.alias, undefined,
            { accountId, appId: account.app_id });
          flow.oauthSessionId = login.session_id;
          flow.verificationURL = verificationURL(login.verification_url);
          flow.expiresAt = Date.parse(login.expires_at);
          flow.status = "authorizing";
        } catch { removeNamespace(accountId); return fail(502, "FEISHU_AUTH_FAILED"); }
      } else if (typeof input.app_alias === "string") {
        const login = await startConnect(user, undefined, flow.alias, input.app_alias || undefined);
        flow.oauthSessionId = login.session_id;
        flow.verificationURL = verificationURL(login.verification_url);
        flow.expiresAt = Date.parse(login.expires_at);
        flow.status = "authorizing";
      } else {
        flow.registration = await provider.begin(appId);
        flow.verificationURL = flow.registration.verificationURL;
        flow.expiresAt = now() + flow.registration.expiresIn * 1000;
      }
      flows.set(flow.id, flow);
      return snapshot(flow);
    },
  };
}
