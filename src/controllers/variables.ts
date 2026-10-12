import { Response, NextFunction } from 'express';
import { Op, UniqueConstraintError } from 'sequelize';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import {
  DeviceModel,
  RunbookModel,
  RunbookStepModel,
  ScheduleModel,
  SiteModel,
  SnippetModel,
  VariableModel,
  VariableInstance
} from '../models';
import {
  ErrorResponse,
  VARIABLE_NAME_PATTERN,
  accessibleSiteIds,
  auditLog,
  canAccessSite,
  decryptVariableValue,
  deviceVariableValues,
  emitEvent,
  encryptVariableValue,
  findTemplateVariables,
  isBoundSecret,
  loadVariableLayers,
  requestIp,
  SECRET_MASK
} from '../utils';

const MAX_VALUE_LENGTH = 10000;
const MAX_DESCRIPTION_LENGTH = 500;

/**
 * Scopes, lowest to highest priority when a snippet is filled:
 * snippet default < global < site < user < runtime prompt.
 * "team" and "personal" are the pre-1.3 names, still accepted.
 */
type Scope = 'global' | 'site' | 'user';

const readScope = (value: unknown): Scope =>
  value === 'global' || value === 'team' ? 'global' : value === 'site' ? 'site' : 'user';

const roleRank: { [key: string]: number } = {
  viewer: 10,
  user: 20,
  editor: 30,
  admin: 40,
  owner: 50
};

const isEditor = (req: AuthenticatedRequest): boolean =>
  (roleRank[req.user?.role || ''] || 0) >= roleRank.editor;

const isAdmin = (req: AuthenticatedRequest): boolean =>
  (roleRank[req.user?.role || ''] || 0) >= roleRank.admin;

const auditActor = (req: AuthenticatedRequest) => ({
  userId: req.user?.id || null,
  ipAddress: requestIp(req)
});

const scopeOf = (variable: { userId: number | null; siteId: number | null }): Scope =>
  variable.userId ? 'user' : variable.siteId ? 'site' : 'global';

// Secret values never leave the server here; use the reveal endpoint
const toJson = (variable: VariableInstance) => {
  const plain = variable.get({ plain: true });

  return {
    id: plain.id,
    name: plain.name,
    value: plain.isSecret ? '' : plain.value,
    description: plain.description,
    scope: scopeOf(plain),
    siteId: plain.siteId,
    isSecret: plain.isSecret,
    hasValue: plain.value !== '',
    updatedAt: plain.updatedAt
  };
};

const readFields = (
  body: any,
  next: NextFunction
): { name: string; value?: string; description: string; isSecret: boolean } | null => {
  const name = String(body.name || '').trim().toUpperCase();
  const value = typeof body.value === 'string' ? body.value : undefined;
  const description =
    typeof body.description === 'string' ? body.description.trim() : '';

  if (!VARIABLE_NAME_PATTERN.test(name)) {
    next(
      new ErrorResponse(
        400,
        'Variable names use A-Z, 0-9, and _, start with a letter, and are at most 64 characters'
      )
    );
    return null;
  }

  if (value !== undefined && value.length > MAX_VALUE_LENGTH) {
    next(new ErrorResponse(400, `Values are limited to ${MAX_VALUE_LENGTH} characters`));
    return null;
  }

  if (description.length > MAX_DESCRIPTION_LENGTH) {
    next(
      new ErrorResponse(400, `Descriptions are limited to ${MAX_DESCRIPTION_LENGTH} characters`)
    );
    return null;
  }

  return { name, value, description, isSecret: Boolean(body.isSecret) };
};

/**
 * User variables belong to their user. Global variables are admin-only.
 * Site variables need an editor with access to that site.
 */
const canChange = async (
  req: AuthenticatedRequest,
  variable: { userId: number | null; siteId: number | null }
): Promise<boolean> => {
  if (variable.userId) {
    return variable.userId === req.user?.id;
  }

  if (!variable.siteId) {
    return isAdmin(req);
  }

  if (!isEditor(req)) {
    return false;
  }

  const site = await SiteModel.findByPk(variable.siteId);
  return Boolean(site && (await canAccessSite(req.user || {}, site)));
};

const permissionMessage = (variable: { userId: number | null; siteId: number | null }): string =>
  variable.siteId
    ? 'Editors with access to this site can change its variables'
    : 'Only admins can change global variables';

const findChangeable = async (
  req: AuthenticatedRequest,
  next: NextFunction
): Promise<VariableInstance | null> => {
  const variable = await VariableModel.findByPk(Number(req.params.id));

  if (!variable || (variable.userId && variable.userId !== req.user?.id)) {
    next(new ErrorResponse(404, 'Variable was not found'));
    return null;
  }

  if (!(await canChange(req, variable))) {
    next(new ErrorResponse(403, permissionMessage(variable)));
    return null;
  }

  return variable;
};

// Secrets are bound to their row (AAD), so the row must exist first
const storedValue = (id: number, value: string, isSecret: boolean): string =>
  isSecret ? encryptVariableValue(id, value) : value;

const duplicateName = (name: string, scope: Scope) =>
  new ErrorResponse(409, `A ${scope} variable named ${name} already exists`);

/**
 * @description Team, site, and the current user's personal variables
 * @route /api/variables
 * @request GET
 */
export const getVariables = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const siteIds = await accessibleSiteIds(req.user || {});
    const variables = await VariableModel.findAll({
      where: {
        [Op.or]: [
          { userId: null, siteId: null },
          { userId: req.user?.id || -1 },
          siteIds === 'all'
            ? { siteId: { [Op.ne]: null } }
            : { siteId: siteIds.length ? siteIds : [-1] }
        ]
      },
      order: [['name', 'ASC']]
    });
    const items = variables.map(toJson);
    const global = items.filter(item => item.scope === 'global');
    const user = items.filter(item => item.scope === 'user');

    res.status(200).json({
      data: {
        global,
        site: items.filter(item => item.scope === 'site'),
        user,
        canEditGlobal: isAdmin(req),
        canEditSite: isEditor(req),
        // Pre-1.3 names, kept for API clients
        team: global,
        personal: user,
        canEditTeam: isAdmin(req)
      }
    });
  }
);

/**
 * @description Create a team, site, or personal variable
 * @route /api/variables
 * @request POST
 */
export const createVariable = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const fields = readFields(req.body, next);

    if (!fields) {
      return;
    }

    const scope = readScope(req.body.scope);
    const owner = {
      userId: scope === 'user' ? req.user!.id : null,
      siteId: scope === 'site' ? Number(req.body.siteId) || null : null
    };

    if (scope === 'site' && !owner.siteId) {
      return next(new ErrorResponse(400, 'Choose a site for this variable'));
    }

    if (!(await canChange(req, owner))) {
      return next(new ErrorResponse(403, permissionMessage(owner)));
    }

    try {
      const variable = await VariableModel.sequelize!.transaction(async transaction => {
        const created = await VariableModel.create(
          {
            ...owner,
            name: fields.name,
            description: fields.description,
            isSecret: fields.isSecret,
            value: fields.isSecret ? '' : fields.value || ''
          },
          { transaction }
        );
        if (fields.isSecret && fields.value) {
          await created.update({ value: storedValue(created.id, fields.value, true) }, { transaction });
        }
        return created;
      });

      if (scope !== 'user') {
        await auditLog('variable.created', {
          ...auditActor(req),
          target: `variable:${variable.id}`,
          metadata: { name: fields.name, scope, siteId: owner.siteId, secret: fields.isSecret }
        });
      }

      res.status(201).json({ data: toJson(variable) });
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        return next(duplicateName(fields.name, scope));
      }

      throw err;
    }
  }
);

/**
 * @description Update a variable. Omit `value` to keep a secret as it is.
 * @route /api/variables/:id
 * @request PUT
 */
export const updateVariable = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const variable = await findChangeable(req, next);

    if (!variable) {
      return;
    }

    const fields = readFields(req.body, next);

    if (!fields) {
      return;
    }

    // Keep the current value when none is sent, re-encrypting or decrypting
    // it if the secret flag changed
    let plainValue: string;

    try {
      plainValue = fields.value !== undefined ? fields.value : decryptVariableValue(variable);
    } catch {
      return next(
        new ErrorResponse(400, 'The stored secret cannot be decrypted. Enter a new value to replace it.')
      );
    }

    try {
      await variable.update({
        name: fields.name,
        description: fields.description,
        isSecret: fields.isSecret,
        value: storedValue(variable.id, plainValue, fields.isSecret)
      });
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        return next(duplicateName(fields.name, scopeOf(variable)));
      }

      throw err;
    }

    if (scopeOf(variable) !== 'user') {
      await auditLog('variable.updated', {
        ...auditActor(req),
        target: `variable:${variable.id}`,
        metadata: {
          name: fields.name,
          scope: scopeOf(variable),
          siteId: variable.siteId,
          secret: fields.isSecret,
          valueChanged: fields.value !== undefined
        }
      });
    }

    res.status(200).json({ data: toJson(variable) });
  }
);

/**
 * @description Show a secret value. Team and site reveals are audited.
 * @route /api/variables/:id/reveal
 * @request GET
 */
export const revealVariable = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const variable = await findChangeable(req, next);

    if (!variable) {
      return;
    }

    let value: string;

    try {
      value = decryptVariableValue(variable);
    } catch {
      return next(
        new ErrorResponse(
          500,
          'This secret cannot be decrypted. VARIABLES_SECRET_KEY or SESSION_SECRET may have changed.'
        )
      );
    }

    // Legacy (unbound) ciphertext is rebound to this row on first read
    if (variable.isSecret && value !== '' && !isBoundSecret(variable.value)) {
      await variable.update({ value: storedValue(variable.id, value, true) });
    }

    if (scopeOf(variable) !== 'user') {
      await auditLog('variable.revealed', {
        ...auditActor(req),
        target: `variable:${variable.id}`,
        metadata: { name: variable.name, scope: scopeOf(variable), siteId: variable.siteId }
      });
      emitEvent({
        event: 'secret.revealed',
        severity: 'warning',
        title: `${req.user?.displayName || 'Someone'} revealed ${variable.name}`,
        text: `A ${scopeOf(variable)} secret was shown in SnippyCode.`,
        siteId: variable.siteId,
        path: variable.siteId ? `/sites/${variable.siteId}` : '/variables',
        fields: [
          { label: 'Secret', value: variable.name },
          { label: 'By', value: req.user?.email || 'unknown' }
        ],
        data: { variableId: variable.id, userId: req.user?.id }
      });
    }

    res.status(200).json({ data: { value } });
  }
);

/**
 * @description Delete a variable
 * @route /api/variables/:id
 * @request DELETE
 */
export const deleteVariable = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const variable = await findChangeable(req, next);

    if (!variable) {
      return;
    }

    await variable.destroy();

    if (scopeOf(variable) !== 'user') {
      await auditLog('variable.deleted', {
        ...auditActor(req),
        target: `variable:${variable.id}`,
        metadata: { name: variable.name, scope: scopeOf(variable), siteId: variable.siteId }
      });
    }

    res.status(200).json({ data: {} });
  }
);

type PreviewSource = 'prompt' | 'user' | 'device' | 'site' | 'global' | 'default' | 'missing';

const readDefinitions = (value: unknown): Array<{ name: string; default?: string; type?: string; ref?: string }> => {
  try {
    const list = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(list) ? list.filter(def => def && typeof def.name === 'string') : [];
  } catch {
    return [];
  }
};

/** Placeholders a snippet uses: in its code and in its variable definitions */
const snippetNames = (snippet: { code: string; variables: unknown }): Set<string> => {
  const names = new Set(findTemplateVariables(snippet.code || '').map(variable => variable.name));
  readDefinitions(snippet.variables).forEach(def => {
    names.add(def.name);
    if (def.ref) names.add(def.ref);
  });
  return names;
};

/**
 * @description Resolved values for a snippet at a site or device: each
 * variable's value and the scope it came from. Secrets are masked; nothing
 * is decrypted here.
 * @route /api/variables/preview?snippetId=&siteId=&deviceId=
 * @request GET
 */
export const previewVariables = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const snippet = await SnippetModel.findByPk(Number(req.query.snippetId) || -1);
    if (!snippet) {
      return next(new ErrorResponse(404, 'Snippet was not found'));
    }

    let siteId = Number(req.query.siteId) || null;
    const device = req.query.deviceId ? await DeviceModel.findByPk(Number(req.query.deviceId) || -1) : null;
    if (req.query.deviceId && !device) {
      return next(new ErrorResponse(404, 'Device was not found'));
    }
    if (device) siteId = device.siteId;

    const site = siteId ? await SiteModel.findByPk(siteId) : null;
    if (siteId && !(site && (await canAccessSite(req.user || {}, site)))) {
      // Same answer for missing and inaccessible sites
      return next(new ErrorResponse(404, 'Site was not found'));
    }

    const layers = await loadVariableLayers({ userId: req.user?.id, siteId, includeSecrets: false });
    const [saved] = layers.sources;
    const deviceValues = device ? deviceVariableValues(device, site?.name) : {};
    const definitions = readDefinitions(snippet.variables);
    const byName = new Map(definitions.map(def => [def.name, def]));
    const inline = new Map(
      findTemplateVariables(snippet.code || '').map(variable => [variable.name, variable.defaultValue])
    );
    const withheld = new Set(layers.withheld);

    const resolve = (name: string): { value: string; source: PreviewSource; isSecret: boolean } => {
      const origin = layers.origins[name];
      if (origin === 'user') return { value: withheld.has(name) ? SECRET_MASK : saved[name], source: 'user', isSecret: withheld.has(name) };
      if (name in deviceValues) return { value: deviceValues[name], source: 'device', isSecret: false };
      if (origin) return { value: withheld.has(name) ? SECRET_MASK : saved[name], source: origin, isSecret: withheld.has(name) };
      const fallback = byName.get(name)?.default || inline.get(name);
      if (fallback !== undefined && fallback !== null && fallback !== '') {
        return { value: fallback, source: 'default', isSecret: false };
      }
      return { value: '', source: 'missing', isSecret: false };
    };

    const items = Array.from(snippetNames(snippet))
      .filter(name => !definitions.some(def => def.ref === name) || byName.has(name) || inline.has(name))
      .sort()
      .map(name => {
        const def = byName.get(name);
        if (def?.type === 'secret-ref' && def.ref) {
          const target = resolve(def.ref);
          return { name, ref: def.ref, ...target, value: target.source === 'missing' ? '' : SECRET_MASK, isSecret: true };
        }
        return { name, ...resolve(name) };
      });

    res.status(200).json({
      data: {
        snippetId: snippet.id,
        siteId,
        deviceId: device?.id || null,
        order: ['default', 'global', 'site', 'device', 'user', 'prompt'],
        variables: items
      }
    });
  }
);

/**
 * @description Which snippets, runbooks and schedules use each variable
 * name. A runbook or schedule uses a name when one of its snippets does or
 * when it stores a value for it.
 * @route /api/variables/usage
 * @request GET
 */
export const getVariableUsage = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const [snippets, steps, runbooks, schedules] = await Promise.all([
      SnippetModel.findAll({ attributes: ['id', 'title', 'code', 'variables'] }),
      RunbookStepModel.findAll({ attributes: ['runbookId', 'snippetId', 'values'] }),
      RunbookModel.findAll({ attributes: ['id', 'title'] }),
      ScheduleModel.findAll({ attributes: ['id', 'name', 'snippetId', 'runbookId', 'variables'] })
    ]);
    type Usage = {
      snippets: Array<{ id: number; title: string }>;
      runbooks: Array<{ id: number; title: string }>;
      schedules: Array<{ id: number; name: string }>;
    };
    const usage: Record<string, Usage> = {};
    const entry = (name: string): Usage =>
      (usage[name] = usage[name] || { snippets: [], runbooks: [], schedules: [] });
    const add = <T extends { id: number }>(list: T[], item: T) => {
      if (!list.some(existing => existing.id === item.id)) list.push(item);
    };
    const keysOf = (value: unknown): string[] => {
      try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
      } catch {
        return [];
      }
    };

    const namesBySnippet = new Map<number, Set<string>>();
    snippets.forEach(snippet => {
      const names = snippetNames(snippet);
      namesBySnippet.set(snippet.id, names);
      names.forEach(name => add(entry(name).snippets, { id: snippet.id, title: snippet.title }));
    });

    const runbookTitle = new Map(runbooks.map(runbook => [runbook.id, runbook.title]));
    const namesByRunbook = new Map<number, Set<string>>();
    steps.forEach(step => {
      const names = namesByRunbook.get(step.runbookId) || new Set<string>();
      (step.snippetId ? namesBySnippet.get(step.snippetId) || new Set<string>() : new Set<string>()).forEach(name => names.add(name));
      keysOf(step.values).forEach(name => names.add(name));
      namesByRunbook.set(step.runbookId, names);
    });
    namesByRunbook.forEach((names, runbookId) => {
      const title = runbookTitle.get(runbookId);
      if (title === undefined) return;
      names.forEach(name => add(entry(name).runbooks, { id: runbookId, title }));
    });

    schedules.forEach(schedule => {
      const names = new Set<string>(keysOf(schedule.variables));
      const fromTarget = schedule.snippetId
        ? namesBySnippet.get(schedule.snippetId)
        : schedule.runbookId
          ? namesByRunbook.get(schedule.runbookId)
          : undefined;
      fromTarget?.forEach(name => names.add(name));
      names.forEach(name => add(entry(name).schedules, { id: schedule.id, name: schedule.name }));
    });

    res.status(200).json({ data: usage });
  }
);
