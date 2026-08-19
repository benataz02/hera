import { describe, expect, test } from "bun:test";
import type { EnabledEntity, ObjectVariantDef } from "@hera/db";
import { getEntityProfile } from "../src/entity-profiles.ts";
import { compileObjectFetch } from "../src/entity-fetch.ts";

const quotationSchema: EnabledEntity = {
  name: "Quotations",
  typeName: "Document",
  keys: ["DocEntry"],
  editable: true,
  properties: [
    { name: "DocEntry", type: "Edm.Int32", nullable: false },
    { name: "DocNum", type: "Edm.Int32", nullable: true },
    { name: "CardCode", type: "Edm.String", nullable: true },
    { name: "CardName", type: "Edm.String", nullable: true },
    { name: "DocumentStatus", type: "Edm.String", nullable: true },
    { name: "Cancelled", type: "Edm.String", nullable: true },
    { name: "DocTotal", type: "Edm.Double", nullable: true },
    { name: "Comments", type: "Edm.String", nullable: true },
  ],
  collections: [
    {
      name: "DocumentLines",
      typeName: "DocumentLine",
      many: true,
      properties: [
        { name: "DocEntry", type: "Edm.Int32", nullable: true },
        { name: "LineNum", type: "Edm.Int32", nullable: true },
        { name: "ItemCode", type: "Edm.String", nullable: true },
        { name: "Quantity", type: "Edm.Double", nullable: true },
        { name: "UnitPrice", type: "Edm.Double", nullable: true },
      ],
    },
  ],
};

const quotationDef: ObjectVariantDef = {
  header: [
    { name: "DocNum", visible: true },
    { name: "CardCode", visible: true },
    { name: "CardName", visible: true },
  ],
  sections: [
    {
      id: "general",
      visible: true,
      fields: [{ name: "Comments", visible: true }],
    },
    {
      id: "DocumentLines",
      visible: true,
      fields: [
        { name: "ItemCode", visible: true },
        { name: "Quantity", visible: true },
        { name: "UnitPrice", visible: true },
      ],
    },
  ],
};

function renderedFields(def: ObjectVariantDef): string[] {
  const names: string[] = [];
  for (const f of def.header) if (f.visible) names.push(f.name);
  for (const s of def.sections) {
    if (!s.visible) continue;
    for (const f of s.fields) if (f.visible) names.push(f.name);
  }
  return names;
}

describe("compileObjectFetch", () => {
  test("injects hidden identity deps without rendering them", () => {
    const profile = getEntityProfile("Quotations");
    const spec = compileObjectFetch(quotationSchema, profile, quotationDef);
    const lines = spec.collections.find((c) => c.name === "DocumentLines")!;

    expect(spec.select).toContain("DocEntry");
    expect(renderedFields(quotationDef)).not.toContain("DocEntry");
    expect(lines.select).toEqual(expect.arrayContaining(["DocEntry", "LineNum"]));
    expect(lines.select).toEqual(expect.arrayContaining(["ItemCode", "Quantity", "UnitPrice"]));
    expect(spec.fullRecordFallback).toBe(false);
  });

  test("rejects unknown header fields", () => {
    const bad: ObjectVariantDef = {
      ...quotationDef,
      header: [...quotationDef.header, { name: "NotARealField", visible: true }],
    };
    expect(() => compileObjectFetch(quotationSchema, getEntityProfile("Quotations"), bad)).toThrow(
      /Unknown field/,
    );
  });

  test("rejects unknown collection fields", () => {
    const bad: ObjectVariantDef = {
      ...quotationDef,
      sections: [
        quotationDef.sections[0]!,
        {
          id: "DocumentLines",
          visible: true,
          fields: [{ name: "BogusCol", visible: true }],
        },
      ],
    };
    expect(() => compileObjectFetch(quotationSchema, getEntityProfile("Quotations"), bad)).toThrow(
      /Unknown field/,
    );
  });

  test("rejects composite keys", () => {
    const composite: EnabledEntity = {
      ...quotationSchema,
      keys: ["DocEntry", "DocNum"],
    };
    expect(() =>
      compileObjectFetch(composite, getEntityProfile("Quotations"), quotationDef),
    ).toThrow(/composite/i);
  });

  test("unprofiled collection sets fullRecordFallback", () => {
    const unprofiled: EnabledEntity = {
      name: "CustomThings",
      typeName: "CustomThing",
      keys: ["Code"],
      editable: false,
      properties: [
        { name: "Code", type: "Edm.String", nullable: false },
        { name: "Name", type: "Edm.String", nullable: true },
      ],
      collections: [
        {
          name: "Rows",
          typeName: "CustomRow",
          many: true,
          properties: [
            { name: "LineId", type: "Edm.Int32", nullable: true },
            { name: "Value", type: "Edm.String", nullable: true },
          ],
        },
      ],
    };
    const def: ObjectVariantDef = {
      header: [{ name: "Name", visible: true }],
      sections: [
        {
          id: "Rows",
          visible: true,
          fields: [{ name: "Value", visible: true }],
        },
      ],
    };
    const spec = compileObjectFetch(unprofiled, null, def);
    expect(spec.fullRecordFallback).toBe(true);
    expect(spec.collections.map((c) => c.name)).toEqual(["Rows"]);
    expect(spec.collections[0]!.select).toEqual(["Value"]);
  });

  test("injects profile title/subtitle and editWhen fields into select", () => {
    const spec = compileObjectFetch(quotationSchema, getEntityProfile("Quotations"), quotationDef);
    expect(spec.select).toEqual(
      expect.arrayContaining(["DocEntry", "DocNum", "CardCode", "CardName", "DocumentStatus", "Cancelled", "Comments"]),
    );
  });
});
