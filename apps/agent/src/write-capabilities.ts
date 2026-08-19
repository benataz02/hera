import type { EntitySchema } from "./service-layer-client.ts";

export type WriteCapability = { entity: string; dedupField: string };

/** Parse `Entity:Udf,Entity2:Udf2` from B1_CREATE_CAPABILITIES. Drops malformed pairs. */
export function parseWriteCapabilities(value: string | undefined): WriteCapability[] {
  if (!value?.trim()) return [];
  const out: WriteCapability[] = [];
  for (const part of value.split(",")) {
    const raw = part.trim();
    if (!raw) continue;
    const i = raw.indexOf(":");
    if (i <= 0 || i === raw.length - 1) continue;
    const entity = raw.slice(0, i).trim();
    const dedupField = raw.slice(i + 1).trim();
    if (!entity || !dedupField) continue;
    out.push({ entity, dedupField });
  }
  return out;
}

/** Keep pairs whose entity+UDF exist in EDMX; first entity wins on duplicates. */
export function validateWriteCapabilities(
  configured: WriteCapability[],
  schemas: EntitySchema[],
): { valid: WriteCapability[]; errors: string[] } {
  const byName = new Map(schemas.map((s) => [s.name, s]));
  const seen = new Set<string>();
  const valid: WriteCapability[] = [];
  const errors: string[] = [];

  for (const cap of configured) {
    if (seen.has(cap.entity)) {
      errors.push(`Duplicate create capability for entity '${cap.entity}'`);
      continue;
    }
    seen.add(cap.entity);
    const schema = byName.get(cap.entity);
    if (!schema) {
      errors.push(`Create capability entity '${cap.entity}' not found in Service Layer metadata`);
      continue;
    }
    if (!schema.properties.some((p) => p.name === cap.dedupField)) {
      errors.push(
        `Create capability UDF '${cap.dedupField}' not found on entity '${cap.entity}'`,
      );
      continue;
    }
    valid.push(cap);
  }
  return { valid, errors };
}
