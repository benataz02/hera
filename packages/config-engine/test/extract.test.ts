import { describe, expect, test } from "bun:test";
import { buildExtractionRequest } from "../src/extract";
import { lookups, model } from "./fixture";

describe("buildExtractionRequest", () => {
  const m = structuredClone(model);
  m.extraction = { context: "Dimensions are in millimetres unless noted." };
  m.parameters.find((p) => p.key === "material")!.extractionHint = "See title block, MATERIAL field";
  const req = buildExtractionRequest(m, lookups.domains);
  const props = req.responseSchema.properties as Record<string, any>;

  test("prompt names the model, context, labels, units, hints and allowed values", () => {
    expect(req.prompt).toContain('"Cable assembly"');
    expect(req.prompt).toContain("Dimensions are in millimetres unless noted.");
    expect(req.prompt).toContain("material: Conductor material (string)");
    expect(req.prompt).toContain("Hint: See title block, MATERIAL field");
    expect(req.prompt).toContain("section: Cross-section (number, mm²)");
    expect(req.prompt).toContain("Allowed values: steel, alu");
    expect(req.prompt).toContain("Allowed values: 10, 16, 25");
  });

  test("finite string domains become enums; numeric and boolean stay free", () => {
    expect(props.material.properties.value).toEqual({ type: "string", enum: ["steel", "alu"], nullable: true });
    expect(props.section.properties.value).toEqual({ type: "number", nullable: true });
    expect(props.coated.properties.value).toEqual({ type: "boolean", nullable: true });
    expect(props.color.properties.value).toEqual({ type: "string", enum: ["red", "black", "blue"], nullable: true });
  });

  test("every parameter is required, with value + evidence", () => {
    expect(req.responseSchema.required).toEqual(["material", "section", "coated", "color"]);
    for (const k of ["material", "section", "coated", "color"]) {
      expect(props[k].type).toBe("object");
      expect(props[k].required).toEqual(["value", "evidence"]);
      expect(props[k].properties.evidence).toEqual({ type: "string" });
    }
  });

  test("range domains appear in the prompt", () => {
    const rm = structuredClone(model);
    rm.parameters.push({
      key: "len", label: "Length", type: "number", ui: "input",
      unit: "mm", domain: { kind: "range", min: 5, max: 5000 },
    });
    const r = buildExtractionRequest(rm, lookups.domains);
    expect(r.prompt).toContain("Allowed range: 5 to 5000");
  });
});
