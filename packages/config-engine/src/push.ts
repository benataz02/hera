// Build a B1 document (header + lines collection) from produced BOM/routing lines, ready to POST
// through the existing entities.create path. Generic over line shape — works for BOM ({item,qty})
// and routing ({operation,time}) alike, since `map` just renames whatever fields the line has.
import type { PushTarget } from "./types.ts";

export function buildPushDoc(target: PushTarget, lines: Record<string, unknown>[], key: string): Record<string, unknown> {
  const linesField = target.linesField ?? "Lines";
  const mapped = lines.map((l) => {
    const row: Record<string, unknown> = {};
    for (const [from, to] of Object.entries(target.map)) row[to] = l[from];
    return row;
  });
  return {
    ...(target.header ?? {}),
    ...(target.keyField ? { [target.keyField]: key } : {}),
    [linesField]: mapped,
  };
}
