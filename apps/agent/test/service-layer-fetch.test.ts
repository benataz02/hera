import { describe, expect, test } from "bun:test";
import {
  buildCrossjoinPath,
  buildObjectHeaderPath,
  flattenCrossjoinRows,
  nextLinkPath,
  projectFullRecord,
  type ObjectFetchRequest,
} from "../src/service-layer-client.ts";

describe("object fetch path builders", () => {
  test("escapes string keys in header path", () => {
    const path = buildObjectHeaderPath("BusinessPartners", "O'Brien", true, ["CardCode", "CardName"]);
    expect(path).toBe("/BusinessPartners('O''Brien')?$select=CardCode,CardName");
  });

  test("uses bare numeric keys in header path", () => {
    const path = buildObjectHeaderPath("Quotations", "142", false, ["DocEntry", "CardCode"]);
    expect(path).toBe("/Quotations(142)?$select=DocEntry,CardCode");
  });

  test("rejects bad identifiers in select", () => {
    expect(() => buildObjectHeaderPath("Quotations", "1", false, ["DocEntry;drop"])).toThrow(
      /Invalid/,
    );
  });

  test("builds profiled collection $crossjoin with escaped filter", () => {
    const path = buildCrossjoinPath({
      entity: "Quotations",
      key: "142",
      keyQuoted: false,
      collection: {
        name: "DocumentLines",
        select: ["DocEntry", "LineNum", "ItemCode"],
        parentKey: "DocEntry",
        childParentKey: "DocEntry",
        rowKey: "LineNum",
      },
    });
    expect(path).toBe(
      "/$crossjoin(Quotations,Quotations/DocumentLines)" +
        "?$expand=Quotations($select=DocEntry),Quotations/DocumentLines($select=DocEntry,LineNum,ItemCode)" +
        "&$filter=" +
        encodeURIComponent(
          "Quotations/DocEntry eq Quotations/DocumentLines/DocEntry and Quotations/DocEntry eq 142",
        ),
    );
  });

  test("escapes string key in crossjoin filter", () => {
    const path = buildCrossjoinPath({
      entity: "BusinessPartners",
      key: "O'Brien",
      keyQuoted: true,
      collection: {
        name: "ContactEmployees",
        select: ["CardCode", "InternalCode", "Name"],
        parentKey: "CardCode",
        childParentKey: "CardCode",
        rowKey: "InternalCode",
      },
    });
    const filter = decodeURIComponent(path.split("&$filter=")[1]!);
    expect(filter).toContain("BusinessPartners/CardCode eq 'O''Brien'");
  });
});

describe("crossjoin merge + full-record fallback", () => {
  test("flattens crossjoin pairs into collection rows", () => {
    const rows = [
      {
        Quotations: { DocEntry: 142 },
        "Quotations/DocumentLines": { DocEntry: 142, LineNum: 0, ItemCode: "A1" },
      },
      {
        Quotations: { DocEntry: 142 },
        "Quotations/DocumentLines": { DocEntry: 142, LineNum: 1, ItemCode: "B2" },
      },
    ];
    expect(flattenCrossjoinRows(rows, "Quotations", "DocumentLines")).toEqual([
      { DocEntry: 142, LineNum: 0, ItemCode: "A1" },
      { DocEntry: 142, LineNum: 1, ItemCode: "B2" },
    ]);
  });

  test("projectFullRecord keeps only requested header + collection fields", () => {
    const request: ObjectFetchRequest = {
      entity: "Quotations",
      key: "142",
      keyQuoted: false,
      select: ["DocEntry", "CardCode", "Comments"],
      collections: [
        {
          name: "DocumentLines",
          select: ["DocEntry", "LineNum", "ItemCode"],
          parentKey: "DocEntry",
          childParentKey: "DocEntry",
          rowKey: "LineNum",
        },
      ],
      fullRecordFallback: true,
    };
    const full = {
      DocEntry: 142,
      CardCode: "C1",
      Comments: "hi",
      Extra: "drop-me",
      DocumentLines: [
        { DocEntry: 142, LineNum: 0, ItemCode: "A1", WarehouseCode: "01" },
        { DocEntry: 142, LineNum: 1, ItemCode: "B2", WarehouseCode: "02" },
      ],
      AddressExtension: { BillToStreet: "x" },
    };
    expect(projectFullRecord(full, request)).toEqual({
      DocEntry: 142,
      CardCode: "C1",
      Comments: "hi",
      DocumentLines: [
        { DocEntry: 142, LineNum: 0, ItemCode: "A1" },
        { DocEntry: 142, LineNum: 1, ItemCode: "B2" },
      ],
    });
  });
});

describe("nextLinkPath", () => {
  const base = "https://b1.example.com:50000/b1s/v2";

  test("returns undefined when there is no next link", () => {
    expect(nextLinkPath(undefined, base)).toBeUndefined();
    expect(nextLinkPath("", base)).toBeUndefined();
    expect(nextLinkPath(42, base)).toBeUndefined();
  });

  test("prefixes a relative link with a slash", () => {
    expect(nextLinkPath("Orders?$skip=20", base)).toBe("/Orders?$skip=20");
  });

  test("keeps an already-rooted relative link", () => {
    expect(nextLinkPath("/Orders?$skip=20", base)).toBe("/Orders?$skip=20");
  });

  test("strips the service root from an absolute link", () => {
    expect(nextLinkPath(`${base}/Orders?$skip=20&$top=5`, base)).toBe("/Orders?$skip=20&$top=5");
  });

  test("keeps the path when an absolute link does not share the service root", () => {
    expect(nextLinkPath("https://other.example.com/Orders?$skip=20", base)).toBe("/Orders?$skip=20");
  });
});
