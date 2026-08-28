import { afterEach, describe, expect, test } from "bun:test";
import { ServiceLayer } from "../src/service-layer.ts";
import { DirectTransport } from "../src/client.ts";
import { B1Error } from "../src/errors.ts";
import { readPages } from "../src/paging.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Call = { url: string; init: RequestInit };

/** Replace fetch with a scripted responder and record every call. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });

const sl = (over: Partial<ConstructorParameters<typeof ServiceLayer>[0]> = {}) =>
  new ServiceLayer({ url: "https://sap:50000", companyDb: "SBODEMOUS", user: "manager", pass: "pw", ...over });

const recordLogger = () => {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    info, warn,
    logger: { info: (m: string) => info.push(m), warn: (m: string) => warn.push(m) },
  };
};

const headerOf = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

describe("login cookies", () => {
  // The sample did setCookie.split(','), which breaks inside `Expires=Wed, 09 Jun 2021 ...`
  // and loses ROUTEID — mandatory on a load-balanced Service Layer.
  test("keeps every Set-Cookie whole, including ROUTEID and a comma-bearing Expires", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "B1SESSION=abc; Path=/b1s/v2; Expires=Wed, 09 Jun 2021 10:18:14 GMT; HttpOnly");
    headers.append("set-cookie", "ROUTEID=.node2; Path=/b1s");
    headers.append("content-type", "application/json");
    const calls = stubFetch((url) =>
      url.endsWith("/Login")
        ? new Response("{}", { headers })
        : json({ value: [] }));

    await sl().request({ url: "Items", method: "GET" });

    const cookie = headerOf(calls[1]!, "Cookie");
    expect(cookie).toBe("B1SESSION=abc; ROUTEID=.node2");
    expect(cookie).not.toContain("Expires");
    expect(cookie).not.toContain("Wed");
  });

  test("falls back to the JSON SessionId when no cookie comes back", async () => {
    const calls = stubFetch((url) => (url.endsWith("/Login") ? json({ SessionId: "sid" }) : json({ value: [] })));
    await sl().request({ url: "Items", method: "GET" });
    expect(headerOf(calls[1]!, "Cookie")).toBe("B1SESSION=sid; CompanyDB=SBODEMOUS");
  });

  test("a failed login surfaces as a B1Error, not a bare string", async () => {
    stubFetch(() => json({ error: { code: 100000004, message: { value: "Invalid credentials" } } }, { status: 401 }));
    const { logger, warn } = recordLogger();
    const e = await sl({ logger }).request({ url: "Items", method: "GET" }).catch((x) => x);
    expect(e).toBeInstanceOf(B1Error);
    expect((e as B1Error).status).toBe(401);
    expect((e as B1Error).code).toBe(100000004);
    expect((e as B1Error).message).toContain("Invalid credentials");
    expect(warn.some((m) => m.includes("login failed") && m.includes("Invalid credentials"))).toBe(true);
    expect(warn.join("\n")).not.toContain("pw");
  });
});

test("request logs method, status, and URL", async () => {
  stubFetch((url) => (url.endsWith("/Login") ? json({ SessionId: "sid" }) : json({ value: [] })));
  const { logger, info } = recordLogger();
  await sl({ logger }).request({ url: "Items", method: "GET" });
  const line = info.find((m) => m.includes("GET") && m.includes("Items"));
  expect(line).toMatch(/^GET 200 \d+ms \/Items$/);
  expect(line).not.toContain("https://");
});

test("ten concurrent cold requests fire exactly one login", async () => {
  let logins = 0;
  stubFetch(async (url) => {
    if (url.endsWith("/Login")) {
      logins++;
      await new Promise((r) => setTimeout(r, 5)); // widen the race the guard has to close
      return json({ SessionId: "sid" });
    }
    return json({ value: [] });
  });

  const s = sl();
  await Promise.all(Array.from({ length: 10 }, () => s.request({ url: "Items", method: "GET" })));
  expect(logins).toBe(1);
});

test("a 401 mid-session re-logs in and retries exactly once", async () => {
  let logins = 0;
  let reads = 0;
  stubFetch((url) => {
    if (url.endsWith("/Login")) { logins++; return json({ SessionId: `sid${logins}` }); }
    reads++;
    return reads === 1 ? json({ error: { code: 301, message: { value: "Invalid session" } } }, { status: 401 }) : json({ value: [1] });
  });

  const res = await sl().request({ url: "Items", method: "GET" });
  expect(logins).toBe(2);
  expect(reads).toBe(2);
  expect(res.status).toBe(200);
});

test("a persistent 401 gives up instead of looping", async () => {
  let reads = 0;
  stubFetch((url) => {
    if (url.endsWith("/Login")) return json({ SessionId: "sid" });
    reads++;
    return json({ error: { code: 301, message: { value: "nope" } } }, { status: 401 });
  });
  await expect(sl().request({ url: "Items", method: "GET" })).rejects.toBeInstanceOf(B1Error);
  expect(reads).toBe(2);
});

describe("DirectTransport", () => {
  const setup = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => {
    const calls = stubFetch((url, init) => (url.endsWith("/Login") ? json({ SessionId: "sid" }) : handler(url, init)));
    return { t: new DirectTransport(sl()), calls };
  };

  test("$count rides on the same read and comes back in the same envelope", async () => {
    const { t, calls } = setup(() => json({ "@odata.count": 412, value: [{ DocEntry: 1 }] }));
    const res = await t.readEntitySet("Orders", { count: true, top: 1 });
    expect(calls[1]!.url).toContain("$count=true");
    expect(calls).toHaveLength(2); // login + one read; no second call for the total
    expect((res.data as Record<string, unknown>)["@odata.count"]).toBe(412);
  });

  test("update sends If-Match and a 412 surfaces as a conflict, never a silent overwrite", async () => {
    const { t, calls } = setup((_u, init) =>
      (init.headers as Record<string, string>)["If-Match"] === "W/\"1\""
        ? json({ error: { code: -2039, message: { value: "Precondition failed" } } }, { status: 412 })
        : json({}));

    const e = await t.updateEntity("Orders", 5, { Comments: "x" }, { etag: 'W/"1"' }).catch((x) => x);
    expect(calls[1]!.init.method).toBe("PATCH");
    expect(e).toBeInstanceOf(B1Error);
    expect((e as B1Error).status).toBe(412);
  });

  test("create asks for the representation so the document comes back in one call", async () => {
    const { t, calls } = setup(() => json({ DocEntry: 77, DocNum: 900, "@odata.etag": "W/\"2\"" }, { status: 201 }));
    const res = await t.createEntity("Quotations", { CardCode: "C1" });
    expect(headerOf(calls[1]!, "Prefer")).toBe("return-representation");
    expect((res.data as Record<string, unknown>).DocEntry).toBe(77);
    expect(res.etag).toBe('W/"2"');
  });

  test("maxPageSize becomes a Prefer header, not a query option", async () => {
    const { t, calls } = setup(() => json({ value: [] }));
    await t.readEntitySet("Items", { maxPageSize: 500 });
    expect(headerOf(calls[1]!, "Prefer")).toBe("odata.maxpagesize=500");
    expect(calls[1]!.url).not.toContain("maxpagesize");
  });

  describe("readNext", () => {
    test("follows a relative nextLink under the Service Layer base", async () => {
      const { t, calls } = setup(() => json({ value: [] }));
      await t.readNext("Items?$skip=20");
      expect(calls[1]!.url).toBe("https://sap:50000/b1s/v2/Items?$skip=20");
    });

    test("rejects a foreign origin — the one route that takes a B1-supplied URL", async () => {
      const { t } = setup(() => json({ value: [] }));
      await expect(t.readNext("https://evil.example/steal")).rejects.toThrow("outside the Service Layer");
      await expect(t.readNext("../../../etc")).rejects.toThrow("outside the Service Layer");
    });
  });
});

describe("readPages", () => {
  const pager = (pages: number) => {
    let n = 0;
    const t = {
      readEntitySet: async () => ({ status: 200, data: { value: [{ i: n }], ...(++n < pages ? { "@odata.nextLink": `Items?$skip=${n}` } : {}) } }),
      readNext: async () => ({ status: 200, data: { value: [{ i: n }], ...(++n < pages ? { "@odata.nextLink": `Items?$skip=${n}` } : {}) } }),
    };
    return t as never;
  };

  test("stops when B1 stops offering a nextLink", async () => {
    const { rows, truncated } = await readPages(pager(3), "Items", undefined, { maxPages: 10 });
    expect(rows).toHaveLength(3);
    expect(truncated).toBe(false);
  });

  test("respects the caller's page cap and says so", async () => {
    const { rows, truncated } = await readPages(pager(100), "Items", undefined, { maxPages: 4 });
    expect(rows).toHaveLength(4);
    expect(truncated).toBe(true);
  });
});

test("a hung Service Layer fails with a timeout rather than hanging", async () => {
  stubFetch(async (url, init) => {
    if (url.endsWith("/Login")) return json({ SessionId: "sid" });
    // Stands in for a real hung request: an open socket keeps the loop alive, which is what
    // lets AbortSignal.timeout's (unref'd) timer fire. The client must be passing that signal.
    return new Promise<Response>((_res, rej) => {
      const keepAlive = setInterval(() => {}, 5);
      init.signal?.addEventListener("abort", () => {
        clearInterval(keepAlive);
        rej(new Error("The operation was aborted"));
      });
    });
  });
  await expect(sl({ timeoutMs: 30 }).request({ url: "Items", method: "GET" })).rejects.toThrow(/abort/i);
});
