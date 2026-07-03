import { describe, expect, test } from "bun:test";
import { bindings, domainOf, propagate } from "../src/propagate";
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

describe("propagate", () => {
  test("expr constraint narrows section when material=alu", () => {
    const p = propagate(model, lookups, { material: "alu" });
    const sec = p.domains.section!;
    const s25 = sec.find((o) => o.value === 25)!;
    expect(s25.eliminatedBy).toBe("25mm² not available in aluminium");
    expect(sec.filter((o) => !o.eliminatedBy).map((o) => o.value)).toEqual([10, 16]);
  });

  test("reverse direction: section=25 eliminates alu", () => {
    const p = propagate(model, lookups, { section: 25 });
    const alu = p.domains.material!.find((o) => o.value === "alu")!;
    expect(alu.eliminatedBy).toBeTruthy();
  });

  test("table constraint filters color by material", () => {
    const p = propagate(model, lookups, { material: "alu", coated: true });
    const live = p.domains.color!.filter((o) => !o.eliminatedBy).map((o) => o.value);
    expect(live).toEqual(["black", "blue"]);
    expect(p.domains.color!.find((o) => o.value === "red")!.eliminatedBy).toContain("combination table");
  });

  test("fully bound violation becomes a conflict", () => {
    const p = propagate(model, lookups, { material: "alu", section: 25 });
    expect(p.conflicts.some((c) => c.message === "25mm² not available in aluminium")).toBe(true);
  });

  test("open excludes bound, defaulted and hidden params", () => {
    const p = propagate(model, lookups, { material: "steel" });
    // coated is defaulted(false) -> not open; color hidden -> not open
    expect(p.open).toEqual(["section"]);
    expect(p.candidateEstimate).toBe(3);
  });

  test("candidateEstimate multiplies live domains", () => {
    const p = propagate(model, lookups, { coated: true });
    // open: material(2) × section(3) × color(3) = 18 before narrowing;
    // no narrowing applies while material unbound (2-unbound support check keeps all)
    expect(p.open.sort()).toEqual(["color", "material", "section"]);
    expect(p.candidateEstimate).toBe(18);
  });

  test("2-unbound support check keeps values that have some support", () => {
    const p = propagate(model, lookups, { coated: true });
    // every color has a supporting material in the allow table except none -> red survives via steel
    expect(p.domains.color!.filter((o) => !o.eliminatedBy)).toHaveLength(3);
  });

  test("consistent full assignment: no conflicts, nothing open", () => {
    const p = propagate(model, lookups, { material: "steel", section: 16, coated: true, color: "black" });
    expect(p.conflicts).toEqual([]);
    expect(p.open).toEqual([]);
    expect(p.candidateEstimate).toBe(1);
  });

  test("undecidable constraint (domainless free-text ref) must NOT over-prune", () => {
    const m2 = structuredClone(model);
    m2.parameters.push({ key: "note", label: "Note", type: "string", ui: "input" });
    m2.structure.sections[0]!.groups[0]!.params.push("note");
    m2.constraints.push({ kind: "expr", assert: 'note != "x" || material == "steel"', message: "note rule" });
    const p = propagate(m2, lookups, {});
    // note is unbound and has no domain -> constraint undecidable -> material keeps both values
    expect(p.domains.material!.filter((o) => !o.eliminatedBy)).toHaveLength(2);
  });

  test("empty live domain -> conflict and zero estimate", () => {
    const m2 = structuredClone(model);
    m2.constraints.push({ kind: "expr", assert: 'material != "alu" || section == 99', message: "no alu sections" });
    const p = propagate(m2, lookups, { material: "alu" });
    expect(p.conflicts.some((c) => c.message.includes("no valid values remain"))).toBe(true);
    expect(p.candidateEstimate).toBe(0);
  });
});
