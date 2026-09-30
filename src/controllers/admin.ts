import bcrypt from 'bcryptjs';
import { Request, Response, NextFunction } from 'express';
import { Issuer } from 'openid-client';
import { Op } from 'sequelize';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import {
  AuditLogModel,
  SettingModel,
  SnippetModel,
  TagModel,
  TaskModel,
  UserModel
} from '../models';
import {
  ErrorResponse,
  auditLog,
  createTags,
  detectSecretFindings,
  getGithubDirectory,
  getGithubFileInfo,
  getGithubFileText,
  requestIp,
  tagParser,
  testGithubRepositoryAccess,
  upsertGithubFile,
  fetchSnippetBoxSnippets
} from '../utils';
import {
  createRawApiKey,
  getRawApiKeySettings,
  publicRawApiKeySettings
} from '../utils/apiKeys';
import {
  defaultOidcSettings,
  getOidcSettings,
  OidcMatchMode,
  persistOidcProvider,
  persistOidcProviderName,
  publicOidcSettings,
  setSetting as setSharedSetting
} from '../utils/oidcSettings';
import {
  getAiSettings,
  publicAiSettings,
  resolveClaudeModel,
  resolveCodexModel,
  saveAiSettings
} from '../utils/aiSettings';
import { testAiProvider } from '../utils/aiAssist';
import {
  completeClaudeLogin,
  disconnectAiProvider,
  pollCodexDeviceLogin,
  startClaudeLogin,
  startCodexDeviceLogin
} from '../utils/aiOAuth';

interface GithubSettings {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

const getSetting = async <T,>(key: string, fallback: T): Promise<T> => {
  const setting = await SettingModel.findByPk(key);

  if (!setting) {
    return fallback;
  }

  try {
    return JSON.parse(setting.value) as T;
  } catch (err) {
    return fallback;
  }
};

const setSetting = async (key: string, value: unknown): Promise<void> => {
  await SettingModel.upsert({ key, value: JSON.stringify(value) });
};

const auditActor = (req: Request) => ({
  userId: (req as any).user?.id || null,
  ipAddress: requestIp(req)
});

const ASSIGNABLE_ROLES = ['viewer', 'editor', 'admin', 'owner'] as const;
type AssignableRole = typeof ASSIGNABLE_ROLES[number];

const normalizeRole = (
  role: unknown,
  fallback: AssignableRole = 'editor'
): AssignableRole => {
  const value = String(role || '').trim();

  if (value === 'user') {
    return 'editor';
  }

  if ((ASSIGNABLE_ROLES as readonly string[]).includes(value)) {
    return value as AssignableRole;
  }

  return fallback;
};

const isOwnerAccount = (user: { isOwner: boolean; role?: string }): boolean =>
  Boolean(user.isOwner || user.role === 'owner');

const countOtherOwners = async (excludeId: number): Promise<number> =>
  UserModel.count({
    where: {
      id: { [Op.ne]: excludeId },
      [Op.or]: [{ isOwner: true }, { role: 'owner' }]
    }
  });

const publicAccount = (user: {
  id: number;
  email: string;
  displayName: string;
  isOwner: boolean;
  role: string;
  mfaEnabled: boolean;
  oidcSubject?: string | null;
}) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  isOwner: user.isOwner,
  role: user.role === 'user' ? 'editor' : user.role,
  mfaEnabled: user.mfaEnabled,
  oidcSubject: user.oidcSubject
});

const getGithubSettings = async (): Promise<GithubSettings> =>
  getSetting<GithubSettings>('github', {
    token: process.env.GITHUB_TOKEN || '',
    owner: process.env.GITHUB_REPO_OWNER || '',
    repo: process.env.GITHUB_REPO_NAME || '',
    branch: process.env.GITHUB_REPO_BRANCH || 'main',
    path: process.env.GITHUB_SNIPPETS_PATH || 'snippets'
  });

const publicGithubSettings = (settings: GithubSettings) => ({
  owner: settings.owner,
  repo: settings.repo,
  branch: settings.branch,
  path: settings.path,
  tokenConfigured: Boolean(settings.token)
});

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);

const extensionForLanguage = (language: string): string => {
  const extensions: { [key: string]: string } = {
    bash: 'sh',
    shell: 'sh',
    dockerfile: 'Dockerfile',
    javascript: 'js',
    typescript: 'ts',
    python: 'py',
    markdown: 'md',
    yaml: 'yml'
  };

  return extensions[language.toLowerCase()] || language.toLowerCase() || 'txt';
};

const languageForFile = (name: string): string => {
  const extension = name.split('.').pop()?.toLowerCase();
  const languages: { [key: string]: string } = {
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    sh: 'bash',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml'
  };

  if (name === 'Dockerfile') {
    return 'dockerfile';
  }

  return extension ? languages[extension] || extension : 'plaintext';
};

const markdownForSnippet = (snippet: {
  title: string;
  description?: string;
  language: string;
  code: string;
  docs?: string;
  tags?: string[];
}): string =>
  [
    `# ${snippet.title}`,
    '',
    snippet.description || '',
    '',
    `Language: ${snippet.language}`,
    `Tags: ${(snippet.tags || []).join(', ') || 'none'}`,
    '',
    '```' + snippet.language,
    snippet.code,
    '```',
    '',
    snippet.docs ? '## Documentation' : '',
    snippet.docs || ''
  ].join('\n');

const createServerTask = async (
  title: string,
  status: 'doing' | 'done' | 'failed',
  description: string
) =>
  TaskModel.create({
    title,
    status,
    description,
    priority: 'medium'
  });

const AUDIT_JOB_TITLES: Record<string, string> = {
  'library.exported': 'Export library JSON',
  'library.imported': 'Import library JSON',
  'library.snippet_box.fetched': 'Import from Snippet Box',
  'ai.tested': 'Test AI assistant'
};

const parseJobMetadata = (raw: string): Record<string, any> => {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
};

const describeAuditJob = (action: string, metadata: Record<string, any>): string => {
  if (action === 'library.imported') {
    return `Imported ${Number(metadata.imported) || 0} snippets.`;
  }
  if (action === 'library.exported') {
    return `Exported ${Number(metadata.count) || 0} snippets.`;
  }
  if (action === 'library.snippet_box.fetched') {
    const host = String(metadata.host || 'Snippet Box');
    return `Fetched ${Number(metadata.count) || 0} snippets from ${host}.`;
  }
  if (action === 'ai.tested') {
    const provider = metadata.provider === 'anthropic' ? 'Claude' : 'Codex';
    return `Tested ${provider}${metadata.model ? ` (${metadata.model})` : ''}.`;
  }

  return '';
};

const listServerTasks = async () => {
  let stored: any[] = [];

  try {
    stored = (
      await TaskModel.findAll({
        order: [['createdAt', 'DESC']],
        limit: 20
      })
    ).map(task => task.get({ plain: true }));
  } catch {
    stored = [];
  }

  const logs = await AuditLogModel.findAll({
    where: { action: { [Op.in]: Object.keys(AUDIT_JOB_TITLES) } },
    order: [['createdAt', 'DESC']],
    limit: 20
  });

  const fromAudit = logs
    .map(entry => {
      const metadata = parseJobMetadata(entry.metadata);

      if (entry.action === 'library.snippet_box.fetched' && metadata.preview) {
        return null;
      }

      return {
        id: Number(entry.id) + 1000000,
        title: AUDIT_JOB_TITLES[entry.action],
        description: describeAuditJob(entry.action, metadata),
        status: 'done' as const,
        priority: 'medium' as const,
        dueDate: null,
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt
      };
    })
    .filter(Boolean);

  return [...stored, ...fromAudit]
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    )
    .slice(0, 20);
};

const buildGithubFilesForSnippet = (rawSnippet: any, settings: GithubSettings) => {
  const tags = rawSnippet.tags?.map((tag: { name: string }) => tag.name) || [];
  const slug = slugify(rawSnippet.title) || `snippet-${rawSnippet.id}`;
  const codeExtension = extensionForLanguage(rawSnippet.language);
  const codePath =
    codeExtension === 'Dockerfile'
      ? `${settings.path}/${slug}/Dockerfile`
      : `${settings.path}/${slug}/snippet.${codeExtension}`;

  return [
    {
      snippetId: rawSnippet.id,
      title: rawSnippet.title,
      path: codePath,
      type: 'code',
      content: rawSnippet.code,
      message: `Export snippet code: ${rawSnippet.title}`
    },
    {
      snippetId: rawSnippet.id,
      title: rawSnippet.title,
      path: `${settings.path}/${slug}/README.md`,
      type: 'docs',
      content: markdownForSnippet({ ...rawSnippet, tags }),
      message: `Export snippet docs: ${rawSnippet.title}`
    }
  ];
};

const importPreviewForPayload = (body: any) => {
  const snippets = Array.isArray(body.snippets) ? body.snippets : [];
  const valid = [];
  const invalid = [];
  const secrets = [];

  for (const [index, item] of snippets.entries()) {
    const title = String(item.title || '').trim();
    const language = String(item.language || 'plaintext').trim().toLowerCase();
    const code = String(item.code || '');

    if (!title || !code) {
      invalid.push({
        index,
        title: title || `Item ${index + 1}`,
        reason: 'Title and code are required'
      });
      continue;
    }

    const findings = detectSecretFindings(code, item.docs, item.description);
    if (findings.length > 0) {
      secrets.push({
        index,
        title,
        findings
      });
    }

    valid.push({
      index,
      title,
      language,
      tags: Array.isArray(item.tags) ? item.tags.length : 0
    });
  }

  return {
    total: snippets.length,
    valid: valid.length,
    invalid,
    secrets
  };
};

export const getAdminOverview = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    const auditQuery = String(req.query.auditQuery || '').trim();
    const auditAction = String(req.query.auditAction || '').trim();
    const auditUserId = String(req.query.auditUserId || '').trim();
    const auditIp = String(req.query.auditIp || '').trim();
    const auditWhere: any = {};

    if (auditAction) {
      auditWhere.action = auditAction.includes('.')
        ? auditAction
        : { [Op.substring]: auditAction };
    }

    if (auditUserId) {
      auditWhere.userId = Number(auditUserId);
    }

    if (auditIp) {
      auditWhere.ipAddress = { [Op.substring]: auditIp };
    }

    if (auditQuery) {
      auditWhere[Op.or] = [
        { action: { [Op.substring]: auditQuery } },
        { target: { [Op.substring]: auditQuery } },
        { metadata: { [Op.substring]: auditQuery } }
      ];
    }

    const [users, tasks, auditLogs, github, oidc, rawApiKey, snippets, ai] =
      await Promise.all([
      UserModel.findAll({
        attributes: [
          'id',
          'email',
          'displayName',
          'isOwner',
          'role',
          'mfaEnabled',
          'oidcSubject',
          'createdAt'
        ]
      }),
      listServerTasks(),
      AuditLogModel.findAll({
        where: auditWhere,
        order: [['createdAt', 'DESC']],
        limit: 100
      }),
      getGithubSettings(),
      getOidcSettings(),
      getRawApiKeySettings(),
      SnippetModel.findAll({
        attributes: ['id', 'title', 'language', 'updatedAt'],
        order: [['updatedAt', 'DESC']]
      }),
      getAiSettings()
    ]);

    res.status(200).json({
      data: {
        github: publicGithubSettings(github),
        oidc: publicOidcSettings(oidc),
        rawApiKey: publicRawApiKeySettings(rawApiKey),
        ai: publicAiSettings(ai),
        snippets,
        users: users.map(user => publicAccount(user)),
        tasks,
        auditLogs
      }
    });
  }
);

export const generateRawApiKey = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    const { key, settings } = createRawApiKey();

    await setSetting('rawApiKey', settings);
    await auditLog('raw_api_key.generated', {
      ...auditActor(req),
      target: 'rawApiKey'
    });

    res.status(201).json({
      data: {
        key,
        rawApiKey: publicRawApiKeySettings(settings)
      }
    });
  }
);

export const revokeRawApiKey = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    await SettingModel.destroy({ where: { key: 'rawApiKey' } });
    await auditLog('raw_api_key.revoked', {
      ...auditActor(req),
      target: 'rawApiKey'
    });

    res.status(200).json({
      data: {
        rawApiKey: publicRawApiKeySettings(null)
      }
    });
  }
);

export const updateOidcSettings = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    const existing = await getOidcSettings();
    const matchMode = String(req.body.matchMode || 'subject_or_email');
    const settings = {
      ...defaultOidcSettings(),
      ...existing,
      enabled: Boolean(req.body.enabled),
      issuerUrl: String(req.body.issuerUrl || '').trim(),
      clientId: String(req.body.clientId || '').trim(),
      clientSecret: req.body.clientSecret
        ? String(req.body.clientSecret).trim()
        : existing.clientSecret,
      redirectUri: String(req.body.redirectUri || '').trim(),
      scopes: String(req.body.scopes || 'openid email profile').trim(),
      subjectClaim: String(req.body.subjectClaim || 'sub').trim(),
      emailClaim: String(req.body.emailClaim || 'email').trim(),
      nameClaim: String(req.body.nameClaim || 'name').trim(),
      matchMode: ['subject', 'email', 'subject_or_email'].includes(matchMode)
        ? (matchMode as OidcMatchMode)
        : 'subject_or_email',
      allowSignup: Boolean(req.body.allowSignup),
      localLoginEnabled: req.body.localLoginEnabled !== false,
      provider: persistOidcProvider(req.body.provider, existing.provider),
      providerName: persistOidcProviderName(
        req.body.providerName,
        existing.providerName
      )
    };

    await setSharedSetting('oidc', settings);
    await auditLog('oidc.updated', {
      ...auditActor(req),
      metadata: publicOidcSettings(settings)
    });

    res.status(200).json({ data: publicOidcSettings(settings) });
  }
);

export const testOidcSettings = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    const existing = await getOidcSettings();
    const settings = {
      ...existing,
      issuerUrl: String(req.body.issuerUrl || existing.issuerUrl).trim(),
      clientId: String(req.body.clientId || existing.clientId).trim(),
      clientSecret: req.body.clientSecret
        ? String(req.body.clientSecret).trim()
        : existing.clientSecret,
      redirectUri: String(req.body.redirectUri || existing.redirectUri).trim(),
      scopes: String(req.body.scopes || existing.scopes).trim()
    };

    if (!settings.issuerUrl || !settings.clientId || !settings.redirectUri) {
      throw new ErrorResponse(400, 'Issuer URL, client ID, and redirect URI are required');
    }

    const issuer = await Issuer.discover(settings.issuerUrl);
    const client = new issuer.Client({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      redirect_uris: [settings.redirectUri],
      response_types: ['code']
    });
    const authorizationUrl = client.authorizationUrl({
      scope: settings.scopes || 'openid email profile',
      state: 'admin-test',
      nonce: 'admin-test'
    });

    res.status(200).json({
      data: {
        ok: true,
        issuer: issuer.issuer,
        authorizationEndpoint: issuer.metadata.authorization_endpoint,
        tokenEndpoint: issuer.metadata.token_endpoint,
        userinfoEndpoint: issuer.metadata.userinfo_endpoint || null,
        authorizationUrl
      }
    });
  }
);

export const updateGithubSettings = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    const existing = await getGithubSettings();
    const settings: GithubSettings = {
      token: req.body.token ? String(req.body.token).trim() : existing.token,
      owner: String(req.body.owner || '').trim(),
      repo: String(req.body.repo || '').trim(),
      branch: String(req.body.branch || 'main').trim(),
      path: String(req.body.path || 'snippets').trim()
    };

    await setSetting('github', settings);
    await auditLog('github.updated', {
      ...auditActor(req),
      metadata: publicGithubSettings(settings)
    });

    res.status(200).json({ data: publicGithubSettings(settings) });
  }
);

export const updateAiSettings = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    const existing = await getAiSettings();
    const openai = req.body.openai || {};
    const anthropic = req.body.anthropic || {};
    const settings = {
      openai: {
        ...existing.openai,
        enabled: Boolean(openai.enabled),
        model: resolveCodexModel(openai.model || existing.openai.model)
      },
      anthropic: {
        ...existing.anthropic,
        enabled: Boolean(anthropic.enabled),
        model: resolveClaudeModel(
          anthropic.model || existing.anthropic.model
        )
      }
    };

    await saveAiSettings(settings);
    await auditLog('ai.updated', {
      ...auditActor(req),
      metadata: publicAiSettings(settings)
    });

    res.status(200).json({ data: publicAiSettings(settings) });
  }
);

export const startOpenaiAiLogin = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = await startCodexDeviceLogin();
      await auditLog('ai.login.started', {
        ...auditActor(req),
        metadata: { provider: 'openai' }
      });
      res.status(200).json({ data });
    } catch (err) {
      return next(
        new ErrorResponse(
          400,
          err instanceof Error ? err.message : 'Could not start ChatGPT sign-in'
        )
      );
    }
  }
);

export const pollOpenaiAiLogin = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = await pollCodexDeviceLogin();

      if (data.connected) {
        await auditLog('ai.login.connected', {
          ...auditActor(req),
          metadata: { provider: 'openai' }
        });
      }

      res.status(200).json({ data });
    } catch (err) {
      return next(
        new ErrorResponse(
          400,
          err instanceof Error ? err.message : 'ChatGPT sign-in failed'
        )
      );
    }
  }
);

export const startAnthropicAiLogin = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    const data = startClaudeLogin();
    await auditLog('ai.login.started', {
      ...auditActor(req),
      metadata: { provider: 'anthropic' }
    });
    res.status(200).json({ data });
  }
);

export const completeAnthropicAiLogin = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await completeClaudeLogin(String(req.body.code || ''));
      await auditLog('ai.login.connected', {
        ...auditActor(req),
        metadata: { provider: 'anthropic' }
      });
      res.status(200).json({ data: { connected: true } });
    } catch (err) {
      return next(
        new ErrorResponse(
          400,
          err instanceof Error ? err.message : 'Claude sign-in failed'
        )
      );
    }
  }
);

export const disconnectAiLogin = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    const provider =
      String(req.params.provider || '').trim() === 'anthropic'
        ? 'anthropic'
        : 'openai';
    await disconnectAiProvider(provider);
    await auditLog('ai.login.disconnected', {
      ...auditActor(req),
      metadata: { provider }
    });
    res.status(200).json({ data: { connected: false } });
  }
);

export const testAiSettings = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const existing = await getAiSettings();
    const provider =
      String(req.body.provider || '').trim() === 'anthropic'
        ? 'anthropic'
        : 'openai';
    const incoming = req.body[provider] || {};
    const model =
      String(incoming.model || '').trim() || existing[provider].model;

    try {
      const result = await testAiProvider(provider, model);
      await createServerTask(
        'Test AI assistant',
        'done',
        `Tested ${provider === 'anthropic' ? 'Claude' : 'Codex'} (${result.model}).`
      );
      await auditLog('ai.tested', {
        ...auditActor(req),
        metadata: { provider, model: result.model, ok: result.ok }
      });
      res.status(200).json({ data: result });
    } catch (err) {
      return next(
        new ErrorResponse(
          400,
          err instanceof Error ? err.message : 'AI test failed'
        )
      );
    }
  }
);

export const testGithubSettings = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    const existing = await getGithubSettings();
    const settings = {
      ...existing,
      token: req.body.token ? String(req.body.token).trim() : existing.token,
      owner: String(req.body.owner || existing.owner).trim(),
      repo: String(req.body.repo || existing.repo).trim(),
      branch: String(req.body.branch || existing.branch || 'main').trim()
    };
    const result = await testGithubRepositoryAccess(settings);

    await auditLog('github.tested', {
      ...auditActor(req),
      metadata: result
    });

    res.status(200).json({ data: result });
  }
);

export const createUser = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const displayName = String(req.body.displayName || '').trim();
    const password = String(req.body.password || '');
    const role = req.body.isOwner
      ? 'owner'
      : normalizeRole(req.body.role);

    if (!email || !displayName || password.length < 10) {
      return next(
        new ErrorResponse(
          400,
          'Email, display name, and a password of at least 10 characters are required'
        )
      );
    }

    const user = await UserModel.create({
      email,
      displayName,
      passwordHash: await bcrypt.hash(password, 12),
      isOwner: role === 'owner',
      role
    });
    await auditLog('user.created', {
      ...auditActor(req),
      target: `user:${user.id}`,
      metadata: { email, role }
    });

    res.status(201).json({
      data: publicAccount(user)
    });
  }
);

export const updateUser = asyncWrapper(
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const user = await UserModel.findByPk(Number(req.params.id));

    if (!user) {
      return next(new ErrorResponse(404, 'User not found'));
    }

    const role = normalizeRole(req.body.role, isOwnerAccount(user) ? 'owner' : 'editor');

    if (isOwnerAccount(user) && role !== 'owner') {
      const otherOwners = await countOtherOwners(user.id);

      if (otherOwners === 0) {
        return next(new ErrorResponse(400, 'Cannot demote the last owner'));
      }
    }

    user.role = role;
    user.isOwner = role === 'owner';
    await user.save();
    await auditLog('user.updated', {
      ...auditActor(req),
      target: `user:${user.id}`,
      metadata: { role }
    });

    res.status(200).json({
      data: publicAccount(user)
    });
  }
);

export const deleteUser = asyncWrapper(
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const user = await UserModel.findByPk(Number(req.params.id));

    if (!user) {
      return next(new ErrorResponse(404, 'User not found'));
    }

    if (req.user?.id === user.id) {
      return next(new ErrorResponse(400, 'You cannot delete your own account'));
    }

    if (isOwnerAccount(user) && (await countOtherOwners(user.id)) === 0) {
      return next(new ErrorResponse(400, 'Cannot delete the last owner'));
    }

    await user.destroy();
    await auditLog('user.deleted', {
      ...auditActor(req),
      target: `user:${user.id}`,
      metadata: { email: user.email }
    });

    res.status(200).json({
      data: { id: user.id }
    });
  }
);

export const uploadSnippetsToGithub = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    const settings = await getGithubSettings();
    const dryRun = Boolean(req.body.dryRun);
    const overwriteMode = req.body.overwriteMode === 'skip' ? 'skip' : 'overwrite';
    const selectedIds = Array.isArray(req.body.snippetIds)
      ? req.body.snippetIds.map((id: unknown) => Number(id)).filter(Boolean)
      : [];

    if (!settings.token || !settings.owner || !settings.repo) {
      throw new ErrorResponse(400, 'GitHub repo is not configured');
    }

    const task = await createServerTask(
      'Upload snippets to GitHub',
      'doing',
        dryRun
          ? 'Planning GitHub upload without writing files.'
          : 'Uploading snippets to configured GitHub repository.'
      );
    await auditLog('github.upload.started', {
      ...auditActor(req),
      target: 'github'
    });

    try {
      const snippets = await SnippetModel.findAll({
        ...(selectedIds.length > 0 ? { where: { id: { [Op.in]: selectedIds } } } : {}),
        include: {
          model: TagModel,
          as: 'tags',
          attributes: ['name'],
          through: { attributes: [] }
        }
      });
      const plannedFiles = snippets.flatMap(snippet =>
        buildGithubFilesForSnippet(snippet.get({ plain: true }), settings)
      );
      const files = [];
      const skipped = [];
      const secretWarnings = snippets
        .map(snippet => {
          const rawSnippet = snippet.get({ plain: true });
          const findings = detectSecretFindings(
            rawSnippet.code,
            rawSnippet.docs,
            rawSnippet.description
          );

          return findings.length
            ? {
                snippetId: rawSnippet.id,
                title: rawSnippet.title,
                findings
              }
            : null;
        })
        .filter(Boolean);

      for (const file of plannedFiles) {
        const existing = await getGithubFileInfo(file.path, settings);

        if (dryRun) {
          files.push({
            path: file.path,
            snippetId: file.snippetId,
            title: file.title,
            status: existing ? 'would-update' : 'would-create'
          });
          continue;
        }

        if (existing && overwriteMode === 'skip') {
          skipped.push({
            path: file.path,
            snippetId: file.snippetId,
            title: file.title,
            status: 'skipped-existing'
          });
          continue;
        }

        files.push(
          await upsertGithubFile(file.path, file.content, file.message, settings)
        );
      }

      await task.update({
        status: 'done',
        description: dryRun
          ? `Dry run planned ${plannedFiles.length} files from ${snippets.length} snippets.`
          : `Uploaded ${snippets.length} snippets, wrote ${files.length} files, skipped ${skipped.length}.`
      });
      await auditLog('github.upload.done', {
        ...auditActor(req),
        target: 'github',
        metadata: {
          dryRun,
          overwriteMode,
          snippets: snippets.length,
          files: files.length,
          skipped: skipped.length,
          secretWarnings
        }
      });

      res.status(200).json({
        data: {
          task,
          dryRun,
          files,
          skipped,
          secretWarnings
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'GitHub upload failed';
      await task.update({
        status: 'failed',
        description: `GitHub upload failed: ${message}`
      });
      await auditLog('github.upload.failed', {
        ...auditActor(req),
        target: 'github',
        metadata: { message }
      });
      throw new ErrorResponse(400, message);
    }
  }
);

export const downloadSnippetsFromGithub = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    const settings = await getGithubSettings();

    if (!settings.token || !settings.owner || !settings.repo) {
      throw new ErrorResponse(400, 'GitHub repo is not configured');
    }

    const task = await createServerTask(
      'Download snippets from GitHub',
      'doing',
      'Downloading snippets from configured GitHub repository.'
    );
    await auditLog('github.download.started', {
      ...auditActor(req),
      target: 'github'
    });

    try {
      const directories = await getGithubDirectory(settings.path, settings);
      let imported = 0;

      for (const directory of directories.filter(item => item.type === 'dir')) {
        const files = await getGithubDirectory(directory.path, settings);
        const codeFile = files.find(
          file => file.type === 'file' && file.name !== 'README.md'
        );

        if (!codeFile) {
          continue;
        }

        const code = await getGithubFileText(codeFile.path, settings);
        const language = languageForFile(codeFile.name);
        const title = directory.name.replace(/-/g, ' ');
        const parsedTags = tagParser([language, 'github']);
        const snippet = await SnippetModel.create({
          title,
          description: `Imported from GitHub path ${codeFile.path}`,
          language,
          code,
          docs: '',
          isPinned: 0
        });
        await createTags(parsedTags, snippet.id);
        imported += 1;
      }

      await task.update({
        status: 'done',
        description: `Imported ${imported} snippets from GitHub.`
      });
      await auditLog('github.download.done', {
        ...auditActor(req),
        target: 'github',
        metadata: { imported }
      });

      res.status(200).json({ data: task });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'GitHub download failed';
      await task.update({
        status: 'failed',
        description: `GitHub download failed: ${message}`
      });
      await auditLog('github.download.failed', {
        ...auditActor(req),
        target: 'github',
        metadata: { message }
      });
      throw new ErrorResponse(400, message);
    }
  }
);

export const exportLibraryJson = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    const snippets = await SnippetModel.findAll({
      include: {
        model: TagModel,
        as: 'tags',
        attributes: ['name'],
        through: { attributes: [] }
      }
    });
    const data = snippets.map(snippet => {
      const raw = snippet.get({ plain: true });
      return {
        title: raw.title,
        description: raw.description,
        language: raw.language,
        code: raw.code,
        docs: raw.docs,
        isPinned: Boolean(raw.isPinned),
        collection: raw.collection,
        fileName: raw.fileName,
        tags: raw.tags?.map(tag => tag.name) || []
      };
    });

    await createServerTask(
      'Export library JSON',
      'done',
      `Exported ${data.length} snippets.`
    );
    await auditLog('library.exported', {
      ...auditActor(req),
      metadata: { count: data.length }
    });

    res.setHeader('Content-Disposition', 'attachment; filename="snippycode-export.json"');
    res.status(200).json({
      exportedAt: new Date().toISOString(),
      snippets: data
    });
  }
);

export const importLibraryJson = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    if (req.body.preview) {
      res.status(200).json({ data: importPreviewForPayload(req.body) });
      return;
    }

    const snippets = Array.isArray(req.body.snippets) ? req.body.snippets : [];
    let imported = 0;

    for (const item of snippets) {
      const title = String(item.title || '').trim();
      const language = String(item.language || 'plaintext').trim().toLowerCase();
      const code = String(item.code || '');

      if (!title || !code) {
        continue;
      }

      const parsedTags = tagParser([...(item.tags || []), language]);
      const snippet = await SnippetModel.create({
        title,
        language,
        code,
        description: String(item.description || ''),
        docs: String(item.docs || ''),
        isPinned: item.isPinned ? 1 : 0,
        collection: String(item.collection || 'General'),
        fileName: String(item.fileName || '')
      });
      await createTags(parsedTags, snippet.id);
      imported += 1;
    }

    await createServerTask(
      'Import library JSON',
      'done',
      `Imported ${imported} snippets.`
    );
    await auditLog('library.imported', {
      ...auditActor(req),
      metadata: { imported }
    });

    res.status(201).json({ data: { imported } });
  }
);

export const importSnippetBox = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const snippets = await fetchSnippetBoxSnippets({
        url: req.body.url,
        apiKey: req.body.apiKey,
        collection: req.body.collection
      });

      let sourceHost = '';
      try {
        sourceHost = new URL(String(req.body.url || '').trim()).host;
      } catch (err) {
        sourceHost = '';
      }

      await auditLog('library.snippet_box.fetched', {
        ...auditActor(req),
        metadata: {
          host: sourceHost,
          count: snippets.length,
          preview: Boolean(req.body.preview)
        }
      });

      if (req.body.preview) {
        res.status(200).json({
          data: {
            snippets,
            preview: importPreviewForPayload({ snippets })
          }
        });
        return;
      }

      req.body.snippets = snippets;
      return importLibraryJson(req, res, next);
    } catch (err) {
      return next(
        new ErrorResponse(
          400,
          err instanceof Error ? err.message : 'Could not import from Snippet Box'
        )
      );
    }
  }
);
