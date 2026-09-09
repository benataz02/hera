import { describe, expect, test } from "bun:test";
import type { TableDef } from "@hera/config-engine";
import { addRow, inputColumns, pasteRows, removeRow, setCell, typedCell } from "./configTableOps.ts";

const def: TableDef = {
  role: "calc",
  key: "holes",
  title: "Holes",
  columns: [
    { key: "shape", label: "Shape", type: "string", cell: { kind: "input" } },
    { key: "size", label: "Size", type: "number", cell: { kind: "input" } },
    { key: "perimeter", label: "Perimeter", type: "number", cell: { kind: "formula", expr: "size * 4" } },
  ],
};

test("typedCell coerces per column type", () => {
  expect(typedCell("number", "12")).toBe(12);
  expect(typedCell("number", "")).toBe(null);
  expect(typedCell("boolean", "true")).toBe(true);
  expect(typedCell("string", "12")).toBe("12");
});

test("formula columns are never editable and never stored", () => {
  expect(inputColumns(def).map((c) => c.key)).toEqual(["shape", "size"]);
});

describe("pasteRows", () => {
  test("a TSV block appends typed rows, skipping the computed column", () => {
    const out = pasteRows([], def, "circular\t10\nrectangular\t20");
    expect(out).toEqual([
      { shape: "circular", size: 10 },
      { shape: "rectangular", size: 20 },
    ]);
  });

  test("blank lines are dropped and maxRows caps the result", () => {
    expect(pasteRows([{ shape: "a" }], def, "b\t1\n\nc\t2\n", 2)).toEqual([{ shape: "a" }, { shape: "b", size: 1 }]);
  });

  test("a short line leaves the missing cells empty rather than shifting them", () => {
    expect(pasteRows([], def, "circular")).toEqual([{ shape: "circular", size: null }]);
  });
});

test("row edits are immutable", () => {
  const rows = [{ shape: "a" }, { shape: "b" }];
  expect(setCell(rows, 1, "size", 3)).toEqual([{ shape: "a" }, { shape: "b", size: 3 }]);
  expect(removeRow(rows, 0)).toEqual([{ shape: "b" }]);
  expect(addRow(rows)).toHaveLength(3);
  expect(rows).toEqual([{ shape: "a" }, { shape: "b" }]); // untouched
});
