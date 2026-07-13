import { describe, expect, test } from "bun:test";
import { ModelDefZ, LookupRefZ, refColumns, derivedKey } from "../src/model";
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

  test("rejects unknown constraint kind", () => {
    const bad = structuredClone(model) as any;
    bad.constraints.push({ kind: "magic" });
    expect(() => ModelDefZ.parse(bad)).toThrow();
  });
});

describe("LookupRef columns", () => {
  test("accepts named-source query refs and rejects the old inline shape", () => {
    expect(LookupRefZ.safeParse({ source: "query", table: "items", valueCol: "ItemCode" }).success).toBe(true);
    expect(LookupRefZ.safeParse({ source: "query", target: "b1", path: "/Items", valueField: "ItemCode" }).success).toBe(false);
    expect(LookupRefZ.safeParse({ source: "table", table: "mats", valueCol: "code", columns: ["density"] }).success).toBe(true);
  });

  test("refColumns defaults to all source columns except valueCol", () => {
    const ref = { source: "table", table: "mats", valueCol: "code" } as const;
    expect(refColumns(ref, ["code", "density", "name"])).toEqual(["density", "name"]);
    expect(refColumns({ ...ref, columns: ["density"] }, ["code", "density", "name"])).toEqual(["density"]);
    expect(refColumns({ ...ref, columns: ["density"] }, undefined)).toEqual(["density"]);
    expect(refColumns(ref, undefined)).toEqual([]);
    expect(refColumns({ source: "manual", options: [] }, ["x"])).toEqual([]);
  });

  test("derivedKey joins with underscore", () => {
    expect(derivedKey("material", "density")).toBe("material_density");
  });
});
