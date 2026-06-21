import { waitForNotify, outboxChannel } from "@hera/db/listener";
import { pool } from "@hera/db";

const ch = outboxChannel("vkaCtlyZJsharGkr8BrfRKIy99CFnNBn");
console.log("channel:", ch, "len", ch.length);
const p = waitForNotify(ch, 5000);
await new Promise((r) => setTimeout(r, 300));
await pool.query(`select pg_notify($1, '')`, [ch]);
const woke = await p;
console.log("woke by notify:", woke);
await pool.end();
process.exit(0);
