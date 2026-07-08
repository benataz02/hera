import { describe, expect, test } from "bun:test";
import { call, makeTenant, makeUser, bindClient, tenantHeaders } from "./harness.ts";
import { router } from "../src/orpc/router.ts";

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

describe("spec test 1 — a client-role session is FORBIDDEN on every internal procedure", () => {
  test("userProcedure + adminProcedure reject role=client; member still passes", async () => {
    const { tenantId, slug } = await makeTenant();
    const client = await makeUser("client", tenantId);
    await bindClient(tenantId, client.userId);
    const ctx = { context: { headers: tenantHeaders(slug, client.cookie) } };

    // spot-check across routers (quotes-equivalent lists, configs, models, extraction)
    expect(await code(call(router.configs.list, undefined, ctx))).toBe("FORBIDDEN");
    expect(await code(call(router.configs.models, undefined, ctx))).toBe("FORBIDDEN");
    expect(await code(call(router.entities.getEnabled, undefined, ctx))).toBe("FORBIDDEN");
    expect(await code(call(router.models.list, undefined, ctx))).toBe("FORBIDDEN");
    expect(await code(call(router.extraction.extract, {
      modelId: crypto.randomUUID(),
      file: { name: "d.pdf", mimeType: "application/pdf", dataBase64: "aGk=" },
    }, ctx))).toBe("FORBIDDEN");

    const m = await makeUser("member", tenantId);
    const mctx = { context: { headers: tenantHeaders(slug, m.cookie) } };
    expect(await code(call(router.configs.list, undefined, mctx))).toBe("OK");
  });
});
