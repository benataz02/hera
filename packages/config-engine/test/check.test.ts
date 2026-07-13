import { describe, expect, it, test } from "bun:test";
import { checkModel } from "../src/check";
import type { ModelDef } from "../src/model";
import { model } from "./fixture";

const PRICES = [{ name: "prices", columns: ["code", "price"] }];

describe("checkModel", () => {
  test("fixture model is clean", () => {
    expect(checkModel(model, PRICES)).toEqual([]);
  });

  test("unknown identifier in a bom expr, with span and path", () => {
    const bad = structuredClone(model);
    bad.bom[0]!.qty = "sektion * 2";
    const issues = checkModel(bad, PRICES);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("bom[0].qty");
    expect(issues[0]!.message).toContain("sektion");
    expect(issues[0]!.from).toBe(0);
    expect(issues[0]!.to).toBe(7);
  });

  test("qty allowed in bom but not in constraints", () => {
    const bad = structuredClone(model);
    bad.constraints.push({ kind: "expr", assert: "qty > 0", message: "x" });
    const issues = checkModel(bad, PRICES);
    expect(issues.some((i) => i.path === "constraints[2].assert")).toBe(true);
  });

  test("unitCost allowed only in pricing", () => {
    const bad = structuredClone(model);
    bad.bom[0]!.qty = "unitCost";
    expect(checkModel(bad, PRICES).length).toBe(1);
    expect(checkModel(model, PRICES)).toEqual([]); // priceExpr uses unitCost and is fine
  });

  test("parse error surfaces with span", () => {
    const bad = structuredClone(model);
    bad.computed[0]!.expr = "1 + ";
    const issues = checkModel(bad, PRICES);
    expect(issues[0]!.path).toBe("computed[0].expr");
    expect(typeof issues[0]!.from).toBe("number");
  });

  test("computed cycle detected", () => {
    const bad = structuredClone(model);
    bad.computed = [
      { key: "a", expr: "b + 1" },
      { key: "b", expr: "a + 1" },
    ];
    const issues = checkModel(bad, PRICES);
    expect(issues.some((i) => i.message.includes("cycle"))).toBe(true);
  });

  test("duplicate keys detected", () => {
    const bad = structuredClone(model);
    bad.computed.push({ key: "material", expr: "1" });
    expect(checkModel(bad, PRICES).some((i) => i.message.includes("duplicate"))).toBe(true);
  });

  test("table constraint: bad arity and unknown param", () => {
    const bad = structuredClone(model);
    bad.constraints.push({ kind: "table", params: ["material", "nosuch"], rows: [["steel"]], mode: "allow" });
    const issues = checkModel(bad, PRICES);
    expect(issues.some((i) => i.message.includes("nosuch"))).toBe(true);
    expect(issues.some((i) => i.message.includes("arity") || i.message.includes("values"))).toBe(true);
  });

  test("structure referencing a missing param", () => {
    const bad = structuredClone(model);
    bad.structure.sections[0]!.groups[0]!.params.push("ghost");
    expect(checkModel(bad, PRICES).some((i) => i.message.includes("ghost"))).toBe(true);
  });

  test("unknown function reported", () => {
    const bad = structuredClone(model);
    bad.computed[0]!.expr = "NOPE(1)";
    expect(checkModel(bad, PRICES).some((i) => i.message.includes("NOPE"))).toBe(true);
  });
});

describe("lookup ref validation", () => {
  const withRef = (ref: object, extra: Partial<ModelDef> = {}): ModelDef => ({
    ...structuredClone(model),
    parameters: [
      ...structuredClone(model).parameters,
      { key: "pick", label: "Pick", type: "string", ui: "select", domain: { kind: "options", ref: ref as never } },
    ],
    ...extra,
  });

  it("flags a ref to an unknown table", () => {
    const issues = checkModel(withRef({ source: "table", table: "ghost", valueCol: "x" }), [{ name: "prices", columns: ["code", "price"] }]);
    expect(issues.some((i) => i.message.includes("unknown table 'ghost'"))).toBe(true);
  });

  it("flags unknown columns in a ref", () => {
    const issues = checkModel(withRef({ source: "table", table: "prices", valueCol: "nope", columns: ["alsoNope"] }), [{ name: "prices", columns: ["code", "price"] }]);
    expect(issues.some((i) => i.message.includes("no column 'nope'"))).toBe(true);
    expect(issues.some((i) => i.message.includes("no column 'alsoNope'"))).toBe(true);
  });

  it("puts derived keys in scope and flags collisions", () => {
    const ok = checkModel(
      withRef({ source: "table", table: "prices", valueCol: "code" }, { computed: [{ key: "p2", expr: "pick_price * 2" }] }),
      [{ name: "prices", columns: ["code", "price"] }],
    );
    expect(ok).toEqual([]);
    const collide = checkModel(
      withRef({ source: "table", table: "prices", valueCol: "code" }, { computed: [{ key: "pick_price", expr: "1" }] }),
      [{ name: "prices", columns: ["code", "price"] }],
    );
    expect(collide.some((i) => i.message.includes("collides"))).toBe(true);
  });

  it("resolves query refs against model.queryTables", () => {
    const m = withRef({ source: "query", table: "items", valueCol: "ItemCode" });
    m.queryTables = [{ name: "items", target: "b1", path: "/Items", columns: ["ItemCode", "ItemName"] }];
    expect(checkModel(m, [{ name: "prices", columns: ["code", "price"] }])).toEqual([]);
  });

  it("flags two derived keys colliding with each other (not a pre-existing key)", () => {
    const bad = structuredClone(model);
    bad.parameters.push(
      {
        key: "a",
        label: "A",
        type: "string",
        ui: "select",
        domain: { kind: "options", ref: { source: "table", table: "t1", valueCol: "x", columns: ["b_c"] } as never },
      },
      {
        key: "a_b",
        label: "AB",
        type: "string",
        ui: "select",
        domain: { kind: "options", ref: { source: "table", table: "t2", valueCol: "y", columns: ["c"] } as never },
      },
    );
    const issues = checkModel(bad, [
      { name: "t1", columns: ["x", "b_c"] },
      { name: "t2", columns: ["y", "c"] },
    ]);
    expect(issues.some((i) => i.message.includes("a_b_c") && i.message.includes("collides"))).toBe(true);
  });

  it("flags a derived key placed in the structure like a real parameter", () => {
    const bad = withRef({ source: "table", table: "prices", valueCol: "code" });
    bad.structure.sections[0]!.groups[0]!.params.push("pick_price");
    const issues = checkModel(bad, [{ name: "prices", columns: ["code", "price"] }]);
    expect(issues.some((i) => i.path === "structure" && i.message.includes("pick_price"))).toBe(true);
  });
});
