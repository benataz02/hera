import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntityProfile } from "@hera/db";
import {
  assertEditableRecord,
  recordPassesEditWhen,
  resolveWriteCapabilities,
} from "../src/write-capabilities.ts";

const STALE_MS = 90_000;

const quotationProfile: EntityProfile = {
  entity: "Quotations",
  family: "sales-document",
  subtitleFields: ["CardCode"],
  fields: {
    editableHeader: ["CardCode"],
    requiredOnCreate: ["CardCode"],
    readOnly: ["DocEntry"],
    collectionEditable: {},
    editWhen: [],
  },
  create: { dedupField: "U_HERA_DedupKey", resultKey: "DocEntry" },
  collections: {},
};

const itemsProfile: EntityProfile = {
  entity: "Items",
  family: "master-data",
  subtitleFields: ["ItemName"],
  fields: {
    editableHeader: ["ItemName"],
    requiredOnCreate: ["ItemCode"],
    readOnly: ["ItemCode"],
    collectionEditable: {},
    editWhen: [],
  },
  collections: {},
};

const documentEditWhenProfile: EntityProfile = {
  ...quotationProfile,
  fields: {
    ...quotationProfile.fields,
    editWhen: [
      { field: "DocumentStatus", allowed: ["bost_Open"] },
      { field: "Cancelled", allowed: ["tNO", "N", false] },
    ],
  },
};

describe("resolveWriteCapabilities freshness", () => {
  const now = new Date("2026-07-29T12:00:00.000Z");
  const fresh = new Date(now.getTime() - 10_000);
  const stale = new Date(now.getTime() - STALE_MS - 1);

  test("no profile → create and edit disabled", () => {
    expect(
      resolveWriteCapabilities({
        entity: "Unknown",
        profile: null,
        writeCapabilities: [{ entity: "Unknown", dedupField: "U_HERA_DedupKey" }],
        checkedAt: fresh,
        lastSeenAt: fresh,
        now,
      }),
    ).toEqual({ canEdit: false, canCreate: false, reason: "No profile" });
  });

  test("stale report / agent offline disables create; update remains allowed", () => {
    // Agent must re-heartbeat on each pull; a one-shot startup report goes stale ~90s later.
    const caps = resolveWriteCapabilities({
      entity: "Quotations",
      profile: quotationProfile,
      writeCapabilities: [{ entity: "Quotations", dedupField: "U_HERA_DedupKey" }],
      checkedAt: stale,
      lastSeenAt: fresh,
      now,
    });
    expect(caps.canEdit).toBe(true);
    expect(caps.canCreate).toBe(false);
    expect(caps.reason).toMatch(/stale|offline/i);

    const offline = resolveWriteCapabilities({
      entity: "Quotations",
      profile: quotationProfile,
      writeCapabilities: [{ entity: "Quotations", dedupField: "U_HERA_DedupKey" }],
      checkedAt: fresh,
      lastSeenAt: stale,
      now,
    });
    expect(offline.canEdit).toBe(true);
    expect(offline.canCreate).toBe(false);
    expect(offline.reason).toMatch(/stale|offline/i);
  });

  test("pull-refreshed checkedAt keeps create enabled while agent is live", () => {
    // Simulates agent re-sending lastValidatedCapabilities on each successful pull.
    expect(
      resolveWriteCapabilities({
        entity: "Quotations",
        profile: quotationProfile,
        writeCapabilities: [{ entity: "Quotations", dedupField: "U_HERA_DedupKey" }],
        checkedAt: fresh,
        lastSeenAt: fresh,
        now,
      }).canCreate,
    ).toBe(true);
  });


  test("current matching report enables create", () => {
    expect(
      resolveWriteCapabilities({
        entity: "Quotations",
        profile: quotationProfile,
        writeCapabilities: [{ entity: "Quotations", dedupField: "U_HERA_DedupKey" }],
        checkedAt: fresh,
        lastSeenAt: fresh,
        now,
      }),
    ).toEqual({ canEdit: true, canCreate: true });
  });

  test("entity not reported disables create; update remains allowed", () => {
    const caps = resolveWriteCapabilities({
      entity: "Quotations",
      profile: quotationProfile,
      writeCapabilities: [{ entity: "Orders", dedupField: "U_HERA_DedupKey" }],
      checkedAt: fresh,
      lastSeenAt: fresh,
      now,
    });
    expect(caps).toEqual({
      canEdit: true,
      canCreate: false,
      reason: "Entity not reported",
    });
  });

  test("UDF mismatch disables create; update remains allowed", () => {
    const caps = resolveWriteCapabilities({
      entity: "Quotations",
      profile: quotationProfile,
      writeCapabilities: [{ entity: "Quotations", dedupField: "U_Wrong" }],
      checkedAt: fresh,
      lastSeenAt: fresh,
      now,
    });
    expect(caps).toEqual({
      canEdit: true,
      canCreate: false,
      reason: "UDF mismatch",
    });
  });

  test("create capability absent (no profile.create) → update still allowed", () => {
    const caps = resolveWriteCapabilities({
      entity: "Items",
      profile: itemsProfile,
      writeCapabilities: [],
      checkedAt: fresh,
      lastSeenAt: fresh,
      now,
    });
    expect(caps.canEdit).toBe(true);
    expect(caps.canCreate).toBe(false);
  });
});

describe("assertEditableRecord / editWhen", () => {
  test("open document passes; closed fails; missing lock fields fail closed", () => {
    expect(
      recordPassesEditWhen(documentEditWhenProfile, {
        DocumentStatus: "bost_Open",
        Cancelled: "tNO",
      }),
    ).toBe(true);
    expect(
      recordPassesEditWhen(documentEditWhenProfile, {
        DocumentStatus: "bost_Close",
        Cancelled: "tNO",
      }),
    ).toBe(false);
    expect(recordPassesEditWhen(documentEditWhenProfile, { Comments: "x" })).toBe(false);

    expect(() =>
      assertEditableRecord(documentEditWhenProfile, {
        DocumentStatus: "bost_Open",
        Cancelled: "tNO",
      }),
    ).not.toThrow();
    expect(() =>
      assertEditableRecord(documentEditWhenProfile, {
        DocumentStatus: "bost_Close",
        Cancelled: "tNO",
      }),
    ).toThrow(/status lock|not editable/i);
  });

  test("empty editWhen always passes", () => {
    expect(recordPassesEditWhen(quotationProfile, {})).toBe(true);
    expect(() => assertEditableRecord(quotationProfile, {})).not.toThrow();
  });
});

test("runbook documents write_capabilities ALTER SQL (drizzle is gitignored)", () => {
  const runbook = readFileSync(
    join(import.meta.dir, "../../../docs/sap-b1-durable-writes.md"),
    "utf8",
  );
  expect(runbook).toMatch(/write_capabilities/i);
  expect(runbook).toMatch(/write_capabilities_checked_at/i);
  expect(runbook).toMatch(/ALTER TABLE\s+"tenant_integration"/i);
  expect(runbook).not.toMatch(/CREATE TABLE\s+"?tenant_integration"?/i);
});
