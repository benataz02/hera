import type { Entries, ModelDef, Val } from "@hera/config-engine";

// Weighted per-param similarity over cached historic rows. Pure — no DB, no agent — so it has
// a network-free test. Score = Σ(weight × match) / Σ(weight of params the user filled).

export type HistoryDef = NonNullable<ModelDef["history"]>;
export type ParamMatch = {
  param: string; column: string; match: "exact" | "closeness" | "contains";
  weight: number; score: number; value: Val;
};
export type Scored = { row: Record<string, Val>; score: number; matches: ParamMatch[] };

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
const filled = (v: Entries[string] | undefined): v is NonNullable<Entries[string]> =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

export function scoreRows(history: HistoryDef, entries: Entries, rows: Record<string, Val>[], top = 10): Scored[] {
  const active = history.mappings.filter((m) => filled(entries[m.param]));
  if (!active.length || !rows.length) return [];
  const totalWeight = active.reduce((s, m) => s + m.weight, 0);

  // closeness auto-normalization: observed numeric range of the column in the historic data
  const ranges = new Map<string, { min: number; max: number }>();
  for (const m of active) {
    if (m.match !== "closeness") continue;
    let min = Infinity, max = -Infinity;
    for (const r of rows) {
      const n = Number(r[m.column]);
      if (Number.isFinite(n)) { min = Math.min(min, n); max = Math.max(max, n); }
    }
    if (min <= max) ranges.set(m.column, { min, max });
  }

  const one = (m: HistoryDef["mappings"][number], entry: Val, hist: Val): number => {
    if (m.match === "exact") return norm(entry) === norm(hist) ? 1 : 0;
    if (m.match === "contains") return norm(entry) && norm(hist).includes(norm(entry)) ? 1 : 0;
    const a = Number(entry), b = Number(hist), rg = ranges.get(m.column);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !rg) return 0;
    if (rg.max === rg.min) return a === b ? 1 : 0;
    return Math.max(0, Math.min(1, 1 - Math.abs(a - b) / (rg.max - rg.min)));
  };

  const scored = rows.map((row) => {
    const matches = active.map((m) => {
      const e = entries[m.param]!;
      // multicombo entries: best match across the selected values
      const vals: Val[] = Array.isArray(e) ? e : [e];
      const score = Math.max(...vals.map((v) => one(m, v, row[m.column] ?? null)));
      return { param: m.param, column: m.column, match: m.match, weight: m.weight, score, value: row[m.column] ?? null };
    });
    return { row, score: matches.reduce((s, x) => s + x.weight * x.score, 0) / totalWeight, matches };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, top);
}
