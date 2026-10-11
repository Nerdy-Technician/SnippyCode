import { randomBytes } from 'crypto';
import { checkToken, hashToken, TokenCheck } from './tokenHash';
import { SettingModel } from '../models';

interface RawApiKeySettings {
  hash: string;
  prefix: string;
  createdAt: string;
}

export const hashApiKey = (key: string): Promise<string> => hashToken(key);

export const createRawApiKey = async (): Promise<{
  key: string;
  settings: RawApiKeySettings;
}> => {
  const secret = randomBytes(32).toString('base64url');
  const key = `sb_raw_${secret}`;

  return {
    key,
    settings: {
      hash: await hashApiKey(key),
      prefix: key.slice(0, 14),
      createdAt: new Date().toISOString()
    }
  };
};

export const createRawSnippetToken = async (): Promise<{
  token: string;
  hash: string;
  prefix: string;
  createdAt: Date;
}> => {
  const secret = randomBytes(32).toString('base64url');
  const token = `sb_snip_${secret}`;

  return {
    token,
    hash: await hashApiKey(token),
    prefix: token.slice(0, 16),
    createdAt: new Date()
  };
};

export const checkTokenHash = (token: string, hash?: string | null): Promise<TokenCheck> =>
  checkToken(token, hash);

export const verifyTokenHash = async (token: string, hash?: string | null): Promise<boolean> =>
  (await checkToken(token, hash)).ok;

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

  const check = await checkToken(key, settings.hash);

  if (check.ok && check.upgrade) {
    await SettingModel.update(
      { value: JSON.stringify({ ...settings, hash: check.upgrade }) },
      { where: { key: 'rawApiKey' } }
    );
  }

  return check.ok;
};
