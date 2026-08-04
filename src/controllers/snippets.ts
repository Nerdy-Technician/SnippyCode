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
  requestIp,
  tagParser,
  createTags,
  verifyTokenHash
} from '../utils';
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
  tags
});

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

    const existing = snippet.get({ plain: true });

    await SnippetVersionModel.create({
      snippetId: snippet.id,
      title: existing.title,
      description: existing.description || '',
      language: existing.language,
      code: existing.code,
      docs: existing.docs || '',
      tags: typeof existing.tags === 'string' ? existing.tags : '',
      createdBy: req.user?.id || null
    });

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

    if (!verifyTokenHash(token, snippet.rawTokenHash)) {
      return next(new ErrorResponse(401, 'Valid snippet raw token required'));
    }

    res.type('text/plain').status(200).send(snippet.code);
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

/**
 * @description Search snippets
 * @route /api/snippets/search
 * @request POST
 */
export const searchSnippets = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { query, tags, languages } = <SearchQuery>req.body;

    // Check if query is empty
    if (query === '' && !tags.length && !languages.length) {
      res.status(200).json({
        data: []
      });

      return;
    }

    const languageFilter = languages.length
      ? { [Op.in]: languages }
      : { [Op.notIn]: languages };

    const tagFilter = tags.length ? { [Op.in]: tags } : { [Op.notIn]: tags };

    const snippets = await SnippetModel.findAll({
      where: {
        [Op.and]: [
          {
            [Op.or]: [
              { title: { [Op.substring]: `${query}` } },
              { description: { [Op.substring]: `${query}` } }
            ]
          },
          {
            language: languageFilter
          }
        ]
      },
      include: {
        model: TagModel,
        as: 'tags',
        attributes: ['name'],
        where: {
          name: tagFilter
        },
        through: {
          attributes: []
        }
      }
    });

    res.status(200).json({
      data: snippets
    });
  }
);
