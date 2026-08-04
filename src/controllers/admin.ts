import bcrypt from 'bcryptjs';
import { Request, Response, NextFunction } from 'express';
import { Issuer } from 'openid-client';
import { Op } from 'sequelize';
import { asyncWrapper } from '../middleware';
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
  upsertGithubFile
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
  publicOidcSettings,
  setSetting as setSharedSetting
} from '../utils/oidcSettings';

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
      auditWhere.action = { [Op.substring]: auditAction };
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

    const [users, tasks, auditLogs, github, oidc, rawApiKey, snippets] = await Promise.all([
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
      TaskModel.findAll({ order: [['createdAt', 'DESC']], limit: 20 }),
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
      })
    ]);

    res.status(200).json({
      data: {
        github: publicGithubSettings(github),
        oidc: publicOidcSettings(oidc),
        rawApiKey: publicRawApiKeySettings(rawApiKey),
        snippets,
        users,
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
      localLoginEnabled: req.body.localLoginEnabled !== false
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
    const role = (['owner', 'admin', 'editor', 'viewer', 'user'].includes(
      String(req.body.role)
    )
      ? String(req.body.role)
      : req.body.isOwner
      ? 'owner'
      : 'user') as 'owner' | 'admin' | 'editor' | 'viewer' | 'user';

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
      data: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        isOwner: user.isOwner,
        role: user.role,
        mfaEnabled: user.mfaEnabled
      }
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

    await auditLog('library.exported', {
      ...auditActor(req),
      metadata: { count: data.length }
    });

    res.setHeader('Content-Disposition', 'attachment; filename=\"snippysafe-export.json\"');
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

    await auditLog('library.imported', {
      ...auditActor(req),
      metadata: { imported }
    });

    res.status(201).json({ data: { imported } });
  }
);
