import { pgTable, uuid, text, jsonb, boolean, timestamp, index } from "drizzle-orm/pg-core";

// An admin-authored configurator model. `definition` holds the @hera/config-engine `Model` jsonb
// (parameters, constraints, formulas, BOM/routing templates). Typed loosely here to keep packages/db
// free of an engine dependency; the server casts it to `Model` at the boundary.
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
