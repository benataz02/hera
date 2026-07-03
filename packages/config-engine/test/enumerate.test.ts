import { describe, expect, test } from "bun:test";
import { enumerate } from "../src/enumerate";
import { lookups, model } from "./fixture";

describe("enumerate", () => {
  test("closed entries -> exactly one candidate equal to entries", () => {
    const e = enumerate(model, lookups, { material: "steel", section: 16 }); // coated defaults false, color hidden
    expect(e.capped).toBe(false);
    expect(e.candidates).toEqual([{ material: "steel", section: 16 }]);
  });

  test("one open param -> one candidate per live value", () => {
    const e = enumerate(model, lookups, { material: "alu" }); // section open, 25 eliminated
    expect(e.candidates.map((c) => c.section).sort()).toEqual([10, 16]);
  });

  test("full open space respects both constraints", () => {
    const e = enumerate(model, lookups, { coated: true });
    // material×section×color minus (alu,25,*) minus disallowed color combos:
    // steel: sections 10,16,25 × colors red,black = 6
    // alu:   sections 10,16    × colors black,blue = 4
    expect(e.candidates).toHaveLength(10);
    expect(e.capped).toBe(false);
    for (const c of e.candidates) {
      expect(!(c.material === "alu" && c.section === 25)).toBe(true);
    }
  });

  test("cap stops early and reports widest open param", () => {
    const e = enumerate(model, lookups, { coated: true }, 4);
    expect(e.candidates).toHaveLength(4);
    expect(e.capped).toBe(true);
    expect(e.widest?.key).toBeDefined();
    expect(e.widest!.size).toBeGreaterThanOrEqual(3);
  });

  test("contradictory entries -> zero candidates", () => {
    const e = enumerate(model, lookups, { material: "alu", section: 25 });
    expect(e.candidates).toEqual([]);
  });
});
