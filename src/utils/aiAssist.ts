import { randomBytes } from 'crypto';
import https from 'https';
import { URL } from 'url';
import {
  AiProviderId,
  AiSettings,
  providerHasAuth,
  getAiSettings,
  resolveClaudeModel,
  resolveCodexModel
} from './aiSettings';
import {
  CODEX_RESPONSES_URL,
  extractResponsesText,
  getFreshProviderOAuth,
  httpsRequest,
  parseCodexStream,
  providerHttpError
} from './aiOAuth';

const randomSessionId = (): string => {
  const hex = randomBytes(16).toString('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
};

export type AssistTarget =
  | 'code'
  | 'docs'
  | 'tags'
  | 'title'
  | 'language'
  | 'description';

export interface AssistSnippetInput {
  title?: string;
  description?: string;
  language?: string;
  code?: string;
  docs?: string;
  tags?: string[];
  collection?: string;
  fileName?: string;
}

export interface AssistResult {
  title?: string;
  language?: string;
  code?: string;
  docs?: string;
  tags?: string[];
  description?: string;
}

const postJson = (
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 45000
): Promise<any> =>
  new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers
        }
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsedBody: any = {};

          try {
            parsedBody = text ? JSON.parse(text) : {};
          } catch (err) {
            reject(new Error('Provider returned invalid JSON'));
            return;
          }

          if (res.statusCode && res.statusCode >= 400) {
            const message =
              parsedBody.error?.message ||
              parsedBody.error?.type ||
              `Provider error ${res.statusCode}`;
            reject(new Error(message));
            return;
          }

          resolve(parsedBody);
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Provider timed out'));
    });
    req.write(payload);
    req.end();
  });

const VALID_TARGETS: AssistTarget[] = [
  'title',
  'language',
  'description',
  'tags',
  'docs',
  'code'
];

const normalizeTargets = (targets?: AssistTarget[]): AssistTarget[] => {
  const requested = (targets || []).filter((target): target is AssistTarget =>
    VALID_TARGETS.includes(target)
  );

  return requested.length > 0
    ? VALID_TARGETS.filter(target => requested.includes(target))
    : ['title', 'language', 'tags', 'docs', 'code'];
};

const extractJsonObject = (raw: string): string => {
  const fenced = String(raw || '').match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/i);

  if (fenced?.[1]) {
    return fenced[1];
  }

  const start = raw.indexOf('{');

  if (start < 0) {
    throw new Error('Provider did not return JSON');
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  throw new Error('Provider did not return JSON');
};

const parseTags = (value: unknown): string[] | undefined => {
  const fromList = (items: unknown[]): string[] =>
    items
      .map(tag => String(tag).trim().replace(/^#/, ''))
      .filter(Boolean)
      .slice(0, 20);

  if (Array.isArray(value)) {
    const tags = fromList(value);
    return tags.length ? tags : undefined;
  }

  if (typeof value === 'string' && value.trim()) {
    const tags = fromList(value.split(/[,\n]/));
    return tags.length ? tags : undefined;
  }

  return undefined;
};

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
};

const parseModelJson = (raw: string): AssistResult => {
  const parsed = JSON.parse(extractJsonObject(raw));

  return {
    title: firstString(parsed.title, parsed.name, parsed.snippet_title),
    language: firstString(parsed.language, parsed.lang),
    code:
      typeof parsed.code === 'string'
        ? parsed.code
        : typeof parsed.snippet === 'string'
        ? parsed.snippet
        : undefined,
    docs: firstString(
      parsed.docs,
      parsed.documentation,
      parsed.readme,
      parsed.markdown
    ),
    description: firstString(parsed.description, parsed.summary),
    tags: parseTags(parsed.tags || parsed.keywords)
  };
};

const snippetSnapshot = (snippet: AssistSnippetInput): Record<string, unknown> => {
  const snapshot: Record<string, unknown> = {};

  if (snippet.title?.trim()) {
    snapshot.title = snippet.title.trim();
  }
  if (snippet.description?.trim()) {
    snapshot.description = snippet.description.trim();
  }
  if (snippet.language?.trim()) {
    snapshot.language = snippet.language.trim();
  }
  if (snippet.fileName) {
    snapshot.fileName = snippet.fileName;
  }
  if (snippet.collection) {
    snapshot.collection = snippet.collection;
  }
  if (Array.isArray(snippet.tags) && snippet.tags.length) {
    snapshot.tags = snippet.tags;
  }
  if (snippet.code) {
    snapshot.code = snippet.code;
  }
  if (snippet.docs?.trim()) {
    snapshot.docs = snippet.docs;
  }

  return snapshot;
};

const buildPrompt = (
  prompt: string,
  snippet: AssistSnippetInput,
  targets: AssistTarget[]
): string => {
  const wanted = targets.join(', ');
  const rules = [
    targets.includes('title') &&
      'title: short human name for the snippet, never empty.',
    targets.includes('language') && 'language: language id as a string.',
    targets.includes('description') && 'description: one-line summary.',
    targets.includes('tags') &&
      'tags: JSON array of 3-8 lowercase keywords, not a comma-separated string, without the language name.',
    targets.includes('docs') &&
      'docs: markdown usage notes for this snippet, never empty.',
    targets.includes('code') && 'code: the full snippet body, not a diff.'
  ].filter(Boolean);

  return [
    'You help maintain a private snippet library.',
    'Return a single JSON object and nothing else.',
    `You MUST include every one of these keys with a non-empty value: ${wanted}.`,
    'Do not omit a required key. Do not wrap the JSON in markdown.',
    targets.includes('code') && targets.some(target => target !== 'code')
      ? `Put ${targets.filter(target => target !== 'code').join(', ')} before code.`
      : '',
    ...rules.map(String),
    'If a required key is missing from Current snippet JSON, generate it from the user request and code.',
    'Never copy empty title, docs, tags, or description into a required key.',
    'Keep secrets out of the output.',
    `User request: ${prompt.trim()}`,
    `Current snippet JSON: ${JSON.stringify(snippetSnapshot(snippet))}`
  ]
    .filter(Boolean)
    .join('\n');
};

const resultHasTarget = (result: AssistResult, target: AssistTarget): boolean => {
  if (target === 'tags') {
    return Array.isArray(result.tags) && result.tags.length > 0;
  }

  const value = result[target];
  return typeof value === 'string' && value.trim().length > 0;
};

const pickRequested = (
  requested: AssistTarget[],
  parsed: AssistResult
): AssistResult => {
  const result: AssistResult = {};

  if (requested.includes('title') && parsed.title) {
    result.title = parsed.title;
  }
  if (requested.includes('language') && parsed.language) {
    result.language = parsed.language;
  }
  if (requested.includes('code') && parsed.code) {
    result.code = parsed.code;
  }
  if (requested.includes('docs') && parsed.docs) {
    result.docs = parsed.docs;
  }
  if (requested.includes('description') && parsed.description) {
    result.description = parsed.description;
  }
  if (requested.includes('tags') && parsed.tags?.length) {
    result.tags = parsed.tags;
  }

  return result;
};

const missingMetadataTargets = (
  requested: AssistTarget[],
  result: AssistResult
): AssistTarget[] =>
  requested.filter(
    target =>
      target !== 'code' &&
      ['title', 'docs', 'tags', 'description', 'language'].includes(target) &&
      !resultHasTarget(result, target)
  );

const pickText = (settings: AiSettings, provider: AiProviderId) => {
  if (provider === 'openai') {
    return settings.openai;
  }

  return settings.anthropic;
};

const callOpenAi = async (
  model: string,
  prompt: string
): Promise<string> => {
  const settings = await getAiSettings();

  if (settings.openai.oauth?.accessToken || settings.openai.oauth?.refreshToken) {
    const oauth = await getFreshProviderOAuth('openai');
    const sessionId = randomSessionId();
    const response = await httpsRequest({
      url: CODEX_RESPONSES_URL,
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'chatgpt-account-id': oauth.accountId || '',
        originator: 'codex_cli_rs',
        version: '0.144.1',
        conversation_id: sessionId,
        session_id: sessionId
      },
      body: JSON.stringify({
        model: resolveCodexModel(model),
        stream: true,
        store: false,
        instructions:
          'You generate snippet title, tags, markdown docs, and code as JSON. Every requested key is required. Return JSON only.',
        input: [{ role: 'user', content: prompt }],
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: sessionId
      }),
      timeoutMs: 45000
    });

    if (response.status >= 400) {
      throw new Error(providerHttpError(response));
    }

    const text =
      parseCodexStream(response.text) || extractResponsesText(response.json);

    if (!text.trim()) {
      throw new Error('Codex returned an empty response');
    }

    return text;
  }

  const apiKey = settings.openai.apiKey;

  if (!apiKey) {
    throw new Error('Sign in with ChatGPT from Admin first');
  }

  const data = await postJson(
    'https://api.openai.com/v1/chat/completions',
    { Authorization: `Bearer ${apiKey}` },
    {
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You generate snippet title, tags, markdown docs, and code as JSON. Every requested key is required.'
        },
        { role: 'user', content: prompt }
      ]
    }
  );

  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('Codex returned an empty response');
  }

  return String(text);
};

const callAnthropic = async (
  model: string,
  prompt: string
): Promise<string> => {
  const settings = await getAiSettings();

  if (
    settings.anthropic.oauth?.accessToken ||
    settings.anthropic.oauth?.refreshToken
  ) {
    const oauth = await getFreshProviderOAuth('anthropic');
    const data = await postJson(
      'https://api.anthropic.com/v1/messages?beta=true',
      {
        Authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'x-app': 'cli'
      },
      {
        model: resolveClaudeModel(model),
        max_tokens: 8192,
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: 'user', content: prompt }]
      }
    );

    const text = Array.isArray(data.content)
      ? data.content
          .filter((part: { type?: string }) => part.type === 'text')
          .map((part: { text?: string }) => part.text || '')
          .join('\n')
      : '';

    if (!text.trim()) {
      throw new Error('Claude Code returned an empty response');
    }

    return text;
  }

  const apiKey = settings.anthropic.apiKey;

  if (!apiKey) {
    throw new Error('Sign in with Claude from Admin first');
  }

  const data = await postJson(
    'https://api.anthropic.com/v1/messages',
    {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    {
      model,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }]
    }
  );

  const text = Array.isArray(data.content)
    ? data.content
        .filter((part: { type?: string }) => part.type === 'text')
        .map((part: { text?: string }) => part.text || '')
        .join('\n')
    : '';

  if (!text.trim()) {
    throw new Error('Claude Code returned an empty response');
  }

  return text;
};

export const resolveAssistProvider = (
  settings: AiSettings,
  requested?: string
): AiProviderId => {
  const requestedId = String(requested || '').trim() as AiProviderId;

  if (
    requestedId === 'openai' &&
    settings.openai.enabled &&
    providerHasAuth(settings.openai)
  ) {
    return 'openai';
  }

  if (
    requestedId === 'anthropic' &&
    settings.anthropic.enabled &&
    providerHasAuth(settings.anthropic)
  ) {
    return 'anthropic';
  }

  if (settings.openai.enabled && providerHasAuth(settings.openai)) {
    return 'openai';
  }

  if (settings.anthropic.enabled && providerHasAuth(settings.anthropic)) {
    return 'anthropic';
  }

  throw new Error('No AI provider is configured');
};

export const runSnippetAssist = async (options: {
  prompt: string;
  provider?: string;
  targets?: AssistTarget[];
  snippet?: AssistSnippetInput;
}): Promise<{ provider: AiProviderId; result: AssistResult }> => {
  const prompt = String(options.prompt || '').trim();

  if (!prompt) {
    throw new Error('A prompt is required');
  }

  const settings = await getAiSettings();
  const provider = resolveAssistProvider(settings, options.provider);
  const requested = normalizeTargets(options.targets);
  const config = pickText(settings, provider);
  const snippet = options.snippet || {};
  const generate = async (
    targets: AssistTarget[],
    current: AssistSnippetInput
  ): Promise<AssistResult> => {
    const fullPrompt = buildPrompt(prompt, current, targets);
    const raw =
      provider === 'openai'
        ? await callOpenAi(config.model, fullPrompt)
        : await callAnthropic(config.model, fullPrompt);

    return pickRequested(targets, parseModelJson(raw));
  };

  const result = await generate(requested, snippet);
  const missing = missingMetadataTargets(requested, result);

  if (missing.length > 0) {
    try {
      const filled = await generate(missing, { ...snippet, ...result });
      Object.assign(result, filled);
    } catch {
      // Keep code from the first pass if metadata fill-in fails.
    }
  }

  return { provider, result };
};

export const testAiProvider = async (
  provider: AiProviderId,
  model: string
): Promise<{ ok: boolean; model: string }> => {
  const prompt = 'Reply with JSON {"ok":true} and nothing else.';

  if (provider === 'openai') {
    await callOpenAi(model, prompt);
  } else {
    await callAnthropic(model, prompt);
  }

  return { ok: true, model };
};
