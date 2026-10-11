import { Response, NextFunction } from 'express';
import { Op, UniqueConstraintError } from 'sequelize';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import { SiteModel, VariableModel, VariableInstance } from '../models';
import {
  ErrorResponse,
  VARIABLE_NAME_PATTERN,
  accessibleSiteIds,
  auditLog,
  canAccessSite,
  decryptSecret,
  encryptSecret,
  emitEvent,
  requestIp
} from '../utils';

const MAX_VALUE_LENGTH = 10000;
const MAX_DESCRIPTION_LENGTH = 500;

type Scope = 'team' | 'personal' | 'site';

const roleRank: { [key: string]: number } = {
  viewer: 10,
  user: 20,
  editor: 30,
  admin: 40,
  owner: 50
};

const isEditor = (req: AuthenticatedRequest): boolean =>
  (roleRank[req.user?.role || ''] || 0) >= roleRank.editor;

const auditActor = (req: AuthenticatedRequest) => ({
  userId: req.user?.id || null,
  ipAddress: requestIp(req)
});

const scopeOf = (variable: { userId: number | null; siteId: number | null }): Scope =>
  variable.userId ? 'personal' : variable.siteId ? 'site' : 'team';

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
 * Personal variables belong to their user. Team and site variables need an
 * editor, and site variables also need access to that site.
 */
const canChange = async (
  req: AuthenticatedRequest,
  variable: { userId: number | null; siteId: number | null }
): Promise<boolean> => {
  if (variable.userId) {
    return variable.userId === req.user?.id;
  }

  if (!isEditor(req)) {
    return false;
  }

  if (variable.siteId) {
    const site = await SiteModel.findByPk(variable.siteId);
    return Boolean(site && (await canAccessSite(req.user || {}, site)));
  }

  return true;
};

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
    next(new ErrorResponse(403, 'Editors with access can change team and site variables'));
    return null;
  }

  return variable;
};

const storedValue = (value: string, isSecret: boolean): string =>
  isSecret && value !== '' ? encryptSecret(value) : value;

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

    res.status(200).json({
      data: {
        team: items.filter(item => item.scope === 'team'),
        personal: items.filter(item => item.scope === 'personal'),
        site: items.filter(item => item.scope === 'site'),
        canEditTeam: isEditor(req)
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

    const scope: Scope =
      req.body.scope === 'team' || req.body.scope === 'site' ? req.body.scope : 'personal';
    const owner = {
      userId: scope === 'personal' ? req.user!.id : null,
      siteId: scope === 'site' ? Number(req.body.siteId) || null : null
    };

    if (scope === 'site' && !owner.siteId) {
      return next(new ErrorResponse(400, 'Choose a site for this variable'));
    }

    if (!(await canChange(req, owner))) {
      return next(new ErrorResponse(403, 'Editors with access can change team and site variables'));
    }

    try {
      const variable = await VariableModel.create({
        ...owner,
        name: fields.name,
        description: fields.description,
        isSecret: fields.isSecret,
        value: storedValue(fields.value || '', fields.isSecret)
      });

      if (scope !== 'personal') {
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
      plainValue = fields.value !== undefined ? fields.value : decryptSecret(variable.value);
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
        value: storedValue(plainValue, fields.isSecret)
      });
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        return next(duplicateName(fields.name, scopeOf(variable)));
      }

      throw err;
    }

    if (scopeOf(variable) !== 'personal') {
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
      value = decryptSecret(variable.value);
    } catch {
      return next(
        new ErrorResponse(
          500,
          'This secret cannot be decrypted. VARIABLES_SECRET_KEY or SESSION_SECRET may have changed.'
        )
      );
    }

    if (scopeOf(variable) !== 'personal') {
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

    if (scopeOf(variable) !== 'personal') {
      await auditLog('variable.deleted', {
        ...auditActor(req),
        target: `variable:${variable.id}`,
        metadata: { name: variable.name, scope: scopeOf(variable), siteId: variable.siteId }
      });
    }

    res.status(200).json({ data: {} });
  }
);
