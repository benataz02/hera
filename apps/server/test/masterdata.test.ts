import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, configMasterdata, configModel } from "@hera/db";
import type { ModelDef } from "@hera/config-engine";
import { router } from "../src/orpc/router.ts";
import { call, makeTenant, makeUser, tenantHeaders, TEST_MODEL } from "./harness.ts";

// The model TEST_MODEL is, with its select fed from masterdata instead of manual options.
const usingTable = (table: string): ModelDef => ({
  ...TEST_MODEL,
  parameters: TEST_MODEL.parameters.map((p) =>
    p.key === "material"
      ? { ...p, domain: { kind: "options", ref: { source: "table", table, valueCol: "code" } } as const }
      : p,
  ),
});

describe.skipIf(!process.env.DATABASE_URL)("masterdata.remove (integration)", () => {
  test("refuses while a model references the table, allows it once nothing does", async () => {
    const { tenantId, slug } = await makeTenant();
    const admin = await makeUser("admin", tenantId);
    const ctx = { context: { headers: tenantHeaders(slug, admin.cookie) } };

    const [t] = await db.insert(configMasterdata).values({
      tenantId, name: "materials", kind: "table",
      columns: [{ key: "code", label: "Code", type: "string" }], rows: [["steel"], ["alu"]],
    }).returning({ id: configMasterdata.id });
    const [m] = await db.insert(configModel)
      .values({ tenantId, name: "Cable", definition: usingTable("materials") })
      .returning({ id: configModel.id });

    await expect(call(router.masterdata.remove, { id: t!.id }, ctx)).rejects.toThrow(/used by model Cable/);
    expect(await db.select().from(configMasterdata).where(eq(configMasterdata.id, t!.id))).toHaveLength(1);

    await db.delete(configModel).where(eq(configModel.id, m!.id));
    await call(router.masterdata.remove, { id: t!.id }, ctx);
    expect(await db.select().from(configMasterdata).where(eq(configMasterdata.id, t!.id))).toHaveLength(0);
  });
});
