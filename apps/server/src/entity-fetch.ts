import type { EnabledEntity, EntityProfile, ObjectVariantDef } from "@hera/db";

export type ObjectFetchRequest = {
  entity: string;
  key: string;
  keyQuoted: boolean;
  select: string[];
  collections: Array<{
    name: string;
    select: string[];
    parentKey: string;
    childParentKey: string;
    rowKey: string;
  }>;
  fullRecordFallback: boolean;
};

function unique(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** Compile a trusted object variant into a minimal SL projection (no browser-supplied paths). */
export function compileObjectFetch(
  schema: EnabledEntity,
  profile: EntityProfile | null,
  definition: ObjectVariantDef,
): Omit<ObjectFetchRequest, "entity" | "key" | "keyQuoted"> {
  if (schema.keys.length !== 1) {
    throw new Error(`Composite keys are not supported for '${schema.name}'`);
  }

  const propByName = new Map(schema.properties.map((p) => [p.name, p]));
  const colByName = new Map(schema.collections.map((c) => [c.name, c]));

  const assertHeaderField = (name: string) => {
    if (!propByName.has(name)) throw new Error(`Unknown field '${name}'`);
  };

  const headerSelect: string[] = [];
  for (const f of definition.header) {
    if (!f.visible) continue;
    assertHeaderField(f.name);
    headerSelect.push(f.name);
  }

  const collectionSpecs: ObjectFetchRequest["collections"] = [];
  let needsFallback = false;

  for (const section of definition.sections) {
    if (!section.visible) continue;

    if (section.id === "general") {
      for (const f of section.fields) {
        if (!f.visible) continue;
        assertHeaderField(f.name);
        headerSelect.push(f.name);
      }
      continue;
    }

    const colSchema = colByName.get(section.id);
    if (!colSchema) {
      // Non-collection section id with fields → treat as header-ish scalars if they exist.
      for (const f of section.fields) {
        if (!f.visible) continue;
        assertHeaderField(f.name);
        headerSelect.push(f.name);
      }
      continue;
    }

    const colProp = new Map(colSchema.properties.map((p) => [p.name, p]));
    const visible: string[] = [];
    for (const f of section.fields) {
      if (!f.visible) continue;
      if (!colProp.has(f.name)) throw new Error(`Unknown field '${f.name}'`);
      visible.push(f.name);
    }

    const colProfile = profile?.collections[section.id];
    if (!colProfile) {
      // Display-only / unprofiled: keep field list for post-GET projection; no $crossjoin.
      needsFallback = true;
      collectionSpecs.push({
        name: section.id,
        select: unique(visible),
        parentKey: schema.keys[0]!,
        childParentKey: schema.keys[0]!,
        rowKey: visible[0] ?? schema.keys[0]!,
      });
      continue;
    }

    collectionSpecs.push({
      name: section.id,
      select: unique([colProfile.childParentKey, colProfile.rowKey, ...visible]),
      parentKey: colProfile.parentKey,
      childParentKey: colProfile.childParentKey,
      rowKey: colProfile.rowKey,
    });
  }

  // Hidden fetch deps: keys, title/subtitle, editWhen locks — never imply render.
  const deps: string[] = [...schema.keys];
  if (profile?.titleField) deps.push(profile.titleField);
  for (const f of profile?.subtitleFields ?? []) deps.push(f);
  for (const rule of profile?.fields.editWhen ?? []) deps.push(rule.field);

  return {
    select: unique([...deps, ...headerSelect]),
    collections: collectionSpecs,
    fullRecordFallback: needsFallback,
  };
}
