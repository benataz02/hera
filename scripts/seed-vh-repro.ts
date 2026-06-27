/** Throwaway: seed a model with one Table-datasource value-help field, to repro the F4 filter bug. */
import { and, eq } from "drizzle-orm";
import { db, pool, organization, configModel, configTable } from "@hera/db";

const SLUG = "acme";

async function main(): Promise<void> {
  const [org] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, SLUG)).limit(1);
  if (!org) throw new Error(`org '${SLUG}' not found`);

  await db.delete(configTable).where(and(eq(configTable.tenantId, org.id), eq(configTable.name, "Colors")));
  const [tbl] = await db
    .insert(configTable)
    .values({
      tenantId: org.id,
      name: "Colors",
      rows: ["Red", "Reddish", "Green", "Blue", "Black", "White", "Yellow"].map((c) => ({ value: c, name: c })),
    })
    .returning({ id: configTable.id });

  const model = {
    name: "VH repro",
    family: "debug",
    sections: [
      {
        id: "s", label: "Spec",
        groups: [
          {
            id: "g", label: "Pick",
            items: [
              {
                id: "color", name: "color", label: "Color",
                input: { mandatory: false, dataSource: { kind: "table", tableId: tbl!.id, valueField: "value", labelField: "name" }, inputType: "combo", value: { kind: "manual" } },
              },
            ],
          },
        ],
      },
    ],
    rules: [],
  };

  await db.delete(configModel).where(and(eq(configModel.tenantId, org.id), eq(configModel.name, model.name)));
  const [row] = await db
    .insert(configModel)
    .values({ tenantId: org.id, name: model.name, family: model.family, definition: model as unknown as Record<string, unknown>, published: true })
    .returning({ id: configModel.id });

  console.log(`Seeded model '${model.name}' (${row!.id}) + table Colors (${tbl!.id}) for ${SLUG}.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
