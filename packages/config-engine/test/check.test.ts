import { describe, expect, test } from "bun:test";
import { checkModel } from "../src/check";
import { model } from "./fixture";

describe("checkModel", () => {
  test("fixture model is clean", () => {
    expect(checkModel(model, ["prices"])).toEqual([]);
  });

  test("unknown identifier in a bom expr, with span and path", () => {
    const bad = structuredClone(model);
    bad.bom[0]!.qty = "sektion * 2";
    const issues = checkModel(bad, ["prices"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("bom[0].qty");
    expect(issues[0]!.message).toContain("sektion");
    expect(issues[0]!.from).toBe(0);
    expect(issues[0]!.to).toBe(7);
  });

  test("qty allowed in bom but not in constraints", () => {
    const bad = structuredClone(model);
    bad.constraints.push({ kind: "expr", assert: "qty > 0", message: "x" });
    const issues = checkModel(bad, ["prices"]);
    expect(issues.some((i) => i.path === "constraints[2].assert")).toBe(true);
  });

  test("unitCost allowed only in pricing", () => {
    const bad = structuredClone(model);
    bad.bom[0]!.qty = "unitCost";
    expect(checkModel(bad, ["prices"]).length).toBe(1);
    expect(checkModel(model, ["prices"])).toEqual([]); // priceExpr uses unitCost and is fine
  });

  test("parse error surfaces with span", () => {
    const bad = structuredClone(model);
    bad.computed[0]!.expr = "1 + ";
    const issues = checkModel(bad, ["prices"]);
    expect(issues[0]!.path).toBe("computed[0].expr");
    expect(typeof issues[0]!.from).toBe("number");
  });

  test("computed cycle detected", () => {
    const bad = structuredClone(model);
    bad.computed = [
      { key: "a", expr: "b + 1" },
      { key: "b", expr: "a + 1" },
    ];
    const issues = checkModel(bad, ["prices"]);
    expect(issues.some((i) => i.message.includes("cycle"))).toBe(true);
  });

  test("duplicate keys detected", () => {
    const bad = structuredClone(model);
    bad.computed.push({ key: "material", expr: "1" });
    expect(checkModel(bad, ["prices"]).some((i) => i.message.includes("duplicate"))).toBe(true);
  });

  test("table constraint: bad arity and unknown param", () => {
    const bad = structuredClone(model);
    bad.constraints.push({ kind: "table", params: ["material", "nosuch"], rows: [["steel"]], mode: "allow" });
    const issues = checkModel(bad, ["prices"]);
    expect(issues.some((i) => i.message.includes("nosuch"))).toBe(true);
    expect(issues.some((i) => i.message.includes("arity") || i.message.includes("values"))).toBe(true);
  });

  test("structure referencing a missing param", () => {
    const bad = structuredClone(model);
    bad.structure.sections[0]!.groups[0]!.params.push("ghost");
    expect(checkModel(bad, ["prices"]).some((i) => i.message.includes("ghost"))).toBe(true);
  });

  test("unknown function reported", () => {
    const bad = structuredClone(model);
    bad.computed[0]!.expr = "NOPE(1)";
    expect(checkModel(bad, ["prices"]).some((i) => i.message.includes("NOPE"))).toBe(true);
  });
});
