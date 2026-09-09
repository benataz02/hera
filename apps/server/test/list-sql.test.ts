import { describe, expect, test } from "bun:test";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { ListVariantDef } from "@hera/db";
import { compileListSql, nextSkipOf, type SqlFields } from "../src/list-sql.ts";
import { configProject } from "@hera/db";

// The SQL executor of a saved view. Same spec, same rules as entity-list.ts's OData compilation —
// these lock in the two that differ from "just drop what you don't recognise": a filter naming a
// missing field throws (dropping it shows MORE rows than asked), an orderby naming one does not.

const dialect = new PgDialect();
const toSql = (s: SQL | undefined) => (s ? dialect.sqlToQuery(s) : undefined);

const fields: SqlFields = {
  name: { col: configProject.name, kind: "string" },
  status: { col: configProject.status, kind: "enum" },
  updatedAt: { col: configProject.updatedAt, kind: "date" },
  customerName: { col: sql`${configProject.customer}->>'cardName'`, kind: "string" },
};

const spec = (over: Partial<ListVariantDef> = {}): ListVariantDef =>
  ({ select: [], filter: [], orderby: [], filterBar: [], ...over });

describe("compileListSql", () => {
  test("an empty spec compiles to nothing at all", () => {
    const { where, orderBy } = compileListSql(fields, spec());
    expect(where).toBeUndefined();
    expect(orderBy).toEqual([]);
  });

  test("every operator, and contains/startswith are case-insensitive like applySpec was", () => {
    const ops = [
      { op: "eq", frag: '"name" = $1', param: "a" },
      { op: "ne", frag: '"name" <> $1', param: "a" },
      { op: "gt", frag: '"name" > $1', param: "a" },
      { op: "ge", frag: '"name" >= $1', param: "a" },
      { op: "lt", frag: '"name" < $1', param: "a" },
      { op: "le", frag: '"name" <= $1', param: "a" },
      { op: "contains", frag: '"name" ilike $1', param: "%a%" },
      { op: "startswith", frag: '"name" ilike $1', param: "a%" },
    ] as const;
    for (const { op, frag, param } of ops) {
      const q = toSql(compileListSql(fields, spec({ filter: [{ field: "name", op, value: "a" }] })).where)!;
      expect(q.sql).toContain(frag);
      expect(q.params).toEqual([param]);
    }
  });

  test("conditions are ANDed", () => {
    const q = toSql(compileListSql(fields, spec({
      filter: [{ field: "name", op: "contains", value: "bolt" }, { field: "status", op: "eq", value: "quoted" }],
    })).where)!;
    expect(q.sql).toContain(" and ");
    expect(q.params).toEqual(["%bolt%", "quoted"]);
  });

  test("a filter naming a missing field throws — dropping it would show more rows than asked", () => {
    expect(() => compileListSql(fields, spec({ filter: [{ field: "nope", op: "eq", value: 1 }] })))
      .toThrow("Filter field 'nope' is not on this list");
  });

  test("search hits string fields only, including derived ones, and is ORed", () => {
    const q = toSql(compileListSql(fields, spec({ search: " ac " })).where)!;
    expect(q.params).toEqual(["%ac%", "%ac%"]); // name + customerName; not status/updatedAt
    expect(q.sql).toContain(" or ");
    expect(q.sql).toContain("->>'cardName'");
  });

  test("a list with no string column searches nothing rather than everything", () => {
    const dateOnly: SqlFields = { updatedAt: { col: configProject.updatedAt, kind: "date" } };
    expect(compileListSql(dateOnly, spec({ search: "x" })).where).toBeUndefined();
  });

  test("orderby is compiled in order, and a missing field is dropped so an old view still opens", () => {
    const { orderBy } = compileListSql(fields, spec({
      orderby: [{ field: "gone", dir: "asc" }, { field: "updatedAt", dir: "desc" }, { field: "name", dir: "asc" }],
    }));
    expect(orderBy).toHaveLength(2);
    expect(toSql(orderBy[0])!.sql).toContain('"updated_at" desc');
    expect(toSql(orderBy[1])!.sql).toContain('"name" asc');
  });
});

describe("nextSkipOf", () => {
  test("a full page means there is probably another; a short one ends the chain", () => {
    expect(nextSkipOf(100, 100, undefined)).toBe(100);
    expect(nextSkipOf(100, 100, 200)).toBe(300);
    expect(nextSkipOf(99, 100, 200)).toBeUndefined();
    expect(nextSkipOf(0, 100, 300)).toBeUndefined();
  });
});
