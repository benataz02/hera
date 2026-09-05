import { boolean, index, jsonb, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { Entries, ModelDef, OutputOverrides, Outputs, QuerySource, Val } from "@hera/config-engine";

// Configurator persistence: a mutable model, and one configuration document that carries its own
// latest calculation. Spec: docs/superpowers/specs/2026-07-03-configurator-design.md.

// The whole model is one jsonb document (ModelDef), loaded/saved whole like ui_variant.definition.
export const configModel = pgTable(
  "config_model",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    definition: jsonb("definition").$type<ModelDef>().notNull(),
    // Client portal publish flag + catalog card subtitle. Columns (not jsonb) so lists filter on them.
    portal: boolean("portal").notNull().default(false),
    portalDescription: text("portal_description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("config_model_tenant_idx").on(t.tenantId)],
);

export type ConfigTableColumn = { key: string; label: string; type: "string" | "number" | "boolean" };

/** A live B1/Beas read, stored whole. Same shape QuerySourceZ validates, plus the two
 *  display-only fields the value-help dialog reads. */
export type MasterdataQuery = QuerySource & {
  /** dialog headers; missing/blank -> show the key. Engine ignores. */
  labels?: Record<string, string>;
  /** keys omitted from the value-help dialog. Still fetched, still derived. */
  hidden?: string[];
};

// Admin-maintained masterdata, referenced by name from LookupRef/LOOKUP(). Two kinds in one table:
// "table" keeps its values in `columns`/`rows`, "query" keeps a live read in `query` and leaves
// both empty. Models reference either kind identically — they never hold the definition.
// ponytail: jsonb rows; real table if >10k rows
export const configMasterdata = pgTable(
  "config_masterdata",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").$type<"table" | "query">().notNull().default("table"),
    columns: jsonb("columns").$type<ConfigTableColumn[]>().notNull().default([]),
    rows: jsonb("rows").$type<Val[][]>().notNull().default([]),
    query: jsonb("query").$type<MasterdataQuery>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("config_masterdata_tenant_name_uq").on(t.tenantId, t.name)],
);
export type ConfigMasterdata = typeof configMasterdata.$inferSelect;

export type ProjectStatus = "draft" | "calculated" | "quoted" | "requested" | "rejected";
export type ProjectSource = "internal" | "portal";
export type ProjectCustomer = { cardCode: string; cardName: string };
// Client-facing history; appended inside each transition. Feeds the portal Timeline and
// survives submit → reject → resubmit cycles without extra timestamp columns.
export type ProjectEvent = {
  at: string;
  kind: "created" | "submitted" | "withdrawn" | "rejected" | "quoted";
  note?: string;
};

// One enumerated configuration, priced per batch quantity, and the user's pick of one.
export type ConfigCandidate = { assignment: Entries; perBatch: { batchQty: number; outputs: Outputs }[] };
export type ConfigSelection = { candidateIdx: number; batchQty: number; overrides?: OutputOverrides };

// The "Configurations" document: customer + model + entries + batches, plus the single calculation
// those entries produced. There is no run history and no id but this one — a recalculate overwrites
// `candidates` in place.
//
// `candidates` are the entries in this same row, enumerated: there is no second copy of `entries`
// because every writer of `entries`/`batches` also sets `status = 'draft'` (configs.update,
// portal.projects.update), so `status === 'calculated'` already means "these entries produced
// these candidates".
// ponytail: that invariant is enforced by convention, not a constraint — a trigger only if a
//           third writer ever appears.
export const configProject = pgTable(
  "config_project",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    modelId: uuid("model_id").notNull(),
    name: text("name").notNull(),
    customer: jsonb("customer").$type<ProjectCustomer>(),
    status: text("status").$type<ProjectStatus>().notNull().default("draft"),
    source: text("source").$type<ProjectSource>().notNull().default("internal"),
    rejectionNote: text("rejection_note"),
    events: jsonb("events").$type<ProjectEvent[]>().notNull().default([]),
    entries: jsonb("entries").$type<Entries>().notNull().default({}),
    batches: jsonb("batches").$type<number[]>().notNull().default([]),
    candidates: jsonb("candidates").$type<ConfigCandidate[]>().notNull().default([]),
    selection: jsonb("selection").$type<ConfigSelection[]>(),
    // When `candidates` was computed. Compared against config_model.updatedAt to decide whether a
    // recalculate can be skipped — cheaper than the ModelDef deep-compare it replaces.
    calculatedAt: timestamp("calculated_at", { withTimezone: true }),
    b1DocEntry: integer("b1_doc_entry"),
    quotedAt: timestamp("quoted_at", { withTimezone: true }),
    // Engineered value/cost of the selected candidates, captured once when the quotation is
    // confirmed. Stored rather than recomputed: recomputing resolves the model's live lookups,
    // which means one SAP round trip per row for a 12-month dashboard window.
    // ponytail: no backfill — configurations quoted before this shipped stay null and are excluded
    //           from the margin roll-up rather than counted as zero margin.
    quotedValue: numeric("quoted_value", { precision: 18, scale: 4 }),
    quotedCost: numeric("quoted_cost", { precision: 18, scale: 4 }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("config_project_tenant_status_idx").on(t.tenantId, t.status)],
);

export type ConfigProject = typeof configProject.$inferSelect;

// Historic configuration rows pulled from the model's history query; wholesale-replaced per sync.
// ponytail: jsonb row per record, ~tens of thousands of rows per model; real columns/pgvector if
// a tenant outgrows in-process scoring.
export const configHistory = pgTable(
  "config_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    modelId: uuid("model_id").notNull(),
    row: jsonb("row").$type<Record<string, Val>>().notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("config_history_tenant_model_idx").on(t.tenantId, t.modelId)],
);
