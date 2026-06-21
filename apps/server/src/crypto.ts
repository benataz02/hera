import { createHash } from "node:crypto";

// Agent bearer tokens are high-entropy random strings, so a plain SHA-256 is enough
// (no slow KDF needed for non-guessable secrets). Store the hash, compare the hash.
// ponytail: sha256 over the raw token; switch to HMAC with a server pepper if tokens
//           ever become low-entropy.
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
