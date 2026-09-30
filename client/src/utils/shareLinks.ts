// Mirrors src/utils/shareLinks.ts on the server.

const POWERSHELL_LANGUAGES = ['powershell', 'pwsh', 'ps1', 'posh'];

export const REMOTE_EXECUTE_WARNING =
  'Only run scripts you trust; this runs the code directly on your machine.';

export const isPowerShellLanguage = (language?: string | null): boolean =>
  POWERSHELL_LANGUAGES.includes(String(language || '').trim().toLowerCase());

/** PUBLIC_BASE_URL from the server when configured, else this page's origin. */
export const resolveBaseUrl = (serverBaseUrl?: string | null): string =>
  (serverBaseUrl || window.location.origin).replace(/\/+$/, '');

export const rawRefFor = (snippet: { id: number; rawSlug?: string | null }): string =>
  snippet.rawSlug || String(snippet.id);

export const buildShareUrl = (baseUrl: string, rawRef: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/s/${encodeURIComponent(rawRef)}`;

export const buildRawUrl = (baseUrl: string, rawRef: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/raw/${encodeURIComponent(rawRef)}`;

export const buildPowerShellRemoteCommand = (rawUrl: string): string =>
  `irm ${rawUrl} | iex`;
