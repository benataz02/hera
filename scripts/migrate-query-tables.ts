/**
 * One-way migration: config_model.definition queryTables[].path and history.query.path become
 * structured queries ({ entitySet, filter, orderby, top }). $select is dropped — it is derived
 * from `columns` at read time now, so the two can never disagree.
 *
 *   bun --env-file=.env scripts/migrate-query-tables.ts          # dry run, prints the plan
 *   bun --env-file=.env scripts/migrate-query-tables.ts --write  # applies it
 *
 * TAKE A DB SNAPSHOT FIRST. Anything that is not a plain entity-set read fails loudly rather
 * than being guessed at — those need a human decision, and there should be none in practice.
 */
import { eq } from "drizzle-orm";
import { db, configModel } from "@hera/db";
import type { ODataQuery } from "@hera/config-engine";

const BASE = "https://migrate.invalid/";
const ENTITY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `/Items?$select=A,B&$filter=X&$top=50` -> { entitySet: "Items", filter: "X", top: 50 }. */
export function parsePath(path: string, columns: string[]): ODataQuery {
  const url = new URL(path, BASE);
  const entitySet = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!ENTITY.test(entitySet))
    throw new Error(`'${path}': '${entitySet}' is not a plain entity set (a function call or a nested path needs a human)`);

  const known = new Set(["$select", "$filter", "$orderby", "$top"]);
  for (const [k] of url.searchParams) {
    if (!known.has(k)) throw new Error(`'${path}': cannot migrate query option '${k}'`);
  }

  // $select is derived from columns from now on, so it must already be covered by them.
  const select = url.searchParams.get("$select");
  if (select) {
    const missing = select.split(",").map((s) => s.trim()).filter((c) => c && !columns.includes(c));
    if (missing.length) throw new Error(`'${path}': $select has ${missing.join(", ")} but columns do not — run Test fetch first`);
  }

  const top = url.searchParams.get("$top");
  if (top !== null && !/^\d+$/.test(top)) throw new Error(`'${path}': $top '${top}' is not a positive integer`);

  return {
    entitySet,
    ...(url.searchParams.get("$filter") ? { filter: url.searchParams.get("$filter")! } : {}),
    ...(url.searchParams.get("$orderby") ? { orderby: url.searchParams.get("$orderby")! } : {}),
    ...(top !== null && Number(top) > 0 ? { top: Number(top) } : {}),
  };
}

type LegacySource = { path?: string; query?: ODataQuery; columns?: string[] };

/** Returns true if it changed anything. */
function migrateSource(s: LegacySource, where: string): boolean {
  if (s.query) return false; // already migrated
  if (typeof s.path !== "string") throw new Error(`${where}: neither 'path' nor 'query'`);
  s.query = parsePath(s.path, s.columns ?? []);
  delete s.path;
  return true;
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const models = await db.select({ id: configModel.id, tenantId: configModel.tenantId, name: configModel.name, definition: configModel.definition }).from(configModel);

  let changed = 0;
  const failures: string[] = [];
  for (const m of models) {
    const def = structuredClone(m.definition) as unknown as {
      queryTables?: LegacySource[];
      history?: { query?: LegacySource };
    };
    let touched = false;
    try {
      for (const [i, qt] of (def.queryTables ?? []).entries())
        touched = migrateSource(qt, `${m.name} queryTables[${i}]`) || touched;
      if (def.history?.query) touched = migrateSource(def.history.query, `${m.name} history.query`) || touched;
    } catch (e) {
      failures.push(`${m.tenantId}/${m.name}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!touched) continue;
    changed++;
    console.log(`${write ? "migrating" : "would migrate"} ${m.tenantId}/${m.name}`);
    console.log(JSON.stringify({ queryTables: def.queryTables, history: def.history?.query }, null, 2));
    if (write) {
      await db.update(configModel)
        .set({ definition: def as never })
        .where(eq(configModel.id, m.id));
    }
  }

  console.log(`\n${models.length} models scanned, ${changed} ${write ? "migrated" : "to migrate"}`);
  if (failures.length) {
    console.error(`\n${failures.length} model(s) need a human:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
  process.exit(0);
}
