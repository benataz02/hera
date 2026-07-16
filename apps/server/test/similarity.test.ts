import { describe, expect, test } from "bun:test";
import { scoreRows } from "../src/similarity.ts";
import type { ModelDef } from "@hera/config-engine";

const history: NonNullable<ModelDef["history"]> = {
  mappings: [
    { param: "material", column: "mat", match: "exact", weight: 2 },
    { param: "section", column: "sec", match: "closeness", weight: 1 },
    { param: "note", column: "descr", match: "contains", weight: 1 },
  ],
  display: [],
};
const rows = [
  { mat: "steel", sec: 10, descr: "Steel cable coated" },
  { mat: "steel", sec: 20, descr: "plain" },
  { mat: "alu", sec: 30, descr: "aluminium special" },
];

describe("scoreRows", () => {
  test("empty entries → no results", () => {
    expect(scoreRows(history, {}, rows)).toEqual([]);
  });

  test("weights only filled params; exact is case-insensitive", () => {
    const r = scoreRows(history, { material: "Steel" }, rows);
    expect(r[0]!.score).toBe(1); // 2/2 — section & note unfilled, excluded from denominator
    expect(r[0]!.matches).toHaveLength(1);
    expect(r.filter((x) => x.score === 1)).toHaveLength(2);
  });

  test("closeness normalizes over the observed range", () => {
    const r = scoreRows(history, { section: 10 }, rows);
    // range 10..30: sec=10 → 1, sec=20 → 0.5, sec=30 → 0
    expect(r.map((x) => x.score)).toEqual([1, 0.5, 0]);
  });

  test("contains is case-insensitive substring on the historic value", () => {
    const r = scoreRows(history, { note: "CABLE" }, rows);
    expect(r[0]!.row.mat).toBe("steel");
    expect(r[0]!.score).toBe(1);
    expect(r[1]!.score).toBe(0);
  });

  test("combined score = Σ(weight·match)/Σ(weight of filled)", () => {
    const r = scoreRows(history, { material: "steel", section: 30 }, rows);
    // row alu/30: exact 0·2 + closeness 1·1 = 1/3; row steel/20: 2·1 + 0.5·1 = 2.5/3
    expect(r[0]!.score).toBeCloseTo(2.5 / 3);
    expect(r[0]!.row.sec).toBe(20);
  });

  test("top caps results", () => {
    expect(scoreRows(history, { material: "steel" }, rows, 1)).toHaveLength(1);
  });
});
