import type { ModelDef, ResolvedLookups } from "../src/model";

/** Cable assembly demo: exercises options/boolean/visibility, expr + table
 *  constraints, computed params, LOOKUP, scrap, setup amortization. */
export const model: ModelDef = {
  name: "Cable assembly",
  parameters: [
    {
      key: "material",
      label: "Conductor material",
      type: "string",
      ui: "select",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: "steel" }, { value: "alu" }] } },
    },
    {
      key: "section",
      label: "Cross-section",
      type: "number",
      ui: "radio",
      unit: "mm²",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: 10 }, { value: 16 }, { value: 25 }] } },
    },
    { key: "coated", label: "Coated", type: "boolean", ui: "checkbox", defaultExpr: "false" },
    {
      key: "color",
      label: "Coating color",
      type: "string",
      ui: "select",
      visibleWhen: "coated",
      domain: {
        kind: "options",
        ref: { source: "manual", options: [{ value: "red" }, { value: "black" }, { value: "blue" }] },
      },
    },
  ],
  structure: {
    sections: [
      {
        key: "main",
        title: "Cable",
        groups: [
          { key: "conductor", title: "Conductor", params: ["material", "section"] },
          { key: "coating", title: "Coating", params: ["coated", "color"] },
        ],
      },
    ],
  },
  computed: [{ key: "weight", expr: 'section * (material == "steel" ? 7.85 : 2.7) * 0.1' }],
  constraints: [
    { kind: "expr", assert: '!(material == "alu" && section == 25)', message: "25mm² not available in aluminium" },
    {
      kind: "table",
      params: ["material", "color"],
      rows: [
        ["steel", "red"],
        ["steel", "black"],
        ["alu", "black"],
        ["alu", "blue"],
      ],
      mode: "allow",
    },
  ],
  bom: [
    {
      id: "conductor",
      itemCode: 'CONCAT("COND-", material)',
      desc: 'CONCAT(material, " conductor")',
      qty: "section * 0.02",
      price: 'LOOKUP("prices", "code", CONCAT("COND-", material), "price")',
      scrapPct: 0,
    },
    {
      id: "coating",
      itemCode: '"COAT-1"',
      condition: "coated",
      qty: "1",
      price: "0.8",
      scrapPct: 5,
    },
  ],
  routing: [
    { id: "cut", resource: "SAW", setupMin: "10", runMinPerUnit: "0.5", ratePerHour: "60" },
    { id: "coat", resource: "COATER", condition: "coated", setupMin: "30", runMinPerUnit: "0.2 * section", ratePerHour: "60" },
  ],
  queryTables: [],
  pricing: { priceExpr: "unitCost * 1.4", quoteItemCode: "CABLE-CFG" },
  batchDefaults: [100, 500, 1000],
};

export const lookups: ResolvedLookups = {
  domains: {
    material: [
      { value: "steel", label: "steel" },
      { value: "alu", label: "alu" },
    ],
    section: [
      { value: 10, label: "10" },
      { value: 16, label: "16" },
      { value: 25, label: "25" },
    ],
    color: [
      { value: "red", label: "red" },
      { value: "black", label: "black" },
      { value: "blue", label: "blue" },
    ],
  },
  tables: {
    prices: {
      columns: ["code", "price"],
      rows: [
        ["COND-steel", 1.5],
        ["COND-alu", 2.5],
      ],
    },
  },
};
