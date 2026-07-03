import { expect, test } from "bun:test";
import { processRequest, type RequestCloudPort, type SlReadPort } from "../src/sync.ts";

function fakes() {
  const fulfilled: unknown[] = [];
  const failed: { id: string; error: string }[] = [];
  const slPaths: string[] = [];
  const beasPaths: string[] = [];
  const sl = { queryRaw: async (p: string) => (slPaths.push(p), { value: ["b1"] }) } as unknown as SlReadPort;
  const cloud: RequestCloudPort = {
    fulfill: async (i) => void fulfilled.push(i),
    fail: async (i) => void failed.push(i),
  };
  const beas = { get: async (p: string) => (beasPaths.push(p), { value: ["beas"] }) };
  return { fulfilled, failed, slPaths, beasPaths, sl, cloud, beas };
}

test("query with target b1 (and with no target) goes to the Service Layer", async () => {
  const f = fakes();
  await processRequest({ id: "1", kind: "query", payload: { target: "b1", path: "/Items" } }, f.sl, f.cloud, f.beas);
  await processRequest({ id: "2", kind: "query", payload: { path: "/Orders" } }, f.sl, f.cloud, f.beas);
  expect(f.slPaths).toEqual(["/Items", "/Orders"]);
  expect(f.beasPaths).toEqual([]);
  expect(f.fulfilled).toHaveLength(2);
});

test("query with target beas goes to the Beas client", async () => {
  const f = fakes();
  await processRequest({ id: "3", kind: "query", payload: { target: "beas", path: "/api/x" } }, f.sl, f.cloud, f.beas);
  expect(f.beasPaths).toEqual(["/api/x"]);
  expect(f.slPaths).toEqual([]);
  expect(f.fulfilled).toHaveLength(1);
});

test("beas target without a configured client fails with the env hint", async () => {
  const f = fakes();
  await processRequest({ id: "4", kind: "query", payload: { target: "beas", path: "/api/x" } }, f.sl, f.cloud);
  expect(f.failed).toHaveLength(1);
  expect(f.failed[0]!.error).toContain("BEAS_BASE_URL");
});
