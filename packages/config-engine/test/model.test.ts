import { describe, expect, test } from "bun:test";
import { ModelDefZ, LookupRefZ, derivedColumns, displayColumns, derivedKey } from "../src/model";
import { model } from "./fixture";

describe("ModelDefZ", () => {
  test("accepts the fixture model", () => {
    expect(() => ModelDefZ.parse(model)).not.toThrow();
  });

  test("rejects a parameter with a bad key", () => {
    const bad = structuredClone(model);
    bad.parameters[0]!.key = "1bad key";
    expect(() => ModelDefZ.parse(bad)).toThrow();
  });

  test("keeps extraction context and per-parameter hints", () => {
    const m = structuredClone(model) as any;
    m.extraction = { context: "Dimensions are in millimetres unless noted." };
    m.parameters[0].extractionHint = "Title block MATERIAL field";
    const parsed = ModelDefZ.parse(m);
    expect(parsed.extraction?.context).toBe("Dimensions are in millimetres unless noted.");
    expect(parsed.parameters[0]!.extractionHint).toBe("Title block MATERIAL field");
  });

  test("keeps excludeFromDomains on a parameter", () => {
    const m = structuredClone(model) as any;
    m.parameters[0].excludeFromDomains = true;
    const parsed = ModelDefZ.parse(m);
    expect(parsed.parameters[0]!.excludeFromDomains).toBe(true);
  });

  test("rejects unknown constraint kind", () => {
    const bad = structuredClone(model) as any;
    bad.constraints.push({ kind: "magic" });
    expect(() => ModelDefZ.parse(bad)).toThrow();
  });
});

describe("LookupRef columns", () => {
  test("accepts named-source query refs and rejects the old inline shape", () => {
    expect(LookupRefZ.safeParse({ source: "query", table: "items", valueCol: "ItemCode" }).success).toBe(true);
    expect(LookupRefZ.safeParse({ source: "query", target: "b1", query: { entitySet: "Items" }, valueField: "ItemCode" }).success).toBe(false);
    expect(LookupRefZ.safeParse({ source: "table", table: "mats", valueCol: "code", columns: ["density"] }).success).toBe(true);
  });

  test("derivedColumns is every extra column; displayColumns honours the subset", () => {
    const ref = { source: "table", table: "mats", valueCol: "code" } as const;
    const all = ["code", "density", "name"];
    expect(derivedColumns(ref, all)).toEqual(["density", "name"]);
    expect(derivedColumns({ ...ref, columns: ["density"] }, all)).toEqual(["density", "name"]);
    expect(derivedColumns({ ...ref, columns: ["density"] }, undefined)).toEqual([]);
    expect(derivedColumns(ref, undefined)).toEqual([]);
    expect(derivedColumns({ source: "manual", options: [] }, ["x"])).toEqual([]);
    expect(displayColumns(ref, all)).toEqual(["density", "name"]);
    expect(displayColumns({ ...ref, columns: ["density"] }, all)).toEqual(["density"]);
    expect(displayColumns({ ...ref, columns: ["density"] }, undefined)).toEqual(["density"]);
    expect(displayColumns(ref, undefined)).toEqual([]);
    expect(displayColumns({ source: "manual", options: [] }, ["x"])).toEqual([]);
  });

  test("derivedKey joins with underscore", () => {
    expect(derivedKey("material", "density")).toBe("material_density");
  });

  test("query table labels/hidden are kept and do not change derived or display columns", () => {
    const m = structuredClone(model) as any;
    m.queryTables = [{
      name: "items", target: "b1", query: { entitySet: "Items" },
      columns: ["ItemCode", "ItemName", "OnHand"],
      labels: { ItemName: "Name" },
      hidden: ["OnHand"],
    }];
    const parsed = ModelDefZ.parse(m);
    expect(parsed.queryTables[0]).toEqual({
      name: "items", target: "b1", query: { entitySet: "Items" },
      columns: ["ItemCode", "ItemName", "OnHand"],
      labels: { ItemName: "Name" },
      hidden: ["OnHand"],
    });
    const ref = { source: "query" as const, table: "items" };
    const cols = parsed.queryTables[0]!.columns;
    expect(derivedColumns(ref, cols)).toEqual(["ItemName", "OnHand"]);
    expect(displayColumns(ref, cols)).toEqual(["ItemName", "OnHand"]);
  });
});
