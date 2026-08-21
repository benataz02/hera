import { describe, expect, test } from "bun:test";
import type { DomainOption, ResolvedLookups } from "@hera/config-engine";
import { mergeQueryPicks, resolveEntry, setEntry, setQueryPick } from "./formHelpers.ts";

const base: ResolvedLookups = {
  domains: { item: [{ value: "A", label: "Ay" }] },
  tables: { items: { columns: ["id", "name"], rows: [["A", "Ay"]], nextLink: "/p2" } },
};

describe("mergeQueryPicks", () => {
  test("empty picks returns the same lookups object", () => {
    expect(mergeQueryPicks(base, {})).toBe(base);
  });

  test("appends the current row per query param without rebuilding domains", () => {
    const picks = setQueryPick({}, "item", "items", { columns: ["id", "name"], rows: [["B", "Bee"]] });
    const lk = mergeQueryPicks(base, picks);
    expect(lk.domains).toBe(base.domains);
    expect(lk.tables.items?.nextLink).toBe("/p2");
    expect(lk.tables.items?.rows).toEqual([["B", "Bee"], ["A", "Ay"]]);
  });

  test("replace keeps one row for that param; clear removes it", () => {
    const first = setQueryPick({}, "item", "items", { columns: ["id", "name"], rows: [["B", "Bee"]] });
    const replaced = setQueryPick(first, "item", "items", { columns: ["id", "name"], rows: [["C", "Cee"]] });
    expect(mergeQueryPicks(base, replaced).tables.items?.rows).toEqual([["C", "Cee"], ["A", "Ay"]]);
    const cleared = setQueryPick(replaced, "item", "items", undefined);
    expect(mergeQueryPicks(base, cleared)).toBe(base);
  });

  test("two params on the same table both contribute a row", () => {
    let picks = setQueryPick({}, "x", "items", { columns: ["id", "name"], rows: [["X", "ex"]] });
    picks = setQueryPick(picks, "y", "items", { columns: ["id", "name"], rows: [["Y", "wye"]] });
    expect(mergeQueryPicks(base, picks).tables.items?.rows).toEqual([
      ["X", "ex"], ["Y", "wye"], ["A", "Ay"],
    ]);
  });

  test("a pick already on the canonical page is not duplicated", () => {
    const picks = setQueryPick({}, "item", "items", { columns: ["id", "name"], rows: [["A", "Ay"]] });
    expect(mergeQueryPicks(base, picks).tables.items?.rows).toEqual([["A", "Ay"]]);
  });
});

describe("resolveEntry", () => {
  const dom: DomainOption[] = [
    { value: "A1", label: "Widget" },
    { value: "B2", label: "Gadget" },
  ];
  test("empty -> clear", () => expect(resolveEntry(dom, "  ")).toEqual({ kind: "clear" }));
  test("exact label (case-insensitive) -> set", () =>
    expect(resolveEntry(dom, "widget")).toEqual({ kind: "set", value: "A1", index: 0 }));
  test("exact value -> set", () => expect(resolveEntry(dom, "B2")).toEqual({ kind: "set", value: "B2", index: 1 }));
  test("duplicate values preserve a label match and raw value deterministically picks the first", () => {
    const dup: DomainOption[] = [
      { value: "X", label: "First" },
      { value: "X", label: "Second" },
    ];
    expect(resolveEntry(dup, "second")).toEqual({ kind: "set", value: "X", index: 1 });
    expect(resolveEntry(dup, "X")).toEqual({ kind: "set", value: "X", index: 0 });
  });
  test("unknown text -> reject", () => expect(resolveEntry(dom, "nope")).toEqual({ kind: "reject" }));
});

describe("setEntry", () => {
  test("same value returns the same object", () => {
    const entries = { material: "steel" };
    expect(setEntry(entries, "material", "steel")).toBe(entries);
  });
  test("missing key stays missing", () => {
    const entries = { material: "steel" };
    expect(setEntry(entries, "width", undefined)).toBe(entries);
  });
  test("set and clear produce a new object", () => {
    const entries = { material: "steel" };
    expect(setEntry(entries, "width", 10)).toEqual({ material: "steel", width: 10 });
    expect(setEntry(entries, "material", undefined)).toEqual({});
  });
});
