import { expect, test } from "bun:test";
import { cacheIsFresh } from "../src/entity-meta.ts";

const DAY = 24 * 60 * 60_000;
const now = Date.parse("2026-09-01T00:00:00Z");

test("a cached schema expires on the TTL and on a parser change", () => {
  expect(cacheIsFresh(new Date(now - 60_000), now)).toBe(true);
  expect(cacheIsFresh(new Date(now - DAY - 1), now)).toBe(false);
  // Inside the TTL but parsed before the parser changed — the case a plain TTL misses.
  expect(cacheIsFresh(new Date(Date.parse("2026-08-28T06:00:00Z")), Date.parse("2026-08-28T18:00:00Z"))).toBe(false);
  // A row written now is always usable — a mistyped future epoch must not re-read $metadata per request.
  expect(cacheIsFresh(new Date())).toBe(true);
});
