import { afterEach, expect, test } from "bun:test";
import { B1Error } from "../src/errors.ts";
import { RemoteTransport } from "../src/remote.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Call = { url: string; init: RequestInit };
const stub = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  return calls;
};

const remote = (over = {}) => new RemoteTransport({ agentUrl: "http://localhost:4000", secret: "s3cret", ...over });

test("each operation is its own endpoint — no generic passthrough, no URL on the wire", async () => {
  const calls = stub(() => Response.json({ status: 200, data: { value: [] } }));
  const t = remote();
  await t.readEntitySet("Items", { filter: "A eq 1" });
  await t.createEntity("Quotations", { CardCode: "C1" }, { prefer: "representation" });
  await t.updateEntity("Orders", 5, { Comments: "x" }, { etag: 'W/"1"' });

  expect(calls.map((c) => c.url)).toEqual([
    "http://localhost:4000/b1/entity-set",
    "http://localhost:4000/b1/create",
    "http://localhost:4000/b1/update",
  ]);
  expect(calls.every((c) => c.init.method === "POST")).toBe(true);
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ entitySet: "Items", query: { filter: "A eq 1" } });
});

test("beas is the same transport pointed at the other route prefix", async () => {
  const calls = stub(() => Response.json({ status: 200, data: {} }));
  await remote({ target: "beas" }).readEntitySet("Parts");
  expect(calls[0]!.url).toBe("http://localhost:4000/beas/entity-set");
});

test("the bearer secret goes on every call; Access headers only when configured", async () => {
  let calls = stub(() => Response.json({ status: 200, data: {} }));
  await remote().readEntitySet("Items");
  let h = calls[0]!.init.headers as Record<string, string>;
  expect(h.Authorization).toBe("Bearer s3cret");
  expect(h["CF-Access-Client-Id"]).toBeUndefined();

  calls = stub(() => Response.json({ status: 200, data: {} }));
  await remote({ accessClientId: "id", accessClientSecret: "sec" }).readEntitySet("Items");
  h = calls[0]!.init.headers as Record<string, string>;
  expect(h["CF-Access-Client-Id"]).toBe("id");
  expect(h["CF-Access-Client-Secret"]).toBe("sec");
});

test("B1's status and code survive the second hop intact", async () => {
  stub(() => Response.json({ error: { status: 412, code: -2039, message: "Precondition failed" } }, { status: 502 }));
  const e = await remote().updateEntity("Orders", 1, {}, { etag: "old" }).catch((x) => x);
  expect(e).toBeInstanceOf(B1Error);
  expect((e as B1Error).status).toBe(412);
  expect((e as B1Error).code).toBe(-2039);
});

test("an unreachable agent is 503, distinct from anything B1 said", async () => {
  stub(() => { throw new TypeError("Unable to connect"); });
  const e = await remote().readEntitySet("Items").catch((x) => x);
  expect(e).toBeInstanceOf(B1Error);
  expect((e as B1Error).status).toBe(503);
  expect((e as B1Error).message).toContain("Agent unreachable");
});
