// The configurator model per prompts/MODEL.md: a tree the admin authors in the builder, stored as
// jsonb. Pure data — the engine (flatten/propagate/enumerate/evaluate) is the behaviour over it.
// Kept isomorphic (no Node/DOM deps) so the exact same module runs in the browser (live config) and
// on the server (re-validation trust boundary).

export type Value = string | number | boolean;
export type Domain = Value[];

// Where an item's candidate values come from (the "Data source" dropdown).
export type DataSource =
  | { kind: "normal"; values?: Value[] } // free input, or a static option list
  | { kind: "masterdata"; masterdataId: string }; // a Configuration Master Data entity (manual rows or a B1 query)

// The "UI Element" dropdown — how the item renders at runtime.
export type InputType = "input" | "radio" | "checkbox" | "multicombo";

// An item's value is either derived from a formula, or a free user pick (manual).
export type ItemValue = { kind: "formula"; expr: string } | { kind: "manual" };

export interface FormItem {
  id: string;
  name: string; // identifier used in expressions (rules/formulas/visibility/price)
  label: string; // the "Description"
  visibility?: string; // boolean expr; item hidden when false
  input: {
    mandatory: boolean;
    dataSource: DataSource;
    inputType: InputType;
    value: ItemValue;
  };
  output?: Record<string, never>; // MODEL.md "empty for now" — reserved
  price?: string; // per-item price expr; summed into the total
}

export interface FormGroup {
  id: string;
  label: string; // the "Description"
  visibility?: string; // boolean expr; group (and all its items) hidden when false
  items: FormItem[];
}

// A page-level section (renders as a DynamicPage/ObjectPage section in the runtime). Holds groups.
export interface FormSection {
  id: string;
  label: string;
  visibility?: string; // boolean expr; section (and everything under it) hidden when false
  groups: FormGroup[];
}

// A boolean rule that must hold (the explicit constraint list). `vars` are the finite-domain items
// it touches — declared so AC-3 propagation knows which arcs to (re)visit.
export interface Rule {
  expr: string;
  vars: string[];
}

// A named, reusable expression authored in the builder's Formulas panel. Not tied to a rendered
// field; referenceable by `name` from any expression (items, rules, visibility, other formulas).
// `id` is a builder-only stable key (like sections/groups) — the engine keys on `name`.
export interface PredefinedFormula {
  id: string;
  name: string;
  expr: string;
  itemId?: string; // builder-only: which field row it's shown under (display anchor; stays global)
}

export interface Model {
  name: string;
  family: string;
  sections: FormSection[];
  rules: Rule[];
  formulas?: PredefinedFormula[];
}

// --- Flattened engine shape (produced by flatten(), consumed by the algorithm) -------------------

export type ParamDomain =
  | { kind: "static"; values: Value[] } // finite, known at author time
  | { kind: "datasource"; source: DataSource } // finite once resolved at runtime (master data)
  | { kind: "input" }; // free value — not enumerated/propagated

export interface Parameter {
  name: string;
  label: string;
  domain: ParamDomain;
  mandatory: boolean;
  visibility?: string;
}

export interface Formula {
  name: string;
  expr: string;
}

export interface PriceLine {
  name: string;
  expr: string;
  visibility?: string;
}

export interface EngineModel {
  parameters: Parameter[];
  constraints: Rule[];
  formulas: Formula[];
  prices: PriceLine[];
}

export type Domains = Record<string, Domain>; // current candidate values per finite param
export type Assignment = Record<string, Value>; // a (partial or complete) set of picks

export interface Evaluated {
  values: Record<string, unknown>; // computed formula values
  prices: { name: string; amount: number }[]; // visible per-item prices
  price: number; // their sum
}
