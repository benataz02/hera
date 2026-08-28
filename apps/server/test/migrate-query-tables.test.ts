import { describe, expect, test } from "bun:test";
import { parsePath } from "../../../scripts/migrate-query-tables.ts";

describe("parsePath", () => {
  test("round-trips a plain entity-set read", () => {
    expect(parsePath("/Items?$select=ItemCode,ItemName&$filter=Frozen eq 'tNO'&$orderby=ItemName&$top=50",
      ["ItemCode", "ItemName"]))
      .toEqual({ entitySet: "Items", filter: "Frozen eq 'tNO'", orderby: "ItemName", top: 50 });
  });

  test("a bare path needs no options", () => {
    expect(parsePath("/Items", ["ItemCode"])).toEqual({ entitySet: "Items" });
    expect(parsePath("Items", ["ItemCode"])).toEqual({ entitySet: "Items" });
  });

  test("decodes an encoded filter", () => {
    expect(parsePath("/Items?$filter=Valid%20eq%20'Y'", []).filter).toBe("Valid eq 'Y'");
  });

  // Fail loudly rather than guess — the whole point of the script.
  test("refuses anything that is not a plain entity-set read", () => {
    expect(() => parsePath("/$crossjoin(Orders,Orders/DocumentLines)", [])).toThrow("plain entity set");
    expect(() => parsePath("/Orders(5)", [])).toThrow("plain entity set");
    expect(() => parsePath("/SQLQueries('x')/List", [])).toThrow("plain entity set");
    expect(() => parsePath("/Items?$expand=Prices", [])).toThrow("$expand");
    expect(() => parsePath("/Items?$skiptoken=abc", [])).toThrow("$skiptoken");
  });

  test("refuses a $select the stored columns do not cover", () => {
    expect(() => parsePath("/Items?$select=ItemCode,Price", ["ItemCode"])).toThrow("Price");
  });
});
