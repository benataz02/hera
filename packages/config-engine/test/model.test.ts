import { describe, expect, test } from "bun:test";
import { ModelDefZ } from "../src/model";
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
