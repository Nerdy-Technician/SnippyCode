import { Router } from 'express';
import {
  createSite,
  deleteSite,
  getSites,
  getSiteUsers,
  setSiteMembers,
  updateSite
} from '../controllers/sites';
import { getSitePatching, getSiteReport, getSitesHealth } from '../controllers/monitoring';
import { requireAuth, requireOwner } from '../middleware';

export const siteRouter = Router();

siteRouter.use(requireAuth);

siteRouter.route('/').get(getSites).post(requireOwner, createSite);
siteRouter.route('/health').get(getSitesHealth);
siteRouter.route('/:id/patching').get(getSitePatching);
siteRouter.route('/:id/report').get(getSiteReport);
siteRouter.route('/users').get(requireOwner, getSiteUsers);
siteRouter.route('/:id').put(requireOwner, updateSite).delete(requireOwner, deleteSite);
siteRouter.route('/:id/members').put(requireOwner, setSiteMembers);
