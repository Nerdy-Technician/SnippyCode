import { Request, Response, NextFunction } from 'express';
import { QueryTypes, Op } from 'sequelize';
import { sequelize } from '../db';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import {
  SnippetModel,
  Snippet_TagModel,
  SnippetVersionModel,
  TagModel
} from '../models';
import {
  ErrorResponse,
  auditLog,
  createRawSnippetToken,
  detectSecretFindings,
  getTags,
  requestIp,
  tagParser,
  createTags,
  verifyRawApiKey,
  verifyTokenHash,
  isSnippetRunEnabled,
  runnerPublicSettings,
  runSnippetCode,
  publicAiAssistStatus,
  runSnippetAssist
} from '../utils';
import { getAiSettings } from '../utils/aiSettings';
import { Body, SearchQuery } from '../typescript/interfaces';

const auditActor = (req: AuthenticatedRequest) => ({
  userId: req.user?.id || null,
  ipAddress: requestIp(req)
});

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 100);

const extensionForLanguage = (language: string): string => {
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

const rawSlugForSnippet = (snippet: {
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

const publicSnippet = (rawSnippet: any, tags?: string[]) => ({
  ...rawSnippet,
  rawTokenHash: undefined,
  rawTokenPrefix: rawSnippet.rawTokenPrefix || null,
  rawTokenConfigured: Boolean(rawSnippet.rawTokenHash),
  isPublic: Boolean(rawSnippet.isPublic),
  tags
});

const snapshotCurrentSnippet = async (
  snippet: {
    id: number;
    title: string;
    description?: string | null;
    language: string;
    code: string;
    docs?: string | null;
  },
  createdBy: number | null
): Promise<void> => {
  const tags = await getTags(snippet.id);

  await SnippetVersionModel.create({
    snippetId: snippet.id,
    title: snippet.title,
    description: snippet.description || '',
    language: snippet.language,
    code: snippet.code,
    docs: snippet.docs || '',
    tags: tags.join(','),
    createdBy
  });
};

const escapeIlike = (value: string): string =>
  value.replace(/[\\%_]/g, char => `\\${char}`);

/**
 * @description Create new snippet
 * @route /api/snippets
 * @request POST
 */
export const createSnippet = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    // Get tags from request body
    const { language, tags: requestTags } = <Body>req.body;
    const parsedRequestTags = tagParser([
      ...requestTags,
      language.toLowerCase()
    ]);

    // Create snippet
    const rawSlug = rawSlugForSnippet(req.body);
    const snippet = await SnippetModel.create({
      ...req.body,
      rawSlug,
      tags: [...parsedRequestTags].join(',')
    });

    // Create tags
    await createTags(parsedRequestTags, snippet.id);

    // Get raw snippet values
    const rawSnippet = snippet.get({ plain: true });

    const secretFindings = detectSecretFindings(
      req.body.code,
      req.body.docs,
      req.body.description
    );

    await auditLog('snippet.created', {
      ...auditActor(req),
      target: `snippet:${snippet.id}`,
      metadata: { title: rawSnippet.title, secretFindings }
    });

    res.status(201).json({
      data: publicSnippet(rawSnippet, [...parsedRequestTags]),
      warnings: secretFindings.map(finding => finding.label)
    });
  }
);

/**
 * @description Get all snippets
 * @route /api/snippets
 * @request GET
 */
export const getAllSnippets = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const snippets = await SnippetModel.findAll({
      include: {
        model: TagModel,
        as: 'tags',
        attributes: ['name'],
        through: {
          attributes: []
        }
      }
    });

    const populatedSnippets = snippets.map(snippet => {
      const rawSnippet = snippet.get({ plain: true });

      return publicSnippet(rawSnippet, rawSnippet.tags?.map(tag => tag.name));
    });

    res.status(200).json({
      data: populatedSnippets
    });
  }
);

/**
 * @description Get single snippet by id
 * @route /api/snippets/:id
 * @request GET
 */
export const getSnippet = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const snippet = await SnippetModel.findOne({
      where: { id: req.params.id },
      include: {
        model: TagModel,
        as: 'tags',
        attributes: ['name'],
        through: {
          attributes: []
        }
      }
    });

    if (!snippet) {
      return next(
        new ErrorResponse(
          404,
          `Snippet with id of ${req.params.id} was not found`
        )
      );
    }

    const rawSnippet = snippet.get({ plain: true });
    const populatedSnippet = {
      ...publicSnippet(rawSnippet, rawSnippet.tags?.map(tag => tag.name))
    };

    res.status(200).json({
      data: populatedSnippet
    });
  }
);

/**
 * @description Update snippet
 * @route /api/snippets/:id
 * @request PUT
 */
export const updateSnippet = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    let snippet = await SnippetModel.findOne({
      where: { id: req.params.id }
    });

    if (!snippet) {
      return next(
        new ErrorResponse(
          404,
          `Snippet with id of ${req.params.id} was not found`
        )
      );
    }

    await snapshotCurrentSnippet(snippet, req.user?.id || null);

    // Get tags from request body
    const { language, tags: requestTags } = <Body>req.body;
    let parsedRequestTags = tagParser([...requestTags, language.toLowerCase()]);

    // Update snippet
    snippet = await snippet.update({
      ...req.body,
      rawSlug: rawSlugForSnippet({ ...req.body, id: snippet.id }),
      tags: [...parsedRequestTags].join(',')
    });

    // Delete old tags and create new ones
    await Snippet_TagModel.destroy({ where: { snippet_id: req.params.id } });
    await createTags(parsedRequestTags, snippet.id);

    // Get raw snippet values
    const rawSnippet = snippet.get({ plain: true });

    const secretFindings = detectSecretFindings(
      req.body.code,
      req.body.docs,
      req.body.description
    );

    await auditLog('snippet.updated', {
      ...auditActor(req),
      target: `snippet:${snippet.id}`,
      metadata: { title: rawSnippet.title, secretFindings }
    });

    res.status(200).json({
      data: publicSnippet(rawSnippet, [...parsedRequestTags]),
      warnings: secretFindings.map(finding => finding.label)
    });
  }
);

/**
 * @description Delete snippet
 * @route /api/snippets/:id
 * @request DELETE
 */
export const deleteSnippet = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const snippet = await SnippetModel.findOne({
      where: { id: req.params.id }
    });

    if (!snippet) {
      return next(
        new ErrorResponse(
          404,
          `Snippet with id of ${req.params.id} was not found`
        )
      );
    }

    await Snippet_TagModel.destroy({ where: { snippet_id: req.params.id } });
    await SnippetVersionModel.destroy({ where: { snippetId: req.params.id } });
    await snippet.destroy();

    await auditLog('snippet.deleted', {
      ...auditActor(req),
      target: `snippet:${req.params.id}`
    });

    res.status(200).json({
      data: {}
    });
  }
);

/**
 * @description Count tags
 * @route /api/snippets/statistics/count
 * @request GET
 */
export const countTags = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const result = await sequelize.query(
      `SELECT
        COUNT(tags.name) as count,
        tags.name
      FROM snippets_tags
      INNER JOIN tags ON snippets_tags.tag_id = tags.id
      GROUP BY tags.name
      ORDER BY name ASC`,
      {
        type: QueryTypes.SELECT
      }
    );

    res.status(200).json({
      data: result
    });
  }
);

/**
 * @description Get raw snippet code
 * @route /api/snippets/raw/:id
 * @request GET
 */
export const getRawCode = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawRef = String(req.params.rawRef || req.params.id || '');
    const snippet = await SnippetModel.findOne({
      where: Number(rawRef)
        ? { id: Number(rawRef) }
        : { rawSlug: rawRef },
      raw: true
    });

    if (!snippet) {
      return next(
        new ErrorResponse(
          404,
          `Snippet with raw reference ${rawRef} was not found`
        )
      );
    }

    const token = String(req.query.key || req.header('x-api-key') || '');
    const snippetTokenOk = verifyTokenHash(token, snippet.rawTokenHash);
    const globalKeyOk = await verifyRawApiKey(token);

    if (!snippet.isPublic && !snippetTokenOk && !globalKeyOk) {
      return next(
        new ErrorResponse(401, 'Valid snippet raw token or raw API key required')
      );
    }

    res.type('text/plain').status(200).send(snippet.code);
  }
);

export const getPublicSnippet = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawRef = String(req.params.rawRef || '');
    const snippet = await SnippetModel.findOne({
      where: Number(rawRef)
        ? { id: Number(rawRef), isPublic: true }
        : { rawSlug: rawRef, isPublic: true },
      include: {
        model: TagModel,
        as: 'tags',
        attributes: ['name'],
        through: {
          attributes: []
        }
      }
    });

    if (!snippet) {
      return next(new ErrorResponse(404, 'Public snippet was not found'));
    }

    const rawSnippet = snippet.get({ plain: true });

    res.status(200).json({
      data: {
        id: rawSnippet.id,
        title: rawSnippet.title,
        description: rawSnippet.description,
        language: rawSnippet.language,
        code: rawSnippet.code,
        docs: rawSnippet.docs,
        collection: rawSnippet.collection || 'General',
        fileName: rawSnippet.fileName,
        rawSlug: rawSnippet.rawSlug,
        tags: rawSnippet.tags?.map(tag => tag.name) || [],
        updatedAt: rawSnippet.updatedAt
      }
    });
  }
);

export const getSnippetRunner = asyncWrapper(
  async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({
      data: runnerPublicSettings()
    });
  }
);

export const getSnippetAssist = asyncWrapper(
  async (_req: Request, res: Response): Promise<void> => {
    const settings = await getAiSettings();
    res.status(200).json({
      data: publicAiAssistStatus(settings)
    });
  }
);

export const assistSnippet = asyncWrapper(
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const prompt = String(req.body.prompt || '').trim();

    if (!prompt) {
      return next(new ErrorResponse(400, 'A prompt is required'));
    }

    try {
      const { provider, result } = await runSnippetAssist({
        prompt,
        provider: req.body.provider,
        targets: Array.isArray(req.body.targets) ? req.body.targets : undefined,
        snippet: req.body.snippet || {}
      });

      await auditLog('snippet.assist', {
        ...auditActor(req),
        metadata: {
          provider,
          targets: req.body.targets || [],
          prompt: prompt.slice(0, 240)
        }
      });

      res.status(200).json({
        data: {
          provider,
          result
        }
      });
    } catch (err) {
      return next(
        new ErrorResponse(
          400,
          err instanceof Error ? err.message : 'AI assist failed'
        )
      );
    }
  }
);

export const runSnippet = asyncWrapper(
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    if (!isSnippetRunEnabled()) {
      return next(
        new ErrorResponse(
          403,
          'Snippet run is disabled. Set SNIPPET_RUN_ENABLED=true on the server.'
        )
      );
    }

    const snippet = await SnippetModel.findByPk(req.params.id);

    if (!snippet) {
      return next(new ErrorResponse(404, 'Snippet was not found'));
    }

    try {
      const result = await runSnippetCode(snippet.language, snippet.code);
      await auditLog('snippet.ran', {
        ...auditActor(req),
        target: `snippet:${snippet.id}`,
        metadata: {
          language: snippet.language,
          ok: result.ok,
          timedOut: result.timedOut,
          exitCode: result.exitCode
        }
      });

      res.status(200).json({ data: result });
    } catch (err) {
      return next(
        new ErrorResponse(
          400,
          err instanceof Error ? err.message : 'Could not run snippet'
        )
      );
    }
  }
);

export const generateSnippetRawToken = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const snippet = await SnippetModel.findByPk(req.params.id);

    if (!snippet) {
      return next(new ErrorResponse(404, 'Snippet was not found'));
    }

    const rawToken = createRawSnippetToken();
    await snippet.update({
      rawTokenHash: rawToken.hash,
      rawTokenPrefix: rawToken.prefix,
      rawTokenCreatedAt: rawToken.createdAt,
      rawSlug: rawSlugForSnippet(snippet)
    });

    await auditLog('snippet.raw_token.generated', {
      ...auditActor(req),
      target: `snippet:${snippet.id}`
    });

    res.status(201).json({
      data: {
        token: rawToken.token,
        rawSlug: snippet.rawSlug,
        rawTokenPrefix: rawToken.prefix,
        rawTokenConfigured: true
      }
    });
  }
);

export const revokeSnippetRawToken = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const snippet = await SnippetModel.findByPk(req.params.id);

    if (!snippet) {
      return next(new ErrorResponse(404, 'Snippet was not found'));
    }

    await snippet.update({
      rawTokenHash: null,
      rawTokenPrefix: null,
      rawTokenCreatedAt: null
    });

    await auditLog('snippet.raw_token.revoked', {
      ...auditActor(req),
      target: `snippet:${snippet.id}`
    });

    res.status(200).json({ data: { rawTokenConfigured: false } });
  }
);

export const getSnippetVersions = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    const versions = await SnippetVersionModel.findAll({
      where: { snippetId: req.params.id },
      order: [['createdAt', 'DESC']],
      limit: 25
    });

    res.status(200).json({ data: versions });
  }
);

export const restoreSnippetVersion = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const snippetId = Number(req.params.id);
    const versionId = Number(req.params.versionId);

    if (!Number.isSafeInteger(versionId) || versionId <= 0) {
      return next(new ErrorResponse(400, 'Version id must be a positive integer'));
    }

    const snippet = await SnippetModel.findByPk(snippetId);

    if (!snippet) {
      return next(new ErrorResponse(404, `Snippet with id of ${snippetId} was not found`));
    }

    const version = await SnippetVersionModel.findOne({
      where: { id: versionId, snippetId }
    });

    if (!version) {
      return next(new ErrorResponse(404, 'Snippet version was not found'));
    }

    await snapshotCurrentSnippet(snippet, req.user?.id || null);

    const parsedTags = tagParser([
      ...(version.tags ? version.tags.split(',') : []),
      version.language.toLowerCase()
    ]);

    await snippet.update({
      title: version.title,
      description: version.description || '',
      language: version.language,
      code: version.code,
      docs: version.docs || '',
      rawSlug: rawSlugForSnippet({
        id: snippet.id,
        title: version.title,
        language: version.language,
        fileName: snippet.fileName
      })
    });

    await Snippet_TagModel.destroy({ where: { snippet_id: snippetId } });
    await createTags(parsedTags, snippet.id);

    const rawSnippet = snippet.get({ plain: true });

    await auditLog('snippet.restored', {
      ...auditActor(req),
      target: `snippet:${snippet.id}`,
      metadata: { versionId: version.id, title: version.title }
    });

    res.status(200).json({
      data: publicSnippet(rawSnippet, [...parsedTags])
    });
  }
);

/**
 * @description Search snippets
 * @route /api/snippets/search
 * @request POST
 */
export const searchSnippets = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { query, tags = [], languages, collections = [] } = <SearchQuery>req.body;
    const searchTags = Array.isArray(tags) ? tags : [];
    const searchLanguages = Array.isArray(languages) ? languages : [];
    const searchCollections = Array.isArray(collections) ? collections : [];
    const trimmedQuery = typeof query === 'string' ? query.trim() : '';

    if (
      !trimmedQuery &&
      !searchTags.length &&
      !searchLanguages.length &&
      !searchCollections.length
    ) {
      res.status(200).json({
        data: []
      });

      return;
    }

    const filters: { [key: string]: unknown }[] = [];

    if (trimmedQuery) {
      const like = `%${escapeIlike(trimmedQuery)}%`;

      filters.push({
        [Op.or]: [
          { title: { [Op.iLike]: like } },
          { description: { [Op.iLike]: like } },
          { code: { [Op.iLike]: like } },
          { docs: { [Op.iLike]: like } }
        ]
      });
    }

    if (searchLanguages.length) {
      filters.push({ language: { [Op.in]: searchLanguages } });
    }

    if (searchCollections.length) {
      const wantsGeneral = searchCollections.some(
        name => name.toLowerCase() === 'general'
      );
      const namedCollections = searchCollections.filter(
        name => name.toLowerCase() !== 'general'
      );
      const collectionFilters: { [key: string]: unknown }[] = [];

      if (namedCollections.length) {
        collectionFilters.push({ collection: { [Op.in]: namedCollections } });
      }

      if (wantsGeneral) {
        collectionFilters.push(
          { collection: 'General' },
          { collection: '' },
          { collection: null }
        );
      }

      filters.push(
        collectionFilters.length === 1
          ? collectionFilters[0]
          : { [Op.or]: collectionFilters }
      );
    }

    const snippets = await SnippetModel.findAll({
      where: filters.length ? { [Op.and]: filters } : undefined,
      include: {
        model: TagModel,
        as: 'tags',
        attributes: ['name'],
        required: false,
        through: {
          attributes: []
        }
      }
    });

    const populatedSnippets = snippets
      .map(snippet => {
        const rawSnippet = snippet.get({ plain: true });
        const tagNames = rawSnippet.tags?.map(tag => tag.name) || [];

        return publicSnippet(rawSnippet, tagNames);
      })
      .filter(snippet => {
        if (!searchTags.length) {
          return true;
        }

        return searchTags.some(tag => (snippet.tags || []).includes(tag));
      });

    res.status(200).json({
      data: populatedSnippets
    });
  }
);

export const renameCollection = asyncWrapper(
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const from = String(req.body.from || '').trim() || 'General';
    const to = String(req.body.to || '').trim();

    if (!to || to.length > 80) {
      return next(new ErrorResponse(400, 'New collection name is required'));
    }

    const where =
      from === 'General'
        ? {
            [Op.or]: [
              { collection: 'General' },
              { collection: '' },
              { collection: null }
            ]
          }
        : { collection: from };

    const [count] = await SnippetModel.update({ collection: to }, { where });

    await auditLog('collection.renamed', {
      ...auditActor(req),
      target: `collection:${from}`,
      metadata: { from, to, count }
    });

    res.status(200).json({
      data: { from, to, count }
    });
  }
);
