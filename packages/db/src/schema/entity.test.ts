import { expect, test } from "bun:test";
import { EnabledEntityZ, EntitySchemaZ, type EnabledEntity, type EntitySchema } from "./entity.ts";

const rich: EntitySchema = {
  name: "Quotations",
  typeName: "Document",
  keys: ["DocEntry"],
  properties: [
    { name: "DocEntry", type: "Edm.Int32", nullable: false },
    {
      name: "DocumentStatus",
      type: "SAPB1.BoStatus",
      nullable: true,
      options: [{ value: "bost_Open", text: "Open", numericValue: 0 }],
    },
    {
      name: "CardCode",
      type: "Edm.String",
      nullable: true,
      lookup: { entitySet: "BusinessPartners", valueField: "CardCode" },
    },
  ],
  collections: [
    {
      name: "DocumentLines",
      typeName: "DocumentLine",
      many: true,
      properties: [
        { name: "LineNum", type: "Edm.Int32", nullable: true },
        { name: "ItemCode", type: "Edm.String", nullable: true },
      ],
    },
  ],
};

test("EntitySchemaZ keeps nested options, lookup, and collections", () => {
  const parsed = EntitySchemaZ.parse(rich);
  expect(parsed.properties.find((p) => p.name === "DocumentStatus")?.options?.[0]?.value).toBe("bost_Open");
  expect(parsed.properties.find((p) => p.name === "CardCode")?.lookup).toEqual({
    entitySet: "BusinessPartners",
    valueField: "CardCode",
  });
  expect(parsed.collections[0]?.properties).toContainEqual(expect.objectContaining({ name: "LineNum" }));
});

test("EnabledEntityZ + JSON round-trip preserves nested metadata", () => {
  const enabled: EnabledEntity = { ...rich, editable: true };
  const roundTripped = EnabledEntityZ.parse(JSON.parse(JSON.stringify(enabled)));
  expect(roundTripped.editable).toBe(true);
  expect(roundTripped.typeName).toBe("Document");
  expect(roundTripped.collections[0]?.name).toBe("DocumentLines");
  expect(roundTripped.properties.find((p) => p.name === "CardCode")?.lookup?.entitySet).toBe(
    "BusinessPartners",
  );
});
