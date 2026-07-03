import { describe, expect, test } from "bun:test";
import { bindings, domainOf } from "../src/propagate";
import { lookups, model } from "./fixture";

describe("bindings", () => {
  test("entries pass through; defaults fill absent params", () => {
    const b = bindings(model, lookups, { material: "steel" });
    expect(b.values.material).toBe("steel");
    expect(b.values.coated).toBe(false); // defaultExpr "false"
    expect(b.defaulted.has("coated")).toBe(true);
    expect(b.values.section).toBeUndefined();
  });

  test("computed evaluates when deps bound, stays absent otherwise", () => {
    const b1 = bindings(model, lookups, { material: "steel", section: 16 });
    expect(b1.values.weight).toBeCloseTo(12.56);
    const b2 = bindings(model, lookups, { material: "steel" });
    expect(b2.values.weight).toBeUndefined();
  });

  test("visibility: color hidden when coated=false, visible when true", () => {
    expect(bindings(model, lookups, {}).visible.color).toBe(false); // coated defaults to false
    expect(bindings(model, lookups, { coated: true }).visible.color).toBe(true);
  });

  test("entry beats default", () => {
    const b = bindings(model, lookups, { coated: true });
    expect(b.values.coated).toBe(true);
    expect(b.defaulted.has("coated")).toBe(false);
  });

  test("domainOf: boolean synthesized, options from lookups", () => {
    expect(domainOf(model, lookups, "coated").map((o) => o.value)).toEqual([true, false]);
    expect(domainOf(model, lookups, "material")).toHaveLength(2);
  });
});
