import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

// Symmetric encryption for credentials the server must be able to *use*, not just compare:
// today only sap_connection.secret. AES-256-GCM, key derived from HERA_SECRET_KEY (any length —
// it is hashed to 32 bytes). Format: iv.tag.ciphertext, base64url, so it round-trips in a text
// column and a re-encrypt is visible as a changed prefix.
// ponytail: one process-wide key, no rotation. Rotation earns its place when there is a second
// tenant-visible secret to rotate; today re-running the seed replaces the row.
const key = () => {
  // `||`, not `??`: an env var declared-but-empty is unset, not a zero-length key.
  const raw = process.env.HERA_SECRET_KEY || process.env.BETTER_AUTH_SECRET;
  if (!raw) throw new Error("HERA_SECRET_KEY (or BETTER_AUTH_SECRET) is required to store SAP credentials");
  return createHash("sha256").update(raw).digest();
};

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(stored: string): string {
  const [iv, tag, body] = stored.split(".");
  if (!iv || !tag || !body) throw new Error("Stored secret is not in iv.tag.ciphertext form");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
}
