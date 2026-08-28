import { describe, expect, test } from "bun:test";
import { decodeBool, encodeBool, isYesNo, parseEntityList, parseEntitySchema } from "../src/metadata.ts";

const xml = await Bun.file(new URL("./fixtures/entity-metadata.edmx", import.meta.url)).text();

describe("parseEntityList", () => {
  const list = parseEntityList(xml);
  const byName = new Map(list.map((e) => [e.name, e]));

  test("one entry per readable EntitySet, labelled and tabled", () => {
    expect(byName.get("Orders")).toEqual({
      name: "Orders", entityType: "SAPB1.Document", table: "ORDR",
      label: "Sales Order", entityClass: "standard",
    });
  });

  test("classifies UDTs and UDOs by the @ table prefix", () => {
    expect(byName.get("U_ProjectData")!.entityClass).toBe("udt");
    expect(byName.get("MyUDO")!.entityClass).toBe("udo");
  });

  test("falls back to the set name when there is no label or table", () => {
    // MyUDO declares a table but no Common.Label.
    expect(byName.get("MyUDO")!.label).toBe("MyUDO");
  });

  test("drops the binary/session sets nobody should browse", () => {
    expect(byName.has("B1Sessions")).toBe(false);
  });
});

describe("parseEntitySchema", () => {
  const schema = parseEntitySchema(xml, "Orders", parseEntityList(xml));
  const f = (name: string) => schema.fields.find((x) => x.name === name);

  test("carries the key and the entity's identity", () => {
    expect(schema.keys).toEqual(["DocEntry"]);
    expect(schema.table).toBe("ORDR");
    expect(schema.entityClass).toBe("standard");
  });

  test("maps EDM primitives to the kinds a form can switch on", () => {
    expect(f("DocEntry")!.kind).toBe("number");
    expect(f("DocDate")!.kind).toBe("date"); // Edm.DateTimeOffset — a date, never a datetime
    expect(f("CardCode")).toMatchObject({ kind: "string", maxLength: 15, label: "Customer/Vendor Code" });
  });

  test("enums become options carrying B1's ValidValue codes", () => {
    expect(f("DocumentStatus")).toMatchObject({
      kind: "enum",
      options: [{ value: "O", label: "bost_Open" }, { value: "C", label: "bost_Close" }],
    });
  });

  test("tYES/tNO is a boolean, not a two-option dropdown", () => {
    expect(f("Cancelled")).toMatchObject({ kind: "boolean", edmType: "SAPB1.BoYesNoEnum" });
    expect(f("Cancelled")!.options).toBeUndefined();
    expect(isYesNo(f("Cancelled")!)).toBe(true);
    expect(isYesNo(f("DocumentStatus")!)).toBe(false);
    // …but it still travels as B1's member name, not true/false.
    expect(encodeBool(f("Cancelled")!, true)).toBe("tYES");
    expect(encodeBool({ edmType: "Edm.Boolean" }, true)).toBe(true);
    expect(decodeBool("tYES")).toBe(true);
  });

  test("a complex collection carries its own fields for a table renderer", () => {
    const lines = f("DocumentLines")!;
    expect(lines.kind).toBe("collection");
    expect(lines.fields!.map((x) => x.name)).toEqual(["LineNum", "ItemCode", "Quantity"]);
    expect(lines.fields!.find((x) => x.name === "ItemCode")!.maxLength).toBe(50);
  });

  test("U_ fields are flagged as UDFs", () => {
    expect(f("U_HERA_DedupKey")!.isUDF).toBe(true);
    expect(f("DocNum")!.isUDF).toBeUndefined();
  });

  // The one thing SAP's parser cannot express, and the reason the document UI can exist.
  test("a ReferentialConstraint becomes a lookup onto the referenced entity set", () => {
    expect(f("CardCode")!.lookup).toEqual({ entitySet: "BusinessPartners", keyField: "CardCode" });
    expect(f("DocNum")!.lookup).toBeUndefined();
  });

  test("an unresolvable type is dropped, not rendered as a mystery box", () => {
    expect(f("Mystery")).toBeUndefined();
  });

  test("an unknown entity set is an error, not an empty schema", () => {
    expect(() => parseEntitySchema(xml, "Nope")).toThrow("not found");
  });

  test("the result is plain JSON — it has to survive jsonb and the wire", () => {
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});

describe("Items", () => {
  test("ItemCode is a string key, so a padded code is not an Int32", () => {
    const schema = parseEntitySchema(xml, "Items", parseEntityList(xml));
    expect(schema.keys).toEqual(["ItemCode"]);
    expect(schema.fields.find((x) => x.name === "ItemCode")).toMatchObject({ kind: "string", edmType: "Edm.String" });
  });
});
