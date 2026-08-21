import { describe, expect, test } from "bun:test";
import { colMinWidth } from "./tableWidths.ts";

const rem = (s: string) => Number(s.replace("rem", ""));

describe("colMinWidth", () => {
  test("a wide column outgrows a narrow one in the same table", () => {
    const rows = [
      ["PC-100", "Powder coat, textured", 14.5, 3],
      ["NONE", "No coating", 0, 0],
    ];
    const label = colMinWidth("Description", rows, 1);
    const lead = colMinWidth("Lead days", rows, 3);
    // The whole point: equal 1fr tracks are what truncate "Powder coat, textured".
    expect(rem(label)).toBeGreaterThan(rem(lead));
  });

  test("sizes to the widest cell, not the first or the header", () => {
    const rows = [["a"], ["a much longer value here"], ["b"]];
    expect(rem(colMinWidth("k", rows, 0))).toBeGreaterThan(rem(colMinWidth("k", [["a"], ["b"]], 0)));
  });

  test("the header counts when it is wider than every cell", () => {
    expect(rem(colMinWidth("A very long column header", [["x"]], 0)))
      .toBeGreaterThan(rem(colMinWidth("k", [["x"]], 0)));
  });

  test("clamps both ends so one cell can't push the rest off screen", () => {
    expect(colMinWidth("", [], 0)).toBe("6rem");
    expect(colMinWidth("k", [["x".repeat(500)]], 0)).toBe("24rem");
  });

  test("null and missing cells count as empty, not as 'null'", () => {
    expect(colMinWidth("k", [[null], [undefined], []], 0)).toBe("6rem");
  });

  test("samples the first 200 rows only", () => {
    const rows = [...Array(400)].map((_, i) => [i < 200 ? "short" : "a much longer value here"]);
    expect(colMinWidth("k", rows, 0)).toBe("6rem");
  });
});
