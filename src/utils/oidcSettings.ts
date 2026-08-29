import { SettingModel } from '../models';

export type OidcMatchMode = 'subject' | 'email' | 'subject_or_email';

export const DEFAULT_OIDC_PROVIDER_NAME = 'Keycloak';

export interface OidcSettings {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  subjectClaim: string;
  emailClaim: string;
  nameClaim: string;
  matchMode: OidcMatchMode;
  allowSignup: boolean;
  localLoginEnabled: boolean;
  provider: string;
  providerName: string;
}

export const defaultOidcSettings = (): OidcSettings => ({
  enabled: false,
  issuerUrl: '',
  clientId: '',
  clientSecret: '',
  redirectUri: '',
  scopes: 'openid email profile',
  subjectClaim: 'sub',
  emailClaim: 'email',
  nameClaim: 'name',
  matchMode: 'subject_or_email',
  allowSignup: false,
  localLoginEnabled: true,
  provider: 'keycloak',
  providerName: DEFAULT_OIDC_PROVIDER_NAME
});

export const resolveOidcProviderName = (value?: string | null): string => {
  const name = String(value || '').trim();
  return name || DEFAULT_OIDC_PROVIDER_NAME;
};

export const persistOidcProviderName = (
  incoming: unknown,
  existing?: string | null
): string => {
  if (incoming === undefined || incoming === null) {
    return resolveOidcProviderName(existing);
  }

  return resolveOidcProviderName(String(incoming));
};

export const persistOidcProvider = (
  incoming: unknown,
  existing?: string | null
): string => {
  if (incoming === undefined || incoming === null) {
    const provider = String(existing || '').trim();
    return provider || 'keycloak';
  }

  const provider = String(incoming).trim().toLowerCase();
  return provider || 'keycloak';
};

export const getSetting = async <T,>(key: string, fallback: T): Promise<T> => {
  const setting = await SettingModel.findByPk(key);

  if (!setting) {
    return fallback;
  }

  try {
    return { ...fallback, ...JSON.parse(setting.value) } as T;
  } catch (err) {
    return fallback;
  }
};

export const setSetting = async (key: string, value: unknown): Promise<void> => {
  await SettingModel.upsert({
    key,
    value: JSON.stringify(value)
  });
};

export const getOidcSettings = async (): Promise<OidcSettings> =>
  getSetting<OidcSettings>('oidc', defaultOidcSettings());

export const oidcIsReady = (settings: OidcSettings): boolean =>
  Boolean(
    settings.enabled &&
      settings.issuerUrl &&
      settings.clientId &&
      settings.clientSecret &&
      settings.redirectUri
  );

export const publicOidcSettings = (settings: OidcSettings) => ({
  enabled: settings.enabled,
  issuerUrl: settings.issuerUrl,
  clientId: settings.clientId,
  redirectUri: settings.redirectUri,
  scopes: settings.scopes,
  subjectClaim: settings.subjectClaim,
  emailClaim: settings.emailClaim,
  nameClaim: settings.nameClaim,
  matchMode: settings.matchMode,
  allowSignup: settings.allowSignup,
  localLoginEnabled: settings.localLoginEnabled,
  provider: persistOidcProvider(undefined, settings.provider),
  providerName: resolveOidcProviderName(settings.providerName),
  clientSecretConfigured: Boolean(settings.clientSecret)
});
