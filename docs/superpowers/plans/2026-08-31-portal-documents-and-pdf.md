# Client portal documents & PDF preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the B2B portal from a quote-request inbox into a follow-up workspace: the client sees the live SAP document chain for a project, browses their own quotations/orders/deliveries/invoices, and previews or downloads the real SAP PDF of any of them — and internal users get the same PDF buttons.

**Architecture:** No schema change and no new `B1Transport` method. Four moves: (1) the agent grows a second on-prem client, `ApiGateway`, for the SAP B1 API Gateway Reporting Service, reachable through a new `POST /print` agent route; (2) the bodies of `entities.rows`/`.one` move into `apps/server/src/entity-read.ts` so the portal router reuses one implementation; (3) the portal's fence is a **filtered `B1EntitySchema`** — the allowlist becomes the schema, so `compileList`'s existing rules (a `select` on a missing field is dropped, a `filter` on one throws) do the fencing with no new policy code, and the CardCode clause is appended to the compiled OData filter where a client can never name it; (4) `EntityListPage`/`EntityObjectPage` gain one `scope` prop and get mounted under `/portal/docs/*`.

**Tech Stack:** Bun · Hono · oRPC · Drizzle/Postgres 17 · React 19 + TanStack Router/Query · UI5 Web Components React 2.25 · zod v4 · SAP B1 Service Layer `/b1s/v2` + SAP B1 API Gateway `/rs/v1`

**Spec:** `C:\Users\bazkarate.SEIDORBCN\.claude\plans\i-want-to-redesign-sunny-kurzweil.md` (this plan's source; copy it to `docs/superpowers/specs/2026-08-31-portal-documents-and-pdf.md` in Task 1 so it travels with the plan)

## Global Constraints

- **Bun only.** Never `npm`/`npx`. Package installs are `bun add`; scripts run via `bun run`.
- **No schema change.** `packages/db` is not modified by any task in this plan. No `bun run db:push`.
- **Imports carry explicit `.ts` extensions**; `verbatimModuleSyntax` is on, so type-only imports must use `import type`.
- **Workspace packages must be direct dependencies.** If a task adds an import from a workspace package not already in that `package.json`, add it and re-run `bun install`. (No task in this plan should need one — check before assuming.)
- **Type-checking is the gate; there is no lint step.** It is per project: `bunx tsc -p <project>/tsconfig.json --noEmit` for each of `packages/{b1,config-engine,db,assistant}`, `apps/{agent,server,web}`. `apps/server/tsconfig.json` also covers `scripts/`.
- **Test scoping:** always `bun test apps packages` or narrower. A bare `bun test` picks up the vendored `b1-mcp-server/` whose suite fails.
- **Server tests need a real Postgres** and `DATABASE_URL`; they self-skip without it. Wrap new server test suites in `describe.skipIf(!process.env.DATABASE_URL)(...)`.
- **`// ponytail:` comments are decisions, not oversights.** Do not delete existing ones. Add one when a task takes a shortcut with a known ceiling.
- **Comments explain _why_.** Several existing comments carry verified error strings from a live B1 — do not "clean those up".
- **Every write to SAP carries an ETag.** Nothing in this plan writes to SAP; if a step seems to need a write, stop and re-read it.
- **Commit after every task**, using the message given in the task's final step.

---

## File Structure

**New (10)**

| File | Responsibility |
|---|---|
| `apps/agent/src/api-gateway.ts` | The API Gateway client: session login (one in-flight promise), `exportPdf(entity, docEntry)` → base64. Knows nothing about HERA. |
| `apps/agent/test/api-gateway.test.ts` | Mock gateway over `Bun.serve`: one login for N calls, re-login on 401, unknown layout refuses. |
| `scripts/print-smoke.ts` | Live one-shot against the real gateway. Confirms the login route, the `DocKey@` parameter name and the four layout codes, writes `out.pdf`. |
| `apps/server/src/entity-read.ts` | `readRows` / `readOne` / `bad` — the B1 read bodies both routers share. Pure of procedure builders. |
| `apps/server/src/print.ts` | `printDocument(tenantId, entity, docEntry)` — `agentPost` to `/print`, errors through `toOrpcError`. |
| `apps/server/src/doc-chain.ts` | The Quotation → Order → Delivery → Invoice walk as three `CrossJoinSpec`s. Pure query-shape + flatten helpers plus one orchestrator taking a `B1Transport`. |
| `apps/server/test/portal-docs.test.ts` | The portal fence: CardCode on every read, no field outside the allowlist, print refusals. |
| `apps/server/test/doc-chain.test.ts` | Pure: the three hop filters and the dedupe. |
| `apps/web/src/components/b1/PrintActions.tsx` | The only place printing exists in the UI: Preview dialog + Download, base64 → blob URL. |
| `apps/web/src/routes/_authed/portal/docs/$entity.tsx` + `$entity_.$key.tsx` | Two 4-line route mounts (counted as one row; they are two files). |

**Modified (17)**

`apps/agent/src/index.ts` · `apps/agent/agent.example.json` · `apps/agent/tsconfig.json` ·
`packages/b1/src/remote.ts` · `apps/server/src/b1.ts` · `apps/server/src/entity-profiles.ts` ·
`apps/server/src/seed-variants.ts` · `apps/server/src/auth.ts` · `scripts/seed-standard.ts` ·
`apps/server/src/orpc/routers/entities.ts` · `apps/server/src/orpc/routers/portal.ts` ·
`apps/server/test/mock-agent.ts` · `apps/server/test/invites.test.ts` ·
`apps/web/src/variants.ts` · `apps/web/src/components/ListReport.tsx` ·
`apps/web/src/components/b1/EntityListPage.tsx` + `EntityObjectPage.tsx` ·
`apps/web/src/components/AppShell.tsx` · `apps/web/src/routes/_authed/portal/index.tsx` ·
`apps/web/src/components/portal/PortalRequestSummary.tsx` · `apps/web/src/routes/_authed/settings.tsx` ·
`package.json` (one script)

**Unchanged:** `packages/db`, `packages/config-engine`, `packages/b1`'s `B1Transport`/`query.ts`/`service-layer.ts`/`client.ts`, the 4-step portal wizard and every `Step*` component, `apps/web/src/listSpec.ts`.

**Note — the spec is already ahead of itself in one place.** `apps/agent/agent.json` on this machine **already carries** a filled `apiGateway` block with `url`, credentials, `allowSelfSigned` and four layout codes (`QUT20009`, `RDR20011`, `DLN20013`, `INV20017`). Task 1 therefore *verifies* those codes rather than discovering them. If `print-smoke.ts` rejects one, fix that entry in `agent.json` and re-run; nothing else changes.

---

## Build order

1–3 Print end to end (agent → server → internal UI). 4–5 Portal document reads. 6–7 Portal variants + the portal pages. 8–9 The timeline. 10 Portal projects list. 11 The business-partner binding.

---

### Task 1: The agent's API Gateway client and `/print` route

The SAP B1 API Gateway is a **different service** from the Service Layer: different port, different login (`POST /login`, not `/b1s/v2/Login`), and its export returns a base64 **string**. It deliberately does not go through `B1Transport` — that would mean a 9th transport method, a `query.ts` path shape it cannot express, and a binary channel `ServiceLayer.request` does not have. Base64 is JSON-safe, so the agent's existing `Response.json` reply channel is already enough.

**Files:**
- Create: `apps/agent/src/api-gateway.ts`
- Create: `apps/agent/test/api-gateway.test.ts`
- Create: `scripts/print-smoke.ts`
- Create: `docs/superpowers/specs/2026-08-31-portal-documents-and-pdf.md` (copy of the spec)
- Modify: `apps/agent/src/index.ts` (`AgentConfig.apiGateway`, the `/print` route)
- Modify: `apps/agent/tsconfig.json` (include `test`)
- Modify: `apps/agent/agent.example.json` (document the block)
- Modify: `package.json` (add the `print:smoke` script)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `apps/agent/src/api-gateway.ts` → `export type ApiGatewayConfig = { url: string; companyDb: string; user: string; pass: string; layouts: Record<string, string>; allowSelfSigned?: boolean; timeoutMs?: number }` and `export class ApiGateway { constructor(o: ApiGatewayConfig, logger?: Logger); exportPdf(entity: string, docEntry: number): Promise<{ pdf: string; fileName: string }> }`.
  - The agent HTTP surface gains `POST /print` with body `{ entity: string, docEntry: number }` and reply `{ pdf: string, fileName: string }`. Errors use the existing `fail()` envelope: `{ error: { status, code, message } }`.

- [ ] **Step 1: Copy the spec next to the plan**

```bash
cp "C:/Users/bazkarate.SEIDORBCN/.claude/plans/i-want-to-redesign-sunny-kurzweil.md" \
   docs/superpowers/specs/2026-08-31-portal-documents-and-pdf.md
```

- [ ] **Step 2: Let the agent's tsconfig see its tests**

Replace the whole of `apps/agent/tsconfig.json` with:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write the failing test**

Create `apps/agent/test/api-gateway.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { ApiGateway } from "../src/api-gateway.ts";

// A stand-in for the SAP B1 API Gateway: the two routes the agent uses, plus a counter so the
// "one login for N exports" and "re-login on 401" rules are observable.
function startMockGateway() {
  let logins = 0;
  let rejectNext = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname, searchParams } = new URL(req.url);
      if (pathname === "/login") {
        logins++;
        return new Response("{}", { headers: { "Set-Cookie": `SESSION=s${logins}; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT` } });
      }
      if (pathname === "/rs/v1/ExportPDFData") {
        if (rejectNext) { rejectNext = false; return new Response("no session", { status: 401 }); }
        if (!req.headers.get("cookie")?.startsWith("SESSION=")) return new Response("no session", { status: 401 });
        const body = (await req.json()) as { name: string; value: string[][] }[];
        return Response.json(`PDF:${searchParams.get("DocCode")}:${body[0]!.name}:${body[0]!.value[0]![0]}`);
      }
      return new Response("nope", { status: 404 });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    get logins() { return logins; },
    expire: () => { rejectNext = true; },
    stop: () => void server.stop(true),
  };
}

const CONFIG = (url: string) => ({
  url, companyDb: "TESTDB", user: "manager", pass: "x",
  layouts: { Quotations: "QUT20009", Orders: "RDR20011" },
});

let gw: ReturnType<typeof startMockGateway> | null = null;
afterEach(() => { gw?.stop(); gw = null; });

describe("ApiGateway", () => {
  test("exports a PDF with the DocKey@ parameter and names the file", async () => {
    gw = startMockGateway();
    const out = await new ApiGateway(CONFIG(gw.url)).exportPdf("Quotations", 12045);
    expect(out.pdf).toBe("PDF:QUT20009:DocKey@:12045");
    expect(out.fileName).toBe("Quotations-12045.pdf");
  });

  test("N concurrent exports cost exactly one login", async () => {
    gw = startMockGateway();
    const g = new ApiGateway(CONFIG(gw.url));
    await Promise.all([g.exportPdf("Quotations", 1), g.exportPdf("Orders", 2), g.exportPdf("Quotations", 3)]);
    expect(gw.logins).toBe(1);
  });

  test("a dropped session is re-logged-in once, transparently", async () => {
    gw = startMockGateway();
    const g = new ApiGateway(CONFIG(gw.url));
    await g.exportPdf("Quotations", 1);
    gw.expire();
    expect((await g.exportPdf("Quotations", 2)).pdf).toBe("PDF:QUT20009:DocKey@:2");
    expect(gw.logins).toBe(2);
  });

  test("an entity with no configured layout refuses before any network call", async () => {
    gw = startMockGateway();
    const g = new ApiGateway(CONFIG(gw.url));
    await expect(g.exportPdf("Invoices", 1)).rejects.toThrow(/No print layout/);
    expect(gw.logins).toBe(0);
  });
});
```

- [ ] **Step 4: Run it to make sure it fails**

Run: `bun test apps/agent`
Expected: FAIL — `Cannot find module '../src/api-gateway.ts'`

- [ ] **Step 5: Write the implementation**

Create `apps/agent/src/api-gateway.ts`:

```ts
import { B1Error, silentLogger, type Logger } from "@hera/b1";

// The SAP B1 API Gateway's Reporting Service. A *different service* from the Service Layer:
// its own port, its own `POST /login`, and an export that answers with a base64 string rather
// than a document. That is why it is not a B1Transport method — there is no URL shape query.ts
// could express and no binary channel ServiceLayer.request has. Base64 is JSON-safe, so the
// agent's existing Response.json reply channel carries it unchanged.
//
// Two lessons are copied verbatim from packages/b1/src/service-layer.ts because they were paid
// for once already:
//   - getSetCookie(), never a split(",") — that shreds `Expires=Wed, 09 Jun ...` and loses the
//     load-balancer's route cookie.
//   - one in-flight login promise, so N cold concurrent requests are one login, not N.

export type ApiGatewayConfig = {
  /** e.g. https://localhost:60020 */
  url: string;
  companyDb: string;
  user: string;
  pass: string;
  /** entity set -> the Crystal layout DocCode that prints it, e.g. { Quotations: "QUT20009" } */
  layouts: Record<string, string>;
  /** The gateway ships a self-signed cert on a stock install. */
  allowSelfSigned?: boolean;
  timeoutMs?: number;
};

export class ApiGateway {
  private readonly base: string;
  private cookieHeader: string | null = null;
  private loginInFlight: Promise<void> | null = null;

  constructor(private readonly o: ApiGatewayConfig, private readonly logger: Logger = silentLogger) {
    this.base = o.url.replace(/\/+$/, "");
  }

  /** Bun-specific: Bun's fetch ignores undici's `dispatcher`, so self-signed handling is `tls`. */
  private init(extra: RequestInit): RequestInit {
    return {
      ...extra,
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000),
      ...(this.o.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
    } as RequestInit;
  }

  private async login(): Promise<void> {
    const res = await fetch(
      `${this.base}/login`,
      this.init({
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ CompanyDB: this.o.companyDb, UserName: this.o.user, Password: this.o.pass }),
      }),
    );
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      throw new B1Error(res.status, null, `API Gateway login failed (${res.status}): ${text}`);
    }
    const cookies = res.headers.getSetCookie();
    if (!cookies.length) throw new B1Error(res.status, null, "API Gateway login returned no session cookie");
    this.cookieHeader = cookies.map((c) => c.split(";")[0]!.trim()).filter(Boolean).join("; ");
    this.logger.info("API Gateway login successful");
  }

  private ensureSession(): Promise<void> {
    if (this.cookieHeader !== null) return Promise.resolve();
    this.loginInFlight ??= this.login().finally(() => { this.loginInFlight = null; });
    return this.loginInFlight;
  }

  /** The document layout parameter body. `DocKey@` is Crystal's name for the document key —
   *  confirmed against the live gateway by scripts/print-smoke.ts step 3. */
  private static body(docEntry: number) {
    return [{ name: "DocKey@", type: "xsd:string", value: [[String(docEntry)]] }];
  }

  async exportPdf(entity: string, docEntry: number): Promise<{ pdf: string; fileName: string }> {
    const layout = this.o.layouts[entity];
    if (!layout) throw new B1Error(400, null, `No print layout configured for '${entity}' in agent.json apiGateway.layouts`);
    if (!Number.isFinite(docEntry)) throw new B1Error(400, null, `Not a document key: '${docEntry}'`);

    const pdf = await this.post(layout, docEntry, false);
    return { pdf, fileName: `${entity}-${docEntry}.pdf` };
  }

  private async post(layout: string, docEntry: number, retried: boolean): Promise<string> {
    await this.ensureSession();
    const res = await fetch(
      `${this.base}/rs/v1/ExportPDFData?DocCode=${encodeURIComponent(layout)}`,
      this.init({
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: this.cookieHeader! },
        body: JSON.stringify(ApiGateway.body(docEntry)),
      }),
    );

    if (res.status === 401 && !retried) {
      // The session died on the gateway's side; drop ours and go once round again.
      this.cookieHeader = null;
      return this.post(layout, docEntry, true);
    }

    const text = await res.text();
    if (!res.ok) throw new B1Error(res.status, null, `API Gateway ExportPDFData ${layout} failed (${res.status}): ${text.slice(0, 500)}`);

    // The gateway answers with a bare JSON string. Tolerate the two other shapes a Crystal
    // endpoint has been seen to use rather than guess wrong at 3am.
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* a raw base64 body is fine too */ }
    const pdf =
      typeof parsed === "string" ? parsed
      : typeof (parsed as { value?: unknown })?.value === "string" ? (parsed as { value: string }).value
      : typeof (parsed as { PDFData?: unknown })?.PDFData === "string" ? (parsed as { PDFData: string }).PDFData
      : null;
    if (!pdf) throw new B1Error(502, null, `API Gateway returned no PDF data for ${layout}`);
    return pdf;
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test apps/agent`
Expected: PASS — 4 tests.

- [ ] **Step 7: Add the `/print` route to the agent**

In `apps/agent/src/index.ts`:

Add the import next to the existing `@hera/b1` one:

```ts
import { ApiGateway, type ApiGatewayConfig } from "./api-gateway.ts";
```

Extend the config type (replace the existing `AgentConfig` line):

```ts
type AgentConfig = { port?: number; secret: string; b1: ServiceConfig; beas?: ServiceConfig; apiGateway?: ApiGatewayConfig };
```

Construct the gateway just below the `transports` const:

```ts
// Optional: an install without a Reporting Service simply has no apiGateway block, and /print
// answers 503 rather than the agent refusing to start.
const gateway = config.apiGateway ? new ApiGateway(config.apiGateway, logger) : null;
```

Then replace the request-dispatch block inside `Bun.serve`'s `fetch` — everything from
`const [, target, ...rest] = pathname.split("/");` down to the end of the `try`/`catch` — with:

```ts
    logger.info(`${req.method} ${pathname}`);
    try {
      // Print is not a B1Transport operation: it talks to a different service on a different
      // port, so it sits beside the /{target}/{operation} split rather than inside it.
      if (pathname === "/print") {
        if (!gateway) throw new B1Error(503, null, "No apiGateway block in agent.json — printing is not configured");
        const b = (await req.json()) as { entity?: unknown; docEntry?: unknown };
        return Response.json(await gateway.exportPdf(String(b.entity ?? ""), Number(b.docEntry)));
      }

      const [, target, ...rest] = pathname.split("/");
      const transport = target ? transports[target] : undefined;
      const handler = routes[`/${rest.join("/")}`];
      if (!transport) return fail(404, null, `Unknown target '${target}'`);
      if (!handler) return fail(404, null, `Unknown operation '${pathname}'`);

      return Response.json(await handler(transport, await req.json()));
    } catch (e) {
      if (e instanceof B1Error) {
        logger.warn(`${pathname}: ${e.message}`);
        return fail(e.status, e.code, e.message);
      }
      logger.warn(`${pathname}:`, e instanceof Error ? e.message : String(e));
      return fail(502, null, e instanceof Error ? e.message : String(e));
    }
```

Finally, mention printing in the boot log — replace the `console.log` after `Bun.serve`:

```ts
console.log(`hera-agent on :${server.port} — services: ${Object.keys(services).join(", ")}${gateway ? " + print" : ""}`);
```

- [ ] **Step 8: Document the block in the example config**

Replace `apps/agent/agent.example.json` with:

```json
{
  "port": 4000,
  "secret": "dev-secret-change-me-min-32-chars-long",
  "b1": {
    "slUrl": "http://localhost:50001",
    "companyDb": "ALUMIGRAF",
    "user": "manager",
    "pass": "1234",
    "allowSelfSigned": true,
    "timeoutMs": 60000
  },
  "apiGateway": {
    "url": "https://localhost:60020",
    "companyDb": "ALUMIGRAF",
    "user": "manager",
    "pass": "1234",
    "allowSelfSigned": true,
    "layouts": {
      "Quotations": "QUT20009",
      "Orders": "RDR20011",
      "DeliveryNotes": "DLN20013",
      "Invoices": "INV20017"
    }
  }
}
```

- [ ] **Step 9: Write the live smoke script**

Create `scripts/print-smoke.ts`:

```ts
/**
 * One-shot check against the REAL SAP B1 API Gateway, using apps/agent/agent.json.
 *
 *   bun run print:smoke [Quotations] [DocEntry]
 *
 * It answers the three things agent.json's `apiGateway` block asserts and nothing else can
 * verify offline:
 *   1. that `POST /login` is the login route and returns a session cookie,
 *   2. what the configured layout codes actually are (LoadAuthorizedCRList),
 *   3. that the document-key parameter really is named `DocKey@` (LoadCR),
 * then exports one PDF to ./out.pdf and reports its size.
 *
 * A mismatch in (3) means the body in apps/agent/src/api-gateway.ts changes and nothing else.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ApiGateway, type ApiGatewayConfig } from "../apps/agent/src/api-gateway.ts";

const entity = process.argv[2] ?? "Quotations";
const docEntry = Number(process.argv[3] ?? 1);

const config = JSON.parse(readFileSync("apps/agent/agent.json", "utf8")) as { apiGateway?: ApiGatewayConfig };
const gw = config.apiGateway;
if (!gw) throw new Error("apps/agent/agent.json has no apiGateway block");

const base = gw.url.replace(/\/+$/, "");
const tls = gw.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {};

// 1. login
const login = await fetch(`${base}/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ CompanyDB: gw.companyDb, UserName: gw.user, Password: gw.pass }),
  ...tls,
} as RequestInit);
console.log(`1. POST /login -> ${login.status}`);
if (!login.ok) { console.error(await login.text()); process.exit(1); }
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]!.trim()).join("; ");
console.log(`   session: ${cookie.slice(0, 60)}…`);

const get = (path: string) =>
  fetch(`${base}${path}`, { headers: { Cookie: cookie, Accept: "application/json" }, ...tls } as RequestInit);

// 2. every layout this company authorizes, so the `layouts` map can be checked by eye
const list = await get("/rs/v1/LoadAuthorizedCRList");
console.log(`2. GET /rs/v1/LoadAuthorizedCRList -> ${list.status}`);
console.log(`   ${(await list.text()).slice(0, 4000)}`);

// 3. the parameter names of the layout we are about to use
const layout = gw.layouts[entity];
if (!layout) throw new Error(`No layout configured for ${entity}`);
const cr = await get(`/rs/v1/LoadCR?DocCode=${encodeURIComponent(layout)}`);
console.log(`3. GET /rs/v1/LoadCR?DocCode=${layout} -> ${cr.status}`);
console.log(`   ${(await cr.text()).slice(0, 4000)}`);
console.log(`   ^ confirm the document-key parameter is named "DocKey@"`);

// 4. the export itself, through the same class the agent uses
const { pdf, fileName } = await new ApiGateway(gw).exportPdf(entity, docEntry);
const bytes = Buffer.from(pdf, "base64");
writeFileSync("out.pdf", bytes);
console.log(`4. ExportPDFData ${layout} DocKey@=${docEntry} -> ${fileName}, ${bytes.length} bytes -> ./out.pdf`);
if (bytes.subarray(0, 4).toString() !== "%PDF") console.error("   !! that is not a PDF header — check the layout code");
```

Add the script to the root `package.json` `"scripts"` block (next to `"e2e"`):

```json
    "print:smoke": "bun scripts/print-smoke.ts",
```

- [ ] **Step 10: Typecheck**

Run:
```bash
bunx tsc -p apps/agent/tsconfig.json --noEmit
bunx tsc -p apps/server/tsconfig.json --noEmit
```
Expected: no output from either. (`scripts/` is checked by the server project.)

- [ ] **Step 11: Verify against the live gateway**

Run: `bun run print:smoke Quotations <a real DocEntry from the ALUMIGRAF company>`

Expected: steps 1–4 all succeed and `out.pdf` opens. If step 3 shows a different key parameter name, change `ApiGateway.body()` to that name and re-run. If a layout code in `agent.json` is wrong, fix that entry and re-run — no code changes.

If the gateway is not reachable right now, note it and continue; nothing downstream depends on this having been run, only on it eventually passing.

- [ ] **Step 12: Commit**

```bash
git add apps/agent/src/api-gateway.ts apps/agent/test/api-gateway.test.ts apps/agent/src/index.ts \
        apps/agent/tsconfig.json apps/agent/agent.example.json scripts/print-smoke.ts package.json \
        docs/superpowers/specs/2026-08-31-portal-documents-and-pdf.md
git commit -m "feat(agent): SAP B1 API Gateway client and POST /print"
```

---

### Task 2: The server's print path (`agentPost`, `agentTarget`, `printDocument`, `entities.print`)

**Files:**
- Modify: `packages/b1/src/remote.ts` (promote the private `call` to an exported `agentPost`)
- Modify: `apps/server/src/b1.ts` (extract `agentTarget`)
- Create: `apps/server/src/print.ts`
- Modify: `apps/server/src/entity-profiles.ts` (`PRINTABLE`)
- Modify: `apps/server/src/orpc/routers/entities.ts` (`print` procedure)
- Modify: `apps/server/test/mock-agent.ts` (a `/print` handler)
- Create: `apps/server/test/print.test.ts`

**Interfaces:**
- Consumes: the agent's `POST /print` from Task 1 (body `{ entity, docEntry }` → `{ pdf, fileName }`).
- Produces:
  - `@hera/b1` → `export type AgentTarget = { agentUrl: string; secret: string; accessClientId?: string | null; accessClientSecret?: string | null; timeoutMs?: number }` and `export async function agentPost(o: AgentTarget, route: string, body: unknown): Promise<unknown>` (route is the **full** agent path, e.g. `/print` or `/b1/entity-set`).
  - `apps/server/src/b1.ts` → `export type TenantAgent = AgentTarget & { beasEnabled: boolean }` and `export async function agentTarget(tenantId: string): Promise<TenantAgent>`.
  - `apps/server/src/print.ts` → `export async function printDocument(tenantId: string, entity: string, docEntry: number): Promise<{ pdf: string; fileName: string }>`.
  - `apps/server/src/entity-profiles.ts` → `export const PRINTABLE: Set<string>`.
  - `router.entities.print({ entity, docEntry })` → `{ pdf, fileName }`, `adminProcedure`.

- [ ] **Step 1: Write the failing test**

First give the mock agent a `/print` route. In `apps/server/test/mock-agent.ts`, add a case to the `switch (route)` block, immediately before `case "/metadata":`:

```ts
        case "/print": {
          if (!["Quotations", "Orders", "DeliveryNotes", "Invoices"].includes(body.entity))
            return fail(400, null, `No print layout configured for '${body.entity}'`);
          return Response.json({
            // "%PDF-1.4\n" — enough for a caller to prove it decoded the base64 it was given.
            pdf: Buffer.from(`%PDF-1.4\n${body.entity}:${body.docEntry}`).toString("base64"),
            fileName: `${body.entity}-${body.docEntry}.pdf`,
          });
        }
```

Note the mock strips a leading `/b1` from the path (`const route = pathname.replace(/^\/b1/, "")`), so a bare `POST /print` arrives as `/print` unchanged. The `const rows = (store[body.entitySet] ??= [])` line above the switch is harmless for a print body.

Now create `apps/server/test/print.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";
import { startMockAgent, connectTenant, type MockAgent } from "./mock-agent.ts";
import { router } from "../src/orpc/router.ts";

// Printing rides the same cloud -> agent hop as every B1 read, but on a route with no
// B1Transport behind it. What matters here is that the curated PRINTABLE list — not a button —
// decides what can be printed, and that the agent's reply reaches the caller intact.

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

let agent: MockAgent | null = null;
afterEach(() => { agent?.stop(); agent = null; });

async function setup() {
  const { tenantId, slug } = await makeTenant();
  const admin = await makeUser("admin", tenantId);
  agent = startMockAgent({});
  await connectTenant(tenantId, agent);
  return { tenantId, slug, ictx: { context: { headers: tenantHeaders(slug, admin.cookie) } }, agent };
}

describe.skipIf(!process.env.DATABASE_URL)("entities.print", () => {
  test("returns the agent's base64 PDF and file name", async () => {
    const s = await setup();
    const out = await call(router.entities.print, { entity: "Quotations", docEntry: 12045 }, s.ictx);
    expect(out.fileName).toBe("Quotations-12045.pdf");
    expect(Buffer.from(out.pdf, "base64").toString()).toBe("%PDF-1.4\nQuotations:12045");
    expect(s.agent.calls.at(-1)).toMatchObject({ route: "/print", body: { entity: "Quotations", docEntry: 12045 } });
  });

  test("an entity outside PRINTABLE never reaches the agent", async () => {
    const s = await setup();
    expect(await code(call(router.entities.print, { entity: "BusinessPartners", docEntry: 1 }, s.ictx))).toBe("FORBIDDEN");
    expect(s.agent.calls.some((c) => c.route === "/print")).toBe(false);
  });

  test("a member (non-admin) cannot print", async () => {
    const s = await setup();
    const plain = await makeUser("member", s.tenantId);
    const ctx = { context: { headers: tenantHeaders(s.slug, plain.cookie) } };
    expect(await code(call(router.entities.print, { entity: "Quotations", docEntry: 1 }, ctx))).toBe("FORBIDDEN");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/server/test/print.test.ts`
Expected: FAIL — `router.entities.print` is undefined.

- [ ] **Step 3: Promote `RemoteTransport.call` to an exported `agentPost`**

In `packages/b1/src/remote.ts`, replace everything from `export type RemoteOptions` down to the end of the `private async call(...)` method with:

```ts
/** Everything needed to reach one tenant's agent. Shared by RemoteTransport and the non-transport
 *  routes (print), so the bearer/CF-Access/timeout handling exists exactly once. */
export type AgentTarget = {
  /** http://localhost:4000 in dev, the tunnel hostname in production. A row in sapConnection —
   *  which is the whole reason the tunnel is deployment config and not a code dependency. */
  agentUrl: string;
  /** Bearer secret the agent checks on every request. */
  secret: string;
  /** Cloudflare Access service token — absent in dev, present in production. */
  accessClientId?: string | null;
  accessClientSecret?: string | null;
  /** Bound on the cloud -> agent hop, independent of the agent -> SL bound. */
  timeoutMs?: number;
};

export type RemoteOptions = AgentTarget & {
  /** Which service the agent should route to. */
  target?: "b1" | "beas";
};

/** Wire shape of the agent's reply. */
type Wire = { error: { status: number; code: string | number | null; message: string } } | Record<string, unknown>;

/**
 * One POST to the agent. `route` is the FULL agent path — `/b1/entity-set`, `/print` — because
 * not every agent route sits under a transport target.
 *
 * Never throws a bare Error: an unreachable agent is a 503 B1Error so toOrpcError can tell it
 * apart from a SAP rejection.
 */
export async function agentPost(o: AgentTarget, route: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${o.agentUrl.replace(/\/+$/, "")}${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${o.secret}`,
        ...(o.accessClientId && o.accessClientSecret
          ? { "CF-Access-Client-Id": o.accessClientId, "CF-Access-Client-Secret": o.accessClientSecret }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs ?? 70_000),
    });
  } catch (e) {
    // Unreachable agent, DNS, TLS, or our own timeout — never a B1 status.
    throw new B1Error(503, null, `Agent unreachable at ${o.agentUrl}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const text = await res.text();
  let wire: Wire | null = null;
  try { wire = text ? (JSON.parse(text) as Wire) : null; } catch { /* fall through */ }
  if (wire && "error" in wire) {
    const err = wire.error as { status: number; code: string | number | null; message: string };
    throw new B1Error(err.status, err.code, err.message);
  }
  if (!res.ok || !wire) throw new B1Error(res.status, null, `Agent error ${res.status}: ${text.slice(0, 500)}`);
  return wire;
}

/** Cloud side of the seam: the same B1Transport methods, one HTTP call each to an
 *  operation-shaped agent endpoint. No route takes a URL except /next, which the agent
 *  origin-checks. */
export class RemoteTransport implements B1Transport {
  private readonly prefix: string;
  constructor(private readonly o: RemoteOptions) {
    this.prefix = `/${o.target ?? "b1"}`;
  }

  private async call(route: string, body: unknown): Promise<B1Response> {
    return (await agentPost(this.o, `${this.prefix}${route}`, body)) as B1Response;
  }
```

Leave every transport method below `call` exactly as it is. The `import type { ... }` list at the top of the file no longer needs anything removed — `B1Response` and the rest are all still used.

- [ ] **Step 4: Check the b1 package still passes**

Run:
```bash
bun test packages/b1
bunx tsc -p packages/b1/tsconfig.json --noEmit
```
Expected: PASS, no type errors. `packages/b1/test/remote.test.ts` exercises the same behaviour through `RemoteTransport` and must stay green untouched.

- [ ] **Step 5: Extract `agentTarget` in the server**

In `apps/server/src/b1.ts`, add `agentPost`'s type to the existing `@hera/b1` import:

```ts
import { B1Error, RemoteTransport, readPages, rowsOrThrow, type AgentTarget, type B1Transport, type Connector } from "@hera/b1";
```

Then replace the whole `tenantConnector` function with:

```ts
export type TenantAgent = AgentTarget & { beasEnabled: boolean };

/** The tenant's agent, as plain config. One PK select — nothing here is worth caching. Printing
 *  needs this without a transport, so the row->config mapping lives here rather than inline. */
export async function agentTarget(tenantId: string): Promise<TenantAgent> {
  const [row] = await db.select().from(sapConnection).where(eq(sapConnection.tenantId, tenantId)).limit(1);
  if (!row) throw new ORPCError("SERVICE_UNAVAILABLE", { message: SAP_UNAVAILABLE });
  return {
    agentUrl: row.agentUrl,
    secret: decryptSecret(row.secret),
    accessClientId: row.accessClientId,
    accessClientSecret: row.accessClientSecret,
    beasEnabled: row.beasEnabled,
  };
}

/** The tenant's on-prem agent, as a pair of transports. The transports hold nothing but config,
 *  so there is nothing worth caching. */
export async function tenantConnector(tenantId: string): Promise<Connector> {
  const a = await agentTarget(tenantId);
  return {
    b1: new RemoteTransport({ ...a, target: "b1" }),
    beas: a.beasEnabled ? new RemoteTransport({ ...a, target: "beas" }) : null,
  };
}
```

- [ ] **Step 6: Add `PRINTABLE`**

At the bottom of `apps/server/src/entity-profiles.ts`, after `missingRequired`:

```ts
/** Documents HERA can ask SAP to render as a PDF. Same shape of rule as ENTITY_PROFILES: the
 *  list is the boundary, enforced in the routers, not by which page drew a button. An entry
 *  here also needs a matching layout code in the agent's `apiGateway.layouts`. */
export const PRINTABLE = new Set(["Quotations", "Orders", "DeliveryNotes", "Invoices"]);
```

- [ ] **Step 7: Write `print.ts`**

Create `apps/server/src/print.ts`:

```ts
import { ORPCError } from "@orpc/server";
import { agentPost } from "@hera/b1";
import { agentTarget, viaB1 } from "./b1.ts";
import { PRINTABLE } from "./entity-profiles.ts";

// PDF rendering is the agent's SAP B1 API Gateway hop, not a Service Layer read — so it goes
// through agentPost on a route of its own rather than a transport method. One implementation,
// called by an admin procedure and a portal one; each adds its own fence before getting here.

export type PrintedDocument = { pdf: string; fileName: string };

export async function printDocument(tenantId: string, entity: string, docEntry: number): Promise<PrintedDocument> {
  if (!PRINTABLE.has(entity)) throw new ORPCError("FORBIDDEN", { message: `${entity} cannot be printed` });
  const target = await agentTarget(tenantId);
  return viaB1(async () => (await agentPost(target, "/print", { entity, docEntry })) as PrintedDocument);
}
```

- [ ] **Step 8: Add the `entities.print` procedure**

In `apps/server/src/orpc/routers/entities.ts`, extend the `entity-profiles.ts` import:

```ts
import { missingRequired, pickEditable, PRINTABLE, profileOf } from "../../entity-profiles.ts";
```

and add:

```ts
import { printDocument } from "../../print.ts";
```

Then add this procedure to `entitiesRouter`, immediately after `copy`:

```ts
  /** The document's own SAP print layout, rendered by the API Gateway on-prem and returned as
   *  base64. `/b1` is admin-only already; PRINTABLE is the second gate and the one that travels. */
  print: adminProcedure
    .input(z.object({ entity: EntityZ, docEntry: z.number().int() }))
    .handler(({ input, context }) => printDocument(context.tenantId, input.entity, input.docEntry)),
```

`PRINTABLE` is imported for the type-level guarantee that both routers reference the same set; the check itself is inside `printDocument`. If the import ends up unused, drop it from this file — `printDocument` owns the rule.

- [ ] **Step 9: Run the tests**

Run:
```bash
bun test apps/server/test/print.test.ts
bun test apps packages
```
Expected: the new file's 3 tests PASS and the whole suite stays green.

- [ ] **Step 10: Typecheck**

Run:
```bash
bunx tsc -p packages/b1/tsconfig.json --noEmit
bunx tsc -p apps/server/tsconfig.json --noEmit
```
Expected: no output.

- [ ] **Step 11: Commit**

```bash
git add packages/b1/src/remote.ts apps/server/src/b1.ts apps/server/src/print.ts \
        apps/server/src/entity-profiles.ts apps/server/src/orpc/routers/entities.ts \
        apps/server/test/mock-agent.ts apps/server/test/print.test.ts
git commit -m "feat(server): entities.print via the agent's API Gateway route"
```

---

### Task 3: `PrintActions` and the internal Preview/Download buttons

**Files:**
- Create: `apps/web/src/components/b1/PrintActions.tsx`
- Modify: `apps/web/src/components/ListReport.tsx` (`selectionActions` prop)
- Modify: `apps/web/src/components/b1/EntityListPage.tsx` (pass `selectionActions`)
- Modify: `apps/web/src/components/b1/EntityObjectPage.tsx` (button in the title actions bar)

**Interfaces:**
- Consumes: `router.entities.print` from Task 2.
- Produces:
  - `apps/web/src/components/b1/PrintActions.tsx` → `export const PRINTABLE_ENTITIES: Set<string>` and `export function PrintActions(props: { entity: string; docEntry: number; scope?: "internal" | "portal"; disabled?: boolean }): JSX.Element | null`.
  - `ListReport` gains `selectionActions?: (rows: Record<string, unknown>[]) => ReactNode`, rendered in the count bar to the left of Delete.

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/b1/PrintActions.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Bar, BusyIndicator, Button, Dialog, MessageStrip } from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";

// The one place printing exists in the UI. Everything that can print a SAP document — the object
// page, the list report's count bar, the portal timeline — renders this and nothing else, so
// there is exactly one blob-URL lifecycle to get right.
//
// apps/web does not depend on @hera/server at runtime (only `import type` for the router), so the
// PRINTABLE list is restated here rather than imported — the same reason portalUi.ts inlines
// ProjectStatus. The server's entity-profiles.ts PRINTABLE is the real boundary; this only
// decides whether to draw a button.
export const PRINTABLE_ENTITIES = new Set(["Quotations", "Orders", "DeliveryNotes", "Invoices"]);

/** base64 -> a blob URL the browser's own PDF viewer can open.
 *  // ponytail: iframe + the browser's viewer; a real viewer only if someone needs annotations. */
const toBlobUrl = (pdf: string) =>
  URL.createObjectURL(new Blob([Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0))], { type: "application/pdf" }));

export function PrintActions({
  entity, docEntry, scope = "internal", disabled,
}: {
  entity: string;
  docEntry: number;
  scope?: "internal" | "portal";
  disabled?: boolean;
}) {
  const [preview, setPreview] = useState<{ url: string; fileName: string } | null>(null);

  // Two mutation option factories, one call site. `scope` is fixed for a given mount, so this is
  // not a conditional hook.
  const options = scope === "portal" ? orpc.portal.docs.print.mutationOptions() : orpc.entities.print.mutationOptions();
  const print = useMutation(options);

  // A blob URL is a document-lifetime allocation; release it when the dialog closes or we unmount.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  if (!PRINTABLE_ENTITIES.has(entity) || !Number.isFinite(docEntry)) return null;

  const run = async (then: (r: { url: string; fileName: string }) => void) => {
    const res = await print.mutateAsync({ entity, docEntry });
    then({ url: toBlobUrl(res.pdf), fileName: res.fileName });
  };

  const close = () => {
    setPreview((p) => { if (p) URL.revokeObjectURL(p.url); return null; });
  };

  return (
    <>
      <Button icon="pdf-attachment" design="Transparent" disabled={disabled || print.isPending}
        onClick={() => void run(setPreview)}>
        Preview
      </Button>
      <Button icon="download" design="Transparent" disabled={disabled || print.isPending}
        onClick={() =>
          void run(({ url, fileName }) => {
            const a = document.createElement("a");
            a.href = url;
            a.download = fileName;
            a.click();
            // The download has already been handed to the browser by the time click() returns.
            URL.revokeObjectURL(url);
          })
        }>
        Download
      </Button>
      {print.error ? <MessageStrip design="Negative" hideCloseButton>{print.error.message}</MessageStrip> : null}
      {print.isPending ? <BusyIndicator active delay={0} /> : null}
      <Dialog
        stretch
        open={!!preview}
        headerText={preview?.fileName ?? ""}
        onClose={close}
        footer={<Bar design="Footer" endContent={<Button onClick={close}>Close</Button>} />}
      >
        {preview ? (
          <iframe src={preview.url} title={preview.fileName}
            style={{ width: "100%", height: "100%", border: 0 }} />
        ) : null}
      </Dialog>
    </>
  );
}
```

`orpc.portal.docs.print` does not exist yet — it arrives in Task 5. Until then this file will not
type-check. That is expected and is resolved by Task 5; do not stub it.

- [ ] **Step 2: Add `selectionActions` to `ListReport`**

In `apps/web/src/components/ListReport.tsx`, add to `ListReportProps`, directly under `onDelete`:

```ts
  /** Extra count-bar actions driven by the current selection. Rendered left of Delete; return
   *  null to draw nothing. ListReport never learns what these actions are.
   *  This cashes in the old `// ponytail: one bulk action; swap for a render-prop slot`. */
  selectionActions?: (rows: Row[]) => ReactNode;
```

Add `selectionActions` to the destructured props in the function signature:

```tsx
export function ListReport({
  listSpec, title, columns: cols, keyField, rows, total,
  loading, error, hasMore, onLoadMore, onRowClick, actions, onDelete, selectionActions, noData,
}: ListReportProps) {
```

And render it in `countBar` — replace the `endContent` fragment with:

```tsx
      endContent={
        <>
          {selectionActions?.(selected.rows)}
          {onDelete ? (
            <Button icon="delete" design="Transparent" disabled={!selected.rows.length || deleting} onClick={runDelete}>
              Delete
            </Button>
          ) : null}
          <Button icon="action-settings" design="Transparent" onClick={() => (colsOpen ? closeColumns() : openColumns())}>Columns</Button>
        </>
      }
```

Delete the now-obsolete ponytail comment on the old single-bulk-action line if it still sits above `onDelete` in the props type — it has been cashed in.

- [ ] **Step 3: Wire it into `EntityListPage`**

In `apps/web/src/components/b1/EntityListPage.tsx`, add the import:

```ts
import { PrintActions } from "./PrintActions.tsx";
```

and add this prop to the `<ListReport …>` element, immediately after `onLoadMore`:

```tsx
      selectionActions={(rows) =>
        // Printing is a one-document action: enabled on exactly one selected row.
        rows.length === 1 ? <PrintActions entity={entity} docEntry={Number(rows[0]!.DocEntry)} /> : null
      }
```

`compileList` always injects `schema.keys` into `$select`, so `DocEntry` is on every row of a
sales-document list even when it is not a visible column — printing needs no extra fetch.

- [ ] **Step 4: Wire it into `EntityObjectPage`**

In `apps/web/src/components/b1/EntityObjectPage.tsx`, add the import:

```ts
import { PrintActions } from "./PrintActions.tsx";
```

and add it inside the `ObjectPageTitle`'s `actionsBar` `Toolbar`, immediately after the Edit button block and before the `flows` map:

```tsx
              <PrintActions entity={entity} docEntry={Number(row.DocEntry)} disabled={editing} />
```

`PrintActions` returns `null` for a non-printable entity or a row with no numeric `DocEntry`, so
no extra gate is needed here.

- [ ] **Step 5: Build the web app**

Run: `bun --cwd apps/web build`
Expected: **FAIL**, with a type error on `orpc.portal.docs.print`. That is the known dependency on Task 5.

To finish this task green, temporarily verify the rest by checking that the *only* error is that
one:

```bash
bunx tsc -p apps/web/tsconfig.json --noEmit
```
Expected: exactly one error, in `PrintActions.tsx`, naming `portal.docs`. Any other error is a real
mistake in this task — fix it before committing.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/b1/PrintActions.tsx apps/web/src/components/ListReport.tsx \
        apps/web/src/components/b1/EntityListPage.tsx apps/web/src/components/b1/EntityObjectPage.tsx
git commit -m "feat(web): PrintActions plus a selectionActions slot on ListReport"
```

---

### Task 4: Extract the shared B1 read bodies into `entity-read.ts`

Pure refactor, no behaviour change. It exists so Task 5's portal reads are the *same* code as the
internal ones rather than a copy that can drift.

**Files:**
- Create: `apps/server/src/entity-read.ts`
- Modify: `apps/server/src/orpc/routers/entities.ts` (call the new functions)

**Interfaces:**
- Consumes: `compileList` (`entity-list.ts`), `entitySchema` (`entity-meta.ts`), `viaB1` (`b1.ts`).
- Produces, from `apps/server/src/entity-read.ts`:
  ```ts
  export function bad(e: unknown): never;
  export type RowsArgs = { spec: ListVariantDef; top: number; skip?: number; count?: boolean };
  export async function readRows(
    b1: B1Transport, schema: B1EntitySchema, entity: string, a: RowsArgs, extraFilter?: string,
  ): Promise<{ rows: Record<string, unknown>[]; keys: string[]; total: number | undefined; nextSkip: number | undefined }>;
  export async function readOne(
    b1: B1Transport, schema: B1EntitySchema, entity: string, raw: Key,
  ): Promise<{ row: Record<string, unknown>; etag: string | null }>;
  ```

- [ ] **Step 1: Write the module**

Create `apps/server/src/entity-read.ts`:

```ts
import { ORPCError } from "@orpc/server";
import {
  andFilter, coerceKey, countOf, rowsOf,
  type B1EntitySchema, type B1Transport, type Key,
} from "@hera/b1";
import type { ListVariantDef } from "@hera/db";
import { compileList } from "./entity-list.ts";
import { viaB1 } from "./b1.ts";

// The B1 read bodies, once. Two routers call these: entities.* (internal, admin) and
// portal.docs.* (a client, fenced to their CardCode). Neither owns the implementation — the same
// pattern portal.extract already uses with extraction.ts.
//
// The `schema` is a parameter rather than something these functions fetch. That is the whole
// seam: the portal hands in a schema filtered to its allowlist, and compileList's existing rules
// then do the fencing with no second policy to keep in step.

/** A modelling error from compileList/coerceKey is the caller's mistake, not a server fault. */
export const bad = (e: unknown): never => {
  throw e instanceof ORPCError
    ? e
    : new ORPCError("BAD_REQUEST", { message: e instanceof Error ? e.message : String(e) });
};

export type RowsArgs = { spec: ListVariantDef; top: number; skip?: number; count?: boolean };

/**
 * One page of rows for a saved list view. The spec is compiled to OData here — the browser never
 * sends a filter string.
 *
 * `extraFilter` is ANDed onto the *compiled* filter, not onto the spec. That is deliberate: a
 * scope clause added after compilation names a field the caller's schema may not even contain,
 * so the caller cannot express, override or observe it through their own spec.
 */
export async function readRows(
  b1: B1Transport,
  schema: B1EntitySchema,
  entity: string,
  a: RowsArgs,
  extraFilter?: string,
) {
  let query;
  try {
    query = compileList(schema, a.spec, { top: a.top, skip: a.skip, count: a.count });
  } catch (e) {
    return bad(e);
  }
  if (extraFilter) query.filter = andFilter(query.filter, extraFilter);

  const res = await viaB1(() => b1.readEntitySet(entity, query));
  const rows = rowsOf(res.data);
  return {
    rows,
    keys: schema.keys,
    total: countOf(res.data),
    // A full page probably means another one; one empty read at the end beats $count per page.
    nextSkip: rows.length === a.top ? (a.skip ?? 0) + rows.length : undefined,
  };
}

/** One row, with its ETag — which is what makes a curated edit safe. The schema decides string
 *  vs integer quoting: a digit-looking ItemCode is not an Int32 key. */
export async function readOne(b1: B1Transport, schema: B1EntitySchema, entity: string, raw: Key) {
  let key: Key;
  try {
    key = coerceKey(schema, raw);
  } catch (e) {
    return bad(e);
  }
  const res = await viaB1(() => b1.readEntity(entity, key));
  return { row: res.data as Record<string, unknown>, etag: res.etag ?? null };
}
```

- [ ] **Step 2: Call it from `entities.ts`**

In `apps/server/src/orpc/routers/entities.ts`:

Add the import:

```ts
import { bad, readOne, readRows } from "../../entity-read.ts";
```

Delete the local `bad` const (the 5-line arrow function) and the local `keyed` helper — `readOne`
now does the coercion.

Trim the `@hera/b1` import to what is still used in this file:

```ts
import { categoriesOf, categoryNames, coerceKey, type Key } from "@hera/b1";
```

(`coerceKey` is still needed by `update`; `rowsOf`/`countOf` are not. If `coerceKey` turns out
unused after the edits below, drop it too — `bunx tsc` will say so.)

Replace the `rows` handler body with:

```ts
    .handler(async ({ input, context }) => {
      const b1 = await b1Of(context.tenantId);
      const schema = await viaB1(() => entitySchema(context.tenantId, b1, input.entity)).catch(bad);
      return readRows(b1, schema, input.entity, input);
    }),
```

Replace the `one` handler body with:

```ts
    .handler(async ({ input, context }) => {
      const b1 = await b1Of(context.tenantId);
      const schema = await viaB1(() => entitySchema(context.tenantId, b1, input.entity)).catch(bad);
      return readOne(b1, schema, input.entity, input.key);
    }),
```

`update` still needs a coerced key. Replace its `const { b1, key } = await keyed(...)` line with:

```ts
      const b1 = await b1Of(context.tenantId);
      const schema = await viaB1(() => entitySchema(context.tenantId, b1, input.entity)).catch(bad);
      let key: Key;
      try { key = coerceKey(schema, input.key); } catch (e) { return bad(e); }
```

- [ ] **Step 3: Run the tests**

Run:
```bash
bun test apps/server/test/entities-router.test.ts
bun test apps packages
```
Expected: PASS, unchanged. `entities-router.test.ts` already asserts on the exact compiled query
(`filter: "CardCode eq 'C0001'"`, `select: ["DocEntry", "CardCode"]`) — if that assertion still
holds, the extraction was behaviour-preserving.

- [ ] **Step 4: Typecheck**

Run: `bunx tsc -p apps/server/tsconfig.json --noEmit`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/entity-read.ts apps/server/src/orpc/routers/entities.ts
git commit -m "refactor(server): extract the B1 read bodies into entity-read.ts"
```

---

### Task 5: `portal.docs.*` — the client's own documents

**Files:**
- Modify: `apps/server/src/orpc/routers/portal.ts` (a `docs` sub-router)
- Create: `apps/server/test/portal-docs.test.ts`

**Interfaces:**
- Consumes: `readRows` / `readOne` / `bad` (Task 4), `printDocument` (Task 2), `entitySchema`, `clientProcedure`'s `context.cardCode`.
- Produces, exported from `apps/server/src/orpc/routers/portal.ts` for the tests:
  - `export const PORTAL_ENTITIES: Set<string>`
  - `export const PORTAL_DOC: readonly string[]`
  - `export const PORTAL_LINE: readonly string[]`
  - `export function portalSchema(schema: B1EntitySchema): B1EntitySchema`
- Produces on the router:
  - `portal.docs.schema({ entity })` → `B1EntitySchema` (filtered)
  - `portal.docs.rows({ entity, spec, top, skip?, count? })` → the same shape as `entities.rows`
  - `portal.docs.one({ entity, key })` → `{ row, etag: null }`
  - `portal.docs.print({ entity, docEntry })` → `{ pdf, fileName }`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/portal-docs.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { call, makeTenant, makeUser, bindClient, tenantHeaders } from "./harness.ts";
import { startMockAgent, connectTenant, type MockAgent } from "./mock-agent.ts";
import { router } from "../src/orpc/router.ts";

// The portal document surface. Two rules carry everything here:
//   1. every read is ANDed with the caller's own CardCode, added AFTER the spec is compiled, so
//      a client's own filter can neither replace it nor observe it;
//   2. the schema a portal read compiles against is filtered to the allowlist, so a field
//      outside it is dropped from $select and *throws* if it appears in a filter.

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");
const EMPTY = { select: [], filter: [], orderby: [], filterBar: [] };

const edmx = await Bun.file(
  new URL("../../../packages/b1/test/fixtures/entity-metadata.edmx", import.meta.url),
).text();

let agent: MockAgent | null = null;
afterEach(() => { agent?.stop(); agent = null; });

async function setup() {
  const { tenantId, slug } = await makeTenant();
  const a = await makeUser("client", tenantId);
  await bindClient(tenantId, a.userId, "CARD-A", "Client A");
  const b = await makeUser("client", tenantId);
  await bindClient(tenantId, b.userId, "CARD-B", "Client B");

  agent = startMockAgent({
    Orders: [
      { DocEntry: 1, DocNum: 901, CardCode: "CARD-A", CardName: "Client A", DocDate: "2026-08-01",
        DocTotal: 100, GrossProfit: 40, SalesPersonCode: 7, DiscountPercent: 5,
        DocumentLines: [{ LineNum: 0, ItemCode: "A1", Quantity: 2, UnitPrice: 5, LineTotal: 10, GrossProfit: 4 }] },
      { DocEntry: 2, DocNum: 902, CardCode: "CARD-B", CardName: "Client B", DocDate: "2026-08-02",
        DocTotal: 200, DocumentLines: [] },
    ],
    Quotations: [], DeliveryNotes: [], Invoices: [],
  });
  agent.metadata.xml = edmx;
  await connectTenant(tenantId, agent);

  return {
    tenantId, slug, agent,
    ctxA: { context: { headers: tenantHeaders(slug, a.cookie) } },
    ctxB: { context: { headers: tenantHeaders(slug, b.cookie) } },
  };
}

describe.skipIf(!process.env.DATABASE_URL)("portal.docs", () => {
  test("every list read is ANDed with the caller's CardCode", async () => {
    const s = await setup();
    await call(router.portal.docs.rows, { entity: "Orders", spec: EMPTY, top: 10 }, s.ctxA);
    const read = s.agent.calls.findLast((c) => c.route === "/entity-set")!;
    expect(String(read.body.query.filter)).toContain("CardCode eq 'CARD-A'");
  });

  test("the client's own filter is kept AND still fenced", async () => {
    const s = await setup();
    await call(router.portal.docs.rows, {
      entity: "Orders", spec: { ...EMPTY, filter: [{ field: "DocNum", op: "eq", value: 901 }] }, top: 10,
    }, s.ctxA);
    const f = String(s.agent.calls.findLast((c) => c.route === "/entity-set")!.body.query.filter);
    expect(f).toContain("DocNum eq 901");
    expect(f).toContain("CardCode eq 'CARD-A'");
  });

  test("a filter naming a field outside the allowlist is refused, not silently dropped", async () => {
    const s = await setup();
    expect(await code(call(router.portal.docs.rows, {
      entity: "Orders", spec: { ...EMPTY, filter: [{ field: "GrossProfit", op: "gt", value: 0 }] }, top: 10,
    }, s.ctxA))).toBe("BAD_REQUEST");
  });

  test("a select naming a field outside the allowlist never reaches $select", async () => {
    const s = await setup();
    await call(router.portal.docs.rows, {
      entity: "Orders", spec: { ...EMPTY, select: ["DocNum", "GrossProfit"] }, top: 10,
    }, s.ctxA);
    const sel = s.agent.calls.findLast((c) => c.route === "/entity-set")!.body.query.select as string[];
    expect(sel).toContain("DocNum");
    expect(sel).not.toContain("GrossProfit");
    expect(sel).not.toContain("CardCode");
  });

  test("an entity outside PORTAL_ENTITIES is refused before any read", async () => {
    const s = await setup();
    expect(await code(call(router.portal.docs.rows, { entity: "BusinessPartners", spec: EMPTY, top: 10 }, s.ctxA)))
      .not.toBe("OK");
    expect(s.agent.calls.some((c) => c.route === "/entity-set")).toBe(false);
  });

  test("one() refuses another CardCode's document", async () => {
    const s = await setup();
    expect(await code(call(router.portal.docs.one, { entity: "Orders", key: 1 }, s.ctxB))).toBe("NOT_FOUND");
    expect(await code(call(router.portal.docs.one, { entity: "Orders", key: 1 }, s.ctxA))).toBe("OK");
  });

  test("one() returns nothing outside the allowlist — header or line", async () => {
    const s = await setup();
    const { row } = await call(router.portal.docs.one, { entity: "Orders", key: 1 }, s.ctxA);
    for (const leaked of ["GrossProfit", "SalesPersonCode", "DiscountPercent", "CardCode", "CardName"])
      expect(row).not.toHaveProperty(leaked);
    expect(row).toMatchObject({ DocNum: 901, DocTotal: 100 });
    const lines = row.DocumentLines as Record<string, unknown>[];
    expect(lines[0]).toMatchObject({ ItemCode: "A1", LineTotal: 10 });
    expect(lines[0]).not.toHaveProperty("GrossProfit");
  });

  test("schema() is filtered to the allowlist, lines included", async () => {
    const s = await setup();
    const schema = await call(router.portal.docs.schema, { entity: "Orders" }, s.ctxA);
    const names = schema.fields.map((f) => f.name);
    expect(names).toContain("DocNum");
    expect(names).not.toContain("CardCode");
    const lines = schema.fields.find((f) => f.name === "DocumentLines");
    expect(lines?.fields?.map((f) => f.name) ?? []).not.toContain("GrossProfit");
  });

  test("print refuses another CardCode's document and a non-printable entity", async () => {
    const s = await setup();
    expect(await code(call(router.portal.docs.print, { entity: "Orders", docEntry: 1 }, s.ctxB))).toBe("NOT_FOUND");
    expect(await code(call(router.portal.docs.print, { entity: "BusinessPartners", docEntry: 1 }, s.ctxA)))
      .not.toBe("OK");
    const out = await call(router.portal.docs.print, { entity: "Orders", docEntry: 1 }, s.ctxA);
    expect(out.fileName).toBe("Orders-1.pdf");
  });

  test("an internal member cannot reach the portal document surface", async () => {
    const s = await setup();
    const plain = await makeUser("member", s.tenantId);
    const ctx = { context: { headers: tenantHeaders(s.slug, plain.cookie) } };
    expect(await code(call(router.portal.docs.rows, { entity: "Orders", spec: EMPTY, top: 10 }, ctx))).toBe("FORBIDDEN");
  });
});
```

The mock agent's `/entity` handler matches on `r.DocEntry === body.key`, and `/entity-set`
understands only `Field eq 'value'` filters — it will return no rows for a compound filter, which
is fine: these tests assert on the *query the cloud sent*, not on B1's own filtering. The one
exception is `one()`, which reads by key and therefore works.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/server/test/portal-docs.test.ts`
Expected: FAIL — `router.portal.docs` is undefined.

- [ ] **Step 3: Add the allowlists and `portalSchema`**

In `apps/server/src/orpc/routers/portal.ts`, extend the imports:

```ts
import { escapeLiteral, type B1EntitySchema } from "@hera/b1";
import { ListVariantDefZ } from "@hera/db";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { entitySchema } from "../../entity-meta.ts";
import { bad, readOne, readRows } from "../../entity-read.ts";
import { printDocument } from "../../print.ts";
```

(`ListVariantDefZ` joins the existing `@hera/db` import; keep one import statement per module.)

Then add this block just above `// --- Client side ---`:

```ts
// --- The client's own SAP documents ------------------------------------------------------------
// Four entity sets, read-only, always fenced to the caller's CardCode.
//
// The fence is this list, not the seeded variant. A variant is UI; this is the boundary.
export const PORTAL_ENTITIES = new Set(["Quotations", "Orders", "DeliveryNotes", "Invoices"]);

// DocumentLines is on the header list because it is a field of the document; its own columns are
// PORTAL_LINE. CardCode is deliberately absent: the client IS the card, and leaving it out of the
// schema is what makes it impossible for a client to filter, sort or select on it.
export const PORTAL_DOC = [
  "DocEntry", "DocNum", "DocDate", "DocDueDate", "DocumentStatus",
  "DocTotal", "DocCurrency", "NumAtCard", "Comments", "DocumentLines",
] as const;
export const PORTAL_LINE = [
  "LineNum", "ItemCode", "ItemDescription", "Quantity", "UnitPrice", "LineTotal",
] as const;

/**
 * The client's view of a sales document, as a schema.
 *
 * Making the allowlist *be* the schema means compileList's existing rules do the fencing and
 * there is no second policy to keep in step: a `select` naming a hidden field is silently
 * dropped (a saved view outliving a field should still open), a `filter` naming one throws
 * (dropping it would show MORE rows than were asked for), and free-text search only reaches
 * allowed string columns.
 */
export function portalSchema(schema: B1EntitySchema): B1EntitySchema {
  const doc = new Set<string>(PORTAL_DOC);
  const line = new Set<string>(PORTAL_LINE);
  return {
    ...schema,
    fields: schema.fields
      .filter((f) => doc.has(f.name))
      .map((f) => (f.kind === "collection" && f.fields ? { ...f, fields: f.fields.filter((x) => line.has(x.name)) } : f)),
  };
}

/** Explicit allow-list projection of one document. Mirrors portalSchema for the response body:
 *  a read that came back wide (readEntity takes no $select here — see docs.one) still leaves
 *  narrow. A new B1 field defaults to excluded, not leaked. */
function projectDoc(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PORTAL_DOC) {
    if (!(k in row)) continue;
    if (k === "DocumentLines" && Array.isArray(row[k])) {
      out[k] = (row[k] as Record<string, unknown>[]).map((l) =>
        Object.fromEntries(PORTAL_LINE.filter((f) => f in l).map((f) => [f, l[f]])));
    } else {
      out[k] = row[k];
    }
  }
  return out;
}

const PortalEntityZ = z.string().refine((e) => PORTAL_ENTITIES.has(e), "Not a portal document");

/** Transport + the filtered schema for one portal entity. */
async function portalEntity(tenantId: string, entity: string) {
  const { b1 } = await tenantConnector(tenantId);
  const full = await viaB1(() => entitySchema(tenantId, b1, entity)).catch(bad);
  return { b1, schema: portalSchema(full) };
}

/** `CardCode eq '…'`, appended to the COMPILED filter. Not to the spec: CardCode is not in the
 *  portal schema, so a client cannot name it, and compileList never sees this clause. */
const cardFence = (cardCode: string) => `CardCode eq '${escapeLiteral(cardCode)}'`;
```

- [ ] **Step 4: Add the `docs` sub-router**

Still in `apps/server/src/orpc/routers/portal.ts`, add this to `portalRouter`, immediately after
the `projects: { … }` block:

```ts
  // Read-only SAP documents for this client's business partner. Every procedure here is
  // clientProcedure + the CardCode fence + the PORTAL_DOC/PORTAL_LINE allowlist; the underlying
  // reads are literally the same functions entities.* uses.
  docs: {
    /** One entity's fields, already narrowed to what a client may see. Same $metadata cache as
     *  entities.schema — the filtering happens after the cache, not inside it. */
    schema: clientProcedure
      .input(z.object({ entity: PortalEntityZ }))
      .handler(async ({ input, context }) => (await portalEntity(context.tenantId, input.entity)).schema),

    rows: clientProcedure
      .input(z.object({
        entity: PortalEntityZ,
        spec: ListVariantDefZ,
        top: z.number().int().min(1).max(200).default(50),
        skip: z.number().int().min(0).optional(),
        count: z.boolean().optional(),
      }))
      .handler(async ({ input, context }) => {
        const { b1, schema } = await portalEntity(context.tenantId, input.entity);
        return readRows(b1, schema, input.entity, input, cardFence(context.cardCode));
      }),

    /** One document. Read wide and projected here rather than $select-ed: a complex collection in
     *  $select is a shape B1 has no need to accept, and the allowlist is the same either way. */
    one: clientProcedure
      .input(z.object({ entity: PortalEntityZ, key: z.union([z.string(), z.number()]) }))
      .handler(async ({ input, context }) => {
        const { b1, schema } = await portalEntity(context.tenantId, input.entity);
        const { row } = await readOne(b1, schema, input.entity, input.key);
        if (row.CardCode !== context.cardCode) throw new ORPCError("NOT_FOUND");
        // No ETag: nothing on the portal writes to SAP, and an ETag is only useful to a writer.
        return { row: projectDoc(row), etag: null as string | null };
      }),

    print: clientProcedure
      .input(z.object({ entity: PortalEntityZ, docEntry: z.number().int() }))
      .handler(async ({ input, context }) => {
        const { b1, schema } = await portalEntity(context.tenantId, input.entity);
        const { row } = await readOne(b1, schema, input.entity, input.docEntry);
        if (row.CardCode !== context.cardCode) throw new ORPCError("NOT_FOUND");
        return printDocument(context.tenantId, input.entity, input.docEntry);
      }),
  },
```

Note `readOne` returns the **unprojected** row (it is `entity-read.ts`'s job to read, not to
censor), which is exactly why the CardCode check above can still see `CardCode`. `projectDoc` is
what leaves the server.

- [ ] **Step 5: Run the tests**

Run:
```bash
bun test apps/server/test/portal-docs.test.ts
bun test apps packages
```
Expected: all 10 new tests PASS, whole suite green.

- [ ] **Step 6: Typecheck server and web**

Run:
```bash
bunx tsc -p apps/server/tsconfig.json --noEmit
bunx tsc -p apps/web/tsconfig.json --noEmit
```
Expected: no output from either. The `PrintActions.tsx` error left over from Task 3 is resolved by
`portal.docs.print` existing.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/orpc/routers/portal.ts apps/server/test/portal-docs.test.ts
git commit -m "feat(server): portal.docs.* — CardCode-fenced, allowlisted document reads"
```

---

### Task 6: Seeded `portal:` variants and read-only variant delivery

`ui_variant.entity` is free text with no FK, so `portal:Quotations` is a legal key alongside
`b1:Quotations` — the precedent is `configs` / `"Requested"`.

**Files:**
- Modify: `apps/server/src/seed-variants.ts` (`ensurePortalVariants`, `portalVariantKey`)
- Modify: `apps/server/src/auth.ts` (call it on org creation)
- Modify: `scripts/seed-standard.ts` (call it in the backfill)
- Modify: `apps/server/src/orpc/routers/portal.ts` (`portal.variants`)
- Modify: `apps/web/src/variants.ts` (endpoint by prefix, `readOnly`)
- Modify: `apps/web/src/components/ListReport.tsx` (honour `readOnly`)
- Modify: `apps/server/test/seed-variants.test.ts` (cover the new seeder)

**Interfaces:**
- Consumes: `ensureStandardVariants` (existing), `clientProcedure`.
- Produces:
  - `apps/server/src/seed-variants.ts` → `export const portalVariantKey = (entity: string) => \`portal:${entity}\`` and `export async function ensurePortalVariants(tenantId: string, userId: string, force?: boolean): Promise<void>`.
  - `portal.variants({ page, entity })` → `{ variants: Array<{ id, name, shared, isDefault, isStandard, definition, userId, author, canManage }>, isAdmin: false }` — **the same field set and order as `variants.list`**, so the web hook's two branches are structurally identical.
  - `useVariants` / `useListSpec` (`apps/web/src/variants.ts`) both gain `readOnly: boolean` in their return.

- [ ] **Step 1: Write the seeder**

At the bottom of `apps/server/src/seed-variants.ts`:

```ts
// --- Portal document views ---------------------------------------------------------------------
// The client's four document lists. Same machinery as the B1 entity views, a different key
// namespace, and a much shorter field list: no CardCode/CardName (the client IS the card), no
// cost, margin or salesperson. The PORTAL_DOC/PORTAL_LINE allowlist in the portal router means
// adding one of those to a variant by hand still would not fetch it.

/** The `entity` key a portal document page saves its views under. Must match the web side's
 *  `portal:${entity}` and the `startsWith("portal:")` test that makes those views read-only. */
export const portalVariantKey = (entity: string) => `portal:${entity}`;

const PORTAL_DOC_ENTITIES = ["Quotations", "Orders", "DeliveryNotes", "Invoices"];
const PORTAL_LIST_FIELDS = ["DocNum", "DocDate", "DocDueDate", "NumAtCard", "DocumentStatus", "DocTotal"];
const PORTAL_OBJECT_FIELDS = [
  "DocNum", "DocDate", "DocDueDate", "DocumentStatus", "DocTotal", "DocCurrency", "NumAtCard", "Comments",
];
const PORTAL_LINE_FIELDS = ["ItemCode", "ItemDescription", "Quantity", "UnitPrice", "LineTotal"];

/** Standard list + object views for the four portal document entities. Idempotent. */
export async function ensurePortalVariants(tenantId: string, userId: string, force = false) {
  for (const entity of PORTAL_DOC_ENTITIES) {
    await ensureStandardVariants(
      tenantId,
      userId,
      portalVariantKey(entity),
      {
        list: {
          select: PORTAL_LIST_FIELDS,
          filter: [],
          // Newest first — DocEntry, not DocNum, which restarts per series.
          orderby: [{ field: "DocEntry", dir: "desc" as const }],
          filterBar: PORTAL_LIST_FIELDS,
        },
        object: {
          header: shown(PORTAL_OBJECT_FIELDS),
          sections: [{ id: "DocumentLines", visible: true, fields: shown(PORTAL_LINE_FIELDS) }],
        },
      },
      force,
    );
  }
}
```

- [ ] **Step 2: Call it from both existing seed sites**

`apps/server/src/auth.ts` — extend the import and the hook:

```ts
import { ensureConfiguratorVariants, ensureEntityVariants, ensurePortalVariants } from "./seed-variants.ts";
```

```ts
        afterCreateOrganization: async ({ organization: org, user }) => {
          await ensureConfiguratorVariants(org.id, user.id);
          await ensureEntityVariants(org.id, user.id);
          await ensurePortalVariants(org.id, user.id);
        },
```

`scripts/seed-standard.ts` — extend the import, the call and the log line:

```ts
import { ensureConfiguratorVariants, ensureEntityVariants, ensurePortalVariants } from "../apps/server/src/seed-variants.ts";
```

```ts
    await ensureConfiguratorVariants(org.id, owner.userId);
    await ensureEntityVariants(org.id, owner.userId, force);
    await ensurePortalVariants(org.id, owner.userId, force);
    console.log(`- ${org.slug}: models, configs, B1 entities, portal documents${force ? " (forced)" : ""}`);
```

Also update the docblock at the top of `scripts/seed-standard.ts` — the "Seeds, per org:" line
should mention the portal document views.

- [ ] **Step 3: Cover the seeder with a test**

Append to `apps/server/test/seed-variants.test.ts` (match the file's existing imports and
`describe.skipIf` style — read it first and follow it rather than pasting a second `describe` with
a duplicate setup):

```ts
  test("portal document views are seeded, shared and read-only-shaped", async () => {
    const { tenantId } = await makeTenant();
    const user = await makeUser("owner", tenantId);
    await ensurePortalVariants(tenantId, user.userId);

    const rows = await db.select().from(uiVariant)
      .where(and(eq(uiVariant.tenantId, tenantId), eq(uiVariant.entity, "portal:Invoices")));
    expect(rows.map((r) => r.page).sort()).toEqual(["list", "object"]);
    const list = rows.find((r) => r.page === "list")!;
    expect(list.shared).toBe(true);
    expect(list.isStandard).toBe(true);
    const def = list.definition as { select: string[] };
    expect(def.select).toContain("DocNum");
    // The client IS the card: no CardCode/CardName, and no cost or margin fields.
    for (const banned of ["CardCode", "CardName", "GrossProfit", "SalesPersonCode"])
      expect(def.select).not.toContain(banned);

    // Idempotent.
    await ensurePortalVariants(tenantId, user.userId);
    const again = await db.select().from(uiVariant)
      .where(and(eq(uiVariant.tenantId, tenantId), eq(uiVariant.entity, "portal:Invoices")));
    expect(again).toHaveLength(2);
  });
```

- [ ] **Step 4: Run it**

Run: `bun test apps/server/test/seed-variants.test.ts`
Expected: PASS, including the new case.

- [ ] **Step 5: Add `portal.variants`**

`variants.list` is `userProcedure`, which fences clients out — without this, `useListSpec` would
fall back to `EMPTY_SPEC` and show every column.

In `apps/server/src/orpc/routers/portal.ts`, extend the `@hera/db` import with `uiVariant`, then add
this procedure to `portalRouter` immediately after the `docs: { … }` block:

```ts
  /** The seeded `portal:` views, read-only. variants.list is userProcedure (it fences clients
   *  out), so this is the client's door to the same rows: shared ones only, never personal ones,
   *  and never writable — there is no portal counterpart to variants.save. */
  variants: clientProcedure
    .input(z.object({ page: z.enum(["list", "object"]), entity: z.string() }))
    .handler(async ({ input, context }) => {
      if (!input.entity.startsWith("portal:"))
        throw new ORPCError("FORBIDDEN", { message: "Not a portal view" });
      const rows = await db
        .select({
          id: uiVariant.id,
          name: uiVariant.name,
          shared: uiVariant.shared,
          isDefault: uiVariant.isDefault,
          isStandard: uiVariant.isStandard,
          definition: uiVariant.definition,
        })
        .from(uiVariant)
        .where(and(
          eq(uiVariant.tenantId, context.tenantId),
          eq(uiVariant.page, input.page),
          eq(uiVariant.entity, input.entity),
          eq(uiVariant.shared, true),
        ));
      // Same field set as variants.list so the web hook's two branches stay one type. userId and
      // author are blanked rather than joined: the internal user who seeded the view is not the
      // client's business.
      return {
        variants: rows.map((r) => ({ ...r, userId: "", author: "", canManage: false })),
        isAdmin: false,
      };
    }),
```

- [ ] **Step 6: Pick the endpoint by prefix in the web hook**

In `apps/web/src/variants.ts`, replace `useVariants` with:

```ts
// One place for the variant query + mutations so both pages stay thin.
//
// A `portal:` key is served by portal.variants instead: variants.list is userProcedure, which
// fences client accounts out entirely. Both queries are declared unconditionally (hooks rules)
// and exactly one is enabled — the disabled one never fetches and is never read.
export function useVariants(page: VariantPage, entity: string) {
  const qc = useQueryClient();
  const readOnly = entity.startsWith("portal:");

  const opts = orpc.variants.list.queryOptions({ input: { page, entity } });
  const internal = useQuery({ ...opts, enabled: !readOnly });
  const portal = useQuery({
    ...orpc.portal.variants.queryOptions({ input: { page, entity } }),
    enabled: readOnly,
  });

  const data = readOnly ? portal.data : internal.data;
  const invalidate = () => qc.invalidateQueries({ queryKey: opts.queryKey });
  const save = useMutation(orpc.variants.save.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(orpc.variants.remove.mutationOptions({ onSuccess: invalidate }));
  const setWidths = useMutation(orpc.variants.setWidths.mutationOptions());
  return {
    variants: data?.variants ?? [],
    isAdmin: data?.isAdmin ?? false,
    isLoading: readOnly ? portal.isPending : internal.isPending,
    /** a portal client cannot create, edit or delete a view — the chrome for it is hidden */
    readOnly,
    save,
    remove,
    setWidths,
  };
}
```

Then thread `readOnly` through `useListSpec`: change its first line to

```ts
  const { variants, isAdmin, isLoading, readOnly, save, remove, setWidths } = useVariants("list", entity);
```

and add `readOnly,` to the object it returns (next to `isAdmin`).

`useObjectVariants` also destructures `useVariants`; leave it alone — the portal object page does
not use it.

- [ ] **Step 7: Honour `readOnly` in `ListReport`**

In `apps/web/src/components/ListReport.tsx`:

Add `readOnly` to the `listSpec` destructure at the top of the component:

```tsx
  const { entity, spec, setSpec, variants, selectedName, setSelectedName, applyVariant, dirty, isAdmin, readOnly, save, remove, setWidths } = listSpec;
```

Guard the width persistence — in `onColumnResizeEnd`, immediately after `setSpec((s) => ({ ...s, widths }))`:

```tsx
      // variants.setWidths is userProcedure; a portal client would only ever get a FORBIDDEN.
      if (readOnly) return;
```

And swap the title-area heading. Replace the `variantManagement` JSX assignment with a guarded one
by adding this line directly after the existing `const variantManagement = (…);` block:

```tsx
  // No save, no Save As, no Manage Views for a user who cannot own a view — a variant switcher
  // with one entry and every action disabled is worse than a plain title.
  const heading = readOnly ? <Title level="H4">{title}</Title> : variantManagement;
```

then use `heading` in both slots of `DynamicPageTitle`:

```tsx
        <DynamicPageTitle
          heading={heading}
          snappedHeading={heading}
```

- [ ] **Step 8: Verify**

Run:
```bash
bun test apps packages
bunx tsc -p apps/server/tsconfig.json --noEmit
bunx tsc -p apps/web/tsconfig.json --noEmit
```
Expected: green, no type errors.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/seed-variants.ts apps/server/src/auth.ts scripts/seed-standard.ts \
        apps/server/src/orpc/routers/portal.ts apps/server/test/seed-variants.test.ts \
        apps/web/src/variants.ts apps/web/src/components/ListReport.tsx
git commit -m "feat: seeded portal: document views, delivered read-only to portal clients"
```

---

### Task 7: The portal document pages (`scope` prop, two routes, the 5-item nav)

`EntityListPage` and `EntityObjectPage` are B1-coupled in exactly four places: the procedure names,
the variant key, and the hardcoded `/b1/...` navigations. One prop derives all four.

**Files:**
- Modify: `apps/web/src/components/b1/EntityListPage.tsx` (`scope`)
- Modify: `apps/web/src/components/b1/EntityObjectPage.tsx` (`scope`)
- Create: `apps/web/src/routes/_authed/portal/docs/$entity.tsx`
- Create: `apps/web/src/routes/_authed/portal/docs/$entity_.$key.tsx`
- Modify: `apps/web/src/components/AppShell.tsx` (client nav)

**Interfaces:**
- Consumes: `portal.docs.schema/rows/one/print` (Task 5), the `portal:` variant key (Task 6), `PrintActions` (Task 3).
- Produces: `EntityListPage` and `EntityObjectPage` both accept `scope?: "internal" | "portal"` (default `"internal"`). Routes `/portal/docs/$entity` and `/portal/docs/$entity/$key`.

- [ ] **Step 1: Add `scope` to `EntityListPage`**

In `apps/web/src/components/b1/EntityListPage.tsx`, replace the signature and the two lines under
it with:

```tsx
// `scope` is the only thing that differs between the internal and the portal mounts: which
// procedures answer, which variant namespace the saved view lives in, and where a row click goes.
// The server fences the portal set independently — this is which page you are on, not permission.
export function EntityListPage({ entity, scope = "internal" }: { entity: string; scope?: "internal" | "portal" }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const portal = scope === "portal";
  const schema = useQuery({
    ...(portal
      ? orpc.portal.docs.schema.queryOptions({ input: { entity } })
      : orpc.entities.schema.queryOptions({ input: { entity } })),
    retry: false,
    staleTime: 60 * 60_000,
  });
  const listSpec = useListSpec(portal ? `portal:${entity}` : `b1:${entity}`);
```

Replace the `useInfiniteQuery` block with:

```tsx
  const rowsOptions = portal
    ? orpc.portal.docs.rows.infiniteOptions({
        input: (skip: number | undefined) => ({ entity, spec: listSpec.spec, top: 100, ...(skip ? { skip } : { count: true }) }),
        initialPageParam: undefined as number | undefined,
        getNextPageParam: (last) => last.nextSkip,
      })
    : orpc.entities.rows.infiniteOptions({
        input: (skip: number | undefined) => ({ entity, spec: listSpec.spec, top: 100, ...(skip ? { skip } : { count: true }) }),
        initialPageParam: undefined as number | undefined,
        getNextPageParam: (last) => last.nextSkip,
      });

  const page = useInfiniteQuery({
    ...rowsOptions,
    // Both gates matter: no schema means no column names to compile against, and an unapplied
    // view would fire one render's worth of requests carrying the previous entity's fields.
    enabled: !!schema.data && listSpec.ready,
    retry: false,
    placeholderData: keepPreviousData,
  });
```

Both branches produce the same input and output shapes, so the ternary should collapse cleanly. If
`tsc` instead complains that the union is not assignable to `useInfiniteQuery`, do not cast — use
the same shape `useVariants` uses in Task 6: declare both `useInfiniteQuery` calls unconditionally
with `enabled: portal ? … : false` and pick the enabled one afterwards.

Change the row click to route by scope:

```tsx
      onRowClick={(row) => {
        const keys = schema.data!.keys;
        // A composite key travels as JSON so one route param can carry both halves.
        const key = keys.length === 1 ? String(row[keys[0]!] ?? "") : JSON.stringify(Object.fromEntries(keys.map((k) => [k, row[k]])));
        if (!key) return;
        if (portal) navigate({ to: "/portal/docs/$entity/$key", params: { entity, key } });
        else navigate({ to: "/b1/$entity/$key", params: { entity, key } });
      }}
```

Pass the scope down to `PrintActions`:

```tsx
      selectionActions={(rows) =>
        rows.length === 1 ? <PrintActions entity={entity} docEntry={Number(rows[0]!.DocEntry)} scope={scope} /> : null
      }
```

And hide the internal-only "Refresh schema" toolbar (it calls `client.entities.schema`, an admin
procedure) — replace the `actions={…}` prop with:

```tsx
      actions={
        portal ? undefined : (
          <Toolbar design="Transparent">
            {/* refetch() alone would return the same cached row — the re-read has to be asked for. */}
            <ToolbarButton icon="refresh" text="Refresh schema" disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                try {
                  const fresh = await client.entities.schema({ entity, refresh: true });
                  qc.setQueryData(orpc.entities.schema.key({ input: { entity }, type: "query" }), fresh);
                } finally { setRefreshing(false); }
              }} />
          </Toolbar>
        )
      }
```

- [ ] **Step 2: Add `scope` to `EntityObjectPage`**

In `apps/web/src/components/b1/EntityObjectPage.tsx`, replace the signature and the four query
lines under it with:

```tsx
export function EntityObjectPage({
  entity, entityKey, scope = "internal",
}: { entity: string; entityKey: string; scope?: "internal" | "portal" }) {
  const navigate = useNavigate();
  const parsed = useMemo(() => parseKeyParam(entityKey), [entityKey]);
  const portal = scope === "portal";

  const schema = useQuery({
    ...(portal
      ? orpc.portal.docs.schema.queryOptions({ input: { entity } })
      : orpc.entities.schema.queryOptions({ input: { entity } })),
    retry: false,
    staleTime: 60 * 60_000,
  });
  const key = useMemo(() => (schema.data ? coerceKey(schema.data, parsed) : parsed), [schema.data, parsed]);
  // No profile fetch on the portal: nothing there is editable and entities.profile is admin-only.
  const meta = useQuery({ ...orpc.entities.profile.queryOptions({ input: { entity } }), staleTime: Infinity, enabled: !portal });
  const one = useQuery({
    ...(portal
      ? orpc.portal.docs.one.queryOptions({ input: { entity, key: key as string | number } })
      : orpc.entities.one.queryOptions({ input: { entity, key } })),
    enabled: !!schema.data,
    retry: false,
  });
```

Under `portal`, there is no Edit button and no copy flows. Replace the `actionsBar` `Toolbar`
contents with:

```tsx
            <Toolbar design="Transparent">
              {profile && !editing && !portal ? (
                <ToolbarButton design="Emphasized" icon="edit" text="Edit"
                  // No ETag means B1 gave us nothing to guard the write with; refuse rather than
                  // send a blind PATCH.
                  disabled={!etag} onClick={() => setDraft({})} />
              ) : null}
              <PrintActions entity={entity} docEntry={Number(row.DocEntry)} scope={scope} disabled={editing} />
              {(meta.data?.flows ?? []).map((f) => (
                <ToolbarButton key={f.target} icon="copy" text={f.label} disabled={copy.isPending || editing}
                  onClick={() => copy.mutate({ sourceEntity: entity, targetEntity: f.target, docEntry: Number(row.DocEntry) })} />
              ))}
              <ToolbarButton icon="nav-back" text="Back to list"
                onClick={() => (portal
                  ? navigate({ to: "/portal/docs/$entity", params: { entity } })
                  : navigate({ to: "/b1/$entity", params: { entity } }))} />
            </Toolbar>
```

`meta` is disabled under portal, so `meta.data?.flows` is `undefined` and the copy buttons draw
nothing — no extra condition needed. The copy mutation's `onSuccess` navigate stays `/b1/...`
because it can only fire from an internal mount.

The "read-only in HERA" MessageStrip would be noise on the portal. Change its condition to:

```tsx
            {!profile && !editing && !portal ? (
```

No filtering of `scalars` is needed: `portal.docs.schema` already returns only the allowlisted
fields, so the form renders exactly those, and `DocumentLines` arrives as the one collection
section with its own columns already narrowed.

- [ ] **Step 3: Add the two routes**

Create `apps/web/src/routes/_authed/portal/docs/$entity.tsx`:

```tsx
import { createFileRoute, redirect } from "@tanstack/react-router";
import { EntityListPage } from "../../../../components/b1/EntityListPage.tsx";

// The four document sets a portal client may browse. The server fences this independently
// (portal.docs's PORTAL_ENTITIES); this guard only keeps a typo out of the URL bar.
const PORTAL_ENTITIES = new Set(["Quotations", "Orders", "DeliveryNotes", "Invoices"]);

export const Route = createFileRoute("/_authed/portal/docs/$entity")({
  beforeLoad: ({ params }) => {
    if (!PORTAL_ENTITIES.has(params.entity)) throw redirect({ to: "/portal" });
  },
  component: () => <EntityListPage entity={Route.useParams().entity} scope="portal" />,
});
```

Create `apps/web/src/routes/_authed/portal/docs/$entity_.$key.tsx`:

```tsx
import { createFileRoute, redirect } from "@tanstack/react-router";
import { EntityObjectPage } from "../../../../components/b1/EntityObjectPage.tsx";

const PORTAL_ENTITIES = new Set(["Quotations", "Orders", "DeliveryNotes", "Invoices"]);

export const Route = createFileRoute("/_authed/portal/docs/$entity_/$key")({
  beforeLoad: ({ params }) => {
    if (!PORTAL_ENTITIES.has(params.entity)) throw redirect({ to: "/portal" });
  },
  component: () => {
    const { entity, key } = Route.useParams();
    return <EntityObjectPage entity={entity} entityKey={key} scope="portal" />;
  },
});
```

`routes/_authed.tsx` already pins client accounts inside `/portal/*` — no change there.

- [ ] **Step 4: Grow the client nav from 2 items to 5**

In `apps/web/src/components/AppShell.tsx`, replace the whole `isClient ? (…)` branch with:

```tsx
          {isClient ? (
            <>
              {/* "New request" leaves the nav — it is a button on the Projects page now. */}
              <SideNavigationItem text="My requests" icon="sales-order" data-to="/portal"
                selected={pathname === "/portal" || pathname === "/portal/new" || (pathname.startsWith("/portal/") && !pathname.startsWith("/portal/docs"))} />
              <SideNavigationItem text="Quotations" icon="sales-quote" data-to="/portal/docs/Quotations"
                selected={pathname.startsWith("/portal/docs/Quotations")} />
              <SideNavigationItem text="Sales orders" icon="sales-order-item" data-to="/portal/docs/Orders"
                selected={pathname.startsWith("/portal/docs/Orders")} />
              <SideNavigationItem text="Deliveries" icon="shipping-status" data-to="/portal/docs/DeliveryNotes"
                selected={pathname.startsWith("/portal/docs/DeliveryNotes")} />
              <SideNavigationItem text="Invoices" icon="monitor-payments" data-to="/portal/docs/Invoices"
                selected={pathname.startsWith("/portal/docs/Invoices")} />
            </>
          ) : (
```

`main.tsx` imports `@ui5/webcomponents-icons/dist/AllIcons.js`, so no per-icon import is needed.

- [ ] **Step 5: Build the web app (regenerates the route tree)**

Run: `bun --cwd apps/web build`
Expected: success. `routeTree.gen.ts` is gitignored and regenerated here — the build failing with
"unknown route `/portal/docs/$entity`" means a file name typo (note the trailing underscore on
`$entity_.$key.tsx`, which is what flattens the layout).

- [ ] **Step 6: Typecheck**

Run: `bunx tsc -p apps/web/tsconfig.json --noEmit`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/b1/EntityListPage.tsx apps/web/src/components/b1/EntityObjectPage.tsx \
        apps/web/src/routes/_authed/portal/docs apps/web/src/components/AppShell.tsx
git commit -m "feat(web): portal document list and object pages under a scope prop"
```

---

### Task 8: `doc-chain.ts` and `portal.docs.chain`

The forward walk from the quotation HERA wrote to whatever SAP has done with it since. Same
machinery as `doc-history.ts` — `CrossJoinSpec` + `b1.crossJoin`, no new `B1Transport` method —
because B1's `$filter` has no lambda operators and a document therefore cannot be filtered by its
lines any other way.

**Files:**
- Create: `apps/server/src/doc-chain.ts`
- Create: `apps/server/test/doc-chain.test.ts`
- Modify: `apps/server/src/orpc/routers/portal.ts` (`docs.chain`)
- Modify: `apps/server/test/mock-agent.ts` (a `/cross-join` handler)

**Interfaces:**
- Consumes: `DOCUMENT_FLOWS` base-type codes from `doc-copy.ts`, `config_run.b1DocEntry`, `loadOwnProject` (existing, in `portal.ts`).
- Produces, from `apps/server/src/doc-chain.ts`:
  ```ts
  export type ChainEntity = "Quotations" | "Orders" | "DeliveryNotes" | "Invoices";
  export type ChainDoc = { entity: ChainEntity; docEntry: number; docNum: number; docDate: string; docTotal: number; docStatus: string };
  export function baseClause(entity: string, baseType: number, baseEntries: number[]): string;
  export function chainQuery(entity: ChainEntity, clauses: string[], top?: number): CrossJoinSpec;
  export function flattenChain(entity: ChainEntity, json: unknown): ChainDoc[];
  export async function documentChain(b1: B1Transport, quotationDocEntry: number): Promise<ChainDoc[]>;
  ```
- Produces on the router: `portal.docs.chain({ projectId })` → `ChainDoc[]`, newest first.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/doc-chain.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { baseClause, chainQuery, flattenChain } from "../src/doc-chain.ts";

// Pure: the shape of each hop and the flattening. The live behaviour is exercised through
// portal.docs.chain against the mock agent.

describe("doc-chain", () => {
  test("a hop joins the document to its own lines and matches on BaseType + BaseEntry", () => {
    const q = chainQuery("Orders", [baseClause("Orders", 23, [42])]);
    expect(q.entities).toEqual(["Orders", "Orders/DocumentLines"]);
    // The DocEntry equality IS the join — without it the crossjoin pairs every document with
    // every line in the company.
    expect(q.filter).toContain("Orders/DocEntry eq Orders/DocumentLines/DocEntry");
    expect(q.filter).toContain("Orders/DocumentLines/BaseType eq 23");
    expect(q.filter).toContain("Orders/DocumentLines/BaseEntry eq 42");
  });

  test("several base entries become an OR group inside one BaseType clause", () => {
    const c = baseClause("Invoices", 15, [7, 8]);
    expect(c).toBe("Invoices/DocumentLines/BaseType eq 15 and (Invoices/DocumentLines/BaseEntry eq 7 or Invoices/DocumentLines/BaseEntry eq 8)");
  });

  test("an invoice hop can match two different base types at once", () => {
    const q = chainQuery("Invoices", [baseClause("Invoices", 17, [1]), baseClause("Invoices", 15, [5])]);
    expect(q.filter).toContain("BaseType eq 17");
    expect(q.filter).toContain("BaseType eq 15");
    expect(q.filter).toContain(" or ");
  });

  test("flatten dedupes by DocEntry — $top counts (doc, line) pairs, not documents", () => {
    const rows = flattenChain("Orders", {
      value: [
        { Orders: { DocEntry: 5, DocNum: 900, DocDate: "2026-08-02", DocTotal: 10, DocumentStatus: "bost_Open" },
          "Orders/DocumentLines": { BaseType: 23, BaseEntry: 42 } },
        { Orders: { DocEntry: 5, DocNum: 900, DocDate: "2026-08-02", DocTotal: 10, DocumentStatus: "bost_Open" },
          "Orders/DocumentLines": { BaseType: 23, BaseEntry: 42 } },
        { Orders: { DocEntry: 6, DocNum: 901, DocDate: "2026-08-03", DocTotal: 20, DocumentStatus: "bost_Close" },
          "Orders/DocumentLines": { BaseType: 23, BaseEntry: 42 } },
      ],
    });
    expect(rows.map((r) => r.docEntry)).toEqual([5, 6]);
    expect(rows[0]).toMatchObject({ entity: "Orders", docNum: 900, docTotal: 10, docStatus: "bost_Open" });
  });

  test("a non-collection response is empty, not a throw", () => {
    expect(flattenChain("Orders", null)).toEqual([]);
    expect(flattenChain("Orders", { odd: true })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/server/test/doc-chain.test.ts`
Expected: FAIL — `Cannot find module '../src/doc-chain.ts'`

- [ ] **Step 3: Write the module**

Create `apps/server/src/doc-chain.ts`:

```ts
import type { B1Transport, CrossJoinSpec } from "@hera/b1";

// The forward document walk: from the quotation HERA wrote (config_run.b1DocEntry — the only B1
// link HERA stores) to whatever SAP has since made of it. Written in the same style as
// doc-history.ts and reusing the same machinery, for the same reason: B1's $filter has no lambda
// operators, so a document cannot be filtered by its lines except through $crossjoin.
//
// The BaseType codes are DOCUMENT_FLOWS' (doc-copy.ts) — the same table the forward copy writes,
// so the walk and the write agree by construction:
//   Quotation(23) -> Orders     Order(17) -> DeliveryNotes, Invoices     Delivery(15) -> Invoices

export type ChainEntity = "Quotations" | "Orders" | "DeliveryNotes" | "Invoices";

export type ChainDoc = {
  entity: ChainEntity;
  docEntry: number;
  docNum: number;
  docDate: string;
  docTotal: number;
  docStatus: string;
};

const SELECT = ["DocEntry", "DocNum", "DocDate", "DocTotal", "DocumentStatus"];

/** `lines/BaseType eq T and (lines/BaseEntry eq a or lines/BaseEntry eq b …)` — B1's $filter has
 *  no `in` operator either, so a set of parents is an OR group. */
export function baseClause(entity: string, baseType: number, baseEntries: number[]): string {
  const ors = baseEntries.map((e) => `${entity}/DocumentLines/BaseEntry eq ${e}`).join(" or ");
  return `${entity}/DocumentLines/BaseType eq ${baseType} and (${ors})`;
}

/** One hop. The DocEntry equality IS the join — without it the crossjoin pairs every document
 *  with every line in the company. */
export function chainQuery(entity: ChainEntity, clauses: string[], top = 50): CrossJoinSpec {
  return {
    entities: [entity, `${entity}/DocumentLines`],
    expand: [
      { entity, select: SELECT },
      { entity: `${entity}/DocumentLines`, select: ["BaseType", "BaseEntry"] },
    ],
    filter: `${entity}/DocEntry eq ${entity}/DocumentLines/DocEntry and (${clauses.join(" or ")})`,
    orderby: `${entity}/DocDate desc`,
    // ponytail: $top counts (doc, line) pairs, not documents — same caveat as doc-history.ts.
    //           A quotation copied into more than ~50 order lines would truncate; raise it then.
    top,
  };
}

/** Crossjoin pairs -> documents, deduped by DocEntry (one pair per matching line). */
export function flattenChain(entity: ChainEntity, json: unknown): ChainDoc[] {
  const pairs = Array.isArray(json) ? json : ((json as { value?: unknown } | null)?.value ?? []);
  if (!Array.isArray(pairs)) return [];
  const seen = new Map<number, ChainDoc>();
  for (const p of pairs as Record<string, unknown>[]) {
    const d = (p[entity] ?? {}) as Record<string, unknown>;
    const docEntry = Number(d.DocEntry ?? 0);
    if (!docEntry || seen.has(docEntry)) continue;
    seen.set(docEntry, {
      entity,
      docEntry,
      docNum: Number(d.DocNum ?? 0),
      docDate: String(d.DocDate ?? ""),
      docTotal: Number(d.DocTotal ?? 0),
      docStatus: String(d.DocumentStatus ?? ""),
    });
  }
  return [...seen.values()];
}

/**
 * The whole chain for one quotation, oldest hop first. Three sequential crossjoins: each hop
 * needs the previous hop's DocEntries to filter on, so they cannot be parallelised.
 * A hop whose source set is empty is skipped entirely rather than sent as `BaseEntry eq ()`.
 *
 * // ponytail: 3 sequential crossjoins per open project; cache the result on config_run if it
 * //           ever shows up in a trace.
 */
export async function documentChain(b1: B1Transport, quotationDocEntry: number): Promise<ChainDoc[]> {
  const hop = async (entity: ChainEntity, clauses: string[]) =>
    clauses.length ? flattenChain(entity, (await b1.crossJoin(chainQuery(entity, clauses))).data) : [];

  const orders = await hop("Orders", [baseClause("Orders", 23, [quotationDocEntry])]);
  const orderEntries = orders.map((o) => o.docEntry);

  const deliveries = await hop("DeliveryNotes", orderEntries.length ? [baseClause("DeliveryNotes", 17, orderEntries)] : []);
  const deliveryEntries = deliveries.map((d) => d.docEntry);

  // An invoice can be raised straight from the order OR from the delivery — both, in one read.
  const invoices = await hop("Invoices", [
    ...(orderEntries.length ? [baseClause("Invoices", 17, orderEntries)] : []),
    ...(deliveryEntries.length ? [baseClause("Invoices", 15, deliveryEntries)] : []),
  ]);

  return [...orders, ...deliveries, ...invoices];
}
```

- [ ] **Step 4: Run the pure tests**

Run: `bun test apps/server/test/doc-chain.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Teach the mock agent `/cross-join`**

In `apps/server/test/mock-agent.ts`, add a case to the `switch (route)` block, just before
`case "/print":`:

```ts
        case "/cross-join": {
          // Enough to prove the walk wires up: pair each document of the leading entity with each
          // of its own lines, and let the caller's assertions do the rest. The mock does not
          // parse the $filter — the filter's shape is asserted by doc-chain.test.ts, which is
          // pure and does not need a server.
          const [lead] = body.entities as string[];
          const docs = store[lead!] ?? [];
          const value = docs.flatMap((d) =>
            ((d.DocumentLines as Record<string, unknown>[] | undefined) ?? [{}]).map((l) => ({
              [lead!]: d, [`${lead}/DocumentLines`]: l,
            })));
          return Response.json({ status: 200, data: { value } });
        }
```

- [ ] **Step 6: Add `docs.chain` to the portal router**

In `apps/server/src/orpc/routers/portal.ts`, add the import:

```ts
import { documentChain } from "../../doc-chain.ts";
```

and add this procedure inside the `docs: { … }` block, after `print`:

```ts
    /** The live SAP document chain for one of this client's projects: the quotation HERA wrote,
     *  then whatever SAP has since made of it. Empty until the project is quoted — before that
     *  there is no b1DocEntry to walk from. */
    chain: clientProcedure
      .input(z.object({ projectId: z.uuid() }))
      .handler(async ({ input, context }) => {
        const p = await loadOwnProject(input.projectId, context);
        const [run] = await db
          .select({ b1DocEntry: configRun.b1DocEntry })
          .from(configRun)
          .where(and(eq(configRun.projectId, p.id), eq(configRun.tenantId, context.tenantId)))
          .limit(1);
        const quotation = run?.b1DocEntry;
        if (quotation == null) return [];

        const { b1 } = await tenantConnector(context.tenantId);
        const [head, chain] = await Promise.all([
          viaB1(() => b1.readEntity("Quotations", quotation, {
            select: ["DocEntry", "DocNum", "DocDate", "DocTotal", "DocumentStatus"],
          })),
          viaB1(() => documentChain(b1, quotation)),
        ]);
        const q = head.data as Record<string, unknown>;
        return [
          {
            entity: "Quotations" as const,
            docEntry: Number(q.DocEntry ?? quotation),
            docNum: Number(q.DocNum ?? 0),
            docDate: String(q.DocDate ?? ""),
            docTotal: Number(q.DocTotal ?? 0),
            docStatus: String(q.DocumentStatus ?? ""),
          },
          ...chain,
        ];
      }),
```

The CardCode fence here is `loadOwnProject` — the project row's `customer->>'cardCode'` — which is
the same fence every other portal project read uses. An internal twin of this procedure is **not**
built; nothing asked for one.

- [ ] **Step 7: Add a router-level test**

Append to `apps/server/test/portal-docs.test.ts`, inside the existing `describe`:

```ts
  test("chain is empty until the project is quoted, and never crosses CardCodes", async () => {
    const s = await setup();
    const [model] = await db.insert(configModel)
      .values({ tenantId: s.tenantId, name: TEST_MODEL.name, definition: TEST_MODEL, portal: true })
      .returning({ id: configModel.id });
    const { id } = await call(router.portal.projects.create, { modelId: model!.id, name: "A's bracket" }, s.ctxA);

    // No run, so no b1DocEntry, so nothing to walk — and no B1 read is made at all.
    expect(await call(router.portal.docs.chain, { projectId: id }, s.ctxA)).toEqual([]);
    expect(s.agent.calls.some((c) => c.route === "/cross-join")).toBe(false);

    expect(await code(call(router.portal.docs.chain, { projectId: id }, s.ctxB))).toBe("NOT_FOUND");
  });
```

Add the imports this needs to the top of the file:

```ts
import { db, configModel } from "@hera/db";
import { call, makeTenant, makeUser, bindClient, tenantHeaders, TEST_MODEL } from "./harness.ts";
```

- [ ] **Step 8: Run everything**

Run:
```bash
bun test apps packages
bunx tsc -p apps/server/tsconfig.json --noEmit
```
Expected: green, no type errors.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/doc-chain.ts apps/server/test/doc-chain.test.ts \
        apps/server/src/orpc/routers/portal.ts apps/server/test/mock-agent.ts \
        apps/server/test/portal-docs.test.ts
git commit -m "feat(server): portal.docs.chain — the live SAP document walk from the quotation"
```

---

### Task 9: The merged timeline

`PortalRequestSummary` already renders `project.events` in a UI5 `Timeline`. It gains a second
source, merged and sorted newest first.

**Files:**
- Modify: `apps/web/src/components/portal/PortalRequestSummary.tsx`

**Interfaces:**
- Consumes: `portal.docs.chain` (Task 8), `PrintActions` (Task 3), the `/portal/docs/$entity/$key` route (Task 7).
- Produces: nothing other components consume.

**UI5 note:** `TimelineItem` makes its `name` clickable, not its `titleText` — `nameClickable`
enables it and `onNameClick` is a plain event handler, not an `href`. `state` takes a `ValueState`
string.

- [ ] **Step 1: Add the chain query and the merge**

In `apps/web/src/components/portal/PortalRequestSummary.tsx`:

Add to the imports:

```tsx
import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { PrintActions } from "../b1/PrintActions.tsx";
```

Add the document-icon map next to `EV_UI`:

```tsx
// The SAP half of the timeline. Same shape as EV_UI so the two merge into one list.
const DOC_UI: Record<"Quotations" | "Orders" | "DeliveryNotes" | "Invoices", { icon: string; text: string }> = {
  Quotations: { icon: "sales-quote", text: "Quotation" },
  Orders: { icon: "sales-order", text: "Sales order" },
  DeliveryNotes: { icon: "shipping-status", text: "Delivery" },
  Invoices: { icon: "monitor-payments", text: "Invoice" },
};

type TimelineEntry = {
  at: string;
  icon: string;
  title: string;
  state?: "Information";
  note?: string;
  doc?: { entity: keyof typeof DOC_UI; docEntry: number; docNum: number };
};
```

Inside the component, after the existing `quoted` query, add:

```tsx
  const navigate = useNavigate();

  // The SAP chain only exists once HERA has written the quotation, which is exactly `quoted`.
  // Before that the timeline is what it has always been.
  const chain = useQuery({
    ...orpc.portal.docs.chain.queryOptions({ input: { projectId: project.id } }),
    enabled: project.status === "quoted",
  });

  const timeline = useMemo<TimelineEntry[]>(
    () =>
      [
        ...project.events.map((e) => ({ at: e.at, icon: EV_UI[e.kind].icon, title: EV_UI[e.kind].text, note: e.note })),
        ...(chain.data ?? []).map((d) => ({
          at: d.docDate,
          icon: DOC_UI[d.entity].icon,
          title: `${DOC_UI[d.entity].text} ${d.docNum || d.docEntry}`,
          state: "Information" as const,
          doc: { entity: d.entity, docEntry: d.docEntry, docNum: d.docNum },
        })),
      ]
        // ISO strings compare correctly as strings; B1 dates are date-only, HERA events are full
        // timestamps, so a same-day document sorts below the event that produced it. Good enough.
        .sort((a, b) => b.at.localeCompare(a.at)),
    [project.events, chain.data],
  );
```

- [ ] **Step 2: Render the merged list**

Replace the whole `<Card header={<CardHeader titleText="History" />}>` block with:

```tsx
        <Card header={<CardHeader titleText="History" />}>
          {chain.error ? <MessageStrip design="Negative" hideCloseButton>{chain.error.message}</MessageStrip> : null}
          <Timeline>
            {timeline.map((e, i) => (
              <TimelineItem
                key={i}
                icon={e.icon}
                titleText={e.title}
                subtitleText={new Date(e.at).toLocaleDateString()}
                {...(e.state ? { state: e.state } : {})}
                // TimelineItem makes `name` clickable, not `titleText` — hence the doc number here.
                {...(e.doc
                  ? {
                      name: `#${e.doc.docNum || e.doc.docEntry}`,
                      nameClickable: true,
                      onNameClick: () =>
                        navigate({
                          to: "/portal/docs/$entity/$key",
                          params: { entity: e.doc!.entity, key: String(e.doc!.docEntry) },
                        }),
                    }
                  : {})}
              >
                {e.doc ? <PrintActions entity={e.doc.entity} docEntry={e.doc.docEntry} scope="portal" /> : null}
                {e.note ? <Text>{e.note}</Text> : null}
              </TimelineItem>
            ))}
          </Timeline>
        </Card>
```

- [ ] **Step 3: Build and typecheck**

Run:
```bash
bunx tsc -p apps/web/tsconfig.json --noEmit
bun --cwd apps/web build
```
Expected: no type errors, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/portal/PortalRequestSummary.tsx
git commit -m "feat(web): merge the live SAP document chain into the portal timeline"
```

---

### Task 10: The portal projects list becomes a `ListReport`

So all five nav items share one chrome.

**Files:**
- Modify: `apps/web/src/routes/_authed/portal/index.tsx`

**Interfaces:**
- Consumes: `applySpec` / `useListSpec` (`variants.ts`), `ListReport`, `portal.projects.list`, `portalStatusUi`.
- Produces: nothing other components consume.

Note this page uses the **local** executor (`applySpec` over the returned array), exactly like
`ConfigsPage` — `portal.projects.list` returns the whole list, so there is nothing to compile to
OData. Its variant key is `"portal:projects"`, which makes it read-only through the same
`startsWith("portal:")` rule as the document lists, and it is **not** one of the four seeded
document views, so `useListSpec` falls back to `EMPTY_SPEC` (all columns, no filter) — which is
what this page wants.

- [ ] **Step 1: Rewrite the page**

Replace the entire contents of `apps/web/src/routes/_authed/portal/index.tsx` with:

```tsx
import { useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { IllustratedMessage, Button, ObjectStatus, Text, Toolbar, ToolbarButton } from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
import { orpc } from "../../../orpc.ts";
import { applySpec, useListSpec, type ListColumn } from "../../../variants.ts";
import { ListReport } from "../../../components/ListReport.tsx";
import { portalStatusUi, type PortalStatus } from "../../../components/portal/portalUi.ts";

export const Route = createFileRoute("/_authed/portal/")({ component: MyRequests });

// Read the value off `cell`, not the documented top-level `value` prop: AnalyticalTable's
// CellInstance Omit<>s over an index signature, which erases the flattened props from the type.
const StatusCell = ({ cell }: { cell: { value?: unknown } }) => {
  const ui = portalStatusUi[cell.value as PortalStatus];
  return ui ? <ObjectStatus state={ui.state}>{ui.text}</ObjectStatus> : <Text>{String(cell.value ?? "")}</Text>;
};

const COLUMNS: ListColumn[] = [
  { name: "name", type: "string", label: "Name" },
  { name: "modelName", type: "string", label: "Product" },
  {
    name: "status",
    type: "enum",
    label: "Status",
    options: Object.entries(portalStatusUi).map(([value, ui]) => ({ value, text: ui.text })),
    Cell: StatusCell,
  },
  { name: "updatedAt", type: "date", label: "Updated" },
];

const noData = (reason: "Empty" | "Filtered") =>
  reason === "Filtered" ? (
    <IllustratedMessage name="NoEntries" design="Auto" titleText="Nothing in this view"
      subtitleText="Try a different filter." />
  ) : (
    <IllustratedMessage name="NoEntries" design="Auto" titleText="No requests yet"
      subtitleText="Configure a product and request a quote from your supplier." />
  );

function MyRequests() {
  const navigate = useNavigate();
  const q = useQuery(orpc.portal.projects.list.queryOptions());

  // `portal:` keys are read-only views (variants.ts) — a portal client cannot save one, so the
  // page gets the ListReport chrome without a variant switcher. This key is deliberately not
  // seeded: an empty spec means every column, which is exactly the four below.
  const listSpec = useListSpec("portal:projects");
  const rows = useMemo(() => applySpec(q.data ?? [], listSpec.spec, COLUMNS), [q.data, listSpec.spec]);

  return (
    <ListReport
      listSpec={listSpec}
      title="My requests"
      columns={COLUMNS}
      keyField="id"
      rows={rows}
      total={rows.length}
      loading={q.isFetching}
      error={q.error}
      onRowClick={(row) => navigate({ to: "/portal/$id", params: { id: String(row.id) } })}
      noData={noData}
      actions={
        <Toolbar design="Transparent">
          {/* "New request" left the nav in favour of five document items; it lives here now. */}
          <ToolbarButton design="Emphasized" text="New request" onClick={() => navigate({ to: "/portal/new" })} />
        </Toolbar>
      }
    />
  );
}
```

`Button` is imported above but only used by the old empty state; if `bunx tsc` flags it as unused,
remove it from the import list.

- [ ] **Step 2: Build and typecheck**

Run:
```bash
bunx tsc -p apps/web/tsconfig.json --noEmit
bun --cwd apps/web build
```
Expected: no type errors, build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/_authed/portal/index.tsx
git commit -m "feat(web): the portal projects list is a ListReport like the four document lists"
```

---

### Task 11: Bind the portal client to a real business partner

Today `portalClients.invite` takes `cardCode`/`cardName` as free text and nothing checks the
CardCode exists.

**Files:**
- Modify: `apps/server/src/orpc/routers/portal.ts` (`invite`)
- Modify: `apps/server/test/invites.test.ts` (mock agent + new cases)
- Modify: `apps/web/src/routes/_authed/settings.tsx` (value help)

**Interfaces:**
- Consumes: `tenantConnector` / `viaB1`, `EntityValueHelp`.
- Produces: `portalClients.invite` input drops `cardName` — it becomes `{ email, cardCode }`.

**Breaking change to note:** `invites.test.ts` currently calls `invite` with `cardName` and with no
`sapConnection` row, so every one of its tests would start failing with `SERVICE_UNAVAILABLE`. Its
setup must gain a mock agent. That is part of this task, not a follow-up.

- [ ] **Step 1: Update the existing tests first (they encode the new contract)**

In `apps/server/test/invites.test.ts`, replace the imports and the `invite` helper with:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, portalClient } from "@hera/db";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";
import { startMockAgent, connectTenant, type MockAgent } from "./mock-agent.ts";
import { router } from "../src/orpc/router.ts";

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

// Inviting a portal client now binds it to a real SAP business partner, so every test that
// invites needs an agent to validate against.
let agent: MockAgent | null = null;
afterEach(() => { agent?.stop(); agent = null; });

async function connect(tenantId: string) {
  agent = startMockAgent({
    BusinessPartners: [
      { CardCode: "C0001", CardName: "Acme Client SL", CardType: "cCustomer" },
      { CardCode: "V0001", CardName: "Acme Supplier SL", CardType: "cSupplier" },
    ],
  });
  await connectTenant(tenantId, agent);
  return agent;
}

async function invite(slug: string, adminCookie: string, email: string, cardCode = "C0001") {
  return call(router.portalClients.invite,
    { email, cardCode },
    { context: { headers: tenantHeaders(slug, adminCookie) } });
}
```

The mock agent's `/entity` handler matches on `r.DocEntry === body.key`, which a BusinessPartners
row does not have. Fix that in `apps/server/test/mock-agent.ts` — replace the `case "/entity":`
block with:

```ts
        case "/entity": {
          // Key by whichever field the set is actually keyed on. DocEntry for documents, and a
          // string key (CardCode, ItemCode) for master data.
          const found = rows.find((r) => r.DocEntry === body.key || r.CardCode === body.key || r.ItemCode === body.key);
          // The agent lifts @odata.etag out of the body into the envelope (see DirectTransport).
          return found
            ? Response.json({ status: 200, data: found, etag: found["@odata.etag"] })
            : fail(404, -2028, "No matching records found");
        }
```

Then, in every test in `invites.test.ts` that calls `makeTenant()`, add `await connect(tenantId);`
right after `makeTenant()` — before the first `invite(...)`. Read the file and do this for each
test; there is no shared setup helper to change in one place.

Finally add two new cases at the end of the `describe`:

```ts
  test("an unknown CardCode is rejected, and nothing is written", async () => {
    const { tenantId, slug } = await makeTenant();
    await connect(tenantId);
    const admin = await makeUser("admin", tenantId);
    expect(await code(invite(slug, admin.cookie, "nobody@acme.test", "ZZZZ"))).toBe("BAD_REQUEST");
    expect(await db.select().from(portalClient).where(eq(portalClient.tenantId, tenantId))).toHaveLength(0);
  });

  test("a supplier is refused, and the stored cardName is B1's, not the browser's", async () => {
    const { tenantId, slug } = await makeTenant();
    await connect(tenantId);
    const admin = await makeUser("admin", tenantId);
    expect(await code(invite(slug, admin.cookie, "vendor@acme.test", "V0001"))).toBe("BAD_REQUEST");

    await invite(slug, admin.cookie, "real@acme.test");
    const [row] = await db.select().from(portalClient).where(eq(portalClient.email, "real@acme.test"));
    expect(row!.cardName).toBe("Acme Client SL");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test apps/server/test/invites.test.ts`
Expected: FAIL — the new cases fail (no validation yet), and the existing ones fail on the extra
`cardName` input being required.

- [ ] **Step 3: Validate against B1 in `invite`**

In `apps/server/src/orpc/routers/portal.ts`, replace the `invite` procedure's input and the two
lines that mint and insert with:

```ts
  invite: adminProcedure
    .input(z.object({ email: z.email(), cardCode: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const email = input.email.toLowerCase();
      const [existing] = await db
        .select({ role: member.role })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(and(eq(member.organizationId, context.tenantId), eq(user.email, email)))
        .limit(1);
      if (existing)
        throw new ORPCError("BAD_REQUEST", { message: `${email} already has access to this workspace` });

      // The binding is the portal's whole trust model — validate it against SAP rather than
      // trusting three text boxes. The stored name is B1's, never the browser's.
      const { b1 } = await tenantConnector(context.tenantId);
      const res = await viaB1(() =>
        b1.readEntity("BusinessPartners", input.cardCode, { select: ["CardCode", "CardName", "CardType"] }),
      ).catch((e: unknown) => {
        if (e instanceof ORPCError && e.code === "NOT_FOUND")
          throw new ORPCError("BAD_REQUEST", { message: `No business partner ${input.cardCode} in SAP.` });
        throw e;
      });
      const bp = res.data as { CardCode?: string; CardName?: string; CardType?: string };
      if (bp.CardType !== "cCustomer")
        throw new ORPCError("BAD_REQUEST", { message: `${input.cardCode} is not a customer in SAP.` });

      const token = randomBytes(32).toString("hex");
      await db.insert(portalClient).values({
        tenantId: context.tenantId, email,
        cardCode: String(bp.CardCode ?? input.cardCode), cardName: String(bp.CardName ?? ""),
        inviteTokenHash: hashToken(token),
      });
      // ponytail: copy-link invites; email provider when onboarding volume demands
      return { token }; // shown once — the web client builds the accept URL from its own origin
    }),
```

`tenantConnector` and `viaB1` are already imported by Task 5.

- [ ] **Step 4: Run the tests**

Run: `bun test apps/server/test/invites.test.ts`
Expected: PASS — the existing cases and the two new ones.

- [ ] **Step 5: Replace the two Inputs with the value help**

In `apps/web/src/routes/_authed/settings.tsx`:

Add the import:

```tsx
import { EntityValueHelp } from "../../components/b1/EntityValueHelp.tsx";
```

Delete the `invCardName` state (`const [invCardName, setInvCardName] = useState("");`) and its
reset in the "Invite client" button's `onClick`.

Replace the invite dialog's `Customer code` / `Customer name` label+Input pairs with:

```tsx
            <Label required>Customer</Label>
            <EntityValueHelp
              entitySet="BusinessPartners"
              keyField="CardCode"
              value={invCardCode}
              onChange={(v) => setInvCardCode(v == null ? "" : String(v))}
              headerText="Select a customer"
            />
```

And update the Create button's guard and payload:

```tsx
                <Button design="Emphasized"
                  disabled={!invEmail.trim() || !invCardCode.trim() || invite.isPending}
                  onClick={() => invite.mutate({ email: invEmail.trim(), cardCode: invCardCode.trim() })}>
                  {invite.isPending ? "Creating…" : "Create invite"}
                </Button>
```

`EntityValueHelp` queries `entities.rows`, an `adminProcedure` — Settings is admin-only, so this is
already inside the right fence.

- [ ] **Step 6: Full verification**

Run:
```bash
bun test apps packages
bunx tsc -p packages/b1/tsconfig.json --noEmit
bunx tsc -p apps/agent/tsconfig.json --noEmit
bunx tsc -p apps/server/tsconfig.json --noEmit
bunx tsc -p apps/web/tsconfig.json --noEmit
bun --cwd apps/web build
```
Expected: whole suite green, no type errors in any project, web build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/orpc/routers/portal.ts apps/server/test/invites.test.ts \
        apps/server/test/mock-agent.ts apps/web/src/routes/_authed/settings.tsx
git commit -m "feat: validate the portal client's business partner against SAP on invite"
```

---

## Manual verification (after Task 11, against the live ALUMIGRAF company)

```bash
docker compose up -d db && bun run dev        # :3000 + :5173
bun run dev:agent                             # agent.json -> localhost:50001 + localhost:60020
bun run seed:standard <slug> --force          # seeds the portal: variants
bun run seed:portal-client <slug> <email> <a real ALUMIGRAF CardCode>
```

Then walk both flows at `http://<slug>.lvh.me:5173`:

1. **Nav** — Quotations → the list shows only that CardCode's documents, minimal columns, no
   CardCode/cost fields, and no variant switcher. Select one row → Preview opens the PDF in the
   dialog, Download saves it. Select two → neither button shows. Open a row → object page, no Edit
   button, lines visible, both buttons work.
2. **Timeline** — take a project through configure → submit → (internal) quote in `/configs`, then
   copy the quotation to an order in `/b1/Quotations/<DocEntry>`. Reload `/portal/<id>`: the order
   appears on the timeline above the quotation, its `#number` navigates to the portal object page,
   and its Preview renders the *order's* layout, not the quotation's.
3. **Internal** — `/b1/Invoices`: select one row, Preview/Download in the count bar; select two,
   both gone. `/b1/Invoices/<DocEntry>`: both buttons next to Edit.
4. **Invite** — Settings → Invite client: the value help returns real business partners; typing an
   unknown CardCode by hand is rejected with SAP's own message; a supplier CardCode is rejected.

**Negative paths to see once:**
- agent stopped → both print buttons surface the existing `SERVICE_UNAVAILABLE` "SAP is not connected."
- API Gateway stopped but agent up → `BAD_GATEWAY` naming the gateway.
- a `layouts` entry pointing at a nonexistent `DocCode` → a message naming the entity, not a blank PDF.
