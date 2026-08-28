import { describe, expect, test } from "bun:test";
import { buildCopy, findFlow, flowsFrom } from "../src/doc-copy.ts";
import { missingRequired, pickEditable, profileOf } from "../src/entity-profiles.ts";

const order = {
  DocEntry: 42,
  DocNum: 900,
  CardCode: "C0001",
  DocDate: "2026-08-01",
  DocDueDate: "2026-08-31",
  DocumentLines: [
    {
      LineNum: 0, ItemCode: "A1", ItemDescription: "Widget", Quantity: 5, UnitPrice: 10,
      WarehouseCode: "01", U_HERA_Note: "keep me",
      // Recalculated or system-managed on the target — must not be copied.
      LineTotal: 50, DocEntry: 42, VisOrder: 0, LineStatus: "bost_Open", TaxTotal: 10.5,
    },
    { LineNum: 3, ItemCode: "B2", Quantity: 1, UnitPrice: 99 }, // LineNum != array index
  ],
};

describe("document flows", () => {
  test("the sales chain is there, with the SOURCE object type as BaseType", () => {
    expect(findFlow("Orders", "DeliveryNotes")).toMatchObject({ baseType: 17 });
    expect(findFlow("DeliveryNotes", "Invoices")).toMatchObject({ baseType: 15 });
    expect(findFlow("Quotations", "Orders")).toMatchObject({ baseType: 23 });
  });

  test("an unsupported conversion has no flow rather than a guessed one", () => {
    expect(findFlow("Invoices", "Quotations")).toBeUndefined();
    expect(flowsFrom("Orders").map((f) => f.target)).toEqual(["DeliveryNotes", "Invoices"]);
  });
});

describe("buildCopy", () => {
  const flow = findFlow("Orders", "DeliveryNotes")!;

  test("every line carries the base reference that closes the source line", () => {
    const doc = buildCopy(flow, order);
    const lines = doc.DocumentLines as Record<string, unknown>[];
    expect(lines[0]).toMatchObject({ BaseType: 17, BaseEntry: 42, BaseLine: 0 });
    // BaseLine is the source LineNum, not the array position — they diverge after a line delete.
    expect(lines[1]).toMatchObject({ BaseLine: 3 });
  });

  test("copies business fields and U_ UDFs, drops calculated and system ones", () => {
    const [line] = buildCopy(flow, order).DocumentLines as Record<string, unknown>[];
    expect(line).toMatchObject({ ItemCode: "A1", Quantity: 5, UnitPrice: 10, WarehouseCode: "01", U_HERA_Note: "keep me" });
    for (const dropped of ["LineTotal", "VisOrder", "LineStatus", "TaxTotal"]) expect(line![dropped]).toBeUndefined();
    // DocEntry on the line would point the new line at the OLD document.
    expect(line!.DocEntry).toBeUndefined();
  });

  test("the header comes from the source and says where it came from", () => {
    const doc = buildCopy(flow, order);
    expect(doc).toMatchObject({ CardCode: "C0001", DocDate: "2026-08-01", DocDueDate: "2026-08-31" });
    expect(String(doc.Comments)).toContain("900");
    expect(buildCopy(flow, order, { comments: "mine" }).Comments).toBe("mine");
  });

  test("a partial copy takes only the selected lines", () => {
    expect((buildCopy(flow, order, { lines: [1] }).DocumentLines as unknown[])).toHaveLength(1);
  });

  test("refuses a source it cannot link to", () => {
    expect(() => buildCopy(flow, { ...order, DocEntry: undefined })).toThrow("DocEntry");
    expect(() => buildCopy(flow, { ...order, DocumentLines: [] })).toThrow("no lines");
    expect(() => buildCopy(flow, order, { lines: [9] })).toThrow("not on the source");
  });
});

describe("entity profiles", () => {
  test("only curated entities are writable at all", () => {
    expect(profileOf("Orders")).toBeDefined();
    expect(profileOf("JournalEntries")).toBeUndefined();
  });

  test("pickEditable is an allowlist and reports what it refused", () => {
    const p = profileOf("Orders")!;
    const { payload, rejected } = pickEditable(p, { Comments: "hi", DocTotal: 999, U_Mine: "x" }, { create: false });
    expect(payload).toEqual({ Comments: "hi", U_Mine: "x" });
    expect(rejected).toEqual(["DocTotal"]);
  });

  test("required-on-create fields are settable on create but not on update", () => {
    const p = profileOf("Items")!;
    expect(pickEditable(p, { ItemCode: "A1" }, { create: true }).rejected).toEqual([]);
    expect(pickEditable(p, { ItemCode: "A1" }, { create: false }).rejected).toEqual(["ItemCode"]);
  });

  test("missingRequired treats empty strings and empty arrays as missing", () => {
    const p = profileOf("Quotations")!;
    expect(missingRequired(p, { CardCode: "C1", DocumentLines: [{}] })).toEqual([]);
    expect(missingRequired(p, { CardCode: "", DocumentLines: [] })).toEqual(["CardCode", "DocumentLines"]);
  });
});
