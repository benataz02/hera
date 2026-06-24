// The "optimum sheet format / min material waste" calc from the aluminium example.
// Standalone and scalar so it's trivially testable and usable from formula expressions.

export interface Pack {
  w: number;
  h: number;
  perSheet: number;
  wastePct: number;
}

// How many (pieceW x pieceH) pieces fit on a (sheetW x sheetH) sheet, allowing 90° rotation.
export function fit(pieceW: number, pieceH: number, sheetW: number, sheetH: number): number {
  if (pieceW <= 0 || pieceH <= 0 || sheetW <= 0 || sheetH <= 0) return 0;
  const straight = Math.floor(sheetW / pieceW) * Math.floor(sheetH / pieceH);
  const rotated = Math.floor(sheetW / pieceH) * Math.floor(sheetH / pieceW);
  return Math.max(straight, rotated);
}

// Pick the candidate sheet format with least material waste. If the piece fits none of them,
// fall back to a bespoke 1-up sheet the size of the piece (zero waste, custom format).
// ponytail: rectangular shelf heuristic only (no kerf, no irregular shapes); swap in a real 2D
//           nesting library if waste accuracy on odd shapes ever matters.
export function packRect(pieceW: number, pieceH: number, formats: [number, number][]): Pack {
  let best: Pack | null = null;
  for (const [w, h] of formats) {
    const perSheet = fit(pieceW, pieceH, w, h);
    if (perSheet <= 0) continue;
    const wastePct = 1 - (perSheet * pieceW * pieceH) / (w * h);
    if (!best || wastePct < best.wastePct) best = { w, h, perSheet, wastePct };
  }
  return best ?? { w: pieceW, h: pieceH, perSheet: 1, wastePct: 0 };
}
