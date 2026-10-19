import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { BrowserIdentityError, createBrowserIdentityService } from "./browser-connect.js";

const service = createBrowserIdentityService();

/** Private server-to-server endpoint; never proxied to a public browser. */
export async function handleBrowserIdentityRequest(req: IncomingMessage, res: ServerResponse, tokens: string[]): Promise<void> {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const supplied = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  if (!/^Bearer\s+/i.test(req.headers.authorization ?? "") || !tokens.some((token) => {
    const expected = Buffer.from(token);
    return expected.length > 0 && supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  })) {
    res.writeHead(401); res.end(JSON.stringify({ error: "UNAUTHORIZED" })); return;
  }
  if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end("{}"); return; }
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > 16_384) { res.writeHead(413); res.end("{}"); return; }
      chunks.push(Buffer.from(chunk));
    }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { res.writeHead(400); res.end(JSON.stringify({ error: "INVALID_JSON" })); return; }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      res.writeHead(400); res.end(JSON.stringify({ error: "INVALID_REQUEST" })); return;
    }
    const result = await service.handle(input as Record<string, unknown>);
    res.writeHead(200); res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(error instanceof BrowserIdentityError ? error.status : 502);
    res.end(JSON.stringify({ error: error instanceof BrowserIdentityError ? error.code : "IDENTITY_UNAVAILABLE" }));
  }
}
