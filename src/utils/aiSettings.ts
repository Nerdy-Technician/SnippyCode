import { getSetting, setSetting } from './oidcSettings';

export type AiProviderId = 'openai' | 'anthropic';

export interface AiOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
  planType?: string;
}

export interface AiProviderSettings {
  enabled: boolean;
  apiKey: string;
  model: string;
  oauth: AiOAuthTokens | null;
}

export interface AiSettings {
  openai: AiProviderSettings;
  anthropic: AiProviderSettings;
}

export const CODEX_MODELS = [
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'gpt-5.5', label: 'GPT-5.5' }
];

export const CLAUDE_MODELS = [
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }
];

const CODEX_MODEL_ALIASES: { [id: string]: string } = {
  'gpt-4o': 'gpt-5.6-terra',
  'gpt-5': 'gpt-5.6-terra',
  'gpt-5.1': 'gpt-5.6-terra',
  'gpt-5.1-codex': 'gpt-5.6-terra',
  'gpt-5.1-codex-max': 'gpt-5.6-sol',
  'gpt-5.2': 'gpt-5.6-terra',
  'gpt-5.2-codex': 'gpt-5.6-terra',
  'gpt-5.3-codex': 'gpt-5.6-terra',
  'gpt-5.4': 'gpt-5.6-terra',
  'gpt-5.4-mini': 'gpt-5.6-luna',
  'gpt-5.6': 'gpt-5.6-sol'
};

export const resolveCodexModel = (model?: string): string => {
  const requested = String(model || '').trim();
  const mapped = CODEX_MODEL_ALIASES[requested] || requested;
  const known = CODEX_MODELS.find(item => item.id === mapped);

  return known?.id || 'gpt-5.6-terra';
};

export const resolveClaudeModel = (model?: string): string => {
  const requested = String(model || '').trim();
  const known = CLAUDE_MODELS.find(item => item.id === requested);

  return known?.id || 'claude-sonnet-4-5';
};

export const defaultAiSettings = (): AiSettings => ({
  openai: {
    enabled: false,
    apiKey: '',
    model: 'gpt-5.6-terra',
    oauth: null
  },
  anthropic: {
    enabled: false,
    apiKey: '',
    model: 'claude-sonnet-4-5',
    oauth: null
  }
});

const mergeProvider = (
  defaults: AiProviderSettings,
  stored?: Partial<AiProviderSettings>
): AiProviderSettings => ({
  ...defaults,
  ...(stored || {}),
  oauth: stored?.oauth || null
});

export const getAiSettings = async (): Promise<AiSettings> => {
  const stored = await getSetting<AiSettings>('ai', defaultAiSettings());
  const defaults = defaultAiSettings();

  return {
    openai: mergeProvider(defaults.openai, {
      ...(stored.openai || {}),
      model: resolveCodexModel(stored.openai?.model)
    }),
    anthropic: mergeProvider(defaults.anthropic, {
      ...(stored.anthropic || {}),
      model: resolveClaudeModel(stored.anthropic?.model)
    })
  };
};

export const saveAiSettings = async (settings: AiSettings): Promise<void> => {
  await setSetting('ai', settings);
};

export const providerHasAuth = (settings: AiProviderSettings): boolean =>
  Boolean(settings.oauth?.accessToken || settings.oauth?.refreshToken || settings.apiKey);

export const publicAiProvider = (settings: AiProviderSettings) => ({
  enabled: Boolean(settings.enabled && providerHasAuth(settings)),
  model: settings.model,
  connected: Boolean(settings.oauth?.accessToken || settings.oauth?.refreshToken),
  email: settings.oauth?.email || '',
  planType: settings.oauth?.planType || ''
});

export const publicAiSettings = (settings: AiSettings) => ({
  openai: publicAiProvider(settings.openai),
  anthropic: publicAiProvider(settings.anthropic),
  models: {
    openai: CODEX_MODELS,
    anthropic: CLAUDE_MODELS
  }
});

export const publicAiAssistStatus = (settings: AiSettings) => {
  const providers: { id: AiProviderId; label: string }[] = [];

  if (providerHasAuth(settings.openai)) {
    providers.push({ id: 'openai', label: 'Codex' });
  }

  if (providerHasAuth(settings.anthropic)) {
    providers.push({ id: 'anthropic', label: 'Claude Code' });
  }

  return {
    enabled: providers.length > 0,
    providers
  };
};
