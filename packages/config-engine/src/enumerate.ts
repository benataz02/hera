import type { Entries, ModelDef, ResolvedLookups } from "./model";
import { type DomainOption, propagate } from "./propagate";

export type Enumeration = {
  candidates: Entries[];
  capped: boolean;
  widest?: { key: string; size: number };
};

const live = (d: DomainOption[]) => d.filter((o) => !o.eliminatedBy);

export function enumerate(model: ModelDef, lookups: ResolvedLookups, entries: Entries, cap = 200): Enumeration {
  const candidates: Entries[] = [];
  let capped = false;

  const first = propagate(model, lookups, entries);
  let widest: Enumeration["widest"];
  for (const k of first.open) {
    const size = live(first.domains[k]!).length;
    if (!widest || size > widest.size) widest = { key: k, size };
  }

  const dfs = (cur: Entries): void => {
    if (capped) return;
    const p = propagate(model, lookups, cur);
    if (p.conflicts.length) return;
    if (p.open.length === 0) {
      if (candidates.length >= cap) {
        capped = true;
        return;
      }
      candidates.push(cur);
      return;
    }
    // smallest live domain first: fail fast, shallow tree
    const key = [...p.open].sort((a, b) => live(p.domains[a]!).length - live(p.domains[b]!).length)[0]!;
    for (const o of live(p.domains[key]!)) {
      if (capped) return;
      dfs({ ...cur, [key]: o.value });
    }
  };
  dfs(entries);
  return { candidates, capped, widest: capped ? widest : undefined };
}
