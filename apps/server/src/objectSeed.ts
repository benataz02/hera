import type { EntityProfile, EntitySchema, ObjectVariantDef } from "@hera/db";

type FieldDef = ObjectVariantDef["header"][number];

const DOC_HEADER_PREF = [
  "DocNum",
  "CardCode",
  "CardName",
  "DocDate",
  "DocDueDate",
  "DocumentStatus",
  "DocCurrency",
  "DocTotal",
  "SalesPersonCode",
  "DocumentsOwner",
];

const DOC_GENERAL_PREF = [
  "NumAtCard",
  "Comments",
  "PaymentGroupCode",
  "TransportationCode",
  "ShipToCode",
  "PayToCode",
  "TaxDate",
];

const DOC_LINE_PREF = [
  "ItemCode",
  "ItemDescription",
  "Quantity",
  "UoMCode",
  "UnitPrice",
  "DiscountPercent",
  "TaxCode",
  "WarehouseCode",
  "LineTotal",
];

const ITEM_HEADER_PREF = ["ItemCode", "ItemName"];
const ITEM_GENERAL_PREF = ["ForeignName", "ItemsGroupCode", "ItemType", "BarCode", "SalesVATGroup", "PurchaseVATGroup"];

const BP_HEADER_PREF = ["CardCode", "CardName"];
const BP_GENERAL_PREF = ["CardType", "GroupCode", "Phone1", "EmailAddress", "Currency", "FederalTaxID"];

function field(name: string, visible = true): FieldDef {
  return { name, visible };
}

function intersect(preferred: string[], available: Set<string>, exclude: Set<string>): FieldDef[] {
  return preferred.filter((n) => available.has(n) && !exclude.has(n)).map((n) => field(n));
}

/** Legacy `{ fields:[], sections:[] }` or new shape with no visible fields. */
export function isEmptyObjectDef(def: unknown): boolean {
  if (!def || typeof def !== "object") return true;
  const d = def as Record<string, unknown>;

  // Legacy shape
  if (Array.isArray(d.fields) && Array.isArray(d.sections) && !("header" in d)) {
    return d.fields.length === 0 && d.sections.length === 0;
  }

  const header = Array.isArray(d.header) ? (d.header as FieldDef[]) : [];
  const sections = Array.isArray(d.sections)
    ? (d.sections as Array<{ visible?: boolean; fields?: FieldDef[] }>)
    : [];

  const headerVisible = header.some((f) => f.visible);
  const sectionVisible = sections.some(
    (s) => s.visible && (s.fields?.length ? s.fields.some((f) => f.visible) : true),
  );
  // Empty when nothing visible; also treat completely empty arrays as empty.
  if (header.length === 0 && sections.length === 0) return true;
  return !headerVisible && !sectionVisible;
}

export function seedObjectDef(schema: EntitySchema, profile: EntityProfile | null): ObjectVariantDef {
  const propNames = new Set(schema.properties.map((p) => p.name));
  const keys = new Set(schema.keys);
  // Keys stay fetch-only unless a later custom variant opts in — never seed them for documents.
  const excludeKeys = new Set(keys);
  // Legacy enabledEntities rows (pre–rich EDMX) omit collections — treat as empty.
  const collections = schema.collections ?? [];

  if (!profile) {
    // Display-only fallback: first few scalars + every collection (no invented prefs).
    const header = schema.properties
      .filter((p) => !keys.has(p.name))
      .slice(0, 8)
      .map((p) => field(p.name));
    const sections = [
      {
        id: "general",
        visible: true,
        fields: schema.properties
          .filter((p) => !keys.has(p.name) && !header.some((h) => h.name === p.name))
          .slice(0, 12)
          .map((p) => field(p.name)),
      },
      ...collections.map((c) => ({
        id: c.name,
        visible: true,
        fields: c.properties.filter((p) => !keys.has(p.name)).slice(0, 8).map((p) => field(p.name)),
      })),
    ];
    return { header, sections };
  }

  if (profile.family === "master-data") {
    const headerPref = profile.entity === "Items" ? ITEM_HEADER_PREF : BP_HEADER_PREF;
    const generalPref = profile.entity === "Items" ? ITEM_GENERAL_PREF : BP_GENERAL_PREF;
    // Master title keys (ItemCode / CardCode) are useful in the header facet.
    const header = intersect(headerPref, propNames, new Set());
    const used = new Set(header.map((h) => h.name));
    const general = intersect(generalPref, propNames, used);
    const sections = [
      { id: "general", visible: true, fields: general },
      ...collections.map((c) => ({
        id: c.name,
        visible: true,
        fields: c.properties.slice(0, 8).map((p) => field(p.name)),
      })),
    ];
    return { header, sections };
  }

  // sales / purchase documents
  const header = intersect(DOC_HEADER_PREF, propNames, excludeKeys);
  const used = new Set(header.map((h) => h.name));
  const general = intersect(DOC_GENERAL_PREF, propNames, used);

  const sections: ObjectVariantDef["sections"] = [{ id: "general", visible: true, fields: general }];

  // Only profiled collections (e.g. DocumentLines) — do not dump every B1 complex property as a tab.
  for (const [name, collProfile] of Object.entries(profile.collections)) {
    const col = collections.find((c) => c.name === name);
    if (!col) continue;
    const colProps = new Set(col.properties.map((p) => p.name));
    const lineExclude = new Set([collProfile.rowKey, collProfile.childParentKey, "VisOrder", "LineStatus"]);
    sections.push({
      id: name,
      visible: true,
      fields: intersect(DOC_LINE_PREF, colProps, lineExclude),
    });
  }

  return { header, sections };
}
