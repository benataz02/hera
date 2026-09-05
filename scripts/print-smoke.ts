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
