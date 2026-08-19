import { ORPCError } from "@orpc/server";
import type { ExtractFile } from "@hera/assistant";

// Attachment validation for Chati's `extractFromDrawing` path. Runs BEFORE the turn is claimed
// (loop.ts STEP 1) — every check here is a typed ORPCError, never a silent pass-through.
// `file.name` is display-only: shown in the transcript and audit lines, never used to build a
// path or command, so it is intentionally not sanitized here.

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PIXELS = 25_000_000; // 25 megapixels
const MAX_PDF_PAGES = 20;

function bad(message: string): never {
  throw new ORPCError("BAD_REQUEST", { message });
}

function checkMagicBytes(mimeType: ExtractFile["mimeType"], buf: Buffer): void {
  const ok =
    mimeType === "application/pdf" ? buf.subarray(0, 5).toString("latin1") === "%PDF-"
    : mimeType === "image/png" ? buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    : buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8; // image/jpeg
  if (!ok) bad("The file content does not match its declared type.");
}

/** Cheap page count: counts `/Type /Page` object dictionaries, excluding the `/Type /Pages` tree
 *  root (the trailing `[^s]` after "Page" rejects the "Pages" match). ponytail: regex page
 *  count; a real PDF parser if a malformed/unusual PDF ever miscounts in practice. */
function checkPdfPageCount(buf: Buffer): void {
  const text = buf.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page[^s]/g) ?? [];
  if (matches.length > MAX_PDF_PAGES) bad(`The PDF has too many pages (max ${MAX_PDF_PAGES}).`);
}

function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null; // 8-byte signature + 4-byte length + "IHDR" + 8 bytes of data
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Scans JPEG markers for the first frame-header (SOFn) marker and reads its width/height.
 *  ponytail: covers baseline/progressive/lossless SOFn markers (0xC0-0xC3/C5-C7/C9-CB/CD-CF);
 *  an exotic/malformed JPEG that never hits one of those just skips the pixel-count check
 *  rather than being rejected on a parsing edge case. */
function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  let i = 2; // skip the SOI marker (FF D8) already confirmed by checkMagicBytes
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; } // standalone, no length
    const isSOF =
      (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    const len = buf.readUInt16BE(i + 2);
    if (isSOF && i + 9 <= buf.length) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (marker === 0xda) return null; // start of scan: no frame header seen before the entropy-coded data
    i += 2 + len;
  }
  return null;
}

export function validateFile(file: ExtractFile): void {
  const decoded = Buffer.from(file.dataBase64, "base64");
  if (decoded.toString("base64") !== file.dataBase64) bad("The file could not be decoded (invalid encoding).");
  if (decoded.length > MAX_BYTES) bad("The file exceeds the 15MB limit.");

  checkMagicBytes(file.mimeType, decoded);

  if (file.mimeType === "application/pdf") {
    checkPdfPageCount(decoded);
    return;
  }
  const dims = file.mimeType === "image/png" ? pngDimensions(decoded) : jpegDimensions(decoded);
  if (dims && dims.width * dims.height > MAX_PIXELS) bad("The image exceeds the maximum resolution (25 megapixels).");
}
