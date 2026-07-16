import { describe, expect, test } from "bun:test";
import { docHistoryPath, flattenDocs, sortDocRows } from "../src/doc-history.ts";

describe("docHistoryPath", () => {
  test("both criteria OR'd, quotes escaped, ordered by DocDate desc", () => {
    const p = docHistoryPath("Orders", { itemCode: "IT'M", cardCode: "C001" });
    expect(p.startsWith("/Orders?")).toBe(true);
    expect(decodeURIComponent(p)).toContain("CardCode eq 'C001' or DocumentLines/any(d: d/ItemCode eq 'IT''M')");
    expect(decodeURIComponent(p)).toContain("$orderby=DocDate desc");
    expect(p).toContain("$top=10");
    expect(p).toContain("$expand=DocumentLines(");
  });

  test("throws without criteria", () => {
    expect(() => docHistoryPath("Quotations", {})).toThrow();
  });
});

const docs = {
  value: [
    {
      DocNum: 7, DocDate: "2026-06-01", CardCode: "C001", CardName: "Acme",
      DocumentLines: [
        { ItemCode: "A", ItemDescription: "item A", Quantity: 5, UnitPrice: 10 },
        { ItemCode: "B", ItemDescription: "item B", Quantity: 1, UnitPrice: 99 },
      ],
    },
    {
      DocNum: 8, DocDate: "2026-07-01", CardCode: "C777", CardName: "Other",
      DocumentLines: [{ ItemCode: "A", ItemDescription: "item A", Quantity: 2, UnitPrice: 12 }],
    },
  ],
};

describe("flattenDocs + sortDocRows", () => {
  test("customer-matched docs keep all lines; item-only docs keep matching lines", () => {
    const rows = flattenDocs("order", docs, { itemCode: "A", cardCode: "C001" });
    expect(rows).toHaveLength(3); // doc 7: both lines (customer match), doc 8: line A only
    expect(rows.find((r) => r.docNum === 7 && r.itemCode === "A")!.matched).toBe("both");
    expect(rows.find((r) => r.docNum === 7 && r.itemCode === "B")!.matched).toBe("customer");
    expect(rows.find((r) => r.docNum === 8)!.matched).toBe("item");
  });

  test("sort: both first, then date desc", () => {
    const rows = sortDocRows(flattenDocs("order", docs, { itemCode: "A", cardCode: "C001" }));
    expect(rows[0]!.matched).toBe("both");
    expect(rows[1]!.docDate >= rows[2]!.docDate).toBe(true);
  });

  test("tolerates a bare-array response and missing lines", () => {
    expect(flattenDocs("quotation", [{ DocNum: 1, CardCode: "C1" }], { cardCode: "C1" })).toEqual([]);
  });
});
