import type { DomainOption, ModelDef, ResolvedLookups, Val } from "@hera/config-engine";

// Pure helpers for ConfiguratorForm, kept UI-free so they're unit-testable without the UI5 runtime.

/** Domains the client can resolve without the server: manual options live inline in the model.
 *  Lets the form render (and non-server fields stay usable) while the single lookups fetch is in flight. */
export function clientBaseLookups(model: ModelDef): ResolvedLookups {
  const domains: ResolvedLookups["domains"] = {};
  for (const p of model.parameters) {
    const ref = p.domain?.kind === "options" ? p.domain.ref : undefined;
    if (ref?.source === "manual")
      domains[p.key] = ref.options.map((o) => ({ value: o.value, label: o.label ?? String(o.value) }));
  }
  return { domains, tables: {} };
}

export type EntryResolution = { kind: "clear" } | { kind: "set"; value: Val } | { kind: "reject" };

/** Map free text typed into a value-help input to a domain option. "reject" = not in the list. */
export function resolveEntry(dom: DomainOption[], raw: string): EntryResolution {
  if (raw.trim() === "") return { kind: "clear" };
  const l = raw.trim().toLowerCase();
  const hit =
    dom.find((o) => o.label.toLowerCase() === l) ??
    dom.find((o) => String(o.value ?? "").toLowerCase() === l);
  return hit ? { kind: "set", value: hit.value } : { kind: "reject" };
}
