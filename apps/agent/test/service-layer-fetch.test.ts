import { afterAll, describe, expect, test } from "bun:test";
import {
  buildCrossjoinPath,
  buildObjectHeaderPath,
  flattenCrossjoinRows,
  nextLinkPath,
  ServiceLayerClient,
  projectFullRecord,
  type ObjectFetchRequest,
} from "../src/service-layer-client.ts";
import { BeasClient } from "../src/beas-client.ts";

describe("object fetch path builders", () => {
  test("escapes string keys in header path", () => {
    const path = buildObjectHeaderPath("BusinessPartners", "O'Brien", true, ["CardCode", "CardName"]);
    expect(path).toBe("/BusinessPartners('O''Brien')?$select=CardCode,CardName");
  });

  test("uses bare numeric keys in header path", () => {
    const path = buildObjectHeaderPath("Quotations", "142", false, ["DocEntry", "CardCode"]);
    expect(path).toBe("/Quotations(142)?$select=DocEntry,CardCode");
  });

  test("rejects bad identifiers in select", () => {
    expect(() => buildObjectHeaderPath("Quotations", "1", false, ["DocEntry;drop"])).toThrow(
      /Invalid/,
    );
  });

  test("builds profiled collection $crossjoin with escaped filter", () => {
    const path = buildCrossjoinPath({
      entity: "Quotations",
      key: "142",
      keyQuoted: false,
      collection: {
        name: "DocumentLines",
        select: ["DocEntry", "LineNum", "ItemCode"],
        parentKey: "DocEntry",
        childParentKey: "DocEntry",
        rowKey: "LineNum",
      },
    });
    expect(path).toBe(
      "/$crossjoin(Quotations,Quotations/DocumentLines)" +
        "?$expand=Quotations($select=DocEntry),Quotations/DocumentLines($select=DocEntry,LineNum,ItemCode)" +
        "&$filter=" +
        encodeURIComponent(
          "Quotations/DocEntry eq Quotations/DocumentLines/DocEntry and Quotations/DocEntry eq 142",
        ),
    );
  });

  test("escapes string key in crossjoin filter", () => {
    const path = buildCrossjoinPath({
      entity: "BusinessPartners",
      key: "O'Brien",
      keyQuoted: true,
      collection: {
        name: "ContactEmployees",
        select: ["CardCode", "InternalCode", "Name"],
        parentKey: "CardCode",
        childParentKey: "CardCode",
        rowKey: "InternalCode",
      },
    });
    const filter = decodeURIComponent(path.split("&$filter=")[1]!);
    expect(filter).toContain("BusinessPartners/CardCode eq 'O''Brien'");
  });
});

describe("crossjoin merge + full-record fallback", () => {
  test("flattens crossjoin pairs into collection rows", () => {
    const rows = [
      {
        Quotations: { DocEntry: 142 },
        "Quotations/DocumentLines": { DocEntry: 142, LineNum: 0, ItemCode: "A1" },
      },
      {
        Quotations: { DocEntry: 142 },
        "Quotations/DocumentLines": { DocEntry: 142, LineNum: 1, ItemCode: "B2" },
      },
    ];
    expect(flattenCrossjoinRows(rows, "Quotations", "DocumentLines")).toEqual([
      { DocEntry: 142, LineNum: 0, ItemCode: "A1" },
      { DocEntry: 142, LineNum: 1, ItemCode: "B2" },
    ]);
  });

  test("projectFullRecord keeps only requested header + collection fields", () => {
    const request: ObjectFetchRequest = {
      entity: "Quotations",
      key: "142",
      keyQuoted: false,
      select: ["DocEntry", "CardCode", "Comments"],
      collections: [
        {
          name: "DocumentLines",
          select: ["DocEntry", "LineNum", "ItemCode"],
          parentKey: "DocEntry",
          childParentKey: "DocEntry",
          rowKey: "LineNum",
        },
      ],
      fullRecordFallback: true,
    };
    const full = {
      DocEntry: 142,
      CardCode: "C1",
      Comments: "hi",
      Extra: "drop-me",
      DocumentLines: [
        { DocEntry: 142, LineNum: 0, ItemCode: "A1", WarehouseCode: "01" },
        { DocEntry: 142, LineNum: 1, ItemCode: "B2", WarehouseCode: "02" },
      ],
      AddressExtension: { BillToStreet: "x" },
    };
    expect(projectFullRecord(full, request)).toEqual({
      DocEntry: 142,
      CardCode: "C1",
      Comments: "hi",
      DocumentLines: [
        { DocEntry: 142, LineNum: 0, ItemCode: "A1" },
        { DocEntry: 142, LineNum: 1, ItemCode: "B2" },
      ],
    });
  });
});

describe("nextLinkPath", () => {
  const base = "https://b1.example.com:50000/b1s/v2";

  test("returns undefined when there is no next link", () => {
    expect(nextLinkPath(undefined, base)).toBeUndefined();
    expect(nextLinkPath("", base)).toBeUndefined();
    expect(nextLinkPath(42, base)).toBeUndefined();
  });

  test("prefixes a relative link with a slash", () => {
    expect(nextLinkPath("Orders?$skip=20", base)).toBe("/Orders?$skip=20");
  });

  test("keeps an already-rooted relative link", () => {
    expect(nextLinkPath("/Orders?$skip=20", base)).toBe("/Orders?$skip=20");
  });

  test("strips the service root from an absolute link", () => {
    expect(nextLinkPath(`${base}/Orders?$skip=20&$top=5`, base)).toBe("/Orders?$skip=20&$top=5");
  });

  test("keeps the path when an absolute link does not share the service root", () => {
    expect(nextLinkPath("https://other.example.com/Orders?$skip=20", base)).toBe("/Orders?$skip=20");
  });
});

describe("queryRaw paging", () => {
  const base = "https://b1.example.com:50000/b1s/v2";
  const real = globalThis.fetch;
  const gets: { url: string; prefer: string | null }[] = [];

  const stub = (body: Record<string, unknown>) => {
    gets.length = 0;
    globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
      if (String(url).endsWith("/Login"))
        return new Response("{}", { headers: { "set-cookie": "B1SESSION=x; path=/" } });
      gets.push({ url: String(url), prefer: new Headers(init.headers).get("Prefer") });
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  };
  const client = () =>
    new ServiceLayerClient({ baseUrl: base, companyDb: "DB", user: "u", pass: "p", pageSize: 100 });

  afterAll(() => { globalThis.fetch = real; });

  test("returns one page and hands the nextLink back as a re-requestable path", async () => {
    stub({ value: [{ ItemCode: "A1" }], "@odata.nextLink": `${base}/Items?$skip=100` });
    const out = (await client().queryRaw("/Items")) as Record<string, unknown>;
    expect(out.value).toEqual([{ ItemCode: "A1" }]);
    expect(out["@odata.nextLink"]).toBe("/Items?$skip=100"); // preserved, not followed
    expect(gets).toHaveLength(1);
    expect(gets[0]!.prefer).toBe("odata.maxpagesize=100");
  });

  test("accepts the v1 odata.nextLink spelling", async () => {
    stub({ value: [{ ItemCode: "A1" }], "odata.nextLink": `${base}/Items?$skip=100` });
    const out = (await client().queryRaw("/Items")) as Record<string, unknown>;
    expect(out["@odata.nextLink"]).toBe("/Items?$skip=100");
  });

  test("all=true asks B1 to switch server paging off", async () => {
    stub({ value: [{ ItemCode: "A1" }] });
    await client().queryRaw("/Items", true);
    expect(gets).toHaveLength(1);
    expect(gets[0]!.prefer).toBe("odata.maxpagesize=0");
  });

  test("rejects invalid configured page sizes", () => {
    for (const pageSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ServiceLayerClient({
        baseUrl: base, companyDb: "DB", user: "u", pass: "p", pageSize,
      })).toThrow("positive integer");
    }
    expect(() => new ServiceLayerClient({
      baseUrl: base, companyDb: "DB", user: "u", pass: "p", pageSize: 1,
    })).not.toThrow();
  });

  test("passes a non-collection response straight through", async () => {
    stub({ ItemCode: "A1" });
    expect(await client().queryRaw("/Items('A1')")).toEqual({ ItemCode: "A1" });
  });

  test("Beas all=false returns only the first page", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({
        value: [{ Code: "A" }],
        "odata.nextLink": "https://beas.example.com/api/rows?$skip=1",
      }));
    }) as unknown as typeof fetch;

    const out = (await new BeasClient({ baseUrl: "https://beas.example.com/api" }).get("/rows", false)) as Record<string, unknown>;
    expect(out.value).toEqual([{ Code: "A" }]);
    expect(out["@odata.nextLink"]).toBe("/rows?$skip=1");
    expect(urls).toHaveLength(1);
  });

  test("Beas all=true follows every page", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      const body = String(url).includes("$skip=1")
        ? { value: [{ Code: "B" }] }
        : { value: [{ Code: "A" }], "@odata.nextLink": "/rows?$skip=1" };
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;

    const out = (await new BeasClient({ baseUrl: "https://beas.example.com/api" }).get("/rows", true)) as Record<string, unknown>;
    expect(out.value).toEqual([{ Code: "A" }, { Code: "B" }]);
    expect(out["@odata.nextLink"]).toBeUndefined();
    expect(urls).toHaveLength(2);
  });

  test("Beas all=true rejects a normalized nextLink cycle before refetching", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      if (urls.length > 2) throw new Error("unexpected third request");
      const body = String(url).includes("$skip=1")
        ? { value: [{ Code: "B" }], "@odata.nextLink": "/rows?$top=10&$skip=1" }
        : {
            value: [{ Code: "A" }],
            "@odata.nextLink": "https://beas.example.com/api/rows?$skip=1&$top=10",
          };
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;

    await expect(
      new BeasClient({ baseUrl: "https://beas.example.com/api" }).get("/rows", true),
    ).rejects.toThrow("repeated");
    expect(urls).toHaveLength(2);
  });
});
