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

// A user-defined lookup table backing the "Table" data source — an ordered list of {value, name}.
// ponytail: rows in jsonb, no per-table DDL; the array stays small (a pick list), so loading it
//           whole is fine. Real columnar tables only if a list ever needs filtering/paging at scale.
export const configTable = pgTable(
  "config_table",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    rows: jsonb("rows").$type<{ value: string; name: string }[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("config_table_tenant_idx").on(t.tenantId),
    uniqueIndex("config_table_tenant_name_uq").on(t.tenantId, t.name),
  ],
);
