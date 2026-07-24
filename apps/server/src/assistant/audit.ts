// Redacted structured audit log for Chati (turn start/end, tool completion). One JSON object per
// line to stdout — deliberately not a DB table or external sink for this milestone; ids, error
// codes, timings and usage are the intended payload, never raw content.

const REDACT_KEYS = new Set(["dataBase64", "apiKey", "authorization", "prompt", "messages"]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.has(k)) continue;
      out[k] = redact(v);
    }
    return out;
  }
  return value;
}

export function auditLine(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(redact(fields)));
}
