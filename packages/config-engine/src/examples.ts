// The aluminium discrete-manufacturing example from prompts/MODEL.md, authored as a real builder
// tree. Shared by the engine self-check, the demo seed (scripts/seed-config.ts), and the e2e slice
// so there is one source of truth for "a known-good model".
import type { Model, FormItem, Value } from "./types.ts";

type Extra = { visibility?: string; price?: string; mandatory?: boolean };

const radio = (name: string, label: string, values: Value[], extra: Extra = {}): FormItem => ({
  id: name,
  name,
  label,
  visibility: extra.visibility,
  price: extra.price,
  input: { mandatory: extra.mandatory ?? false, dataSource: { kind: "normal", values }, inputType: "radio", value: { kind: "manual" } },
});
const free = (name: string, label: string, extra: Extra = {}): FormItem => ({
  id: name,
  name,
  label,
  visibility: extra.visibility,
  price: extra.price,
  input: { mandatory: extra.mandatory ?? false, dataSource: { kind: "normal" }, inputType: "input", value: { kind: "manual" } },
});
const derived = (name: string, label: string, expr: string, extra: Extra = {}): FormItem => ({
  id: name,
  name,
  label,
  visibility: extra.visibility,
  price: extra.price,
  input: { mandatory: false, dataSource: { kind: "normal" }, inputType: "input", value: { kind: "formula", expr } },
});

// Panels / plaques / button boxes from aluminium sheet. Demonstrates: static finite domains, free
// inputs, bidirectional rules (printing<->qty<->format, quality<->machining), formulas using the
// packing helper, quantity-driven pricing, and group/item visibility.
export const aluminiumModel: Model = {
  name: "Aluminium panel",
  family: "panels",
  sections: [
    {
      id: "s_spec",
      label: "Specification",
      groups: [
        {
          id: "g_part",
          label: "Part",
          items: [
            radio("product", "Product", ["panel", "plaque", "buttonbox"]),
            radio("thickness", "Thickness (mm)", [0.5, 1, 2, 3, 5, 8, 10]),
            free("width", "Piece width (mm)", { mandatory: true }),
            free("height", "Piece height (mm)", { mandatory: true }),
            // Visible only for plaques — proves visibility-aware validation (hidden => not required).
            free("engraving", "Engraving text", { mandatory: true, visibility: `product == "plaque"` }),
          ],
        },
        {
          id: "g_process",
          label: "Process",
          items: [
            radio("treatment", "Treatment", ["anodizing", "matt", "color"]),
            radio("printing", "Printing", ["serigraphy", "digital"]),
            radio("format", "Sheet format", ["1000x500", "500x500"]),
            radio("quality", "Quality", ["standard", "high"]),
            radio("machining", "Machining", ["punching", "laser", "milling"]),
            radio("qty", "Quantity", [100, 500, 1000], { price: "200 + sheetsNeeded * (10 + thickness) + qty * 0.5" }),
          ],
        },
      ],
    },
    {
      id: "s_calc",
      label: "Calculated",
      groups: [
        {
          id: "g_calc",
          label: "Derived values",
          items: [
            derived("perSheet", "Pieces per sheet", "fit(width, height, sheetW(format), sheetH(format))"),
            derived("sheetsNeeded", "Sheets needed", "perSheet > 0 ? ceil(qty / perSheet) : qty"),
            derived("areaM2", "Piece area (m2)", "width * height / 1000000"),
          ],
        },
      ],
    },
  ],
  rules: [
    // Printing depends on quantity: serigraphy needs a run >= 500, digital is for runs <= 500.
    { expr: `printing != "serigraphy" or qty >= 500`, vars: ["printing", "qty"] },
    { expr: `printing != "digital" or qty <= 500`, vars: ["printing", "qty"] },
    // Sheet format depends on the printing method.
    { expr: `printing != "digital" or format == "1000x500"`, vars: ["printing", "format"] },
    { expr: `printing != "serigraphy" or format == "500x500"`, vars: ["printing", "format"] },
    // Machining depends on quality: high quality forbids punching; standard forbids milling.
    { expr: `quality != "high" or (machining == "laser" or machining == "milling")`, vars: ["quality", "machining"] },
    { expr: `quality != "standard" or (machining == "punching" or machining == "laser")`, vars: ["quality", "machining"] },
  ],
};
