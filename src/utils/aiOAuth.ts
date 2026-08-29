import { createHash, randomBytes } from 'crypto';
import https from 'https';
import { URL } from 'url';
import { AiProviderId, AiSettings, AiOAuthTokens, getAiSettings, saveAiSettings } from './aiSettings';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_ISSUER = 'https://auth.openai.com';
export const CODEX_RESPONSES_URL =
  'https://chatgpt.com/backend-api/codex/responses';
const CODEX_DEVICE_REDIRECT = 'https://auth.openai.com/deviceauth/callback';

const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const CLAUDE_REDIRECT_URI =
  'https://console.anthropic.com/oauth/code/callback';
const CLAUDE_SCOPES = 'org:create_api_key user:profile user:inference';
const CLAUDE_TOKEN_URLS = [
  'https://console.anthropic.com/v1/oauth/token',
  'https://platform.claude.com/v1/oauth/token'
];

export interface AiPendingAuth {
  openai?: {
    deviceAuthId: string;
    userCode: string;
    expiresAt: number;
  };
  anthropic?: {
    verifier: string;
    state: string;
    expiresAt: number;
  };
}

const emptyPending = (): AiPendingAuth => ({});

let pendingAuth: AiPendingAuth = emptyPending();

const base64Url = (buffer: Buffer): string =>
  buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

const createPkce = (): { verifier: string; challenge: string } => {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
};

export const httpsRequest = (options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}): Promise<{ status: number; json: any; text: string }> =>
  new Promise((resolve, reject) => {
    const parsed = new URL(options.url);
    const payload = options.body || '';
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method || 'POST',
        headers: {
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...(options.headers || {})
        }
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any = {};

          try {
            json = text ? JSON.parse(text) : {};
          } catch (err) {
            json = {};
          }

          resolve({
            status: res.statusCode || 0,
            json,
            text
          });
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(options.timeoutMs || 30000, () => {
      req.destroy(new Error('Provider timed out'));
    });

    if (payload) {
      req.write(payload);
    }

    req.end();
  });

const decodeJwtPayload = (token: string): Record<string, any> => {
  const parts = String(token || '').split('.');

  if (parts.length < 2) {
    return {};
  }

  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (err) {
    return {};
  }
};

const identityFromCodexAccess = (
  accessToken: string
): { accountId: string; email: string; planType: string } => {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload['https://api.openai.com/auth'] || {};
  const profile = payload['https://api.openai.com/profile'] || {};

  return {
    accountId: String(auth.chatgpt_account_id || payload.chatgpt_account_id || ''),
    email: String(profile.email || payload.email || ''),
    planType: String(auth.chatgpt_plan_type || '')
  };
};

const tokensFromOAuthResponse = (
  json: any,
  extras: Partial<AiOAuthTokens> = {}
): AiOAuthTokens => {
  const accessToken = String(json.access_token || '').trim();
  const refreshToken = String(json.refresh_token || extras.refreshToken || '').trim();

  if (!accessToken) {
    throw new Error('Sign-in did not return an access token');
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
    accountId: extras.accountId || '',
    email: extras.email || '',
    planType: extras.planType || ''
  };
};

const saveProviderOAuth = async (
  provider: AiProviderId,
  oauth: AiOAuthTokens | null
): Promise<AiSettings> => {
  const settings = await getAiSettings();
  settings[provider].oauth = oauth;

  if (oauth) {
    settings[provider].enabled = true;
  }

  await saveAiSettings(settings);
  return settings;
};

export const startCodexDeviceLogin = async (): Promise<{
  verificationUrl: string;
  userCode: string;
}> => {
  const response = await httpsRequest({
    url: `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID })
  });

  if (response.status >= 400) {
    throw new Error(
      'ChatGPT device login is not available. Try again, or sign in from a browser that can open auth.openai.com.'
    );
  }

  const userCode = String(response.json.user_code || '').trim();
  const deviceAuthId = String(response.json.device_auth_id || '').trim();

  if (!userCode || !deviceAuthId) {
    throw new Error('ChatGPT did not return a device code');
  }

  pendingAuth.openai = {
    deviceAuthId,
    userCode,
    expiresAt: Date.now() + 15 * 60 * 1000
  };

  return {
    verificationUrl: `${CODEX_ISSUER}/codex/device`,
    userCode
  };
};

export const pollCodexDeviceLogin = async (): Promise<{
  pending: boolean;
  connected: boolean;
}> => {
  const pending = pendingAuth.openai;

  if (!pending || pending.expiresAt < Date.now()) {
    pendingAuth.openai = undefined;
    throw new Error('ChatGPT sign-in expired. Start again.');
  }

  const response = await httpsRequest({
    url: `${CODEX_ISSUER}/api/accounts/deviceauth/token`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_auth_id: pending.deviceAuthId,
      user_code: pending.userCode
    })
  });

  if (response.status === 403 || response.status === 404) {
    return { pending: true, connected: false };
  }

  if (response.status >= 400) {
    throw new Error('ChatGPT device sign-in failed');
  }

  const authorizationCode = String(response.json.authorization_code || '').trim();
  const codeVerifier = String(response.json.code_verifier || '').trim();

  if (!authorizationCode || !codeVerifier) {
    throw new Error('ChatGPT did not return an authorization code');
  }

  const token = await httpsRequest({
    url: `${CODEX_ISSUER}/oauth/token`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: CODEX_DEVICE_REDIRECT
    }).toString()
  });

  if (token.status >= 400) {
    throw new Error('Could not finish ChatGPT sign-in');
  }

  const identity = identityFromCodexAccess(String(token.json.access_token || ''));
  await saveProviderOAuth(
    'openai',
    tokensFromOAuthResponse(token.json, identity)
  );
  pendingAuth.openai = undefined;

  return { pending: false, connected: true };
};

export const startClaudeLogin = (): { authorizeUrl: string } => {
  const pkce = createPkce();
  const state = randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: CLAUDE_REDIRECT_URI,
    scope: CLAUDE_SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state
  });

  pendingAuth.anthropic = {
    verifier: pkce.verifier,
    state,
    expiresAt: Date.now() + 15 * 60 * 1000
  };

  return { authorizeUrl: `${CLAUDE_AUTHORIZE_URL}?${params.toString()}` };
};

const exchangeClaudeToken = async (body: Record<string, string>): Promise<any> => {
  let lastError = 'Could not finish Claude sign-in';

  for (const url of CLAUDE_TOKEN_URLS) {
    const response = await httpsRequest({
      url,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (response.status < 400 && response.json.access_token) {
      return response.json;
    }

    lastError =
      response.json.error_description ||
      response.json.error ||
      lastError;
  }

  throw new Error(String(lastError));
};

export const completeClaudeLogin = async (rawCode: string): Promise<void> => {
  const pending = pendingAuth.anthropic;

  if (!pending || pending.expiresAt < Date.now()) {
    pendingAuth.anthropic = undefined;
    throw new Error('Claude sign-in expired. Start again.');
  }

  const trimmed = String(rawCode || '').trim();
  const [codePart, statePart] = trimmed.includes('#')
    ? trimmed.split('#', 2)
    : [trimmed, pending.state];
  const code = codePart.trim();

  if (!code) {
    throw new Error('Paste the code shown after you approve Claude');
  }

  const json = await exchangeClaudeToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: CLAUDE_REDIRECT_URI,
    client_id: CLAUDE_CLIENT_ID,
    code_verifier: pending.verifier,
    state: String(statePart || pending.state).trim() || pending.state
  });

  const payload = decodeJwtPayload(String(json.access_token || ''));
  await saveProviderOAuth(
    'anthropic',
    tokensFromOAuthResponse(json, {
      email: String(payload.email || json.account?.email || '')
    })
  );
  pendingAuth.anthropic = undefined;
};

export const disconnectAiProvider = async (provider: AiProviderId): Promise<void> => {
  if (provider === 'openai') {
    pendingAuth.openai = undefined;
  } else {
    pendingAuth.anthropic = undefined;
  }

  const settings = await getAiSettings();
  settings[provider].oauth = null;
  await saveAiSettings(settings);
};

const refreshCodex = async (oauth: AiOAuthTokens): Promise<AiOAuthTokens> => {
  const response = await httpsRequest({
    url: `${CODEX_ISSUER}/oauth/token`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: CODEX_CLIENT_ID
    }).toString()
  });

  if (response.status >= 400 || !response.json.access_token) {
    throw new Error('ChatGPT sign-in expired. Sign in again from Admin.');
  }

  const identity = identityFromCodexAccess(String(response.json.access_token));
  return tokensFromOAuthResponse(response.json, {
    refreshToken: String(response.json.refresh_token || oauth.refreshToken),
    ...identity
  });
};

const refreshClaude = async (oauth: AiOAuthTokens): Promise<AiOAuthTokens> => {
  const json = await exchangeClaudeToken({
    grant_type: 'refresh_token',
    refresh_token: oauth.refreshToken,
    client_id: CLAUDE_CLIENT_ID
  });

  return tokensFromOAuthResponse(json, {
    refreshToken: String(json.refresh_token || oauth.refreshToken),
    email: oauth.email
  });
};

export const getFreshProviderOAuth = async (
  provider: AiProviderId
): Promise<AiOAuthTokens> => {
  const settings = await getAiSettings();
  const oauth = settings[provider].oauth;

  if (!oauth?.accessToken && !oauth?.refreshToken) {
    throw new Error(
      provider === 'openai'
        ? 'Sign in with ChatGPT from Admin first'
        : 'Sign in with Claude from Admin first'
    );
  }

  const stillFresh =
    oauth.accessToken && oauth.expiresAt && oauth.expiresAt - Date.now() > 60_000;

  if (stillFresh) {
    return oauth;
  }

  if (!oauth.refreshToken) {
    throw new Error('Sign-in expired. Sign in again from Admin.');
  }

  const next =
    provider === 'openai'
      ? await refreshCodex(oauth)
      : await refreshClaude(oauth);
  await saveProviderOAuth(provider, next);
  return next;
};

export const extractResponsesText = (data: any): string => {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text;
  }

  const parts: string[] = [];
  const output = Array.isArray(data.output) ? data.output : [];

  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];

    for (const part of content) {
      if (typeof part?.text === 'string') {
        parts.push(part.text);
      }
    }
  }

  return parts.join('\n');
};

export const providerHttpError = (response: {
  status: number;
  json: any;
  text: string;
}): string => {
  const detail = response.json?.detail || response.json?.error?.message || response.json?.error;
  const message =
    typeof detail === 'string'
      ? detail
      : detail && typeof detail.message === 'string'
      ? detail.message
      : '';

  return message || `Codex error ${response.status}`;
};

export const parseCodexStream = (text: string): string => {
  let output = '';
  let completed = '';

  for (const block of String(text || '').split(/\n\n/)) {
    const data = block
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('');

    if (!data || data === '[DONE]') {
      continue;
    }

    try {
      const json = JSON.parse(data);

      if (json.type === 'error' || json.error) {
        throw new Error(
          json.error?.message || json.detail || json.message || 'Codex error'
        );
      }

      if (json.type === 'response.output_text.delta' && typeof json.delta === 'string') {
        output += json.delta;
      } else if (typeof json.delta === 'string' && String(json.type || '').includes('delta')) {
        output += json.delta;
      }

      if (json.type === 'response.completed' || json.type === 'response.done') {
        completed = extractResponsesText(json.response || json);
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        continue;
      }

      throw err;
    }
  }

  return (completed || output).trim();
};
