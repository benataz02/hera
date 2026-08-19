import { expect, test } from "bun:test";
import { applySpec, formatCell, EMPTY_SPEC, listFetchSelect, type ListColumn, type ListVariantDef } from "./listSpec.ts";

const COLUMNS: ListColumn[] = [
  { name: "name", type: "string" },
  { name: "status", type: "enum" },
  { name: "qty", type: "number" },
  { name: "updatedAt", type: "date" },
];

const ROWS = [
  { name: "Pump A", status: "requested", qty: 10, updatedAt: "2026-07-20T10:00:00Z" },
  { name: "valve b", status: "draft", qty: 2, updatedAt: "2026-07-22T10:00:00Z" },
  { name: "Gearbox", status: "quoted", qty: 30, updatedAt: "2026-07-21T10:00:00Z" },
];

const spec = (over: Partial<ListVariantDef>): ListVariantDef => ({ ...EMPTY_SPEC, ...over });
const names = (rows: { name: string }[]) => rows.map((r) => r.name);

test("list fetch select is withheld until the view is ready", () => {
  const discovered: ListColumn[] = [
    { name: "ItemCode", type: "string" },
    { name: "ItemName", type: "string" },
    { name: "U_Custom", type: "string" },
  ];
  // EMPTY_SPEC.select is [] which visibleColumns treats as "all columns" — that fallback
  // must not drive the OData $select or the table/filter chrome before a view is applied.
  expect(listFetchSelect(false, EMPTY_SPEC, discovered)).toBeNull();
  expect(listFetchSelect(true, spec({ select: ["ItemCode", "ItemName"] }), discovered)).toEqual([
    "ItemCode",
    "ItemName",
  ]);
});

test("empty spec returns the input array untouched", () => {
  const out = applySpec(ROWS, EMPTY_SPEC, COLUMNS);
  expect(out).toBe(ROWS); // identity: never copies the query cache's array for nothing
});

test("eq / ne", () => {
  expect(names(applySpec(ROWS, spec({ filter: [{ field: "status", op: "eq", value: "requested" }] }), COLUMNS))).toEqual(["Pump A"]);
  expect(names(applySpec(ROWS, spec({ filter: [{ field: "status", op: "ne", value: "requested" }] }), COLUMNS))).toEqual(["valve b", "Gearbox"]);
});

test("eq coerces across string/number for numeric columns", () => {
  expect(names(applySpec(ROWS, spec({ filter: [{ field: "qty", op: "eq", value: 10 }] }), COLUMNS))).toEqual(["Pump A"]);
  expect(names(applySpec(ROWS, spec({ filter: [{ field: "qty", op: "eq", value: "10" }] }), COLUMNS))).toEqual(["Pump A"]);
});

test("contains / startswith are case-insensitive", () => {
  expect(names(applySpec(ROWS, spec({ filter: [{ field: "name", op: "contains", value: "A" }] }), COLUMNS))).toEqual(["Pump A", "valve b", "Gearbox"]);
  expect(names(applySpec(ROWS, spec({ filter: [{ field: "name", op: "startswith", value: "v" }] }), COLUMNS))).toEqual(["valve b"]);
  expect(names(applySpec(ROWS, spec({ filter: [{ field: "name", op: "startswith", value: "V" }] }), COLUMNS))).toEqual(["valve b"]);
});

test("gt / ge / lt / le compare numerically, not lexically", () => {
  expect(names(applySpec(ROWS, spec({ filter: [{ field: "qty", op: "gt", value: 10 }] }), COLUMNS))).toEqual(["Gearbox"]);
  expect(names(applySpec(ROWS, spec({ filter: [{ field: "qty", op: "ge", value: 10 }] }), COLUMNS))).toEqual(["Pump A", "Gearbox"]);
  // lexically "2" > "10", so a string compare here would drop "valve b"
  expect(names(applySpec(ROWS, spec({ filter: [{ field: "qty", op: "lt", value: 10 }] }), COLUMNS))).toEqual(["valve b"]);
  expect(names(applySpec(ROWS, spec({ filter: [{ field: "qty", op: "le", value: 10 }] }), COLUMNS))).toEqual(["Pump A", "valve b"]);
});

test("dates compare by timestamp", () => {
  const out = applySpec(ROWS, spec({ filter: [{ field: "updatedAt", op: "gt", value: "2026-07-20T12:00:00Z" }] }), COLUMNS);
  expect(names(out).sort()).toEqual(["Gearbox", "valve b"]);
});

test("conditions are AND-combined", () => {
  const out = applySpec(
    ROWS,
    spec({ filter: [{ field: "qty", op: "ge", value: 10 }, { field: "status", op: "eq", value: "quoted" }] }),
    COLUMNS,
  );
  expect(names(out)).toEqual(["Gearbox"]);
});

test("search matches text columns only, case-insensitively", () => {
  expect(names(applySpec(ROWS, spec({ search: "VALVE" }), COLUMNS))).toEqual(["valve b"]);
  // "30" only appears in the numeric qty column, which search must not reach
  expect(applySpec(ROWS, spec({ search: "30" }), COLUMNS)).toEqual([]);
  // whitespace-only search is not a filter
  expect(applySpec(ROWS, spec({ search: "  " }), COLUMNS)).toBe(ROWS);
});

test("orderby asc/desc by type", () => {
  expect(names(applySpec(ROWS, spec({ orderby: [{ field: "qty", dir: "asc" }] }), COLUMNS))).toEqual(["valve b", "Pump A", "Gearbox"]);
  expect(names(applySpec(ROWS, spec({ orderby: [{ field: "qty", dir: "desc" }] }), COLUMNS))).toEqual(["Gearbox", "Pump A", "valve b"]);
  expect(names(applySpec(ROWS, spec({ orderby: [{ field: "updatedAt", dir: "desc" }] }), COLUMNS))).toEqual(["valve b", "Gearbox", "Pump A"]);
  expect(names(applySpec(ROWS, spec({ orderby: [{ field: "name", dir: "asc" }] }), COLUMNS))).toEqual(["Gearbox", "Pump A", "valve b"]);
});

test("sorting never mutates the input", () => {
  const before = names(ROWS);
  applySpec(ROWS, spec({ orderby: [{ field: "qty", dir: "desc" }] }), COLUMNS);
  expect(names(ROWS)).toEqual(before);
});

test("nulls sort first and never match a comparison", () => {
  const rows = [...ROWS, { name: "Blank", status: "draft", qty: null as unknown as number, updatedAt: "2026-07-19T10:00:00Z" }];
  expect(names(applySpec(rows, spec({ orderby: [{ field: "qty", dir: "asc" }] }), COLUMNS))[0]).toBe("Blank");
  expect(names(applySpec(rows, spec({ filter: [{ field: "qty", op: "gt", value: 0 }] }), COLUMNS))).not.toContain("Blank");
});

test("formatCell renders dates locally, not as a Date toString", () => {
  const iso = "2026-07-20T10:00:00Z";
  expect(formatCell(iso, "date")).toBe(new Date(iso).toLocaleString());
  expect(formatCell(new Date(iso), "Edm.DateTimeOffset")).toBe(new Date(iso).toLocaleString());
  expect(formatCell("not a date", "date")).toBe("not a date");
  expect(formatCell(null, "string")).toBe("");
  expect(formatCell({ a: 1 }, "string")).toBe('{"a":1}');
});
