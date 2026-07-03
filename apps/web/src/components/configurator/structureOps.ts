import type { ModelDef } from "@hera/config-engine";

// Pure structure-tree edits for the Parameters tab. All functions return new ModelDefs.

export type RowRef =
  | { kind: "section"; s: number }
  | { kind: "group"; s: number; g: number }
  | { kind: "param"; key: string };

export const rowKeyOf = (r: RowRef): string =>
  r.kind === "section" ? `s:${r.s}` : r.kind === "group" ? `g:${r.s}.${r.g}` : `p:${r.key}`;

export function parseRowKey(k: string): RowRef {
  if (k.startsWith("s:")) return { kind: "section", s: Number(k.slice(2)) };
  if (k.startsWith("g:")) {
    const [s, g] = k.slice(2).split(".").map(Number);
    return { kind: "group", s: s!, g: g! };
  }
  return { kind: "param", key: k.slice(2) };
}

export type Placement = "Before" | "After" | "On";

export function canDrop(_def: ModelDef, srcKey: string, dstKey: string, placement: Placement): boolean {
  const src = parseRowKey(srcKey);
  const dst = parseRowKey(dstKey);
  if (srcKey === dstKey) return false;
  if (src.kind === "param") return (dst.kind === "group" && placement === "On") || (dst.kind === "param" && placement !== "On");
  if (src.kind === "group") return (dst.kind === "section" && placement === "On") || (dst.kind === "group" && placement !== "On");
  return dst.kind === "section" && placement !== "On";
}

const stripParam = (def: ModelDef, key: string): ModelDef => ({
  ...def,
  structure: {
    sections: def.structure.sections.map((s) => ({
      ...s,
      groups: s.groups.map((g) => ({ ...g, params: g.params.filter((p) => p !== key) })),
    })),
  },
});

/** section/group indices of the group that contains a param, or null. */
function findParam(def: ModelDef, key: string): { s: number; g: number; i: number } | null {
  for (let s = 0; s < def.structure.sections.length; s++)
    for (let g = 0; g < def.structure.sections[s]!.groups.length; g++) {
      const i = def.structure.sections[s]!.groups[g]!.params.indexOf(key);
      if (i >= 0) return { s, g, i };
    }
  return null;
}

const editGroup = (def: ModelDef, s: number, g: number, fn: (params: string[]) => string[]): ModelDef => ({
  ...def,
  structure: {
    sections: def.structure.sections.map((sec, si) =>
      si !== s ? sec : { ...sec, groups: sec.groups.map((gr, gi) => (gi !== g ? gr : { ...gr, params: fn(gr.params) })) },
    ),
  },
});

export function applyMove(def: ModelDef, srcKey: string, dstKey: string, placement: Placement): ModelDef {
  if (!canDrop(def, srcKey, dstKey, placement)) return def;
  const src = parseRowKey(srcKey);
  const dst = parseRowKey(dstKey);

  if (src.kind === "param") {
    const without = stripParam(def, src.key);
    if (dst.kind === "group") return editGroup(without, dst.s, dst.g, (ps) => [...ps, src.key]);
    const at = findParam(without, (dst as { key: string }).key);
    if (!at) return def;
    return editGroup(without, at.s, at.g, (ps) => {
      const i = ps.indexOf((dst as { key: string }).key) + (placement === "After" ? 1 : 0);
      return [...ps.slice(0, i), src.key, ...ps.slice(i)];
    });
  }

  if (src.kind === "group") {
    const grp = def.structure.sections[src.s]!.groups[src.g]!;
    const sections = def.structure.sections.map((s, si) =>
      si === src.s ? { ...s, groups: s.groups.filter((_, gi) => gi !== src.g) } : s,
    );
    if (dst.kind === "section")
      return { ...def, structure: { sections: sections.map((s, si) => (si === dst.s ? { ...s, groups: [...s.groups, grp] } : s)) } };
    // Before/After another group: recompute dst indices against the filtered array
    const dstGrp = dst as { s: number; g: number };
    const dstGrpKey = def.structure.sections[dstGrp.s]!.groups[dstGrp.g]!.key;
    return {
      ...def,
      structure: {
        sections: sections.map((s) => {
          const gi = s.groups.findIndex((g) => g.key === dstGrpKey);
          if (gi < 0) return s;
          const at = gi + (placement === "After" ? 1 : 0);
          return { ...s, groups: [...s.groups.slice(0, at), grp, ...s.groups.slice(at)] };
        }),
      },
    };
  }

  // section reorder
  const sec = def.structure.sections[src.s]!;
  const rest = def.structure.sections.filter((_, i) => i !== src.s);
  const dstSecKey = def.structure.sections[(dst as { s: number }).s]!.key;
  const at = rest.findIndex((s) => s.key === dstSecKey) + (placement === "After" ? 1 : 0);
  return { ...def, structure: { sections: [...rest.slice(0, at), sec, ...rest.slice(at)] } };
}

export function removeFromStructure(def: ModelDef, ref: RowRef): ModelDef {
  if (ref.kind === "param") return stripParam(def, ref.key);
  if (ref.kind === "group")
    return {
      ...def,
      structure: {
        sections: def.structure.sections.map((s, si) =>
          si === ref.s ? { ...s, groups: s.groups.filter((_, gi) => gi !== ref.g) } : s,
        ),
      },
    };
  return { ...def, structure: { sections: def.structure.sections.filter((_, si) => si !== ref.s) } };
}

export function placeParam(def: ModelDef, key: string, s: number, g: number): ModelDef {
  return editGroup(stripParam(def, key), s, g, (ps) => [...ps, key]);
}

export function unplacedParams(def: ModelDef): string[] {
  const placed = new Set(def.structure.sections.flatMap((s) => s.groups.flatMap((g) => g.params)));
  return def.parameters.map((p) => p.key).filter((k) => !placed.has(k));
}
