import { describe, expect, test } from "bun:test";
import { DirectTransport, nextLinkOf } from "../src/index.ts";
import type { ServiceLayer } from "../src/service-layer.ts";

// The Service Layer pages server-side at 20 rows unless asked otherwise, and that default is
// invisible: you get 20 rows and an @odata.nextLink, which looks exactly like a short last page to
// anyone inferring "there is more" from the row count. These lock in both halves of the fix.

const spy = () => {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const sl = {
    base: "https://sap.example:50000/b1s/v2/",
    request: async (o: { url: string; headers?: Record<string, string> }) => {
      calls.push(o);
      return { status: 200, data: { value: [] } };
    },
  } as unknown as ServiceLayer;
  return { calls, t: new DirectTransport(sl) };
};

describe("Prefer: odata.maxpagesize", () => {
  test("asking for $top implies asking for a page that big — otherwise B1 answers with 20", async () => {
    const { calls, t } = spy();
    await t.readEntitySet("Items", { top: 100 });
    expect(calls[0]!.url).toContain("$top=100");
    expect(calls[0]!.headers).toEqual({ Prefer: "odata.maxpagesize=100" });
  });

  test("an explicit maxPageSize wins over $top", async () => {
    const { calls, t } = spy();
    await t.readEntitySet("Items", { top: 100, maxPageSize: 20 });
    expect(calls[0]!.headers).toEqual({ Prefer: "odata.maxpagesize=20" });
  });

  test("maxPageSize 0 disables server paging and is not confused with 'unset'", async () => {
    const { calls, t } = spy();
    await t.readEntitySet("Items", { maxPageSize: 0 });
    expect(calls[0]!.headers).toEqual({ Prefer: "odata.maxpagesize=0" });
  });

  test("no $top and no maxPageSize sends no Prefer header at all", async () => {
    const { calls, t } = spy();
    await t.readEntitySet("Items", { select: ["ItemCode"] });
    expect(calls[0]!.headers).toBeUndefined();
  });

  test("readNext re-sends it — Prefer is per-request, so page 2 would otherwise drop to 20", async () => {
    const { calls, t } = spy();
    await t.readNext("Items?$skip=100", 100);
    expect(calls[0]!.headers).toEqual({ Prefer: "odata.maxpagesize=100" });
  });

  test("readNext still refuses a link outside the Service Layer", async () => {
    const { t } = spy();
    await expect(t.readNext("https://evil.example/steal", 100)).rejects.toThrow("outside the Service Layer");
  });
});

describe("nextLinkOf is the 'there is more' signal", () => {
  test("reads both the v4 and v3 spellings, and ignores an empty one", () => {
    expect(nextLinkOf({ value: [], "@odata.nextLink": "Items?$skip=20" })).toBe("Items?$skip=20");
    expect(nextLinkOf({ value: [], "odata.nextLink": "Items?$skip=20" })).toBe("Items?$skip=20");
    expect(nextLinkOf({ value: [] })).toBeUndefined();
    expect(nextLinkOf({ value: [], "@odata.nextLink": "" })).toBeUndefined();
  });

  test("a full page that is genuinely the last one has no nextLink — the row count cannot tell", () => {
    // 20 rows returned for $top=20 used to mean "probably more"; B1 says otherwise.
    expect(nextLinkOf({ value: new Array(20).fill({}) })).toBeUndefined();
  });
});
