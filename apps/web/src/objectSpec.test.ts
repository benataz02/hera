import { describe, expect, test } from "bun:test";
import type { EntityProfile, EntityProperty, EntitySchema, ObjectVariantDef } from "@hera/db";
import { EMPTY_SPEC, listSelect, visibleColumns, type ListColumn } from "./listSpec.ts";
import {
  applySectionPicker,
  autoColumnWidths,
  availableObjectSections,
  titleForRecord,
  visibleObjectSections,
} from "./objectSpec.ts";

const QUOTATION_SCHEMA: EntitySchema = {
  name: "Quotations",
  typeName: "Document",
  keys: ["DocEntry"],
  properties: [
    { name: "DocEntry", type: "Edm.Int32", nullable: false },
    { name: "DocNum", type: "Edm.Int32", nullable: false },
    { name: "CardCode", type: "Edm.String", nullable: true },
    { name: "CardName", type: "Edm.String", nullable: true },
    { name: "Comments", type: "Edm.String", nullable: true },
  ],
  collections: [
    {
      name: "DocumentLines",
      typeName: "DocumentLine",
      many: true,
      properties: [
        { name: "DocEntry", type: "Edm.Int32", nullable: false },
        { name: "LineNum", type: "Edm.Int32", nullable: false },
        { name: "ItemCode", type: "Edm.String", nullable: true },
      ],
    },
  ],
};

const QUOTATION_PROFILE: EntityProfile = {
  entity: "Quotations",
  family: "sales-document",
  titleField: "DocNum",
  subtitleFields: ["CardCode", "CardName"],
  fields: {
    editableHeader: ["CardCode", "CardName"],
    requiredOnCreate: ["CardCode"],
    readOnly: ["DocEntry", "DocNum"],
    collectionEditable: { DocumentLines: ["ItemCode"] },
    editWhen: [],
  },
  collections: {
    DocumentLines: {
      parentKey: "DocEntry",
      childParentKey: "DocEntry",
      rowKey: "LineNum",
      editable: true,
    },
  },
};

const ITEM_SCHEMA: EntitySchema = {
  name: "Items",
  typeName: "Item",
  keys: ["ItemCode"],
  properties: [
    { name: "ItemCode", type: "Edm.String", nullable: false },
    { name: "ItemName", type: "Edm.String", nullable: true },
  ],
  collections: [],
};

const ITEM_PROFILE: EntityProfile = {
  entity: "Items",
  family: "master-data",
  titleField: "ItemCode",
  subtitleFields: ["ItemName"],
  fields: {
    editableHeader: ["ItemName"],
    requiredOnCreate: ["ItemCode", "ItemName"],
    readOnly: ["ItemCode"],
    collectionEditable: {},
    editWhen: [],
  },
  collections: {},
};

test("list projection includes DocEntry while rendered columns do not", () => {
  const columns: ListColumn[] = [
    { name: "DocEntry", type: "Edm.Int32" },
    { name: "DocNum", type: "Edm.Int32" },
    { name: "CardCode", type: "Edm.String" },
    { name: "CardName", type: "Edm.String" },
  ];
  const spec = { ...EMPTY_SPEC, select: ["DocNum", "CardCode", "CardName"] };
  const rendered = visibleColumns(spec, columns);
  const select = listSelect(["DocEntry"], rendered);
  expect(select).toContain("DocEntry");
  expect(rendered).not.toContain("DocEntry");
});

test("search visibility uses rendered columns, not fetch-only keys", () => {
  // Client sends visibleCols as `select`; server unions keys for OData $select but builds
  // q/`fields` from the pre-union visible set — a hidden string key must not be searchable.
  const keys = ["ItemCode"];
  const visible = ["ItemName", "ForeignName"];
  expect(listSelect(keys, visible)).toContain("ItemCode");
  expect(visible).not.toContain("ItemCode");
});

test("document title uses entity + DocNum with CardCode · CardName subtitle", () => {
  const { title, subtitle } = titleForRecord(
    "Quotations",
    { DocEntry: 9, DocNum: 142, CardCode: "C0001", CardName: "Customer" },
    QUOTATION_SCHEMA,
    QUOTATION_PROFILE,
  );
  expect(title).toBe("Quotations 142");
  expect(subtitle).toBe("C0001 · Customer");
});

test("master fallback title uses entity + key with ItemName subtitle", () => {
  const { title, subtitle } = titleForRecord(
    "Items",
    { ItemCode: "A0001", ItemName: "Item Name" },
    ITEM_SCHEMA,
    ITEM_PROFILE,
  );
  expect(title).toBe("Items A0001");
  expect(subtitle).toBe("Item Name");
});

test("visibleObjectSections skips hidden fields and keys", () => {
  const definition: ObjectVariantDef = {
    header: [
      { name: "DocNum", visible: true },
      { name: "CardCode", visible: true },
    ],
    sections: [
      {
        id: "general",
        visible: true,
        fields: [
          { name: "Comments", visible: true },
          { name: "CardName", visible: false },
        ],
      },
      {
        id: "DocumentLines",
        visible: true,
        fields: [
          { name: "ItemCode", visible: true },
          { name: "LineNum", visible: false },
        ],
      },
      { id: "hidden", visible: false, fields: [{ name: "Comments", visible: true }] },
    ],
  };
  const sections = visibleObjectSections(QUOTATION_SCHEMA, definition);
  expect(sections.map((s) => s.id)).toEqual(["general", "DocumentLines"]);
  expect(sections[0]!.fields.map((f) => f.name)).toEqual(["Comments"]);
  expect(sections[1]!.fields.map((f) => f.name)).toEqual(["ItemCode"]);
  expect(sections.flatMap((s) => s.fields.map((f) => f.name))).not.toContain("DocEntry");
});

const LINE_PROPS: EntityProperty[] = [
  { name: "ItemCode", type: "Edm.String", nullable: true, lookup: { entitySet: "Items", valueField: "ItemCode" } },
  { name: "ItemDescription", type: "Edm.String", nullable: true },
  { name: "Quantity", type: "Edm.Decimal", nullable: true },
  { name: "DocDate", type: "Edm.DateTime", nullable: true },
  { name: "TaxCode", type: "Edm.String", nullable: true },
  { name: "UnitPrice", type: "Edm.Double", nullable: true },
];

/** Deterministic measure: 1 unit per character — keeps width assertions stable. */
const measure = (text: string) => text.length;

describe("autoColumnWidths", () => {
  test("keeps numeric/date/code compact vs lookup/description", () => {
    const widths = autoColumnWidths({
      fields: [
        { name: "Quantity", visible: true },
        { name: "DocDate", visible: true },
        { name: "TaxCode", visible: true },
        { name: "ItemCode", visible: true },
        { name: "ItemDescription", visible: true },
      ],
      properties: LINE_PROPS,
      rows: [
        {
          Quantity: 12,
          DocDate: "2026-07-01",
          TaxCode: "A1",
          ItemCode: "A00001",
          ItemDescription: "Industrial centrifugal pump assembly",
        },
      ],
      mode: "display",
      measure,
    });
    expect(widths.Quantity).toBeLessThan(widths.ItemCode as number);
    expect(widths.DocDate).toBeLessThan(widths.ItemCode as number);
    expect(widths.TaxCode).toBeLessThan(widths.ItemCode as number);
    expect(widths.ItemDescription).toBe("flex");
  });

  test("clamps to type min/max", () => {
    const widths = autoColumnWidths({
      fields: [
        { name: "Quantity", visible: true },
        { name: "ItemDescription", visible: true, label: "D" },
      ],
      properties: LINE_PROPS,
      rows: [
        {
          Quantity: "999999999999999999999999",
          ItemDescription: "x".repeat(500),
        },
      ],
      mode: "display",
      measure,
    });
    // Quantity stays numeric-bounded (not flex); description is the flex column.
    expect(typeof widths.Quantity).toBe("number");
    expect(widths.Quantity as number).toBeLessThanOrEqual(120);
    expect(widths.Quantity as number).toBeGreaterThanOrEqual(48);
    expect(widths.ItemDescription).toBe("flex");
  });

  test("edit mode pads wider than display for the same content", () => {
    const fields = [
      { name: "Quantity", visible: true },
      { name: "TaxCode", visible: true },
    ];
    const rows = [{ Quantity: 10, TaxCode: "VAT" }];
    const display = autoColumnWidths({
      fields,
      properties: LINE_PROPS,
      rows,
      mode: "display",
      measure,
    });
    const edit = autoColumnWidths({
      fields,
      properties: LINE_PROPS,
      rows,
      mode: "edit",
      measure,
    });
    expect(edit.Quantity as number).toBeGreaterThan(display.Quantity as number);
    expect(edit.TaxCode as number).toBeGreaterThan(display.TaxCode as number);
  });

  test("explicit variant width always wins (including description)", () => {
    const widths = autoColumnWidths({
      fields: [
        { name: "ItemDescription", visible: true, width: 333 },
        { name: "Comments", visible: true },
      ],
      properties: [
        ...LINE_PROPS,
        { name: "Comments", type: "Edm.String", nullable: true },
      ],
      rows: [{ ItemDescription: "Pump", Comments: "note" }],
      mode: "display",
      measure,
    });
    expect(widths.ItemDescription).toBe(333);
    expect(widths.Comments).toBe("flex");
  });

  test("reset-to-auto (no width) re-enables content sizing / flex", () => {
    const withOverride = autoColumnWidths({
      fields: [{ name: "ItemDescription", visible: true, width: 400 }],
      properties: LINE_PROPS,
      rows: [{ ItemDescription: "Pump" }],
      mode: "display",
      measure,
    });
    const reset = autoColumnWidths({
      fields: [{ name: "ItemDescription", visible: true }],
      properties: LINE_PROPS,
      rows: [{ ItemDescription: "Pump" }],
      mode: "display",
      measure,
    });
    expect(withOverride.ItemDescription).toBe(400);
    expect(reset.ItemDescription).toBe("flex");
  });

  test("exactly one description-like column may be flex", () => {
    const widths = autoColumnWidths({
      fields: [
        { name: "ItemDescription", visible: true },
        { name: "Comments", visible: true },
        { name: "Quantity", visible: true },
      ],
      properties: [
        ...LINE_PROPS,
        { name: "Comments", type: "Edm.String", nullable: true },
      ],
      rows: [{ ItemDescription: "A", Comments: "B", Quantity: 1 }],
      mode: "display",
      measure,
    });
    const flexCols = Object.entries(widths).filter(([, w]) => w === "flex").map(([n]) => n);
    expect(flexCols).toEqual(["ItemDescription"]);
    expect(typeof widths.Comments).toBe("number");
  });

  test("skips invisible fields", () => {
    const widths = autoColumnWidths({
      fields: [
        { name: "Quantity", visible: true },
        { name: "ItemDescription", visible: false },
      ],
      properties: LINE_PROPS,
      rows: [{ Quantity: 1, ItemDescription: "hidden" }],
      mode: "display",
      measure,
    });
    expect(widths).toEqual({ Quantity: expect.any(Number) });
    expect(widths).not.toHaveProperty("ItemDescription");
  });
});

describe("section picker", () => {
  const MULTI_SCHEMA: EntitySchema = {
    ...QUOTATION_SCHEMA,
    collections: [
      ...QUOTATION_SCHEMA.collections,
      {
        name: "DocumentReferences",
        typeName: "DocumentReference",
        many: true,
        properties: [
          { name: "DocEntry", type: "Edm.Int32", nullable: false },
          { name: "RefDocEntr", type: "Edm.Int32", nullable: true },
          { name: "RefObjType", type: "Edm.String", nullable: true },
        ],
      },
      // Single complex child — a lines table can't render it, so it must not be offered.
      {
        name: "TaxExtension",
        typeName: "TaxExtension",
        many: false,
        properties: [{ name: "Incoterms", type: "Edm.String", nullable: true }],
      },
    ],
  };

  test("offers General plus every many-collection, never single complex children", () => {
    expect(availableObjectSections(MULTI_SCHEMA).map((s) => s.name)).toEqual([
      "general",
      "DocumentLines",
      "DocumentReferences",
    ]);
  });

  test("keeps existing section fields, seeds columns for a newly added one", () => {
    const def: ObjectVariantDef = {
      header: [{ name: "CardCode", visible: true }],
      sections: [
        { id: "general", visible: true, fields: [{ name: "Comments", visible: true }] },
        { id: "DocumentLines", visible: true, fields: [{ name: "ItemCode", visible: true }] },
      ],
    };
    const next = applySectionPicker(
      def,
      [
        { name: "general", visible: true },
        { name: "DocumentLines", visible: false },
        { name: "DocumentReferences", visible: true },
      ],
      MULTI_SCHEMA,
    );

    expect(next.header).toEqual(def.header);
    expect(next.sections[1]).toEqual({
      id: "DocumentLines",
      visible: false,
      fields: [{ name: "ItemCode", visible: true }],
    });
    // Parent key (DocEntry) stays out of the seeded columns.
    expect(next.sections[2]).toEqual({
      id: "DocumentReferences",
      visible: true,
      fields: [
        { name: "RefDocEntr", visible: true },
        { name: "RefObjType", visible: true },
      ],
    });
  });
});
