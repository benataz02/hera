import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { ORPCError } from "@orpc/server";
import { B1Error } from "@hera/b1";
import { toOrpcError } from "../src/b1.ts";

describe("toOrpcError", () => {
  test("an agent-secret 401 is not reported as SAP rejecting the request", () => {
    const e = toOrpcError(new B1Error(401, null, "Bad agent secret"));
    expect(e).toBeInstanceOf(ORPCError);
    expect((e as ORPCError).code).toBe("BAD_GATEWAY");
    expect((e as ORPCError).message).not.toMatch(/SAP rejected/i);
    expect((e as ORPCError).message).toMatch(/agent/i);
  });

  test("a real SAP 401 still says SAP rejected the request", () => {
    const e = toOrpcError(new B1Error(401, 100000004, "B1 401 (100000004): Invalid credentials"));
    expect((e as ORPCError).message).toMatch(/^SAP rejected the request:/);
  });
});

test("seed:agent default secret matches agent.example.json", () => {
  const example = JSON.parse(readFileSync("apps/agent/agent.example.json", "utf8")) as { secret: string };
  const src = readFileSync("scripts/seed-agent.ts", "utf8");
  expect(src).not.toContain("dev-agent-secret");
  expect(src).toContain(example.secret);
});
