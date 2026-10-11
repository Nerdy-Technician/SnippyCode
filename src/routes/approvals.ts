import { Router } from 'express';
import {
  approveRun,
  countApprovals,
  denyRun,
  getApprovals,
  getApprovalSettingsRoute,
  updateApprovalSettings
} from '../controllers/approvals';
import { requireAuth, requireMinimumRole } from '../middleware';

export const approvalRouter = Router();
const admin = requireMinimumRole('admin');

approvalRouter.use(requireAuth);
approvalRouter.route('/').get(getApprovals);
approvalRouter.route('/count').get(countApprovals);
approvalRouter.route('/settings').get(getApprovalSettingsRoute).put(admin, updateApprovalSettings);
// Who may decide is checked per request (admins, or site admins of every site reached)
approvalRouter.route('/:id/approve').post(approveRun);
approvalRouter.route('/:id/deny').post(denyRun);
