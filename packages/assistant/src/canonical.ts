/** Sorted-key JSON stringify, so semantically-identical objects with different key order hash
 *  identically. Used for `operationKey` (loop.ts, the real idempotency key) and the stored
 *  `inputHash` audit column (turns.ts). */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** Serialized byte size — the cap unit for tool results fed back into model context. */
export const byteSize = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

export const MAX_TOOL_RESULT_BYTES = 32 * 1024;
