import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Portal client = invite AND binding in one row: user_id/accepted_at are null until the
// invite is accepted. Token stored as SHA-256 hash (same hashToken as agent tokens).
export const portalClient = pgTable(
  "portal_client",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    email: text("email").notNull(),
    cardCode: text("card_code").notNull(),
    cardName: text("card_name").notNull(),
    userId: text("user_id"), // null until accepted
    inviteTokenHash: text("invite_token_hash").notNull(),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("portal_client_token_uq").on(t.inviteTokenHash),
    uniqueIndex("portal_client_tenant_user_uq").on(t.tenantId, t.userId).where(sql`user_id is not null`),
    index("portal_client_tenant_idx").on(t.tenantId),
  ],
);
