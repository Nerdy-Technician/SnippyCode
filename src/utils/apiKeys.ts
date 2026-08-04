import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { SettingModel } from '../models';

interface RawApiKeySettings {
  hash: string;
  prefix: string;
  createdAt: string;
}

export const hashApiKey = (key: string): string =>
  createHash('sha256').update(key).digest('hex');

export const createRawApiKey = (): {
  key: string;
  settings: RawApiKeySettings;
} => {
  const secret = randomBytes(32).toString('base64url');
  const key = `sb_raw_${secret}`;

  return {
    key,
    settings: {
      hash: hashApiKey(key),
      prefix: key.slice(0, 14),
      createdAt: new Date().toISOString()
    }
  };
};

export const createRawSnippetToken = (): {
  token: string;
  hash: string;
  prefix: string;
  createdAt: Date;
} => {
  const secret = randomBytes(32).toString('base64url');
  const token = `sb_snip_${secret}`;

  return {
    token,
    hash: hashApiKey(token),
    prefix: token.slice(0, 16),
    createdAt: new Date()
  };
};

export const verifyTokenHash = (token: string, hash?: string | null): boolean => {
  if (!token || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, 'hex');
  const actual = Buffer.from(hashApiKey(token), 'hex');

  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

export const getRawApiKeySettings =
  async (): Promise<RawApiKeySettings | null> => {
    const setting = await SettingModel.findByPk('rawApiKey');

    if (!setting) {
      return null;
    }

    try {
      return JSON.parse(setting.value) as RawApiKeySettings;
    } catch (err) {
      return null;
    }
  };

export const publicRawApiKeySettings = (
  settings: RawApiKeySettings | null
) => ({
  configured: Boolean(settings?.hash),
  prefix: settings?.prefix || '',
  createdAt: settings?.createdAt || null
});

export const verifyRawApiKey = async (key?: string): Promise<boolean> => {
  if (!key) {
    return false;
  }

  const settings = await getRawApiKeySettings();

  if (!settings?.hash) {
    return false;
  }

  const expected = Buffer.from(settings.hash, 'hex');
  const actual = Buffer.from(hashApiKey(key), 'hex');

  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
