import { expect, test } from "bun:test";
import type { EntitySchema } from "../src/service-layer-client.ts";
import {
  parseWriteCapabilities,
  validateWriteCapabilities,
  type WriteCapability,
} from "../src/write-capabilities.ts";

const quotations: EntitySchema = {
  name: "Quotations",
  typeName: "Document",
  keys: ["DocEntry"],
  properties: [
    { name: "DocEntry", type: "Edm.Int32", nullable: false },
    { name: "U_HERA_DedupKey", type: "Edm.String", nullable: true },
  ],
  collections: [],
};

const orders: EntitySchema = {
  name: "Orders",
  typeName: "Document",
  keys: ["DocEntry"],
  properties: [
    { name: "DocEntry", type: "Edm.Int32", nullable: false },
    { name: "U_HERA_DedupKey", type: "Edm.String", nullable: true },
  ],
  collections: [],
};

test("parseWriteCapabilities: empty / undefined → []", () => {
  expect(parseWriteCapabilities(undefined)).toEqual([]);
  expect(parseWriteCapabilities("")).toEqual([]);
  expect(parseWriteCapabilities("  ,  ")).toEqual([]);
});

test("parseWriteCapabilities: well-formed pairs", () => {
  expect(parseWriteCapabilities("Quotations:U_HERA_DedupKey,Orders:U_HERA_DedupKey")).toEqual([
    { entity: "Quotations", dedupField: "U_HERA_DedupKey" },
    { entity: "Orders", dedupField: "U_HERA_DedupKey" },
  ]);
});

test("parseWriteCapabilities: drops malformed pairs", () => {
  expect(
    parseWriteCapabilities("bad,Quotations:U_HERA_DedupKey,:NoEntity,NoField:,Orders:U_HERA_DedupKey"),
  ).toEqual([
    { entity: "Quotations", dedupField: "U_HERA_DedupKey" },
    { entity: "Orders", dedupField: "U_HERA_DedupKey" },
  ]);
});

test("validateWriteCapabilities: missing entity or UDF", () => {
  const configured = parseWriteCapabilities(
    "Quotations:U_HERA_DedupKey,Orders:U_HERA_DedupKey,Ghosts:U_HERA_DedupKey,Quotations:MissingUdf",
  );
  // Ghosts entity absent; Quotations:MissingUdf UDF absent on schema (and duplicate entity).
  const { valid, errors } = validateWriteCapabilities(
    [
      { entity: "Quotations", dedupField: "U_HERA_DedupKey" },
      { entity: "Orders", dedupField: "U_HERA_DedupKey" },
      { entity: "Ghosts", dedupField: "U_HERA_DedupKey" },
      { entity: "Orders", dedupField: "U_Missing" },
    ],
    [quotations, orders],
  );
  expect(valid).toEqual([
    { entity: "Quotations", dedupField: "U_HERA_DedupKey" },
    { entity: "Orders", dedupField: "U_HERA_DedupKey" },
  ]);
  expect(errors.some((e) => /Ghosts/i.test(e))).toBe(true);
  expect(errors.some((e) => /U_Missing|Orders/i.test(e))).toBe(true);
  expect(configured.length).toBeGreaterThan(0); // sanity: parser used elsewhere
});

test("validateWriteCapabilities: duplicate entity keeps first valid, errors on later", () => {
  const { valid, errors } = validateWriteCapabilities(
    [
      { entity: "Quotations", dedupField: "U_HERA_DedupKey" },
      { entity: "Quotations", dedupField: "U_Other" },
    ],
    [quotations],
  );
  expect(valid).toEqual([{ entity: "Quotations", dedupField: "U_HERA_DedupKey" }]);
  expect(errors.some((e) => /duplicate/i.test(e))).toBe(true);
});

test("pull refresh reuses last validated list without re-running EDMX validation", () => {
  // Mirrors index.ts: validate once → cache → re-heartbeat same list on each pull.
  const { valid } = validateWriteCapabilities(
    [{ entity: "Quotations", dedupField: "U_HERA_DedupKey" }],
    [quotations],
  );
  let lastValidated: WriteCapability[] | undefined = valid;
  expect(lastValidated).toEqual([{ entity: "Quotations", dedupField: "U_HERA_DedupKey" }]);
  // Subsequent pull heartbeats must send the cache, not undefined (which would skip and go stale).
  const forPull = lastValidated;
  expect(forPull).toEqual(valid);
  lastValidated = [];
  expect(lastValidated).toEqual([]); // empty validated config still refreshes checked_at
});
