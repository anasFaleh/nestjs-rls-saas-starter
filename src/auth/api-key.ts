import { createHash, randomBytes } from 'node:crypto';

/**
 * API key format: `sk_` + 43 base64url characters (32 random bytes = 256 bits).
 * Only SHA-256(key) is stored. A slow hash (bcrypt/argon2) is not needed: the key is random, not a password,
 * so it cannot be guessed from a dictionary, and a fast hash keeps the per-request lookup cheap.
 */
export const API_KEY_RE = /^sk_[A-Za-z0-9_-]{43}$/;
/** Shown in lists to recognise a key; reveals 5 of 256 random bits. */
export const API_KEY_PREFIX_LENGTH = 8;

export interface NewApiKey {
  /** The full key. Show it to the user ONCE; it is never stored. */
  key: string;
  prefix: string;
  hash: Uint8Array<ArrayBuffer>;
}

/** SHA-256 of the key (32 bytes). A plain Uint8Array: what Prisma expects for a `Bytes` column. */
export function hashApiKey(key: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(key, 'utf8').digest());
}

export function generateApiKey(): NewApiKey {
  const key = `sk_${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, API_KEY_PREFIX_LENGTH), hash: hashApiKey(key) };
}

/** Reads `Authorization: Bearer sk_...`. Returns null when missing or malformed (format check before any DB work). */
export function extractApiKey(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer[ ]+(\S+)$/i.exec(authorization.trim());
  const key = match?.[1];
  return key && API_KEY_RE.test(key) ? key : null;
}
