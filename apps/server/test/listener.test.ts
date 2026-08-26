import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "@hera/db";
import { waitForNotify } from "@hera/db/listener";

// The shared LISTEN client must never have two queries in flight: pg@9 turns that into an error.
test("concurrent waitForNotify serializes LISTEN on the shared client", async () => {
  const warnings: string[] = [];
  const onWarn = (w: Error) => warnings.push(w.message);
  process.on("warning", onWarn);

  const tag = crypto.randomUUID().slice(0, 8);
  const channels = Array.from({ length: 5 }, (_, i) => `test_notify_${i}_${tag}`);
  const waits = channels.map((c) => waitForNotify(c, 5000));
  await Bun.sleep(300); // every LISTEN lands before the NOTIFYs
  for (const c of channels) await db.execute(sql.raw(`NOTIFY "${c}"`));

  expect(await Promise.all(waits)).toEqual(channels.map(() => true));
  await Bun.sleep(50);
  process.off("warning", onWarn);
  expect(warnings.filter((m) => m.includes("already executing a query"))).toEqual([]);
});
