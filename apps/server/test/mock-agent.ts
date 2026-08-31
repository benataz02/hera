import { db, sapConnection } from "@hera/db";
import { entitySetPath } from "@hera/b1";
import { encryptSecret } from "../src/crypto.ts";

// A stand-in for the on-prem agent: the same operation-shaped HTTP surface over a tiny in-memory
// B1. Real enough to exercise the whole cloud hop — RemoteTransport, the bearer check, the wire
// error envelope — without a Service Layer.

export type MockStore = Record<string, Record<string, unknown>[]>;

const SECRET = "test-agent-secret";

export type MockAgent = {
  url: string;
  store: MockStore;
  /** EDMX served by /metadata; set it to make entities.schema work */
  metadata: { xml: string };
  /** every {route, body} the cloud sent, in order */
  calls: { route: string; body: Record<string, unknown> }[];
  /** entity sets whose UDFs are "not defined in this company" — filtering on one 400s, as B1 does */
  missingUdf: Set<string>;
  stop: () => void;
};

/** `Field eq 'value'` — the only filter shape the mock understands, which is all the dedup
 *  check-then-create needs. Anything else matches nothing. */
function applyFilter(rows: Record<string, unknown>[], filter: string | undefined): Record<string, unknown>[] {
  if (!filter) return rows;
  const m = /^([A-Za-z_][A-Za-z0-9_]*) eq '(.*)'$/.exec(filter);
  if (!m) return [];
  return rows.filter((r) => String(r[m[1]!] ?? "") === m[2]!.replace(/''/g, "'"));
}

export function startMockAgent(store: MockStore = {}): MockAgent {
  const calls: MockAgent["calls"] = [];
  const missingUdf = new Set<string>();
  const metadata = { xml: "" };
  let nextDocEntry = 1;
  let nextEtag = 1000; // clear of any etag a fixture hand-writes

  const fail = (status: number, code: number | null, message: string) =>
    Response.json({ error: { status, code, message } }, { status: status === 401 ? 401 : 502 });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/health") return Response.json({ ok: true });
      if (req.headers.get("authorization") !== `Bearer ${SECRET}`) return fail(401, null, "Bad agent secret");

      const route = pathname.replace(/^\/b1/, "");
      const body = (await req.json()) as Record<string, any>;
      calls.push({ route, body });
      const rows = (store[body.entitySet] ??= []);

      switch (route) {
        case "/entity-set": {
          const filter: string | undefined = body.query?.filter;
          // B1 answers a filter on a UDF that does not exist in the company with a 400.
          if (filter && missingUdf.has(body.entitySet) && /U_[A-Za-z0-9_]+/.test(filter))
            return fail(400, -1000, `Property '${/U_[A-Za-z0-9_]+/.exec(filter)![0]}' of '${body.entitySet}' is invalid`);
          // Assert the URL builder is still reachable from here — a bad query would throw.
          entitySetPath(body.entitySet, body.query);
          return Response.json({ status: 200, data: { value: applyFilter(rows, filter).slice(0, body.query?.top ?? 20) } });
        }
        case "/create": {
          const row = { DocEntry: nextDocEntry, DocNum: 900 + nextDocEntry, "@odata.etag": `W/"${nextEtag++}"`, ...body.data };
          nextDocEntry++;
          rows.push(row);
          return Response.json({ status: 201, data: row, etag: row["@odata.etag"] });
        }
        case "/entity": {
          const found = rows.find((r) => r.DocEntry === body.key);
          // The agent lifts @odata.etag out of the body into the envelope (see DirectTransport).
          return found
            ? Response.json({ status: 200, data: found, etag: found["@odata.etag"] })
            : fail(404, -2028, "No matching records found");
        }
        case "/update": {
          const found = rows.find((r) => r.DocEntry === body.key);
          if (!found) return fail(404, -2028, "No matching records found");
          // The whole point of If-Match: a stale tag means someone else got there first.
          if (body.etag && body.etag !== found["@odata.etag"])
            return fail(412, -2039, "Precondition failed");
          Object.assign(found, body.data, { "@odata.etag": `W/"${nextEtag++}"` });
          return Response.json({ status: 204, data: null });
        }
        case "/print": {
          if (!["Quotations", "Orders", "DeliveryNotes", "Invoices"].includes(body.entity))
            return fail(400, null, `No print layout configured for '${body.entity}'`);
          return Response.json({
            // "%PDF-1.4\n" — enough for a caller to prove it decoded the base64 it was given.
            pdf: Buffer.from(`%PDF-1.4\n${body.entity}:${body.docEntry}`).toString("base64"),
            fileName: `${body.entity}-${body.docEntry}.pdf`,
          });
        }
        case "/metadata":
          return Response.json({ status: 200, data: metadata.xml });
        default:
          return fail(404, null, `Unknown operation '${route}'`);
      }
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    store, calls, missingUdf, metadata,
    stop: () => void server.stop(true),
  };
}

/** Point a tenant at the mock agent — the same row a real install writes. */
export async function connectTenant(tenantId: string, agent: MockAgent): Promise<void> {
  const row = { tenantId, agentUrl: agent.url, secret: encryptSecret(SECRET) };
  await db.insert(sapConnection).values(row).onConflictDoUpdate({ target: sapConnection.tenantId, set: row });
}
