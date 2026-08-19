import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEdmx, pickLabelField, SlError } from "../src/service-layer-client.ts";

const fixture = readFileSync(join(import.meta.dir, "fixtures/entity-metadata.edmx"), "utf8");

test("parseEdmx: Quotations keys, DocumentLines collection, enum options, CardCode lookup", () => {
  const schemas = parseEdmx(fixture);
  const schema = schemas.find((s) => s.name === "Quotations");
  expect(schema).toBeDefined();
  expect(schema!.name).toBe("Quotations");
  expect(schema!.keys).toEqual(["DocEntry"]);
  expect(schema!.collections.find((x) => x.name === "DocumentLines")?.properties).toContainEqual(
    expect.objectContaining({ name: "LineNum" }),
  );
  expect(schema!.properties.find((x) => x.name === "DocumentStatus")?.options).toContainEqual(
    expect.objectContaining({ value: "bost_Open" }),
  );
  expect(schema!.properties.find((x) => x.name === "CardCode")?.lookup).toEqual({
    entitySet: "BusinessPartners",
    valueField: "CardCode",
    labelField: "CardName",
  });
});

test("pickLabelField: conventional key/name pair, generic fallback, none", () => {
  const s = (name: string) => ({ name, type: "Edm.String", nullable: true });
  expect(pickLabelField([s("CardCode"), s("CardName")], "CardCode")).toBe("CardName");
  expect(pickLabelField([s("ItemCode"), s("ItemName")], "ItemCode")).toBe("ItemName");
  expect(pickLabelField([s("Code"), s("Name")], "Code")).toBe("Name");
  // No stem partner — any *Name/*Description string field wins over the key.
  expect(pickLabelField([s("AbsEntry"), s("SeriesName")], "AbsEntry")).toBe("SeriesName");
  // Numeric-only target: nothing sensible to show, server falls back to the key.
  expect(
    pickLabelField([{ name: "AbsEntry", type: "Edm.Int32", nullable: false }], "AbsEntry"),
  ).toBeUndefined();
  // Never echo the key back as its own label.
  expect(pickLabelField([s("Name")], "Name")).toBeUndefined();
});

test("parseEdmx: reverse entity-set navigation is not an owned collection", () => {
  const schemas = parseEdmx(fixture);
  const bp = schemas.find((s) => s.name === "BusinessPartners");
  expect(bp).toBeDefined();
  // NavigationProperty Collection(Document) — never walked by splitOwned, still must stay out.
  expect(bp!.collections.find((x) => x.name === "Quotations")).toBeUndefined();
  // Property Collection(Document) — exercises addressableTypes skip; must not become a section
  // and must not leak into scalar properties either.
  expect(bp!.collections.find((x) => x.name === "RelatedQuotations")).toBeUndefined();
  expect(bp!.properties.find((x) => x.name === "RelatedQuotations")).toBeUndefined();
});

test("parseEdmx: enum Name is value; numeric Value is numericValue only", () => {
  const schemas = parseEdmx(fixture);
  const opt = schemas
    .find((s) => s.name === "Quotations")!
    .properties.find((p) => p.name === "DocumentStatus")!
    .options!.find((o) => o.value === "bost_Open");
  expect(opt).toEqual({ value: "bost_Open", text: "Open", numericValue: 0 });
});

test("requireXmlMetadata: rejects non-XML body without xml content-type", async () => {
  const { requireXmlMetadata } = await import("../src/service-layer-client.ts");
  expect(() => requireXmlMetadata("application/json", '{"oops":true}')).toThrow(SlError);
  try {
    requireXmlMetadata("application/json", '{"oops":true}');
  } catch (e) {
    expect(e).toBeInstanceOf(SlError);
    expect((e as SlError).code).toBe("BAD_METADATA_RESPONSE");
  }
});

test("requireXmlMetadata: accepts xml content-type or body starting with <", async () => {
  const { requireXmlMetadata } = await import("../src/service-layer-client.ts");
  expect(() => requireXmlMetadata("application/xml", "not-xml")).not.toThrow();
  expect(() => requireXmlMetadata("text/plain", "  <edmx/>")).not.toThrow();
});
