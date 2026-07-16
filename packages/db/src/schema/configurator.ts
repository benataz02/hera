import { boolean, index, jsonb, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { Entries, ModelDef, OutputOverrides, Outputs, ResolvedLookups, Val } from "@hera/config-engine";

// Configurator persistence: mutable model + immutable snapshot-on-run (model + lookups + computed
// outputs frozen per engine run). Spec: docs/superpowers/specs/2026-07-03-configurator-design.md.

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

// Admin-maintained lookup tables; LookupRef/LOOKUP() reference them by name.
// ponytail: jsonb rows; real table if >10k rows
export const configTable = pgTable(
  "config_table",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    columns: jsonb("columns").$type<ConfigTableColumn[]>().notNull().default([]),
    rows: jsonb("rows").$type<Val[][]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("config_table_tenant_name_uq").on(t.tenantId, t.name)],
);

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

// The "Configurations" document: customer + model + entries + batches; runs hang off it.
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
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("config_project_tenant_status_idx").on(t.tenantId, t.status)],
);

export type RunCandidate = { assignment: Entries; perBatch: { batchQty: number; outputs: Outputs }[] };
export type RunSelection = { candidateIdx: number; batchQty: number; overrides?: OutputOverrides };

// Immutable snapshot of one engine run. b1DocEntry/quotedAt are written by phase 5 (createQuote).
export const configRun = pgTable(
  "config_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    modelSnapshot: jsonb("model_snapshot").$type<ModelDef>().notNull(),
    lookupSnapshot: jsonb("lookup_snapshot").$type<ResolvedLookups>().notNull(),
    entries: jsonb("entries").$type<Entries>().notNull(),
    candidates: jsonb("candidates").$type<RunCandidate[]>().notNull(),
    selection: jsonb("selection").$type<RunSelection[]>(),
    b1DocEntry: integer("b1_doc_entry"),
    quotedAt: timestamp("quoted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("config_run_tenant_project_idx").on(t.tenantId, t.projectId)],
);

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
