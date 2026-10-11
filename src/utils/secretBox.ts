import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const PREFIX = 'enc:v1:';
export const SECRET_MASK = '••••••';

/**
 * AES-256-GCM key for secret variables. Prefer a dedicated VARIABLES_SECRET_KEY:
 * falling back to SESSION_SECRET means rotating that also makes stored
 * secrets unreadable.
 */
const secretKey = (): Buffer => {
  const material =
    process.env.VARIABLES_SECRET_KEY || process.env.SESSION_SECRET || '';

  if (!material && process.env.NODE_ENV === 'production') {
    throw new Error('VARIABLES_SECRET_KEY or SESSION_SECRET is required to store secrets');
  }

  return createHash('sha256')
    .update(`snippycode-variables:${material || 'dev-only-change-me'}`)
    .digest();
};

export const isEncryptedSecret = (value: string): boolean =>
  typeof value === 'string' && value.startsWith(PREFIX);

export const encryptSecret = (plain: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);

  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
};

/**
 * Throws when the value was tampered with or the key changed.
 */
export const decryptSecret = (stored: string): string => {
  if (!isEncryptedSecret(stored)) {
    return stored;
  }

  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), raw.subarray(0, 12));
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
