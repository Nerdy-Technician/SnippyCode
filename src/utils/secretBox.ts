import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const PREFIX = 'enc:v1:';
// v2 values are bound to where they are stored (AAD), e.g. schedules:12:variables:NAME
const PREFIX_V2 = 'enc:v2:';
export const SECRET_MASK = '••••••';

// Production never falls back to SESSION_SECRET (rotating the session secret
// must not make stored secrets unreadable, and one leak must not expose both)
const KEY_REQUIRED =
  'VARIABLES_SECRET_KEY must be set when NODE_ENV=production. Upgrading from a ' +
  'setup that relied on SESSION_SECRET? Set VARIABLES_SECRET_KEY to the same ' +
  'value as SESSION_SECRET so existing secrets stay readable (see docs/upgrading-v1.2.3.md).';

/**
 * AES-256-GCM key for secret variables. Prefer a dedicated VARIABLES_SECRET_KEY:
 * falling back to SESSION_SECRET means rotating that also makes stored
 * secrets unreadable.
 */
const secretKey = (): Buffer => {
  const material =
    process.env.VARIABLES_SECRET_KEY || process.env.SESSION_SECRET || '';

  if (process.env.NODE_ENV === 'production' && !process.env.VARIABLES_SECRET_KEY) {
    throw new Error(KEY_REQUIRED);
  }
  // The dev-only key is never used in production (checked above and at startup)

  return createHash('sha256')
    .update(`snippycode-variables:${material || 'dev-only-change-me'}`)
    .digest();
};

export const isEncryptedSecret = (value: string): boolean =>
  typeof value === 'string' && (value.startsWith(PREFIX) || value.startsWith(PREFIX_V2));

/** v2: encrypted with AAD (bound to its row and field) */
export const isBoundSecret = (value: string): boolean => typeof value === 'string' && value.startsWith(PREFIX_V2);

/**
 * Called at startup: in production a real key must be configured, so the
 * dev-only fallback can never encrypt production data.
 */
export const assertSecretKeyConfigured = (): void => {
  if (process.env.NODE_ENV === 'production' && !process.env.VARIABLES_SECRET_KEY) {
    throw new Error(KEY_REQUIRED);
  }
};

export const encryptSecret = (plain: string, aad?: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);

  return `${aad ? PREFIX_V2 : PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
};

/**
 * Throws when the value was tampered with or the key changed.
 */
export const decryptSecret = (stored: string, aad?: string): string => {
  if (!isEncryptedSecret(stored)) {
    return stored;
  }

  const bound = stored.startsWith(PREFIX_V2);
  if (bound && !aad) {
    throw new Error('This secret is bound to its location; decrypt it with its AAD');
  }
  const raw = Buffer.from(stored.slice(bound ? PREFIX_V2.length : PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), raw.subarray(0, 12));
  // A v2 value moved to another row or field fails authentication here
  if (bound) decipher.setAAD(Buffer.from(aad as string, 'utf8'));
  decipher.setAuthTag(raw.subarray(12, 28));

  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
};

/**
 * Hide secret values in text such as saved run output. Very short values
 * are skipped because masking them would mangle unrelated output.
 */
export const maskSecrets = (text: string, secrets: string[]): string =>
  secrets
    .filter(secret => secret && secret.length >= 4)
    .sort((a, b) => b.length - a.length)
    .reduce((masked, secret) => masked.split(secret).join(SECRET_MASK), text || '');
