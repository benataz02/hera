import { nextLinkOf, rowsOf, type B1Transport, type QueryOptions } from "./types.ts";

/** Follow @odata.nextLink up to `maxPages`. There is no `readAll`: `maxPages` has no default,
 *  so every caller that exhausts an entity set states its own bound at the call site instead of
 *  hiding an unbounded fetch behind an innocent-looking line. */
export async function readPages(
  t: B1Transport,
  entitySet: string,
  q: QueryOptions | undefined,
  opts: { maxPages: number },
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  let res = await t.readEntitySet(entitySet, q);
  const rows = rowsOf(res.data);
  let next = nextLinkOf(res.data);
  for (let page = 1; next && page < opts.maxPages; page++) {
    res = await t.readNext(next, q?.maxPageSize ?? q?.top);
    rows.push(...rowsOf(res.data));
    next = nextLinkOf(res.data);
  }
  return { rows, truncated: !!next };
}
