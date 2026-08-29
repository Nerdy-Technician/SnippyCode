export const AUDIT_ACTIONS: { id: string; label: string }[] = [
  { id: 'auth.setup_oidc', label: 'Finished OIDC setup' },
  { id: 'auth.setup_owner', label: 'Created owner account' },
  { id: 'auth.login', label: 'Signed in' },
  { id: 'auth.login_failed', label: 'Sign-in failed' },
  { id: 'auth.logout', label: 'Signed out' },
  { id: 'auth.oidc_login', label: 'Signed in with OIDC' },
  { id: 'oidc.updated', label: 'Updated OIDC settings' },
  { id: 'github.updated', label: 'Updated GitHub sync' },
  { id: 'github.tested', label: 'Tested GitHub access' },
  { id: 'github.upload.started', label: 'Started GitHub upload' },
  { id: 'github.upload.done', label: 'Uploaded snippets to GitHub' },
  { id: 'github.upload.failed', label: 'GitHub upload failed' },
  { id: 'github.download.started', label: 'Started GitHub download' },
  { id: 'github.download.done', label: 'Downloaded snippets from GitHub' },
  { id: 'github.download.failed', label: 'GitHub download failed' },
  { id: 'ai.updated', label: 'Updated AI settings' },
  { id: 'ai.login.started', label: 'Started AI sign-in' },
  { id: 'ai.login.connected', label: 'Connected AI assistant' },
  { id: 'ai.login.disconnected', label: 'Disconnected AI assistant' },
  { id: 'ai.tested', label: 'Tested AI assistant' },
  { id: 'raw_api_key.generated', label: 'Generated raw API key' },
  { id: 'raw_api_key.revoked', label: 'Revoked raw API key' },
  { id: 'user.created', label: 'Created user' },
  { id: 'user.updated', label: 'Updated user' },
  { id: 'user.deleted', label: 'Deleted user' },
  { id: 'library.exported', label: 'Exported library' },
  { id: 'library.imported', label: 'Imported library' },
  { id: 'library.snippet_box.fetched', label: 'Fetched Snippet Box library' },
  { id: 'snippet.created', label: 'Created snippet' },
  { id: 'snippet.updated', label: 'Updated snippet' },
  { id: 'snippet.deleted', label: 'Deleted snippet' },
  { id: 'snippet.assist', label: 'Generated with AI' },
  { id: 'snippet.ran', label: 'Ran snippet' },
  { id: 'snippet.raw_token.generated', label: 'Generated raw token' },
  { id: 'snippet.raw_token.revoked', label: 'Revoked raw token' },
  { id: 'snippet.restored', label: 'Restored snippet version' },
  { id: 'collection.renamed', label: 'Renamed collection' }
];

const ACTION_LABELS = Object.fromEntries(
  AUDIT_ACTIONS.map(action => [action.id, action.label])
);

const SKIP_META_KEYS = new Set([
  'apiKey',
  'clientSecret',
  'token',
  'hash',
  'accessToken',
  'refreshToken',
  'secret'
]);

const humanize = (value: string): string =>
  value
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());

export const auditActionLabel = (action: string): string =>
  ACTION_LABELS[action] || humanize(action);

export const auditGroup = (action: string): string => {
  if (action.startsWith('auth.') || action.startsWith('oidc.')) {
    return 'Sign-in';
  }
  if (action.startsWith('github.')) {
    return 'GitHub';
  }
  if (action.startsWith('library.') || action.startsWith('collection.')) {
    return 'Library';
  }
  if (action.startsWith('snippet.')) {
    return 'Snippets';
  }
  if (action.startsWith('ai.')) {
    return 'AI';
  }
  if (action.startsWith('user.')) {
    return 'Users';
  }
  if (action.startsWith('raw_api_key.')) {
    return 'Keys';
  }

  return 'System';
};

export const auditTone = (action: string): 'ok' | 'warn' | 'bad' => {
  if (/\.failed$|_failed$|\.deleted$|\.revoked$/.test(action)) {
    return 'bad';
  }
  if (/\.started$|\.disconnected$/.test(action)) {
    return 'warn';
  }

  return 'ok';
};

const providerLabel = (value: unknown): string => {
  const id = String(value || '');

  if (id === 'openai') {
    return 'Codex';
  }
  if (id === 'anthropic') {
    return 'Claude';
  }

  return id;
};

const parseMetadata = (raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
};

const formatValue = (key: string, value: unknown): string | null => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (Array.isArray(value)) {
    if (!value.length) {
      return null;
    }
    if (key === 'secretFindings' || key === 'secretWarnings') {
      return `${value.length} flagged`;
    }
    if (value.every(item => typeof item === 'string' || typeof item === 'number')) {
      return value.map(String).join(', ');
    }
    return `${value.length} items`;
  }

  if (typeof value === 'object') {
    const nested = value as Record<string, unknown>;
    if (typeof nested.label === 'string') {
      return nested.label;
    }
    if (typeof nested.fullName === 'string') {
      return nested.fullName;
    }
    if (typeof nested.model === 'string') {
      return nested.model;
    }
    return null;
  }

  if (key === 'provider') {
    return providerLabel(value);
  }
  if (key === 'ok') {
    return value === true || value === 'true' ? 'OK' : 'Failed';
  }

  return String(value);
};

const META_LABELS: Record<string, string> = {
  title: 'Title',
  email: 'Email',
  role: 'Role',
  provider: 'Provider',
  providerName: 'Provider',
  model: 'Model',
  imported: 'Imported',
  count: 'Count',
  host: 'Host',
  prompt: 'Prompt',
  targets: 'Fields',
  language: 'Language',
  ok: 'Result',
  timedOut: 'Timed out',
  exitCode: 'Exit',
  from: 'From',
  to: 'To',
  dryRun: 'Dry run',
  files: 'Files',
  skipped: 'Skipped',
  snippets: 'Snippets',
  overwriteMode: 'Conflicts',
  versionId: 'Version',
  issuerUrl: 'Issuer',
  preview: 'Preview',
  message: 'Error',
  fullName: 'Repository',
  enabled: 'Enabled',
  owner: 'Owner',
  repo: 'Repo',
  branch: 'Branch',
  path: 'Path',
  tokenConfigured: 'Token',
  localLoginEnabled: 'Local login'
};

export const auditDetails = (metadata: string): string[] => {
  const data = parseMetadata(metadata);

  return Object.entries(data)
    .filter(([key]) => !SKIP_META_KEYS.has(key))
    .map(([key, value]) => {
      const formatted = formatValue(key, value);
      if (!formatted) {
        return null;
      }

      const label = META_LABELS[key] || humanize(key);
      return `${label}: ${formatted}`;
    })
    .filter((line): line is string => Boolean(line))
    .slice(0, 8);
};

export const auditTargetLabel = (
  target?: string | null,
  metadata?: string
): string => {
  const data = parseMetadata(metadata || '{}');
  const raw = String(target || '').trim();

  if (raw.startsWith('snippet:')) {
    const title = typeof data.title === 'string' ? data.title : '';
    return title || `Snippet ${raw.slice(8)}`;
  }
  if (raw === 'github') {
    return 'GitHub';
  }
  if (raw === 'rawApiKey') {
    return 'Raw API key';
  }
  if (!raw || raw === 'system') {
    if (typeof data.email === 'string' && data.email) {
      return data.email;
    }
    return '';
  }

  return raw;
};
