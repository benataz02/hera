import { ORPCError } from "@orpc/server";

// Assistant usage policy: three env-configured knobs, no unbounded default — any one of them
// unset disables the assistant entirely (an operator must opt in). ponytail: in-memory,
// single Bun process; Redis if the server ever scales out.
//
// `AssistantDeps.policy` (packages/assistant/src/loop.ts) exposes exactly two hooks —
// `checkTurnStart` (called once, before any provider call) and `chargeTokens` (called after
// every usage chunk) — with no "turn ended" hook. The concurrent-call semaphore is therefore
// approximated as "concurrently active turns", each auto-released after a fixed TTL modeled on
// loop.ts's own 120s `TURN_WATCHDOG_MS` plus slack for the wrap-up call, rather than an exact
// acquire/release pair: a turn that finishes earlier still holds its slot until the TTL elapses.
// Good enough for a coarse fail-fast guard against a pile-up of concurrent provider calls in one
// process; not a precise limiter.
const TURN_SLOT_TTL_MS = 130_000;
const HOUR_MS = 60 * 60 * 1000;

function positiveNumberEnv(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export type Policy = {
  checkTurnStart(tenantId: string, userId: string): void;
  chargeTokens(tenantId: string, n: number): void;
};

export function makePolicy(env: Record<string, string | undefined> = process.env): Policy {
  const turnsPerUserPerHour = positiveNumberEnv(env.ASSIST_TURNS_PER_USER_PER_HOUR);
  const tenantTokensPerDay = positiveNumberEnv(env.ASSIST_TENANT_TOKENS_PER_DAY);
  const maxConcurrentProviderCalls = positiveNumberEnv(env.ASSIST_MAX_CONCURRENT_PROVIDER_CALLS);
  const enabled = turnsPerUserPerHour !== undefined && tenantTokensPerDay !== undefined && maxConcurrentProviderCalls !== undefined;

  const turnTimestampsByUser = new Map<string, number[]>();
  const tokensByTenantDay = new Map<string, number>(); // key: `${tenantId}:${YYYY-MM-DD}` (UTC)
  let activeSlots = 0;

  const dayKey = (tenantId: string) => `${tenantId}:${new Date().toISOString().slice(0, 10)}`;

  return {
    checkTurnStart(tenantId, userId) {
      if (!enabled) throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Assistant usage policy is not configured" });

      const now = Date.now();
      const recent = (turnTimestampsByUser.get(userId) ?? []).filter((t) => now - t < HOUR_MS);
      if (recent.length >= turnsPerUserPerHour!)
        throw new ORPCError("TOO_MANY_REQUESTS", { message: "Too many assistant turns this hour; try again later" });

      if (activeSlots >= maxConcurrentProviderCalls!)
        throw new ORPCError("TOO_MANY_REQUESTS", { message: "The assistant is busy; try again shortly" });

      const key = dayKey(tenantId);
      if ((tokensByTenantDay.get(key) ?? 0) >= tenantTokensPerDay!)
        throw new ORPCError("FORBIDDEN", { message: "BUDGET_EXCEEDED" });

      recent.push(now);
      turnTimestampsByUser.set(userId, recent);
      activeSlots += 1;
      const release = setTimeout(() => { activeSlots = Math.max(0, activeSlots - 1); }, TURN_SLOT_TTL_MS);
      release.unref?.();
    },

    chargeTokens(tenantId, n) {
      if (!enabled) return; // unreachable in practice: checkTurnStart already threw for this turn
      const key = dayKey(tenantId);
      const total = (tokensByTenantDay.get(key) ?? 0) + n;
      tokensByTenantDay.set(key, total);
      if (total > tenantTokensPerDay!) throw new ORPCError("FORBIDDEN", { message: "BUDGET_EXCEEDED" });
    },
  };
}
