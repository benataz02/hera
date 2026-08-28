import { describe, expect, test } from "bun:test";
import type { B1EntitySchema } from "@hera/b1";
import type { ListVariantDef } from "@hera/db";
import { compileList, scalarFields } from "../src/entity-list.ts";

const schema: B1EntitySchema = {
  name: "Orders", entityType: "SAPB1.Document", table: "ORDR", label: "Sales Order",
  entityClass: "standard", keys: ["DocEntry"],
  fields: [
    { name: "DocEntry", kind: "number", edmType: "Edm.Int32" },
    { name: "DocNum", kind: "number", edmType: "Edm.Int32" },
    { name: "CardCode", kind: "string", edmType: "Edm.String", maxLength: 15 },
    { name: "CardName", kind: "string", edmType: "Edm.String" },
    { name: "DocDate", kind: "date", edmType: "Edm.Date" },
    { name: "DocumentStatus", kind: "enum", edmType: "SAPB1.BoStatus", options: [{ value: "O", label: "bost_Open" }] },
    { name: "Cancelled", kind: "boolean", edmType: "SAPB1.BoYesNoEnum" },
    { name: "Printed", kind: "boolean", edmType: "Edm.Boolean" },
    { name: "DocumentLines", kind: "collection", edmType: "SAPB1.DocumentLine", fields: [] },
  ],
};

const spec = (over: Partial<ListVariantDef> = {}): ListVariantDef =>
  ({ select: [], filter: [], orderby: [], filterBar: [], ...over });

describe("compileList", () => {
  test("a collection is never projected — one $select would drag every line in", () => {
    expect(scalarFields(schema).map((f) => f.name)).not.toContain("DocumentLines");
    expect(compileList(schema, spec()).select).not.toContain("DocumentLines");
  });

  // A BoYesNoEnum column is a boolean to the UI but a quoted member to B1: `eq true` is a 400.
  test("a yes/no boolean filters as 'tYES', a real one as true", () => {
    const f = (field: string, value: boolean) => compileList(schema, spec({ filter: [{ field, op: "eq", value }] })).filter;
    expect(f("Cancelled", false)).toBe("Cancelled eq 'tNO'");
    expect(f("Cancelled", true)).toBe("Cancelled eq 'tYES'");
    expect(f("Printed", true)).toBe("Printed eq true");
  });

  test("keys are always selected, so any listed row can be opened", () => {
    expect(compileList(schema, spec({ select: ["CardName"] })).select).toEqual(["DocEntry", "CardName"]);
  });

  test("filters AND together with the right literal per field kind", () => {
    const q = compileList(schema, spec({
      filter: [
        { field: "CardCode", op: "eq", value: "C'1" },
        { field: "DocNum", op: "ge", value: 100 },
        { field: "DocDate", op: "eq", value: "2026-01-31" },
        { field: "DocumentStatus", op: "eq", value: "O" },
        { field: "CardName", op: "contains", value: "Acme" },
      ],
    }));
    expect(q.filter).toBe(
      "((((CardCode eq 'C''1') and (DocNum ge 100)) and (DocDate eq 2026-01-31)) and (DocumentStatus eq 'O')) and (contains(CardName,'Acme'))",
    );
  });

  // Dropping a filter shows MORE rows than were asked for — the dangerous direction.
  test("a filter on a field the entity does not have is an error", () => {
    expect(() => compileList(schema, spec({ filter: [{ field: "Nope", op: "eq", value: 1 }] }))).toThrow("Nope");
    expect(() => compileList(schema, spec({ filter: [{ field: "DocNum", op: "eq", value: "abc" }] }))).toThrow("number");
  });

  // ...whereas a saved view outliving a UDF should still open.
  test("a select or orderby on a missing field is dropped, not fatal", () => {
    const q = compileList(schema, spec({ select: ["CardName", "U_Gone"], orderby: [{ field: "U_Gone", dir: "asc" }] }));
    expect(q.select).toEqual(["DocEntry", "CardName"]);
    expect(q.orderby).toBeUndefined();
  });

  test("free-text search becomes contains() over string fields only", () => {
    const q = compileList(schema, spec({ search: " ac'me " }));
    expect(q.filter).toBe("contains(CardCode,'ac''me') or contains(CardName,'ac''me')");
  });

  test("search stays inside the visible columns when the view pins them", () => {
    expect(compileList(schema, spec({ select: ["CardName"], search: "x" })).filter)
      .toBe("contains(CardName,'x')");
  });

  test("orderby direction and paging ride along", () => {
    const q = compileList(schema, spec({ orderby: [{ field: "DocDate", dir: "desc" }] }), { top: 25, skip: 50, count: true });
    expect(q).toMatchObject({ orderby: "DocDate desc", top: 25, skip: 50, count: true });
  });
});

