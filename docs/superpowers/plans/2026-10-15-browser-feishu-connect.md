# Browser Feishu Connect Implementation Plan

**Goal:** ChatGPT「连接另一个账户」通过浏览器完成飞书应用接入、用户授权及独立账号绑定。

**Architecture:** OAuth proxy browser transactions call a bearer-protected internal identity endpoint on feishu-mcp. Backend reuses credential namespaces and device login; grants carry an immutable account identity.

**Tech Stack:** Node 22, Express 4, TypeScript, node:test, official Feishu app registration protocol, lark-cli.

## Global Constraints

No manual Secret input, no server commands for users, no automatic new application creation, no credential leakage, preserve existing company connections and uncommitted work.

## Tasks

- [x] Add HTTP regression tests reproducing login skipping account choice, same-client account mixups and spoofed identity headers. Run `node --test feishu-mcp-oauth/test/*.test.mjs` and observe failures before implementation.
- [x] Add backend identity service tests for official app registration begin/poll, continuation into device login, rejection/expiry, ownership checks and credential secrecy. Use a fake external Feishu transport and controlled CLI executable; keep state, namespace and routing logic real.
- [x] Implement `identity/browser-provider.ts`, `identity/browser-connect.ts`, `identity/browser-http.ts`; extend OAuth session completion with resulting account ID, isolated provisioning and actual app metadata. Add fail-closed account resolution and authenticated profile tool.
- [x] Implement `feishu-mcp-oauth/browser-connect.js` and integrate it with `/authorize`, proxy login callbacks, token issuance/refresh and trusted identity headers. Require browser session and per-flow CSRF; show selected account before callback.
- [x] Extend deployment overlay patch for internal endpoint and profile metadata; copy browser module into proxy image. Verify patch fresh apply and idempotence against upstream checkout.
- [x] Run TypeScript build, identity selfcheck, backend/proxy tests, existing OAuth flow checks updated to select an account, and inspect final diff. Document deployment and live authorization verification limits.

The user approved the flow in chat and explicitly requested development; execute in this session without another approval gate.
