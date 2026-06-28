import { pgTable, uuid, text, jsonb, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

// The authored configurator model — the whole tree (groups/items/rules) lives in one jsonb
// `definition` (the @hera/config-engine Model). Tenant-scoped like `quote`: tenant_id text, no FK.
// ponytail: single jsonb doc, loaded/saved whole; normalise into group/item tables only if models
//           ever get big enough that partial loads matter.
export const configModel = pgTable(
  "config_model",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    family: text("family").notNull().default(""),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    published: boolean("published").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("config_model_tenant_idx").on(t.tenantId)],
);

// Configuration Master Data — the single entity backing a field's "Master data" data source.
// Defined either manually (rows typed in) or by a B1 query (OData GET via the agent). `columns[0]`
// is the key value; the value-help shows every column, the type-ahead the first two.
// ponytail: rows/columns in jsonb, loaded whole (a pick list stays small). For a query the rows
//           are NOT stored here — they're fetched live and cached client-side; only the query
//           definition (source/path) lives here. Real columnar storage only if a list ever needs
//           server-side filtering/paging at scale.
export const configMasterdata = pgTable(
  "config_masterdata",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").$type<"manual" | "query">().notNull(),
    columns: jsonb("columns").$type<string[]>().notNull().default([]), // columns[0] = key
    rows: jsonb("rows").$type<Record<string, string | number | boolean>[]>().notNull().default([]), // manual only; keyed by column name
    source: text("source"), // query only
    path: text("path"), // query only
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("config_masterdata_tenant_idx").on(t.tenantId),
    uniqueIndex("config_masterdata_tenant_name_uq").on(t.tenantId, t.name),
  ],
);
