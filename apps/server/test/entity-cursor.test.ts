import { describe, expect, test } from "bun:test";
process.env.HERA_SECRET_KEY ??= "test-key-for-cursor-sealing-min-length";
const { readRows } = await import("../src/entity-read.ts");

// The list cursor is B1's own @odata.nextLink, encrypted. These cover the reason it is sealed
// rather than sent as-is: readNext will fetch any URL under the Service Layer base, so an
// unsealed cursor would let a portal client replace the page-1 CardCode fence with anything.

const schema = {
  name: "Orders", label: "Orders", keys: ["DocEntry"],
  fields: [
    { name: "DocEntry", kind: "number", edmType: "Edm.Int32" },
    { name: "CardCode", kind: "string", edmType: "Edm.String" },
  ],
} as never;

const spec = { select: [], filter: [], orderby: [], filterBar: [] };
const internal = { tenantId: "t1", key: "internal" };
const portal = { tenantId: "t1", key: "portal:C0001" };

/** A transport that answers one page and records what it was asked for. */
const fake = (nextLink?: string) => {
  const seen: { entitySet?: string; query?: unknown; nextLink?: string; maxPageSize?: number }[] = [];
  const b1 = {
    readEntitySet: async (entitySet: string, query: unknown) => {
      seen.push({ entitySet, query });
      return { status: 200, data: { value: [{ DocEntry: 1 }], ...(nextLink ? { "@odata.nextLink": nextLink } : {}) } };
    },
    readNext: async (link: string, maxPageSize?: number) => {
      seen.push({ nextLink: link, maxPageSize });
      return { status: 200, data: { value: [{ DocEntry: 2 }] } };
    },
  } as never;
  return { b1, seen };
};

describe("list paging cursor", () => {
  test("page 1 asks for a page size, never a $top, and seals the nextLink it gets back", async () => {
    const { b1, seen } = fake("Orders?$skip=100");
    const page = await readRows(b1, schema, "Orders", { spec, pageSize: 100, count: true }, internal);
    const q = seen[0]!.query as Record<string, unknown>;
    expect(q.maxPageSize).toBe(100);
    expect(q.top).toBeUndefined(); // $top would suppress @odata.nextLink
    expect(q.count).toBe(true);
    expect(page.nextCursor).toBeString();
    expect(page.nextCursor).not.toContain("Orders"); // opaque: the URL is not readable
  });

  test("the last page has no cursor", async () => {
    const { b1 } = fake(undefined);
    const page = await readRows(b1, schema, "Orders", { spec, pageSize: 100 }, internal);
    expect(page.nextCursor).toBeUndefined();
  });

  test("a cursor round-trips to readNext, carrying the page size so page 2 isn't 20 rows", async () => {
    const { b1, seen } = fake("Orders?$skip=100");
    const first = await readRows(b1, schema, "Orders", { spec, pageSize: 100 }, internal);
    await readRows(b1, schema, "Orders", { spec, pageSize: 100, cursor: first.nextCursor }, internal);
    expect(seen[1]).toEqual({ nextLink: "Orders?$skip=100", maxPageSize: 100 });
  });

  test("a portal client cannot replay an internal cursor — that is the CardCode fence", async () => {
    const { b1 } = fake("Orders?$skip=100");
    const first = await readRows(b1, schema, "Orders", { spec, pageSize: 100 }, internal);
    await expect(
      readRows(b1, schema, "Orders", { spec, pageSize: 100, cursor: first.nextCursor }, portal),
    ).rejects.toThrow("does not belong to this list");
  });

  test("a cursor is bound to its entity set and its tenant", async () => {
    const { b1 } = fake("Orders?$skip=100");
    const first = await readRows(b1, schema, "Orders", { spec, pageSize: 100 }, internal);
    await expect(
      readRows(b1, schema, "Invoices", { spec, pageSize: 100, cursor: first.nextCursor }, internal),
    ).rejects.toThrow("does not belong to this list");
    await expect(
      readRows(b1, schema, "Orders", { spec, pageSize: 100, cursor: first.nextCursor }, { tenantId: "t2", key: "internal" }),
    ).rejects.toThrow("does not belong to this list");
  });

  test("a forged or tampered cursor fails closed", async () => {
    const { b1 } = fake("Orders?$skip=100");
    await expect(
      readRows(b1, schema, "Orders", { spec, pageSize: 100, cursor: "Orders?$skip=0" }, internal),
    ).rejects.toThrow("Invalid page cursor");
  });
});
