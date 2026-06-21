import { Client } from "pg";

// One dedicated direct connection running LISTEN, fanned out in-process.
// NEVER one LISTEN connection per parked request. PgBouncer transaction mode breaks
// LISTEN — this connection must be direct/session-mode.
// ponytail: single global listener; if you ever shard the server across processes,
//           each process keeps its own listener and they all see every NOTIFY.

type Resolver = () => void;
const subs = new Map<string, Set<Resolver>>();
let client: Client | null = null;
let connecting: Promise<void> | null = null;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function ensureClient(): Promise<Client> {
  if (client) return client;
  if (!connecting) {
    connecting = (async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      c.on("notification", (msg) => {
        const set = subs.get(msg.channel);
        if (set) for (const r of [...set]) r();
      });
      c.on("error", () => {
        // Drop the connection; re-LISTEN on every channel on next ensure.
        client = null;
        connecting = null;
      });
      client = c;
      // Re-arm LISTEN for any channels that already have subscribers (post-reconnect).
      for (const ch of subs.keys()) await c.query(`LISTEN ${quoteIdent(ch)}`);
    })();
  }
  await connecting;
  return client!;
}

/**
 * Resolve true if a NOTIFY arrives on `channel` within `timeoutMs`, else false.
 * The doorbell carries no payload — caller does its own scoped SELECT after waking.
 */
export async function waitForNotify(channel: string, timeoutMs: number): Promise<boolean> {
  const c = await ensureClient();
  if (!subs.has(channel)) {
    subs.set(channel, new Set());
    await c.query(`LISTEN ${quoteIdent(channel)}`);
  }
  const set = subs.get(channel)!;
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      set.delete(r);
      clearTimeout(timer);
      resolve(v);
    };
    const r: Resolver = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    set.add(r);
  });
}

export const outboxChannel = (tenantId: string) => `outbox_t${tenantId}`;
export const quoteChannel = (quoteId: string) => `quote_${quoteId}`;
// Per-request reply doorbell: the agent fulfills/fails a request -> wake the waiting browser handler.
export const requestChannel = (requestId: string) => `req_${requestId}`;
