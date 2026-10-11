import { NextFunction, Response } from 'express';
import { Op } from 'sequelize';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import { RunApprovalModel, SiteMemberModel, UserModel } from '../models';
import {
  ApprovalError,
  ErrorResponse,
  approvalJson,
  auditLog,
  cleanApprovalSettings,
  decideApproval,
  expireApprovals,
  getApprovalSettings,
  isAdminRole,
  canDecideApproval,
  emitEvent,
  requestIp,
  saveApprovalSettings
} from '../utils';

const namesFor = async (ids: Array<number | null>) => {
  const wanted = Array.from(new Set(ids.filter(Boolean) as number[]));
  const users = wanted.length ? await UserModel.findAll({ where: { id: wanted }, attributes: ['id', 'displayName', 'email'] }) : [];
  return Object.fromEntries(users.map(user => [user.id, user.displayName || user.email]));
};

/**
 * @description Approval requests. Admins see everyone's; others see their own.
 * ?status=pending (default) or ?status=history
 * @route /api/approvals
 * @request GET
 */
export const getApprovals = asyncWrapper(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  await expireApprovals();
  const pending = req.query.status !== 'history';
  const approvals = await RunApprovalModel.findAll({
    where: {
      status: pending ? 'pending' : { [Op.ne]: 'pending' },
      // Site admins see requests for their sites (checked per item below)
      ...(isAdminRole(req.user?.role) || (await isAnySiteAdmin(req.user?.id)) ? {} : { requestedBy: req.user?.id || -1 })
    },
    order: [[pending ? 'createdAt' : 'updatedAt', pending ? 'ASC' : 'DESC']],
    limit: pending ? 500 : Math.min(500, Math.max(1, Number(req.query.limit) || 100))
  });
  const viewer = { id: req.user?.id || -1, role: req.user?.role, isOwner: req.user?.isOwner };
  const visible = [];
  for (const item of approvals) {
    const canDecide = await canDecideApproval(viewer, item);
    // Non-admins see their own requests and the ones they may decide
    if (isAdminRole(viewer.role) || item.requestedBy === viewer.id || canDecide) {
      visible.push({ item, canDecide: canDecide && item.status === 'pending' });
    }
  }
  const names = await namesFor(visible.flatMap(({ item }) => [item.requestedBy, item.decidedBy]));
  res.status(200).json({
    data: visible.map(({ item, canDecide }) => ({ ...approvalJson(item, names), canDecide }))
  });
});

/**
 * @description How many requests this user could approve (the nav badge)
 * @route /api/approvals/count
 * @request GET
 */
export const countApprovals = asyncWrapper(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  if (!isAdminRole(req.user?.role) && !(await isAnySiteAdmin(req.user?.id))) {
    res.status(200).json({ data: { pending: 0 } });
    return;
  }
  const open = await RunApprovalModel.findAll({ where: { status: 'pending', expiresAt: { [Op.gt]: new Date() } }, limit: 500 });
  const viewer = { id: req.user?.id || -1, role: req.user?.role, isOwner: req.user?.isOwner };
  let pending = 0;
  for (const item of open) if (await canDecideApproval(viewer, item)) pending += 1;
  res.status(200).json({ data: { pending } });
});

const isAnySiteAdmin = async (userId?: number | null): Promise<boolean> =>
  Boolean(userId) && (await SiteMemberModel.count({ where: { userId: userId as number, role: 'admin' } })) > 0;

const decide = (approve: boolean) =>
  asyncWrapper(async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const approval = await decideApproval({
        id: Number(req.params.id) || -1,
        approver: { id: req.user!.id, role: req.user?.role, isOwner: req.user?.isOwner },
        approve,
        comment: req.body?.comment,
        ipAddress: requestIp(req)
      });
      const names = await namesFor([approval.requestedBy, approval.decidedBy]);
      res.status(200).json({ data: approvalJson(approval, names) });
    } catch (err) {
      if (err instanceof ApprovalError) {
        return next(new ErrorResponse(err.status, err.message));
      }
      throw err;
    }
  });

/** @route /api/approvals/:id/approve @request POST */
export const approveRun = decide(true);
/** @route /api/approvals/:id/deny @request POST */
export const denyRun = decide(false);

/** @route /api/approvals/settings @request GET */
export const getApprovalSettingsRoute = asyncWrapper(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.status(200).json({ data: await getApprovalSettings() });
});

/** @route /api/approvals/settings @request PUT (admins) */
export const updateApprovalSettings = asyncWrapper(async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  // One admin alone must not be able to switch the gate off: owner only
  if (!req.user?.isOwner) {
    await auditLog('approval.settings_refused', {
      userId: req.user?.id || null,
      ipAddress: requestIp(req),
      target: 'settings:approvals',
      metadata: { attempted: req.body || {} }
    });
    return next(new ErrorResponse(403, 'Only the owner can change approval settings'));
  }
  const before = await getApprovalSettings();
  const after = cleanApprovalSettings(req.body, before);
  await saveApprovalSettings(after);
  await auditLog('approval.settings_changed', {
    userId: req.user?.id || null,
    ipAddress: requestIp(req),
    target: 'settings:approvals',
    metadata: { before, after }
  });
  const weakened = (before.enabled && !after.enabled) || after.deviceThreshold > before.deviceThreshold || after.expiryHours > before.expiryHours;
  emitEvent({
    event: 'approval.settings_changed',
    severity: weakened ? 'error' : 'warning',
    title: weakened ? 'Run approvals were weakened' : 'Run approval settings changed',
    text: `Enabled ${before.enabled} → ${after.enabled}; threshold ${before.deviceThreshold} → ${after.deviceThreshold}; expiry ${before.expiryHours}h → ${after.expiryHours}h.`,
    siteId: null,
    path: '/approvals',
    data: { before, after }
  });
  res.status(200).json({ data: after });
});
