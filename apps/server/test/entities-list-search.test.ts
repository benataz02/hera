import { expect, test } from "bun:test";
import { buildListSearchFields } from "../src/orpc/routers/entities.ts";

const PROPS = [
  { name: "ItemCode", type: "Edm.String" },
  { name: "ItemName", type: "Edm.String" },
  { name: "ItemsGroupCode", type: "Edm.Int32" },
  { name: "ForeignName", type: "Edm.String" },
];

test("search fields omit hidden string keys even when they would be fetch-unioned", () => {
  // Client select = visible only (ItemCode is the schema key, omitted from the view).
  const fields = buildListSearchFields(PROPS, ["ItemName", "ForeignName"], "pump");
  expect(fields).toEqual(["ItemName", "ForeignName"]);
  expect(fields).not.toContain("ItemCode");
});

test("search fields include a key when it is also a visible column", () => {
  const fields = buildListSearchFields(PROPS, ["ItemCode", "ItemName"], "A0001");
  expect(fields).toEqual(["ItemCode", "ItemName"]);
});

test("no q → no search fields", () => {
  expect(buildListSearchFields(PROPS, ["ItemName"], undefined)).toEqual([]);
});

test("no select → all string properties are searchable", () => {
  expect(buildListSearchFields(PROPS, undefined, "x")).toEqual(["ItemCode", "ItemName", "ForeignName"]);
});
