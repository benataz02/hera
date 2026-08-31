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
