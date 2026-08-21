// UI5's Table gives every column an equal track — it builds `minmax(minWidth ?? 3rem, 1fr)` per
// column (Table.js `_gridTemplateColumns`) — so a 20-character value truncates next to a 1-character
// one. Size the floor from the widest cell instead; the grid still shares the leftover slack, and
// the table scrolls once the floors stop fitting.
//
// `width` can't express this: TableUtils `isValidColumnWidth` probes `max(3rem, <value>)` against a
// throwaway element, which rejects `max-content`, `minmax()` and `fit-content()` — they fall back to
// `1fr` silently. Setting an explicit width on *every* column also flips `_hasFlexibleColumns` off,
// which appends a dummy `1fr` track to soak up the slack.

// ponytail: samples the first 200 rows — scanning all of them would re-measure the whole table on
// every keystroke. Widen the sample if a late row turns out to be the widest.
const SAMPLE = 200;
// 0.62rem ≈ the average advance of "72"/Arial at 14px (the Horizon body face). This is an estimate,
// not a measurement: a column of all-caps Ws still clips a little. Canvas measureText would be
// exact and isn't worth the wiring here.
const REM_PER_CHAR = 0.62;
// Covers the Input's own padding and border plus the table cell's horizontal padding.
const CHROME_REM = 2.5;
const MIN_REM = 6;
const MAX_REM = 24;

/**
 * Minimum width for a lookup-table column, from the widest of its header and its sampled cells.
 * Pass the result to `TableHeaderCell.minWidth`.
 */
export const colMinWidth = (header: string, rows: readonly unknown[][], i: number): string => {
  const chars = Math.max(
    header.length,
    ...rows.slice(0, SAMPLE).map((r) => String(r[i] ?? "").length),
  );
  // Clamped so one pathologically long cell can't push every other column off screen.
  const rem = Math.min(Math.max(chars * REM_PER_CHAR + CHROME_REM, MIN_REM), MAX_REM);
  return `${rem}rem`;
};
