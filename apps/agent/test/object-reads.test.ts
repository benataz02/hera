import { describe, expect, test } from "bun:test";
import {
  buildItemPriceBody,
  buildLookupListPath,
  normalizeItemPriceDate,
} from "../src/service-layer-client.ts";
import { processRequest, type RequestCloudPort, type SlReadPort } from "../src/sync.ts";

describe("lookup paging", () => {
  test("builds paged lookup path with key+label select and search", () => {
    const path = buildLookupListPath({
      entity: "BusinessPartners",
      keyField: "CardCode",
      labelField: "CardName",
      search: "Acme",
      skip: 20,
      top: 50,
    });
    expect(path).toContain("/BusinessPartners?");
    expect(path).toContain("$top=50");
    expect(path).toContain("$skip=20");
    expect(path).toContain("$select=CardCode,CardName");
    const decoded = decodeURIComponent(path);
    expect(decoded).toMatch(/contains\(CardCode,'Acme'\)/);
    expect(decoded).toMatch(/contains\(CardName,'Acme'\)/);
  });

  test("rejects bad identifiers", () => {
    expect(() =>
      buildLookupListPath({
        entity: "Items;drop",
        keyField: "ItemCode",
        labelField: "ItemName",
        search: "",
        skip: 0,
        top: 50,
      }),
    ).toThrow(/Invalid/);
  });
});

describe("CompanyService_GetItemPrice body", () => {
  test("uses InventoryQuantity not Quantity", () => {
    const body = buildItemPriceBody({
      itemCode: "A0001",
      cardCode: "C20000",
      inventoryQuantity: 3,
      uomEntry: 1,
      uomQuantity: 2,
      date: "2026-07-29",
      currency: "EUR",
      priceList: 1,
    });
    expect(body).toEqual({
      ItemPriceParams: {
        ItemCode: "A0001",
        CardCode: "C20000",
        InventoryQuantity: 3,
        UoMEntry: 1,
        UoMQuantity: 2,
        Date: "2026-07-29T00:00:00Z",
        Currency: "EUR",
        PriceList: 1,
      },
    });
    expect(JSON.stringify(body)).not.toContain('"Quantity"');
  });

  test("omits invalid date instead of inventing DateTimeOffset", () => {
    const body = buildItemPriceBody({ itemCode: "A0001", date: "not-a-date" });
    expect(body.ItemPriceParams.Date).toBeUndefined();
    expect(body.ItemPriceParams.ItemCode).toBe("A0001");
  });

  test("normalizeItemPriceDate accepts ISO date and datetime", () => {
    expect(normalizeItemPriceDate("2026-07-29")).toBe("2026-07-29T00:00:00Z");
    expect(normalizeItemPriceDate("2026-07-29T15:30:00Z")).toBe("2026-07-29T15:30:00Z");
    expect(normalizeItemPriceDate("")).toBeUndefined();
    expect(normalizeItemPriceDate(undefined)).toBeUndefined();
  });
});

describe("processRequest lookup + item-context", () => {
  test("lookup kind calls listLookup", async () => {
    const fulfilled: unknown[] = [];
    const calls: unknown[] = [];
    const sl = {
      listLookup: async (opts: unknown) => {
        calls.push(opts);
        return { rows: [{ key: "C1", label: "Acme" }], hasMore: false };
      },
    } as unknown as SlReadPort;
    const cloud: RequestCloudPort = {
      fulfill: async (i) => void fulfilled.push(i),
      fail: async () => {},
    };
    const payload = {
      entity: "BusinessPartners",
      keyField: "CardCode",
      labelField: "CardName",
      search: "Ac",
      skip: 0,
      top: 50,
    };
    await processRequest({ id: "l1", kind: "lookup", payload }, sl, cloud);
    expect(calls).toEqual([payload]);
    expect(fulfilled).toEqual([
      { id: "l1", result: { rows: [{ key: "C1", label: "Acme" }], hasMore: false } },
    ]);
  });

  test("item-context kind calls getItemContext", async () => {
    const fulfilled: unknown[] = [];
    const calls: unknown[] = [];
    const sl = {
      getItemContext: async (opts: unknown) => {
        calls.push(opts);
        return {
          defaults: { ItemName: "Pump" },
          price: { value: 10, currency: "EUR", discount: 0 },
        };
      },
    } as unknown as SlReadPort;
    const cloud: RequestCloudPort = {
      fulfill: async (i) => void fulfilled.push(i),
      fail: async () => {},
    };
    const payload = {
      itemCode: "A0001",
      select: ["ItemCode", "ItemName", "SalesUnit"],
      price: { itemCode: "A0001", inventoryQuantity: 1 },
    };
    await processRequest({ id: "ic1", kind: "item-context", payload }, sl, cloud);
    expect(calls).toEqual([payload]);
    expect(fulfilled).toHaveLength(1);
  });
});
