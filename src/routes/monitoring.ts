import { Router } from 'express';
import {
  alertAction,
  createPolicy,
  deletePolicy,
  getAlerts,
  getPolicies,
  patchPolicyNow,
  previewPolicy,
  updatePolicy
} from '../controllers/monitoring';
import { requireAuth, requireMinimumRole } from '../middleware';

export const alertRouter = Router();

alertRouter.use(requireAuth);
alertRouter.route('/').get(getAlerts);
alertRouter.route('/action').post(alertAction);

export const policyRouter = Router();

const admin = requireMinimumRole('admin');

// Policies reach every site, so only admins manage them
policyRouter.use(requireAuth, requireMinimumRole('editor'));
policyRouter.route('/').get(getPolicies).post(admin, createPolicy);
policyRouter.route('/preview').post(previewPolicy);
policyRouter.route('/:id').put(admin, updatePolicy).delete(admin, deletePolicy);
policyRouter.route('/:id/patch').post(admin, patchPolicyNow);
