import { describe, expect, test } from "bun:test";
import { checkModel } from "../src/check";
import type { ModelDef, TableDef } from "../src/model";
import { bindings } from "../src/propagate";
import { evalTableRows, splitShares, tableAggregates } from "../src/tables";
import { lookups, model as base } from "./fixture";

const known = [{ name: "prices", columns: ["code", "price"] }];

/** n machined holes: an options column, then two formula columns chained in declaration order. */
const holes: TableDef = {
  role: "calc",
  key: "holes",
  title: "Machined holes",
  columns: [
    {
      key: "shape",
      label: "Shape",
      type: "string",
      cell: {
        kind: "options",
        ref: { source: "manual", options: [{ value: "circular" }, { value: "rectangular" }] },
      },
    },
    { key: "size", label: "Size", type: "number", unit: "mm", cell: { kind: "input" } },
    {
      key: "perimeter",
      label: "Perimeter",
      type: "number",
      unit: "mm",
      cell: { kind: "formula", expr: 'shape == "circular" ? 3.14159 * size : 4 * size' },
    },
    {
      key: "minutes",
      label: "Machining time",
      type: "number",
      unit: "min",
      cell: { kind: "formula", expr: "perimeter / 50" },
    },
  ],
};

/** Merge production: n items out of one configuration, each its own quotation line. */
const parts: TableDef = {
  role: "items",
  key: "parts",
  title: "Items",
  qtyCol: "pieces",
  basisCol: "area",
  map: { code: "U_HERA_ItemCode", name: "ItemDescription" },
  columns: [
    { key: "code", label: "Item code", type: "string", cell: { kind: "input" } },
    { key: "name", label: "Description", type: "string", cell: { kind: "input" } },
    { key: "width", label: "Width", type: "number", unit: "mm", cell: { kind: "input" } },
    { key: "pieces", label: "Pieces", type: "number", cell: { kind: "input" } },
    // reads a model parameter as well as its own row
    { key: "area", label: "Area", type: "number", cell: { kind: "formula", expr: "width * section" } },
  ],
};

const model: ModelDef = {
  ...base,
  tables: [holes, parts],
  structure: {
    sections: [{ ...base.structure.sections[0]!, tables: ["holes"] }],
  },
};

const entries = { material: "steel", section: 10, coated: false };
const rows = {
  holes: [
    { shape: "circular", size: 10 },
    { shape: "rectangular", size: 20 },
  ],
};

describe("evalTableRows", () => {
  test("formula columns chain in declaration order", () => {
    const out = evalTableRows(holes, rows.holes, {}, lookups.tables);
    expect(out[0]!.perimeter).toBeCloseTo(31.4159, 6);
    expect(out[0]!.minutes).toBeCloseTo(0.628318, 6);
    expect(out[1]!.perimeter).toBe(80);
    expect(out[1]!.minutes).toBe(1.6);
  });

  test("a row formula reads model values, and row cells shadow them", () => {
    const out = evalTableRows(parts, [{ width: 3, pieces: 1 }], { section: 10 }, lookups.tables);
    expect(out[0]!.area).toBe(30);

    // a column named after a parameter: the row's own `section` wins over the model's 10
    const shadowing: TableDef = {
      role: "calc",
      key: "cuts",
      title: "Cuts",
      columns: [
        { key: "section", label: "Section", type: "number", cell: { kind: "input" } },
        { key: "twice", label: "Twice", type: "number", cell: { kind: "formula", expr: "section * 2" } },
      ],
    };
    expect(evalTableRows(shadowing, [{ section: 3 }], { section: 10 }, lookups.tables)[0]!.twice).toBe(6);
    // a declared column shadows even while empty — the cell reads as zero, not as the model's 10
    expect(evalTableRows(shadowing, [{}], { section: 10 }, lookups.tables)[0]!.twice).toBe(0);
  });

  test("a missing cell reads as the type's zero rather than blanking the row", () => {
    const out = evalTableRows(holes, [{ shape: "rectangular" }], {}, lookups.tables);
    expect(out[0]!.size).toBe(0);
    expect(out[0]!.perimeter).toBe(0);
  });
});

describe("tableAggregates", () => {
  test("sums numeric and numeric-formula columns, and counts rows", () => {
    const agg = tableAggregates(model, rows, { section: 10 }, lookups);
    expect(agg.holes_count).toBe(2);
    expect(agg.holes_size).toBe(30);
    expect(agg.holes_perimeter).toBeCloseTo(111.4159, 6);
    expect(agg.holes_minutes).toBeCloseTo(2.228318, 6);
    expect(agg.parts_count).toBe(0);
    expect(agg.parts_area).toBe(0);
    // string columns contribute nothing
    expect(agg).not.toHaveProperty("holes_shape");
  });

  test("aggregates land in the binding scope, so model formulas can read them", () => {
    const withTable: ModelDef = {
      ...model,
      computed: [...model.computed, { key: "drillMin", expr: "holes_minutes * 2" }],
    };
    const b = bindings(withTable, lookups, entries, rows);
    expect(b.values.holes_count).toBe(2);
    expect(b.values.drillMin as number).toBeCloseTo(4.456636, 6);
  });

  test("a model with no tables is untouched", () => {
    const b = bindings(base, lookups, entries);
    expect(Object.keys(b.values).some((k) => k.startsWith("holes_"))).toBe(false);
  });
});

describe("splitShares", () => {
  // the reconciliation guard: the quotation's line sum has to equal the stored quotedValue
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

  test("a total that does not divide evenly still sums to the total", () => {
    const three = [
      { area: 1, pieces: 1 },
      { area: 1, pieces: 1 },
      { area: 1, pieces: 1 },
    ];
    const shares = splitShares(three, "pieces", "area", 100);
    expect(sum(shares)).toBe(100);
    expect(shares).toEqual([33.34, 33.33, 33.33]);
  });

  test("weights by basis x qty", () => {
    const shares = splitShares([{ area: 2, pieces: 1 }, { area: 1, pieces: 1 }], "pieces", "area", 10);
    expect(shares).toEqual([6.67, 3.33]);
    expect(sum(shares)).toBe(10);
  });

  test("zero basis degenerates to an equal split, not a division by zero", () => {
    const shares = splitShares([{ area: 0, pieces: 1 }, { area: 0, pieces: 2 }], "pieces", "area", 9);
    expect(shares).toEqual([4.5, 4.5]);
  });

  test("no rows, no shares", () => {
    expect(splitShares([], "pieces", "area", 10)).toEqual([]);
  });
});

describe("checkModel", () => {
  const msgs = (m: ModelDef) => checkModel(m, known).map((i) => i.message);

  test("the fixture with tables is clean", () => {
    expect(checkModel(model, known)).toEqual([]);
  });

  test("a table key colliding with a parameter", () => {
    const m: ModelDef = { ...model, tables: [{ ...holes, key: "material" }], structure: base.structure };
    expect(msgs(m)).toContain("table key 'material' collides with an existing key");
  });

  test("an aggregate colliding with a computed value", () => {
    const m: ModelDef = { ...model, computed: [...model.computed, { key: "holes_size", expr: "1" }] };
    expect(msgs(m)).toContain("aggregate 'holes_size' collides with an existing key");
  });

  test("a cell formula referencing a later column of its own table", () => {
    const m: ModelDef = {
      ...model,
      tables: [
        {
          ...holes,
          columns: [
            { key: "early", label: "Early", type: "number", cell: { kind: "formula", expr: "late + 1" } },
            { key: "late", label: "Late", type: "number", cell: { kind: "input" } },
          ],
        },
      ],
      structure: base.structure,
    };
    expect(msgs(m)).toContain("unknown identifier 'late'");
  });

  test("a map target the price split owns", () => {
    const m: ModelDef = { ...model, tables: [holes, { ...parts, map: { code: "ItemCode" } }] };
    expect(msgs(m)).toContain("'ItemCode' is set by the price split and cannot be mapped");
  });

  test("qtyCol / basisCol must be number columns", () => {
    const m: ModelDef = { ...model, tables: [holes, { ...parts, basisCol: "name" }] };
    expect(msgs(m)).toContain("'name' is not a number column of this table");
  });

  test("two items tables", () => {
    const m: ModelDef = { ...model, tables: [parts, { ...parts, key: "more" }] };
    expect(msgs(m)).toContain("at most one items table per model");
  });

  test("a section placing an undeclared table", () => {
    const m: ModelDef = {
      ...model,
      structure: { sections: [{ ...base.structure.sections[0]!, tables: ["nope"] }] },
    };
    expect(msgs(m)).toContain("structure references unknown table 'nope'");
  });
});
