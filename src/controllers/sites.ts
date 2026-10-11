import { Response, NextFunction } from 'express';
import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../db';
import { asyncWrapper, AuthenticatedRequest, effectiveRole } from '../middleware';
import { SiteInstance, SiteMemberModel, SiteModel, UserModel } from '../models';
import {
  ErrorResponse,
  accessibleSiteIds,
  auditLog,
  emitEvent,
  isAdminRole,
  requestIp
} from '../utils';

const auditActor = (req: AuthenticatedRequest) => ({
  userId: req.user?.id || null,
  ipAddress: requestIp(req)
});

const siteChanged = (req: AuthenticatedRequest, site: SiteInstance, what: string) =>
  emitEvent({
    event: 'site.changed',
    severity: 'info',
    title: `${site.name} ${what}`,
    text: `By ${req.user?.displayName || 'someone'}.`,
    siteId: site.id,
    path: what === 'was deleted' ? '/sites' : `/sites/${site.id}`,
    data: { siteId: site.id, change: what }
  });

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);

const parseTags = (value: unknown): string =>
  (Array.isArray(value) ? value : String(value || '').split(','))
    .map(tag => String(tag).trim().toLowerCase())
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .slice(0, 20)
    .join(',');

const uniqueSlug = async (base: string, exceptId?: number): Promise<string> => {
  const root = base || 'site';

  for (let n = 1; n < 1000; n += 1) {
    const slug = n === 1 ? root : `${root}-${n}`;
    const existing = await SiteModel.findOne({ where: { slug } });

    if (!existing || existing.id === exceptId) {
      return slug;
    }
  }

  return `${root}-${Date.now()}`;
};

const readFields = (body: any, next: NextFunction) => {
  const name = String(body.name || '').trim();

  if (!name || name.length > 120) {
    next(new ErrorResponse(400, 'Site name is required (up to 120 characters)'));
    return null;
  }

  return {
    name,
    description: String(body.description || '').trim().slice(0, 2000),
    tags: parseTags(body.tags),
    access: body.access === 'members' ? ('members' as const) : ('everyone' as const)
  };
};

const siteJson = (
  site: SiteInstance,
  extra: {
    memberIds?: number[];
    variableCount?: number;
    lastRunAt?: Date | null;
    deviceCount?: number;
    devicesOnline?: number;
  } = {}
) => ({
  id: site.id,
  name: site.name,
  slug: site.slug,
  description: site.description,
  tags: site.tags ? site.tags.split(',') : [],
  access: site.access,
  createdAt: site.createdAt,
  updatedAt: site.updatedAt,
  ...extra
});

const findSite = async (req: AuthenticatedRequest, next: NextFunction) => {
  const site = await SiteModel.findByPk(Number(req.params.id));

  if (!site) {
    next(new ErrorResponse(404, 'Site was not found'));
    return null;
  }

  return site;
};

/**
 * @description Sites the current user can use. Admins also get member lists.
 * @route /api/sites
 * @request GET
 */
export const getSites = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const ids = await accessibleSiteIds(req.user || {});
    const sites = await SiteModel.findAll({
      where: ids === 'all' ? undefined : { id: ids.length ? ids : [-1] },
      order: [['name', 'ASC']]
    });
    const siteIds = sites.map(site => site.id);
    const admin = isAdminRole(req.user?.role);

    const [members, counts, runs, devices] = siteIds.length
      ? await Promise.all([
          admin ? SiteMemberModel.findAll({ where: { siteId: siteIds }, raw: true }) : [],
          sequelize.query<{ siteId: number; count: string }>(
            `SELECT "siteId", COUNT(*) AS count FROM variables WHERE "siteId" IN (:siteIds) GROUP BY "siteId"`,
            { type: QueryTypes.SELECT, replacements: { siteIds } }
          ),
          sequelize.query<{ siteId: number; lastRunAt: Date }>(
            `SELECT "siteId", MAX("createdAt") AS "lastRunAt" FROM snippet_runs WHERE "siteId" IN (:siteIds) GROUP BY "siteId"`,
            { type: QueryTypes.SELECT, replacements: { siteIds } }
          ),
          // Online means seen within the last 90 seconds, as in the device list
          sequelize.query<{ siteId: number; total: string; online: string }>(
            `SELECT "siteId", COUNT(*) AS total,
               COUNT(*) FILTER (WHERE "lastSeenAt" > NOW() - INTERVAL '90 seconds') AS online
             FROM devices WHERE "revokedAt" IS NULL AND "siteId" IN (:siteIds) GROUP BY "siteId"`,
            { type: QueryTypes.SELECT, replacements: { siteIds } }
          )
        ])
      : [[], [], [], []];

    res.status(200).json({
      data: {
        sites: sites.map(site =>
          siteJson(site, {
            memberIds: admin
              ? members.filter(member => member.siteId === site.id).map(member => member.userId)
              : undefined,
            variableCount: Number(counts.find(row => row.siteId === site.id)?.count || 0),
            lastRunAt: runs.find(row => row.siteId === site.id)?.lastRunAt || null,
            deviceCount: Number(devices.find(row => row.siteId === site.id)?.total || 0),
            devicesOnline: Number(devices.find(row => row.siteId === site.id)?.online || 0)
          })
        ),
        canManage: admin
      }
    });
  }
);

/**
 * @description Users who can be added to members-only sites (admins)
 * @route /api/sites/users
 * @request GET
 */
export const getSiteUsers = asyncWrapper(
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const users = await UserModel.findAll({ order: [['displayName', 'ASC']] });

    res.status(200).json({
      data: users.map(user => ({
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        role: effectiveRole(user)
      }))
    });
  }
);

/**
 * @description Create a site (admins)
 * @route /api/sites
 * @request POST
 */
export const createSite = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const fields = readFields(req.body, next);

    if (!fields) {
      return;
    }

    const site = await SiteModel.create({
      ...fields,
      slug: await uniqueSlug(slugify(req.body.slug || fields.name))
    });

    siteChanged(req, site, 'was created');
    await auditLog('site.created', {
      ...auditActor(req),
      target: `site:${site.id}`,
      metadata: { name: site.name, access: site.access }
    });

    res.status(201).json({ data: siteJson(site, { memberIds: [], variableCount: 0 }) });
  }
);

/**
 * @description Update a site (admins)
 * @route /api/sites/:id
 * @request PUT
 */
export const updateSite = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const site = await findSite(req, next);
    const fields = site && readFields(req.body, next);

    if (!site || !fields) {
      return;
    }

    await site.update({
      ...fields,
      slug: req.body.slug ? await uniqueSlug(slugify(req.body.slug), site.id) : site.slug
    });

    siteChanged(req, site, 'was updated');
    await auditLog('site.updated', {
      ...auditActor(req),
      target: `site:${site.id}`,
      metadata: { name: site.name, access: site.access }
    });

    res.status(200).json({ data: siteJson(site) });
  }
);

/**
 * @description Replace who can see a members-only site (admins)
 * @route /api/sites/:id/members
 * @request PUT
 */
export const setSiteMembers = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const site = await findSite(req, next);

    if (!site) {
      return;
    }

    const requested: number[] = Array.isArray(req.body.userIds)
      ? req.body.userIds.map(Number).filter((id: number) => Number.isSafeInteger(id))
      : [];
    const users = await UserModel.findAll({
      where: { id: { [Op.in]: requested.length ? requested : [-1] } },
      attributes: ['id']
    });
    const userIds = users.map(user => user.id);

    await sequelize.transaction(async transaction => {
      await SiteMemberModel.destroy({ where: { siteId: site.id }, transaction });
      await SiteMemberModel.bulkCreate(
        userIds.map(userId => ({ siteId: site.id, userId })),
        { transaction }
      );
    });

    siteChanged(req, site, 'members changed');
    await auditLog('site.members_updated', {
      ...auditActor(req),
      target: `site:${site.id}`,
      metadata: { name: site.name, memberCount: userIds.length }
    });

    res.status(200).json({ data: { memberIds: userIds } });
  }
);

/**
 * @description Delete a site with its variables and run history (admins)
 * @route /api/sites/:id
 * @request DELETE
 */
export const deleteSite = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const site = await findSite(req, next);

    if (!site) {
      return;
    }

    await site.destroy();

    siteChanged(req, site, 'was deleted');
    await auditLog('site.deleted', {
      ...auditActor(req),
      target: `site:${req.params.id}`,
      metadata: { name: site.name }
    });

    res.status(200).json({ data: {} });
  }
);
