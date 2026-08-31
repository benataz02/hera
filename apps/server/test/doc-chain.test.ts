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
