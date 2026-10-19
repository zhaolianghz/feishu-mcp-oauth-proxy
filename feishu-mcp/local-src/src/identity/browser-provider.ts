import { gzipSync } from "node:zlib";

const ENDPOINT = "https://accounts.feishu.cn/oauth/v1/app/registration";
const HOSTS = new Set(["accounts.feishu.cn", "open.feishu.cn"]);
export const USER_SCOPES = ["contact:user.base:readonly", "offline_access", "docx:document",
  "drive:drive", "sheets:spreadsheet", "bitable:app", "wiki:wiki:readonly", "search:docs:read"];

export interface Registration {
  deviceCode: string;
  verificationURL: string;
  expiresIn: number;
  interval: number;
}

export function verificationURL(raw: unknown): string {
  const url = new URL(String(raw));
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.port || url.username || url.password) {
    throw new Error("Invalid Feishu verification URL");
  }
  return url.href;
}

const seconds = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, 3600) : fallback;

/** Official device registration protocol; never returns credentials to browsers. */
export function registrationClient(fetchImpl: typeof fetch = fetch) {
  async function request(form: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await fetchImpl(ENDPOINT, { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(30_000), redirect: "error" });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok && !data.error) throw new Error("Feishu registration unavailable");
    return data;
  }
  return {
    async begin(appId?: string): Promise<Registration> {
      const data = await request({ action: "begin", archetype: "PersonalAgent",
        auth_method: "client_secret", request_user_info: "open_id tenant_brand" });
      if (data.error || typeof data.device_code !== "string" || !data.device_code) {
        throw new Error("Feishu registration could not begin");
      }
      const url = new URL(verificationURL(data.verification_uri_complete));
      url.searchParams.set("from", "sdk");
      url.searchParams.set("tp", "sdk");
      url.searchParams.set("source", "feishu-mcp");
      // Omit createOnly so the platform can offer existing-app onboarding.
      if (appId) url.searchParams.set("clientID", appId);
      url.searchParams.set("addons", gzipSync(JSON.stringify({ preset: false, scopes: { user: USER_SCOPES } })).toString("base64url"));
      return { deviceCode: data.device_code, verificationURL: url.href,
        expiresIn: seconds(data.expire_in ?? data.expires_in, 600), interval: seconds(data.interval, 5) };
    },
    poll(deviceCode: string) { return request({ action: "poll", device_code: deviceCode }); },
  };
}
