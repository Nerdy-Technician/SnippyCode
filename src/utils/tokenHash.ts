import { createHash, randomBytes, scrypt, timingSafeEqual } from 'crypto';

/**
 * Hashes for API keys and tokens (raw API key, snippet raw tokens, device and
 * enrolment tokens). No module imports here, so migrations can use it.
 *
 * Stored formats:
 * - scrypt$<N>:<r>:<p>$<salt>$<hash>         scrypt(token), for new tokens
 * - scrypt-sha256$<N>:<r>:<p>$<salt>$<hash>  scrypt(sha256(token)), written by
 *   migration 16 around the SHA-256 hashes stored before v1.2.2. When one of
 *   these verifies, callers replace it with a plain scrypt hash, so the
 *   SHA-256 step disappears as tokens are used.
 */

const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;
const MAX_MEM = 64 * 1024 * 1024;
const MODERN = 'scrypt';
const LEGACY = 'scrypt-sha256';

const scryptAsync = (input: string, salt: Buffer, params: { N: number; r: number; p: number }) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(input, salt, KEY_LENGTH, { ...params, maxmem: MAX_MEM }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });

const encode = async (scheme: string, input: string): Promise<string> => {
  const salt = randomBytes(16);
  const key = await scryptAsync(input, salt, PARAMS);
  return `${scheme}$${PARAMS.N}:${PARAMS.r}:${PARAMS.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
};

const schemeOf = (stored?: string | null): string | null => {
  const scheme = String(stored || '').split('$')[0];
  return scheme === MODERN || scheme === LEGACY ? scheme : null;
};

export const isScryptHash = (stored?: string | null): boolean => schemeOf(stored) !== null;
export const isLegacyWrappedHash = (stored?: string | null): boolean => schemeOf(stored) === LEGACY;

export const hashToken = (token: string): Promise<string> => encode(MODERN, token);

/** Migration 16: wrap a pre-v1.2.2 SHA-256 hex hash without knowing the token. */
export const wrapLegacyHash = (sha256Hex: string): Promise<string> => encode(LEGACY, sha256Hex);

// Recently verified tokens, so agents polling every few seconds do not pay
// for scrypt on each request. Keyed by the stored hash, so a rotated or
// revoked hash never matches. Holds the token only in this process's memory.
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 5000;
const verified = new Map<string, { token: Buffer; expires: number }>();

export const clearTokenHashCache = (): void => verified.clear();

const cachedMatch = (token: string, stored: string): boolean => {
  const entry = verified.get(stored);

  if (!entry || entry.expires < Date.now()) {
    return false;
  }

  const given = Buffer.from(token);
  return given.length === entry.token.length && timingSafeEqual(given, entry.token);
};

export interface TokenCheck {
  ok: boolean;
  /** A plain scrypt hash to store instead, when a legacy-wrapped hash matched. */
  upgrade?: string;
}

export const checkToken = async (token: string, stored?: string | null): Promise<TokenCheck> => {
  const scheme = schemeOf(stored);

  if (!token || !stored || !scheme) {
    return { ok: false };
  }

  if (scheme === MODERN && cachedMatch(token, stored)) {
    return { ok: true };
  }

  const [, params, salt, hash] = stored.split('$');
  const [N, r, p] = String(params || '').split(':').map(Number);

  if (!N || !r || !p || !salt || !hash) {
    return { ok: false };
  }

  const input =
    scheme === LEGACY ? createHash('sha256').update(token).digest('hex') : token;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scryptAsync(input, Buffer.from(salt, 'base64url'), { N, r, p });

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false };
  }

  if (scheme === LEGACY) {
    return { ok: true, upgrade: await hashToken(token) };
  }

  if (verified.size >= CACHE_MAX) {
    verified.delete(verified.keys().next().value as string);
  }
  verified.set(stored, { token: Buffer.from(token), expires: Date.now() + CACHE_TTL_MS });

  return { ok: true };
};

export const verifyToken = async (token: string, stored?: string | null): Promise<boolean> =>
  (await checkToken(token, stored)).ok;
