import {
  pgTable, pgEnum, uuid, text, jsonb, timestamp, index,
} from "drizzle-orm/pg-core";

export const quoteStatus = pgEnum("quote_status", [
  "draft", "syncing", "synced", "failed",
]);

// Minimal business object — the canonical thing the backbone syncs to B1.
export const quote = pgTable(
  "quote",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    status: quoteStatus("status").notNull().default("draft"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    docEntry: text("doc_entry"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("quote_tenant_idx").on(t.tenantId)],
);
