import { Op } from 'sequelize';
import { SiteInstance, SiteMemberModel, SiteModel } from '../models';

export interface SiteViewer {
  id?: number | null;
  role?: string;
}

export const isAdminRole = (role?: string): boolean =>
  role === 'admin' || role === 'owner';

/**
 * Admins see every site. Everyone else sees open sites plus the
 * members-only sites they were added to.
 */
export const accessibleSiteIds = async (viewer: SiteViewer): Promise<number[] | 'all'> => {
  if (isAdminRole(viewer.role)) {
    return 'all';
  }

  const memberships = viewer.id
    ? await SiteMemberModel.findAll({ where: { userId: viewer.id }, raw: true })
    : [];
  const sites = await SiteModel.findAll({
    where: {
      [Op.or]: [
        { access: 'everyone' },
        { id: memberships.map(member => member.siteId) }
      ]
    },
    attributes: ['id'],
    raw: true
  });

  return sites.map(site => site.id);
};

export const canAccessSite = async (
  viewer: SiteViewer,
  site: Pick<SiteInstance, 'id' | 'access'>
): Promise<boolean> => {
  if (isAdminRole(viewer.role) || site.access === 'everyone') {
    return true;
  }

  if (!viewer.id) {
    return false;
  }

  return Boolean(
    await SiteMemberModel.findOne({ where: { siteId: site.id, userId: viewer.id } })
  );
};

/**
 * Load a site by id or slug when the viewer may use it, otherwise null.
 */
export const findAccessibleSite = async (
  viewer: SiteViewer,
  ref: unknown
): Promise<SiteInstance | null> => {
  const value = String(ref ?? '').trim();

  if (!value) {
    return null;
  }

  const site = /^\d+$/.test(value)
    ? await SiteModel.findByPk(Number(value))
    : await SiteModel.findOne({ where: { slug: value } });

  return site && (await canAccessSite(viewer, site)) ? site : null;
};
