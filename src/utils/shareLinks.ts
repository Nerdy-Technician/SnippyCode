import { Request } from 'express';

/**
 * Helpers for share links (/s/:rawRef) and raw links (/raw/:rawRef).
 *
 * A raw reference is either a numeric snippet id ("16") or a raw slug such as
 * "purge-onedrive-from-windows.powershell". Slugs keep their dots, so the
 * language extension is part of the slug and must never be read as a number
 * or a file extension.
 */

export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 100);

export const extensionForLanguage = (language: string): string => {
  const extensions: { [key: string]: string } = {
    bash: 'sh',
    shell: 'sh',
    javascript: 'js',
    typescript: 'ts',
    python: 'py',
    markdown: 'md',
    yaml: 'yml'
  };

  return extensions[language] || language || 'txt';
};

export const rawSlugForSnippet = (snippet: {
  id?: number;
  title: string;
  language: string;
  fileName?: string | null;
}): string => {
  if (snippet.fileName) {
    return slugify(snippet.fileName);
  }

  const extension = extensionForLanguage(snippet.language);
  const base = slugify(snippet.title) || `snippet-${snippet.id || Date.now()}`;

  return base.includes('.') ? base : `${base}.${extension}`;
};

export type RawRefLookup = { id: number } | { rawSlug: string };

/**
 * Turn a /s/ or /raw/ path segment into a database lookup.
 *
 * Only plain positive integers are treated as ids. Anything else, including
 * dotted values such as "1.5", "1e3" or "my-script.powershell", is looked up
 * by slug. `Number(ref)` is deliberately not used here: it accepts "1.5",
 * "1e3" and "0x10".
 */
export const parseRawRef = (rawRef: unknown): RawRefLookup | null => {
  const ref = typeof rawRef === 'string' ? rawRef.trim() : '';

  if (!ref || ref.length > 255) {
    return null;
  }

  if (/^[1-9][0-9]*$/.test(ref)) {
    const id = Number(ref);
    return Number.isSafeInteger(id) ? { id } : null;
  }

  return { rawSlug: ref };
};

export const rawRefForSnippet = (snippet: {
  id: number;
  rawSlug?: string | null;
}): string => snippet.rawSlug || String(snippet.id);

const POWERSHELL_LANGUAGES = ['powershell', 'pwsh', 'ps1', 'posh'];

export const isPowerShellLanguage = (language?: string | null): boolean =>
  POWERSHELL_LANGUAGES.includes(String(language || '').trim().toLowerCase());

const HOST_PATTERN = /^[a-z0-9.-]+(:[0-9]{1,5})?$|^\[[0-9a-f:]+\](:[0-9]{1,5})?$/i;

/**
 * PUBLIC_BASE_URL (for example https://snippycode.example.com) without a
 * trailing slash, or '' when it is unset or not a plain http(s) URL.
 */
export const configuredPublicBaseUrl = (): string => {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim();

  return /^https?:\/\/[^\s'"`;|&$()<>\\]+$/i.test(configured)
    ? configured.replace(/\/+$/, '')
    : '';
};

/**
 * Base URL used in share links and the PowerShell one-liner.
 * PUBLIC_BASE_URL wins when set; otherwise the request protocol and host are
 * used (trust proxy is enabled, so X-Forwarded-Proto from the reverse proxy
 * is honoured).
 */
export const resolvePublicBaseUrl = (req: Request): string => {
  const configured = configuredPublicBaseUrl();

  if (configured) {
    return configured;
  }

  const host = String(req.get('host') || '');
  const protocol = req.protocol === 'https' ? 'https' : 'http';

  return HOST_PATTERN.test(host) ? `${protocol}://${host}` : '';
};

export const buildRawUrl = (baseUrl: string, rawRef: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/raw/${encodeURIComponent(rawRef)}`;

export const buildPowerShellRemoteCommand = (rawUrl: string): string =>
  `irm ${rawUrl} | iex`;
