import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { QueryTypes, Op } from 'sequelize';
import { sequelize } from '../db';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import {
  DeviceModel,
  SnippetInstance,
  SnippetModel,
  Snippet_TagModel,
  SnippetVersionModel,
  TagModel,
  VariableModel,
  SiteModel
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
  checkTokenHash,
  isSnippetRunEnabled,
  runnerPublicSettings,
  publicAiAssistStatus,
  runSnippetAssist,
  buildPowerShellRemoteCommand,
  buildRawUrl,
  isPowerShellLanguage,
  parseRawRef,
  RawRefLookup,
  rawRefForSnippet,
  rawSlugForSnippet,
  resolvePublicBaseUrl,
  attachSnippetUsage,
  recordSnippetUsage,
  setSnippetFavorite,
  renderTemplateSafe,
  TemplateValueError,
  VARIABLE_NAME_PATTERN,
  findAccessibleSite,
  renderSnippetFor,
  runAndRecord,
  announceRun,
  queueAgentJob,
  lintAvailability,
  lintCode,
  deviceVariableValues,
  explainSnippet,
  convertSnippet,
  searchByMeaning,
  accessibleSiteIds,
  REFERENCE_SOURCES
} from '../utils';
import {
  approvalJson,
  isAdminRole,
  rawNames,
  approvalReasons,
  assertApprovalFresh,
  contentHash,
  dangerousContent,
  isSnippetDangerous,
  approvedRunId,
  getApprovalSettings,
  registerApprovalExecutor,
  replayHandler,
  requestApproval
} from '../utils';
import { getAiSettings } from '../utils/aiSettings';
import { Body, SearchQuery, SnippetCreationAttributes } from '../typescript/interfaces';

const auditActor = (req: AuthenticatedRequest) => ({
  userId: req.user?.id || null,
  ipAddress: requestIp(req)
});

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

const withUsage = async <T extends { id: number }>(
  req: AuthenticatedRequest,
  snippet: T
) => (await attachSnippetUsage([snippet], req.user?.id))[0];

const trackUsage = (
  snippetId: number,
  kind: 'view' | 'copy' | 'raw' | 'run',
  userId?: number | null
): void => {
  // Counters are best effort and never fail the request
  recordSnippetUsage(snippetId, kind, userId).catch(() => undefined);
};

/**
 * Explicit values for {{NAME}} placeholders, from a query string or JSON body.
 */
const readVariableValues = (input: unknown): Record<string, string> => {
  const values: Record<string, string> = {};

  if (!input || typeof input !== 'object') {
    return values;
  }

  Object.entries(input as Record<string, unknown>).forEach(([name, value]) => {
    if (VARIABLE_NAME_PATTERN.test(name) && typeof value === 'string') {
      values[name] = value;
    }
  });

  return values;
};

/**
 * Single source of truth for share visibility. /s/ (via
 * /api/snippets/public/:rawRef) and tokenless /raw/:rawRef both resolve
 * snippets through this lookup, so a snippet is reachable without a token
 * exactly when it is public. There is no share expiry in SnippyCode; add it
 * here if it is ever introduced.
 */
const sharedSnippetWhere = (lookup: RawRefLookup) => ({ ...lookup, isPublic: true });

const sendPlainText = (res: Response, body: string): void => {
  res
    .status(200)
    .set({
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Content-Disposition': 'inline'
    })
    .send(body);
};

const auditVisibilityChange = async (
  req: AuthenticatedRequest,
  snippetId: number,
  before: boolean,
  after: boolean
): Promise<void> => {
  if (before === after) {
    return;
  }

  await auditLog('snippet.visibility_changed', {
    ...auditActor(req),
    target: `snippet:${snippetId}`,
    metadata: { from: before ? 'public' : 'private', to: after ? 'public' : 'private' }
  });
};

/**
 * @description Create new snippet
 * @route /api/snippets
 * @request POST
 */
export const createSnippet = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    // Apply create defaults for optional fields the client left out
    const createDefaults: { [key: string]: unknown } = {
      description: '',
      docs: '',
      isPinned: 0,
      tags: [],
      collection: 'General',
      fileName: '',
      isPublic: false
    };
    const { tags: requestTags = [], ...values } = {
      ...createDefaults,
      ...req.body
    } as Body;
    const parsedRequestTags = tagParser([
      ...requestTags,
      values.language.toLowerCase()
    ]);

    // Only admins may mark a variable raw (inserted unquoted)
    if (!isAdminRole(req.user?.role) && rawNames((values as any).variables).length) {
      return next(new ErrorResponse(403, 'Only admins can mark a variable raw (unquoted)'));
    }

    // Create snippet
    const rawSlug = rawSlugForSnippet(values);
    const snippet = await SnippetModel.create({
      ...(values as SnippetCreationAttributes),
      rawSlug
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
      data: await withUsage(req, publicSnippet(rawSnippet, [...parsedRequestTags])),
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
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
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
      data: await attachSnippetUsage(populatedSnippets, req.user?.id)
    });
  }
);

/**
 * @description Get single snippet by id
 * @route /api/snippets/:id
 * @request GET
 */
export const getSnippet = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
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
      data: await withUsage(req, populatedSnippet)
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

    const wasPublic = Boolean(snippet.isPublic);
    // Fields left out of the body keep their stored value (see
    // validateSnippetBody); tags too, when the client does not send them.
    // The dangerous flag has its own endpoint (only admins may clear it)
    const body = { ...req.body };
    delete body.dangerous;
    // Only admins may mark a variable raw (inserted unquoted). A non-admin
    // save keeps an admin's raw flags only while the code is unchanged;
    // otherwise they are dropped and those values are quoted again
    if (!isAdminRole(req.user?.role) && body.variables !== undefined) {
      const before = new Set(rawNames(snippet.variables));
      const asked = rawNames(body.variables);
      if (asked.some(name => !before.has(name))) {
        return next(new ErrorResponse(403, 'Only admins can mark a variable raw (unquoted)'));
      }
      if (body.code !== undefined && body.code !== snippet.code) {
        body.variables = (body.variables as any[]).map(({ raw: _raw, ...def }) => def);
      }
    }
    const { tags: bodyTags, ...values } = <Body>body;
    const requestTags = bodyTags ?? (await getTags(snippet.id));
    const parsedRequestTags = tagParser([...requestTags, values.language.toLowerCase()]);

    // Update snippet
    snippet = await snippet.update({
      ...values,
      rawSlug: rawSlugForSnippet({
        id: snippet.id,
        title: values.title,
        language: values.language,
        fileName: values.fileName !== undefined ? values.fileName : snippet.fileName
      })
    });

    // Delete old tags and create new ones
    await Snippet_TagModel.destroy({ where: { snippet_id: req.params.id } });
    await createTags(parsedRequestTags, snippet.id);
    await auditVisibilityChange(req, snippet.id, wasPublic, Boolean(snippet.isPublic));

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
      data: await withUsage(req, publicSnippet(rawSnippet, [...parsedRequestTags])),
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
 * @description Update only the pin and public flags of a snippet
 * @route /api/snippets/:id
 * @request PATCH
 */
export const patchSnippetFlags = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const snippet = await SnippetModel.findByPk(Number(req.params.id), {
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
        new ErrorResponse(404, `Snippet with id of ${req.params.id} was not found`)
      );
    }

    const wasPublic = Boolean(snippet.isPublic);
    const changes = <{ isPinned?: number; isPublic?: boolean; dangerous?: boolean }>{ ...req.body };
    delete changes.dangerous;

    await snippet.update(changes);

    const rawSnippet = snippet.get({ plain: true });

    await auditLog('snippet.updated', {
      ...auditActor(req),
      target: `snippet:${snippet.id}`,
      metadata: { title: rawSnippet.title, fields: Object.keys(changes) }
    });
    await auditVisibilityChange(req, snippet.id, wasPublic, Boolean(snippet.isPublic));

    res.status(200).json({
      data: publicSnippet(rawSnippet, rawSnippet.tags?.map(tag => tag.name))
    });
  }
);

/**
 * @description Get raw snippet code as text/plain.
 * Public snippets are served to anyone, exactly like the /s/ share page.
 * Private snippets need their snippet raw token or the admin raw API key
 * (?key= or x-api-key). Anything else is a 404, so private snippets are
 * indistinguishable from missing ones.
 * @route /raw/:rawRef and /api/snippets/raw/:rawRef
 * @request GET
 */
export const getRawCode = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawRef = String(req.params.rawRef || req.params.id || '');
    const lookup = parseRawRef(rawRef);
    const notFound = () =>
      next(new ErrorResponse(404, `Snippet with raw reference ${rawRef} was not found`));

    if (!lookup) {
      return notFound();
    }

    const token = String(req.query.key || req.header('x-api-key') || '');
    const globalKeyOk = await verifyRawApiKey(token);

    // A valid snippet token or the admin raw API key unlocks private snippets
    // and server-side values (site, team, secrets) for rendering
    // verifyRawApiKey and verifyTokenHash reject empty tokens themselves
    const candidates = await SnippetModel.findAll({
      where: lookup,
      order: [['id', 'ASC']],
      raw: true
    });
    let tokenMatch: (typeof candidates)[number] | undefined;

    for (const candidate of candidates) {
      if (globalKeyOk) {
        tokenMatch = candidate;
        break;
      }

      const check = await checkTokenHash(token, candidate.rawTokenHash);

      if (check.ok) {
        // Replace a migrated pre-v1.2.2 hash with a plain scrypt one
        if (check.upgrade) {
          await SnippetModel.update({ rawTokenHash: check.upgrade }, { where: { id: candidate.id } });
        }
        tokenMatch = candidate;
        break;
      }
    }

    // Public snippets are served to anyone, exactly like the /s/ share page
    const shared = tokenMatch
      ? null
      : await SnippetModel.findOne({
          where: sharedSnippetWhere(lookup),
          order: [['id', 'ASC']],
          raw: true
        });

    const snippet = tokenMatch || shared;

    if (!snippet) {
      return notFound();
    }

    const snippetTokenOk = Boolean(tokenMatch);

    // ?render=0 returns the stored template. Otherwise placeholders are filled
    // from query values, then site and team values including secrets (token or
    // key holders only, so anonymous public fetches never see them), then
    // inline defaults.
    const authorized = snippetTokenOk || globalKeyOk;
    const explicit = readVariableValues(req.query);
    let siteId: number | null = null;

    if (req.query.site !== undefined) {
      if (!authorized) {
        return next(new ErrorResponse(401, 'Site values need a snippet raw token or raw API key'));
      }

      // The admin API key reaches every site; a snippet token only open sites
      const site = await findAccessibleSite(
        { role: globalKeyOk ? 'admin' : undefined },
        req.query.site
      );

      if (!site) {
        return next(new ErrorResponse(404, 'Site was not found'));
      }

      siteId = site.id;
    }

    // Values are type-checked and quoted for the snippet's language
    let body = snippet.code;
    if (req.query.render !== '0') {
      if (authorized) {
        const rendered = await renderSnippetFor({
          code: snippet.code,
          language: snippet.language,
          definitions: snippet.variables,
          siteId,
          explicit,
          includeSecrets: true
        });
        if (rendered.errors.length) return next(new ErrorResponse(400, rendered.errors.join('; ')));
        body = rendered.code;
      } else {
        try {
          body = renderTemplateSafe(snippet.code, { language: snippet.language, raw: rawNames(snippet.variables) }, explicit);
        } catch (err) {
          if (err instanceof TemplateValueError) return next(new ErrorResponse(400, err.message));
          throw err;
        }
      }
    }

    trackUsage(snippet.id, 'raw');

    res.set('X-Content-SHA256', createHash('sha256').update(body, 'utf8').digest('hex'));
    sendPlainText(res, body);
  }
);

/**
 * @description Get a public snippet for the /s/:rawRef share page
 * @route /api/snippets/public/:rawRef
 * @request GET
 */
export const getPublicSnippet = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const lookup = parseRawRef(req.params.rawRef);
    const snippet = lookup
      ? await SnippetModel.findOne({
          where: sharedSnippetWhere(lookup),
          order: [['id', 'ASC']],
          include: {
            model: TagModel,
            as: 'tags',
            attributes: ['name'],
            through: {
              attributes: []
            }
          }
        })
      : null;

    if (!snippet) {
      return next(new ErrorResponse(404, 'Public snippet was not found'));
    }

    const rawSnippet = snippet.get({ plain: true });
    const baseUrl = resolvePublicBaseUrl(req);
    const rawUrl = buildRawUrl(baseUrl, rawRefForSnippet(rawSnippet));

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
        updatedAt: rawSnippet.updatedAt,
        rawUrl,
        powerShellCommand: isPowerShellLanguage(rawSnippet.language)
          ? buildPowerShellRemoteCommand(rawUrl)
          : null
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

/** Values that fail their type, or required ones still missing */
const variableProblem = (rendered: { errors: string[]; missingRequired: string[] }): string | null => {
  const problems = [...rendered.errors, ...rendered.missingRequired.map(name => `${name} needs a value`)];
  return problems.length ? problems.join('; ') : null;
};

/**
 * @description Flag a snippet as dangerous (its runs need approval).
 * Editors can set the flag; only admins can clear it.
 * @route /api/snippets/:id/dangerous
 * @request PUT
 */
export const setSnippetDangerous = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const snippet = await SnippetModel.findByPk(Number(req.params.id));

    if (!snippet) {
      return next(new ErrorResponse(404, 'Snippet was not found'));
    }

    const dangerous = Boolean(req.body?.dangerous);
    if (!dangerous && snippet.dangerous && !isAdminRole(req.user?.role)) {
      return next(new ErrorResponse(403, 'Only admins can clear the dangerous flag'));
    }

    if (dangerous !== snippet.dangerous) {
      await snippet.update({ dangerous });
      await auditLog(dangerous ? 'snippet.flagged_dangerous' : 'snippet.unflagged_dangerous', {
        ...auditActor(req),
        target: `snippet:${snippet.id}`,
        metadata: { title: snippet.title }
      });
    }

    res.status(200).json({ data: { id: snippet.id, dangerous } });
  }
);

/**
 * Dangerous snippets and large runs wait for an admin. Responds 202 with the
 * approval request and returns true when the run was held.
 */
const holdForApproval = async (
  req: AuthenticatedRequest,
  res: Response,
  snippet: SnippetInstance,
  site: { id: number; name: string } | null,
  targets: Array<{ type: 'device' | 'site'; id: number | null; name: string }>
): Promise<boolean> => {
  // Exactly what would run: re-computed on replay and compared (TOCTOU)
  const hash = contentHash({
    kind: 'snippet',
    id: snippet.id,
    language: snippet.language,
    code: snippet.code,
    definitions: snippet.variables || [],
    values: readVariableValues(req.body?.variables),
    siteId: site?.id || null,
    targets: targets.map(target => `${target.type}:${target.id}`).sort()
  });
  const approved = approvedRunId(req);
  if (approved) {
    await assertApprovalFresh(approved, hash);
    return false;
  }
  // A server run reaches one machine; device runs count every device queued
  const why = approvalReasons({ dangerous: isSnippetDangerous(snippet), targetCount: targets.length }, await getApprovalSettings());
  if (!why.length) return false;
  const rules = dangerousContent(snippet.code);

  const approval = await requestApproval({
    kind: 'snippet',
    title: snippet.title,
    why,
    requestedBy: req.user?.id || null,
    reason: req.body?.reason,
    snippetId: snippet.id,
    siteId: site?.id || null,
    targets,
    targetCount: targets.length,
    payload: { siteId: req.body?.siteId, deviceIds: req.body?.deviceIds, variables: req.body?.variables },
    ipAddress: requestIp(req),
    contentHash: hash,
    contentPreview: `${rules.length ? `# Matched rules: ${rules.join(', ')}\n` : ''}# ${snippet.language}\n${snippet.code}`,
    siteIds: site ? [site.id] : []
  });
  res.status(202).json({ data: { approval: approvalJson(approval) } });
  return true;
};

export const runSnippet = asyncWrapper(
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const snippet = await SnippetModel.findByPk(req.params.id);

    if (!snippet) {
      return next(new ErrorResponse(404, 'Snippet was not found'));
    }

    // Devices: queue a job for each chosen device (or every device at the site)
    if (req.body?.deviceIds !== undefined) {
      const site = await findAccessibleSite(req.user || {}, req.body?.siteId);

      if (!site) {
        return next(new ErrorResponse(400, 'Choose a site to run on its devices'));
      }

      const wanted = req.body.deviceIds === 'all'
        ? undefined
        : (Array.isArray(req.body.deviceIds) ? req.body.deviceIds : []).map(Number);
      const devices = await DeviceModel.findAll({
        where: {
          siteId: site.id,
          revokedAt: null,
          // Clones waiting for approval get no jobs
          clonePendingApproval: false,
          ...(wanted ? { id: wanted.length ? wanted : [-1] } : {})
        }
      });

      if (!devices.length) {
        return next(new ErrorResponse(400, `${site.name} has no enrolled devices to run on`));
      }

      const jobs = [];
      let secretsUsed: string[] = [];
      const renders = [];

      // Each device gets its own DEVICE_* values; check them all before queueing any
      for (const device of devices) {
        const rendered = await renderSnippetFor({
          code: snippet.code,
          language: snippet.language,
          definitions: snippet.variables,
          userId: req.user?.id,
          siteId: site.id,
          explicit: readVariableValues(req.body?.variables),
          deviceValues: deviceVariableValues(device, site.name),
          includeSecrets: true
        });
        const problem = variableProblem(rendered);
        if (problem) {
          return next(new ErrorResponse(400, devices.length > 1 ? `${device.name}: ${problem}` : problem));
        }
        renders.push({ device, rendered });
      }

      // Values are checked first, so nobody is asked to approve a run that cannot start
      if (await holdForApproval(req, res, snippet, site, devices.map(d => ({ type: 'device' as const, id: d.id, name: d.name })))) {
        return;
      }

      for (const { device, rendered } of renders) {
        secretsUsed = rendered.secretsUsed;
        jobs.push(
          await queueAgentJob({
            device,
            snippet,
            code: rendered.code,
            secretValues: rendered.secretValues,
            userId: req.user?.id
          })
        );
      }

      await auditLog('snippet.queued_on_devices', {
        ...auditActor(req),
        target: `snippet:${snippet.id}`,
        metadata: {
          site: site.name,
          devices: devices.map(device => device.name),
          secretsUsed
        }
      });

      res.status(202).json({
        data: {
          jobs: jobs.map(job => ({
            id: job.id,
            deviceId: job.deviceId,
            deviceName: devices.find(device => device.id === job.deviceId)?.name || null,
            status: job.status
          }))
        }
      });
      return;
    }

    if (!isSnippetRunEnabled()) {
      return next(
        new ErrorResponse(
          403,
          'Snippet run is disabled. Set SNIPPET_RUN_ENABLED=true on the server.'
        )
      );
    }

    const site = req.body?.siteId
      ? await findAccessibleSite(req.user || {}, req.body.siteId)
      : null;

    if (req.body?.siteId && !site) {
      return next(new ErrorResponse(404, 'Site was not found'));
    }

    try {
      const rendered = await renderSnippetFor({
        code: snippet.code,
        language: snippet.language,
        definitions: snippet.variables,
        userId: req.user?.id,
        siteId: site?.id,
        explicit: readVariableValues(req.body?.variables),
        includeSecrets: true
      });
      const problem = variableProblem(rendered);
      if (problem) {
        return next(new ErrorResponse(400, problem));
      }
      if (await holdForApproval(req, res, snippet, site, [{ type: 'site', id: site?.id || null, name: site?.name || 'Server' }])) {
        return;
      }
      const run = await runAndRecord({
        snippet,
        code: rendered.code,
        secretValues: rendered.secretValues,
        siteId: site?.id,
        userId: req.user?.id
      });
      trackUsage(snippet.id, 'run', req.user?.id);
      announceRun(run).catch(() => undefined);
      await auditLog('snippet.ran', {
        ...auditActor(req),
        target: `snippet:${snippet.id}`,
        metadata: {
          language: snippet.language,
          ok: run.ok,
          timedOut: run.timedOut,
          exitCode: run.exitCode,
          runId: run.id,
          site: site?.name,
          secretsUsed: rendered.secretsUsed
        }
      });

      res.status(200).json({
        data: {
          runId: run.id,
          ok: run.ok,
          timedOut: run.timedOut,
          exitCode: run.exitCode,
          stdout: run.stdout,
          stderr: run.stderr,
          language: run.language,
          durationMs: run.durationMs,
          sandbox: run.sandbox
        }
      });
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

    const rawToken = await createRawSnippetToken();
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
      data: await withUsage(req, publicSnippet(rawSnippet, [...parsedTags]))
    });
  }
);

/**
 * @description Search snippets
 * @route /api/snippets/search
 * @request POST
 */
export const searchSnippets = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
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
      data: await attachSnippetUsage(populatedSnippets, req.user?.id)
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

/**
 * @description Record a view or copy for usage stats and the user's history
 * @route /api/snippets/:id/activity
 * @request POST
 */
export const recordSnippetActivity = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const type = req.body?.type;

    if (type !== 'view' && type !== 'copy') {
      return next(new ErrorResponse(400, 'Activity type must be view or copy'));
    }

    const snippet = await SnippetModel.findByPk(req.params.id, { attributes: ['id'] });

    if (!snippet) {
      return next(new ErrorResponse(404, 'Snippet was not found'));
    }

    await recordSnippetUsage(snippet.id, type, req.user?.id);

    res.status(200).json({ data: {} });
  }
);

/**
 * @description Star or unstar a snippet for the current user
 * @route /api/snippets/:id/favorite
 * @request PUT
 */
export const setFavorite = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const snippet = await SnippetModel.findByPk(req.params.id, { attributes: ['id'] });

    if (!snippet) {
      return next(new ErrorResponse(404, 'Snippet was not found'));
    }

    const isFavorite = Boolean(req.body?.favorite);
    await setSnippetFavorite(req.user!.id, snippet.id, isFavorite);

    res.status(200).json({ data: { isFavorite } });
  }
);

/**
 * @description Fill a snippet's placeholders for the current user and site,
 * secrets included. Used for copying so secrets never sit in the page.
 * @route /api/snippets/:id/render
 * @request POST
 */
export const renderSnippet = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const snippet = await SnippetModel.findByPk(req.params.id);

    if (!snippet) {
      return next(new ErrorResponse(404, 'Snippet was not found'));
    }

    const site = req.body?.siteId
      ? await findAccessibleSite(req.user || {}, req.body.siteId)
      : null;

    if (req.body?.siteId && !site) {
      return next(new ErrorResponse(404, 'Site was not found'));
    }

    const rendered = await renderSnippetFor({
      code: snippet.code,
      language: snippet.language,
      definitions: snippet.variables,
      userId: req.user?.id,
      siteId: site?.id,
      explicit: readVariableValues(req.body?.variables),
      includeSecrets: true
    });

    if (req.body?.purpose === 'copy') {
      trackUsage(snippet.id, 'copy', req.user?.id);

      if (rendered.secretsUsed.length) {
        await auditLog('variable.secret_used', {
          ...auditActor(req),
          target: `snippet:${snippet.id}`,
          metadata: { title: snippet.title, site: site?.name, secrets: rendered.secretsUsed }
        });
      }
    }

    res.status(200).json({
      data: {
        code: rendered.code,
        sha256: createHash('sha256').update(rendered.code, 'utf8').digest('hex'),
        secretsUsed: rendered.secretsUsed,
        missing: rendered.missing,
        errors: rendered.errors
      }
    });
  }
);

/**
 * @description Lint code with shellcheck, ruff, or PSScriptAnalyzer
 * @route /api/snippets/lint
 * @request POST
 */
export const lintSnippet = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const language = String(req.body?.language || '');
    const code = typeof req.body?.code === 'string' ? req.body.code : '';

    if (code.length > 100_000) {
      return next(new ErrorResponse(400, 'Code is too large to lint'));
    }

    res.status(200).json({ data: await lintCode(language, code) });
  }
);

export const getLintTools = asyncWrapper(
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(200).json({ data: lintAvailability() });
  }
);

const aiError = (err: unknown) =>
  new ErrorResponse(400, err instanceof Error ? err.message : 'The AI assistant failed');

/**
 * @description Explain what a snippet does and what could go wrong
 * @route /api/snippets/:id/explain
 * @request POST
 */
export const explainSnippetRoute = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const snippet = await SnippetModel.findByPk(req.params.id);

    if (!snippet) {
      return next(new ErrorResponse(404, 'Snippet was not found'));
    }

    try {
      const { provider, result } = await explainSnippet({
        provider: req.body?.provider,
        snippet: {
          title: snippet.title,
          description: snippet.description,
          language: snippet.language,
          code: snippet.code
        }
      });

      await auditLog('snippet.explained', {
        ...auditActor(req),
        target: `snippet:${snippet.id}`,
        metadata: { provider }
      });

      res.status(200).json({ data: { provider, ...result } });
    } catch (err) {
      next(aiError(err));
    }
  }
);

/**
 * @description Convert a snippet to another language (returns the code; the
 * editor decides whether to save it as a new snippet)
 * @route /api/snippets/:id/convert
 * @request POST
 */
export const convertSnippetRoute = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const snippet = await SnippetModel.findByPk(req.params.id);

    if (!snippet) {
      return next(new ErrorResponse(404, 'Snippet was not found'));
    }

    try {
      const { provider, result } = await convertSnippet({
        provider: req.body?.provider,
        targetLanguage: req.body?.language,
        snippet: {
          title: snippet.title,
          description: snippet.description,
          language: snippet.language,
          code: snippet.code
        }
      });

      await auditLog('snippet.converted', {
        ...auditActor(req),
        target: `snippet:${snippet.id}`,
        metadata: { provider, from: snippet.language, to: result.language }
      });

      res.status(200).json({ data: { provider, ...result } });
    } catch (err) {
      next(aiError(err));
    }
  }
);

/**
 * @description Find snippets by meaning with the AI assistant
 * @route /api/snippets/search/meaning
 * @request POST
 */
export const searchByMeaningRoute = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const snippets = await SnippetModel.findAll({
      include: { model: TagModel, as: 'tags', attributes: ['name'], through: { attributes: [] } },
      order: [['updatedAt', 'DESC']]
    });

    try {
      const { provider, results } = await searchByMeaning({
        provider: req.body?.provider,
        query: req.body?.query,
        entries: snippets.map(snippet => {
          const plain = snippet.get({ plain: true });

          return {
            id: plain.id,
            title: plain.title,
            description: plain.description,
            language: plain.language,
            collection: plain.collection,
            tags: plain.tags?.map(tag => tag.name),
            code: plain.code
          };
        })
      });
      const byId = new Map(snippets.map(snippet => [snippet.id, snippet.get({ plain: true })]));
      const matches = results
        .filter(result => byId.has(result.id))
        .map(result => {
          const plain = byId.get(result.id)!;
          return { ...publicSnippet(plain, plain.tags?.map(tag => tag.name)), reason: result.reason };
        });

      res.status(200).json({ data: { provider, results: await attachSnippetUsage(matches, req.user?.id) } });
    } catch (err) {
      next(aiError(err));
    }
  }
);

/**
 * @description Where snippet variable definitions can be imported from:
 * other snippets' definitions, and saved variables (personal, team and the
 * sites you can access) by NAME ONLY, never their values.
 * @route /api/snippets/variable-sources
 * @request GET
 */
export const getVariableSources = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const [snippets, siteIds] = await Promise.all([
      SnippetModel.findAll({ attributes: ['id', 'title', 'variables'], order: [['title', 'ASC']] }),
      accessibleSiteIds(req.user || {})
    ]);
    const saved = await VariableModel.findAll({
      attributes: ['name', 'userId', 'siteId', 'isSecret', 'description'],
      where: {
        [Op.or]: [
          { userId: req.user?.id || -1 },
          { userId: null, siteId: null },
          { userId: null, siteId: siteIds === 'all' ? { [Op.ne]: null } : siteIds.length ? siteIds : [-1] }
        ]
      },
      order: [['name', 'ASC']]
    });
    const sites = await SiteModel.findAll({ attributes: ['id', 'name'] });

    res.status(200).json({
      data: {
        snippets: snippets
          .filter(snippet => (snippet.variables || []).length)
          .map(snippet => ({ id: snippet.id, title: snippet.title, variables: snippet.variables })),
        saved: saved.map(variable => ({
          name: variable.name,
          scope: variable.userId ? 'personal' : variable.siteId ? 'site' : 'team',
          siteName: variable.siteId ? sites.find(site => site.id === variable.siteId)?.name || null : null,
          isSecret: variable.isSecret,
          description: variable.description
        })),
        // Hook: a dedicated secrets store would be listed here too
        sources: REFERENCE_SOURCES
      }
    });
  }
);

registerApprovalExecutor('snippet', async (approval, payload, requester) => {
  const { status, body } = await replayHandler(runSnippet, {
    params: { id: String(approval.snippetId) },
    body: payload,
    user: requester,
    approvalId: approval.id
  });
  const data = body?.data || {};
  return data.jobs
    ? `Queued on ${data.jobs.length} device(s)`
    : `Server run #${data.runId} finished (${status}, exit ${data.exitCode ?? '-'})`;
});
