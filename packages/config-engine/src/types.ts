// The configurator model: what an admin authors, stored as jsonb. Pure data — the engine
// (propagate/enumerate/evaluate) is the behaviour over it. Kept isomorphic (no Node/DOM deps)
// so the exact same module runs in the browser (live config) and on the server (re-validation).

export type Value = string | number | boolean;
export type Domain = Value[];

// Where a parameter's candidate values come from.
export type ParamDomain =
  | { kind: "static"; values: Value[] }                    // hard-coded list
  | { kind: "range"; min: number; max: number; step: number } // discretised to options
  | { kind: "datasource"; entity: string; valueField: string; labelField?: string; filter?: string } // B1 list via entities.list
  | { kind: "input" };                                     // free user value (not enumerated/propagated)

export interface Parameter {
  name: string;        // identifier used in expressions
  label: string;
  type: "enum" | "number" | "bool";
  domain: ParamDomain;
}

// A boolean expression that must hold. `vars` are the (finite-domain) parameters it touches —
// declared so propagation knows which arcs to (re)visit. Constraints must reference only
// finite-domain params (enforced at save time); free inputs live in formulas, not constraints.
export interface Constraint { expr: string; vars: string[]; }

// Derived value: `name = expr`. Evaluated in order; later formulas may use earlier ones.
export interface Formula { name: string; expr: string; }

// `item`/`qtyExpr`/`timeExpr` are expressions; `condition` (if set) gates the line.
export interface BomLine { item: string; qtyExpr: string; condition?: string; }
export interface RoutingOp { operation: string; timeExpr: string; condition?: string; }
export interface Pricing { costExpr: string; markupExpr: string; }

// Optional B1 push: build one document (header + a lines collection) from the produced BOM/routing
// lines and POST it via the existing entities.create path. `map` renames produced line fields to the
// B1 line fields; `header` carries static document fields; `keyField` receives the external key.
export interface PushTarget {
  entity: string;                      // B1 EntitySet, e.g. "ProductTrees"
  map: Record<string, string>;         // produced line field -> B1 line field, e.g. { item: "ItemCode", qty: "Quantity" }
  linesField?: string;                 // document collection name (default "Lines"), e.g. "ProductTreeLines"
  header?: Record<string, unknown>;    // static header fields, e.g. { TreeType: "iProductionTree" }
  keyField?: string;                   // header field set to the external key, e.g. "TreeCode"
}

export interface Model {
  name: string;
  family: string;
  parameters: Parameter[];
  constraints: Constraint[];
  formulas: Formula[];
  bom: BomLine[];
  routing: RoutingOp[];
  pricing: Pricing;
  bomTarget?: PushTarget;
  routingTarget?: PushTarget;
}

export type Domains = Record<string, Domain>;   // current candidate values per finite param
export type Assignment = Record<string, Value>; // a (partial or complete) set of picks

export interface Evaluated {
  values: Record<string, unknown>;              // params + computed formulas
  bom: { item: Value; qty: number }[];
  routing: { operation: string; time: number }[];
  cost: number;
  markup: number;
  price: number;
}
