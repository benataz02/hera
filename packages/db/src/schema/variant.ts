import { pgTable, uuid, text, jsonb, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { z } from "zod";

// SAP-Fiori "views": a saved personalization of an entity page. Tenant-scoped like the rest
// (tenant_id text, no FK), plus user_id for per-user ownership and a `shared` (public/global)
// flag that admins set to publish a view tenant-wide.

// A list view IS the OData call: the agent compiles select/filter/orderby/top/skip into the
// Service Layer GET. No client-side processing — the table renders exactly what comes back.
export const FilterOpZ = z.enum(["eq", "ne", "contains", "startswith", "gt", "ge", "lt", "le"]);
export type FilterOp = z.infer<typeof FilterOpZ>;
export const FilterCondZ = z.object({
  field: z.string(),
  op: FilterOpZ,
  value: z.union([z.string(), z.number(), z.boolean()]),
});
export type FilterCond = z.infer<typeof FilterCondZ>;
export const WidthsZ = z.record(z.string(), z.number());
export const ListVariantDefZ = z.object({
  select: z.array(z.string()), // $select + column order; [] = all fields
  filter: z.array(FilterCondZ), // $filter, AND-combined
  orderby: z.array(z.object({ field: z.string(), dir: z.enum(["asc", "desc"]) })), // $orderby
  filterBar: z.array(z.string()), // field names shown in the FilterBar (Adapt Filters); [] = default set
  search: z.string().optional(), // free-text contains() across string fields (FilterBar search slot)
  widths: WidthsZ.optional(), // px per field, from manual column resize
  labels: z.record(z.string(), z.string()).optional(), // custom header text per field
});
export type ListVariantDef = z.infer<typeof ListVariantDefZ>;

// An object view is pure presentation: which sections/fields show and in what order. The
// single-record GET is unchanged (full record); only the layout differs.
export const ObjectVariantDefZ = z.object({
  fields: z.array(z.object({ name: z.string(), visible: z.boolean() })),
  sections: z.array(z.object({ id: z.string(), visible: z.boolean() })),
});
export type ObjectVariantDef = z.infer<typeof ObjectVariantDefZ>;

export type VariantDef = ListVariantDef | ObjectVariantDef;

// ponytail: one jsonb `definition` loaded/saved whole, same as config_model — a view is small.
export const uiVariant = pgTable(
  "ui_variant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(), // creator/owner
    page: text("page").$type<"list" | "object">().notNull(),
    entity: text("entity").notNull(),
    name: text("name").notNull(),
    shared: boolean("shared").notNull().default(false), // public/global; admin-managed
    isDefault: boolean("is_default").notNull().default(false), // this user's default for (page, entity)
    isStandard: boolean("is_standard").notNull().default(false), // the preseeded, shared "Standard" row for (page, entity)
    definition: jsonb("definition").$type<VariantDef>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ui_variant_lookup_idx").on(t.tenantId, t.page, t.entity)],
);
