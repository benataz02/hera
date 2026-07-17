import { describe, expect, test } from "bun:test";
import { docHistoryPath, flattenDocs, sortDocRows } from "../src/doc-history.ts";

describe("docHistoryPath", () => {
  test("both criteria OR'd against the crossjoin, quotes escaped, ordered by DocDate desc", () => {
    const p = docHistoryPath("Orders", { itemCode: "IT'M", cardCode: "C001" });
    expect(p.startsWith("/$crossjoin(Orders,Orders/DocumentLines)?")).toBe(true);
    expect(decodeURIComponent(p)).toContain(
      "(Orders/CardCode eq 'C001' or Orders/DocumentLines/ItemCode eq 'IT''M')",
    );
    expect(decodeURIComponent(p)).toContain("$orderby=Orders/DocDate desc");
    expect(p).toContain("$top=10");
    // B1 has no lambdas — the whole reason this is a crossjoin.
    expect(decodeURIComponent(p)).not.toContain("any(");
  });

  // Without this the crossjoin pairs every document with every line in the company.
  test("always joins on DocEntry, even with a single criterion", () => {
    for (const opts of [{ cardCode: "C001" }, { itemCode: "A" }]) {
      expect(decodeURIComponent(docHistoryPath("Quotations", opts))).toContain(
        "Quotations/DocEntry eq Quotations/DocumentLines/DocEntry and (",
      );
    }
  });

  test("throws without criteria", () => {
    expect(() => docHistoryPath("Quotations", {})).toThrow();
  });
});

// Shape copied from a live b1s/v2 $crossjoin response: one flat pair per line.
const pair = (d: Record<string, unknown>, l: Record<string, unknown>) => ({
  Orders: d,
  "Orders/DocumentLines": l,
});
const docs = {
  value: [
    pair({ DocNum: 7, DocDate: "2026-06-01", CardCode: "C001", CardName: "Acme" },
      { ItemCode: "A", ItemDescription: "item A", Quantity: 5, UnitPrice: 10 }),
    pair({ DocNum: 7, DocDate: "2026-06-01", CardCode: "C001", CardName: "Acme" },
      { ItemCode: "B", ItemDescription: "item B", Quantity: 1, UnitPrice: 99 }),
    pair({ DocNum: 8, DocDate: "2026-07-01", CardCode: "C777", CardName: "Other" },
      { ItemCode: "A", ItemDescription: "item A", Quantity: 2, UnitPrice: 12 }),
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
