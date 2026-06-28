/** Throwaway: seed a model with one master-data value-help field, to repro the F4 filter behaviour. */
import { and, eq } from "drizzle-orm";
import { db, pool, organization, configModel, configMasterdata } from "@hera/db";

const SLUG = "acme";

async function main(): Promise<void> {
  const [org] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, SLUG)).limit(1);
  if (!org) throw new Error(`org '${SLUG}' not found`);

  await db.delete(configMasterdata).where(and(eq(configMasterdata.tenantId, org.id), eq(configMasterdata.name, "Colors")));
  const [md] = await db
    .insert(configMasterdata)
    .values({
      tenantId: org.id,
      name: "Colors",
      kind: "manual",
      columns: ["code", "name"],
      rows: ["Red", "Reddish", "Green", "Blue", "Black", "White", "Yellow"].map((c) => ({ code: c, name: c })),
    })
    .returning({ id: configMasterdata.id });

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
                input: { mandatory: false, dataSource: { kind: "masterdata", masterdataId: md!.id }, inputType: "input", value: { kind: "manual" } },
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

  console.log(`Seeded model '${model.name}' (${row!.id}) + master data Colors (${md!.id}) for ${SLUG}.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
