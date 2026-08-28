import { describe, expect, test } from "bun:test";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";
import { router } from "../src/orpc/router.ts";

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

describe("dashboard.overview", () => {
  test("returns a zeroed overview for a tenant with no data", async () => {
    const { tenantId, slug } = await makeTenant();
    const u = await makeUser("member", tenantId);
    const out = await call(
      router.dashboard.overview,
      { window: "month" },
      { context: { headers: tenantHeaders(slug, u.cookie) } },
    );
    expect(out.orderValue.total).toBe(0);
    expect(out.funnel).toHaveLength(4);
    expect(out.computedAt).toBeNull();
  });
});

describe("dashboard.refresh", () => {
  // A tenant with no sap_connection row has no agent to refresh from — the canonical
  // "SAP is not connected." now comes from that missing row, not from a stub fetcher.
  test("a tenant with no agent configured gets SERVICE_UNAVAILABLE", async () => {
    const { tenantId, slug } = await makeTenant();
    const u = await makeUser("member", tenantId);
    expect(
      await code(
        call(router.dashboard.refresh, undefined, {
          context: { headers: tenantHeaders(slug, u.cookie) },
        }),
      ),
    ).toBe("SERVICE_UNAVAILABLE");
  });
});
