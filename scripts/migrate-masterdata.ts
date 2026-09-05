/**
 * One-way migration: config_model.definition.queryTables[] becomes config_masterdata rows of kind
 * "query". A query is tenant masterdata now — one definition per name, referenced by every model
 * that names it — so the copy inside each model is removed.
 *
 *   bun --env-file=.env scripts/migrate-masterdata.ts          # dry run, prints the plan
 *   bun --env-file=.env scripts/migrate-masterdata.ts --write  # applies it
 *
 * TAKE A DB SNAPSHOT FIRST. Run it after `bun run db:push` has created config_masterdata.
 *
 * Two models that define the same query name differently cannot both become one tenant row, so
 * that case fails loudly with the list instead of picking a winner: renaming one of them also
 * means rewriting the refs inside that model, which is a human decision.
 */
import { and, eq } from "drizzle-orm";
import { db, configMasterdata, configModel, type MasterdataQuery } from "@hera/db";

type LegacyQueryTable = MasterdataQuery & { name: string };

const canonical = (q: MasterdataQuery) =>
  JSON.stringify({
    target: q.target,
    query: { entitySet: q.query.entitySet, filter: q.query.filter ?? null, orderby: q.query.orderby ?? null },
    columns: q.columns,
    labels: q.labels ?? null,
    hidden: q.hidden ?? null,
  });

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const models = await db
    .select({ id: configModel.id, tenantId: configModel.tenantId, name: configModel.name, definition: configModel.definition })
    .from(configModel);

  // tenant -> name -> { query, from: model names }
  const planned = new Map<string, Map<string, { query: MasterdataQuery; from: string[] }>>();
  const failures: string[] = [];
  const touched: typeof models = [];

  for (const m of models) {
    const def = m.definition as unknown as { queryTables?: LegacyQueryTable[] };
    if (!def.queryTables?.length) continue;
    touched.push(m);
    const byName = planned.get(m.tenantId) ?? new Map();
    planned.set(m.tenantId, byName);
    for (const qt of def.queryTables) {
      const { name, ...query } = qt;
      const seen = byName.get(name);
      if (!seen) byName.set(name, { query, from: [m.name] });
      else if (canonical(seen.query) === canonical(query)) seen.from.push(m.name);
      else failures.push(`${m.tenantId}: '${name}' is defined differently by ${seen.from.join(", ")} and ${m.name}`);
    }
  }

  // An existing row of the same name is only reusable if it says the same thing.
  for (const [tenantId, byName] of planned) {
    for (const [name, entry] of byName) {
      const [row] = await db
        .select({ kind: configMasterdata.kind, query: configMasterdata.query })
        .from(configMasterdata)
        .where(and(eq(configMasterdata.tenantId, tenantId), eq(configMasterdata.name, name)))
        .limit(1);
      if (!row) {
        console.log(`${write ? "creating" : "would create"} ${tenantId}/${name} (from ${entry.from.join(", ")})`);
        console.log(JSON.stringify(entry.query, null, 2));
        if (write)
          await db.insert(configMasterdata).values({ tenantId, name, kind: "query", query: entry.query });
        continue;
      }
      if (row.kind !== "query" || !row.query)
        failures.push(`${tenantId}: '${name}' already exists as a maintained table`);
      else if (canonical(row.query) !== canonical(entry.query))
        failures.push(`${tenantId}: '${name}' already exists with a different query`);
      else console.log(`reusing ${tenantId}/${name}`);
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} name conflict(s) need a human:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    console.error("Nothing was stripped from the models; resolve the names and run again.");
    process.exit(1);
  }

  for (const m of touched) {
    const def = structuredClone(m.definition) as unknown as { queryTables?: LegacyQueryTable[] };
    delete def.queryTables;
    console.log(`${write ? "stripping" : "would strip"} queryTables from ${m.tenantId}/${m.name}`);
    if (write) await db.update(configModel).set({ definition: def as never }).where(eq(configModel.id, m.id));
  }

  console.log(`\n${models.length} models scanned, ${touched.length} ${write ? "migrated" : "to migrate"}`);
  process.exit(0);
}
