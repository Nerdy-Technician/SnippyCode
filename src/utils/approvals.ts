import { Op } from 'sequelize';
import { RunApprovalInstance, RunApprovalKind, RunApprovalModel, SiteMemberModel, UserModel } from '../models';
import { auditLog } from './audit';
import { emitEvent } from './notify';
import { getSetting, setSetting } from './oidcSettings';
import { decryptSecret, encryptSecret } from './secretBox';
import { isAdminRole } from './siteAccess';
import { Logger } from './Logger';

const logger = new Logger('approvals');

/**
 * Approval for risky runs. A run of a dangerous-flagged snippet or runbook,
 * or one that targets more devices than the threshold, is held as an
 * approval request until an admin (not the requester) approves it. The held
 * request is replayed as the requester once approved, so every access check
 * runs again at that moment.
 */

export interface ApprovalSettings {
  enabled: boolean;
  deviceThreshold: number;
  expiryHours: number;
}

export const defaultApprovalSettings = (): ApprovalSettings => ({ enabled: true, deviceThreshold: 10, expiryHours: 24 });

export const getApprovalSettings = async (): Promise<ApprovalSettings> => ({
  ...defaultApprovalSettings(),
  ...(await getSetting<Partial<ApprovalSettings>>('approvals', {}))
});

export const cleanApprovalSettings = (body: any, current: ApprovalSettings): ApprovalSettings => {
  const int = (value: unknown, min: number, max: number, fallback: number) => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    enabled: body?.enabled === undefined ? current.enabled : Boolean(body.enabled),
    // Floor of 2: a threshold can't be raised high enough to switch the size check off silently
    deviceThreshold: body?.deviceThreshold === undefined ? current.deviceThreshold : int(body.deviceThreshold, 2, 1_000, 10),
    expiryHours: body?.expiryHours === undefined ? current.expiryHours : int(body.expiryHours, 1, 24 * 14, 24)
  };
};

export const saveApprovalSettings = (settings: ApprovalSettings) => setSetting('approvals', settings);

/** Why a run needs approval; empty when it doesn't */
export const approvalReasons = (
  run: { dangerous?: boolean; targetCount: number },
  settings: ApprovalSettings
): string[] => {
  if (!settings.enabled) return [];
  const why: string[] = [];
  if (run.dangerous) why.push('dangerous');
  if (run.targetCount > settings.deviceThreshold) why.push('large');
  return why;
};

export interface ApprovalTarget {
  type: 'device' | 'site' | 'schedule';
  id: number | null;
  name: string;
}

export const requestApproval = async (options: {
  kind: RunApprovalKind;
  title: string;
  why: string[];
  requestedBy: number | null;
  trigger?: 'manual' | 'schedule';
  reason?: string;
  snippetId?: number | null;
  runbookId?: number | null;
  scheduleId?: number | null;
  scheduleRunId?: number | null;
  siteId?: number | null;
  targets: ApprovalTarget[];
  targetCount: number;
  payload?: unknown;
  ipAddress?: string | null;
  /** sha256 of code + values + resolved targets (see contentHash) */
  contentHash: string;
  contentPreview?: string;
  /** Every site the run reaches */
  siteIds?: number[];
  /** Users who may not decide it besides the requester */
  excludedApprovers?: Array<number | null | undefined>;
}): Promise<RunApprovalInstance> => {
  const settings = await getApprovalSettings();
  const approval = await RunApprovalModel.create({
    kind: options.kind,
    title: options.title.slice(0, 200),
    why: options.why.join(','),
    requestedBy: options.requestedBy,
    trigger: options.trigger || 'manual',
    reason: String(options.reason || '').trim().slice(0, 2000),
    snippetId: options.snippetId || null,
    runbookId: options.runbookId || null,
    scheduleId: options.scheduleId || null,
    scheduleRunId: options.scheduleRunId || null,
    siteId: options.siteId || null,
    targets: JSON.stringify(options.targets.slice(0, 500)),
    targetCount: options.targetCount,
    // May hold variable values typed in for the run, so it is encrypted
    payload: encryptSecret(JSON.stringify(options.payload || {})),
    expiresAt: new Date(Date.now() + settings.expiryHours * 3_600_000),
    contentHash: options.contentHash,
    contentPreview: String(options.contentPreview || '').slice(0, 100_000),
    siteIds: Array.from(new Set((options.siteIds || []).filter(Boolean))).sort((a, b) => a - b).join(','),
    excludedApprovers: Array.from(new Set((options.excludedApprovers || []).filter(Boolean) as number[])).join(',')
  });

  await auditLog('approval.requested', {
    userId: options.requestedBy,
    ipAddress: options.ipAddress || null,
    target: `approval:${approval.id}`,
    metadata: {
      kind: approval.kind,
      title: approval.title,
      why: options.why,
      trigger: approval.trigger,
      targets: options.targetCount,
      reason: approval.reason
    }
  });

  emitEvent({
    event: 'approval.requested',
    severity: 'warning',
    title: `Approval needed: ${approval.title}`,
    text: `${options.why.includes('dangerous') ? 'Dangerous' : 'Large'} run on ${options.targetCount} target(s) is waiting for an admin.${approval.reason ? ` Reason: ${approval.reason}` : ''}`,
    siteId: approval.siteId,
    path: '/approvals',
    data: { approvalId: approval.id, why: options.why }
  });

  return approval;
};

export const approvalPayload = (approval: RunApprovalInstance): any => {
  try {
    return JSON.parse(decryptSecret(approval.payload) || '{}');
  } catch {
    return {};
  }
};

// Executors are registered by the modules that own each kind of run, so
// this file does not import the controllers (and they can import it)
type Executor = (approval: RunApprovalInstance, payload: any, requester: any) => Promise<string>;
const executors = new Map<RunApprovalKind, Executor>();
type Closer = (approval: RunApprovalInstance, message: string) => Promise<void>;
const closers = new Map<RunApprovalKind, Closer>();

export const registerApprovalExecutor = (kind: RunApprovalKind, run: Executor, close?: Closer): void => {
  executors.set(kind, run);
  if (close) closers.set(kind, close);
};

export class ApprovalError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The run changed between request and approval */
export class StaleApprovalError extends Error {}

const idList = (value: string): number[] => (value || '').split(',').map(Number).filter(Boolean);

/**
 * Called by each run path on replay, with the hash it computes NOW from the
 * live snippet/runbook/schedule and the targets it resolves NOW. Anything
 * different from what was approved refuses the run.
 */
export const assertApprovalFresh = async (approvalId: number, hash: string): Promise<void> => {
  const approval = await RunApprovalModel.findByPk(approvalId);
  if (!approval || !approval.contentHash || approval.contentHash !== hash) {
    await auditLog('approval.stale', {
      target: `approval:${approvalId}`,
      metadata: { kind: approval?.kind, title: approval?.title }
    });
    throw new StaleApprovalError(
      'The code, values or targets changed after this run was requested, so the approval no longer applies. Request it again.'
    );
  }
};

/**
 * Who may decide a request: never the requester or an excluded user (the
 * schedule's owner and last editor); otherwise global admins/owner, or a
 * site admin of EVERY site the run reaches.
 */
export const canDecideApproval = async (
  approver: { id: number; role?: string; isOwner?: boolean },
  approval: RunApprovalInstance
): Promise<boolean> => {
  if (approval.requestedBy === approver.id) return false;
  if (idList(approval.excludedApprovers).includes(approver.id)) return false;
  if (isAdminRole(approver.role) || approver.isOwner) return true;
  const sites = idList(approval.siteIds);
  if (!sites.length) return false;
  const adminOf = await SiteMemberModel.count({ where: { userId: approver.id, siteId: sites, role: 'admin' } });
  return adminOf === sites.length;
};

const requesterAsViewer = async (id: number | null) => {
  const user = id ? await UserModel.findByPk(id) : null;
  if (!user) return null;
  const role = user.isOwner ? 'owner' : !user.role || user.role === 'user' ? 'editor' : user.role;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isOwner: user.isOwner,
    role
  };
};

/**
 * Approve or deny. Atomic: only one decision can win, and the requester can
 * never decide their own request.
 */
export const decideApproval = async (options: {
  id: number;
  approver: { id: number; role?: string; isOwner?: boolean };
  approve: boolean;
  comment?: string;
  ipAddress?: string | null;
}): Promise<RunApprovalInstance> => {
  const approval = await RunApprovalModel.findByPk(options.id);
  if (!approval) throw new ApprovalError(404, 'Approval request was not found');
  if (approval.requestedBy === options.approver.id || idList(approval.excludedApprovers).includes(options.approver.id)) {
    throw new ApprovalError(403, 'You cannot approve or deny your own run (or a schedule you own or last edited)');
  }
  if (!(await canDecideApproval(options.approver, approval))) {
    throw new ApprovalError(403, 'Only admins of every site this run reaches can approve or deny it');
  }

  const now = new Date();
  const comment = String(options.comment || '').trim().slice(0, 2000);
  const status = options.approve ? 'approved' : 'denied';
  const [claimed] = await RunApprovalModel.update(
    { status, decidedBy: options.approver.id, decidedAt: now, decisionComment: comment },
    { where: { id: approval.id, status: 'pending', expiresAt: { [Op.gt]: now } } }
  );

  if (!claimed) {
    await approval.reload();
    if (approval.status === 'pending') {
      await expireApprovals(now);
      throw new ApprovalError(409, 'This approval request has expired');
    }
    throw new ApprovalError(409, `This approval request was already ${approval.status}`);
  }

  await approval.reload();
  await auditLog(`approval.${status}`, {
    userId: options.approver.id,
    ipAddress: options.ipAddress || null,
    target: `approval:${approval.id}`,
    metadata: { kind: approval.kind, title: approval.title, comment, requestedBy: approval.requestedBy }
  });

  if (!options.approve) {
    await closers.get(approval.kind)?.(approval, `Denied${comment ? `: ${comment}` : ''}`).catch(() => undefined);
    return approval;
  }

  // Run it now, as the requester
  try {
    const executor = executors.get(approval.kind);
    if (!executor) throw new Error(`Nothing can run ${approval.kind} approvals`);
    const requester = approval.trigger === 'schedule' ? null : await requesterAsViewer(approval.requestedBy);
    if (approval.trigger !== 'schedule' && !requester) throw new Error('The requester no longer exists');
    const result = await executor(approval, approvalPayload(approval), requester);
    await approval.update({ result: result.slice(0, 2000), payload: '' });
    await auditLog('approval.executed', { userId: options.approver.id, target: `approval:${approval.id}`, metadata: { result: result.slice(0, 500) } });
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    await approval.update({ status: err instanceof StaleApprovalError ? 'stale' : 'failed', result: message, payload: '' });
    await auditLog('approval.failed', { userId: options.approver.id, target: `approval:${approval.id}`, metadata: { message } });
    await closers.get(approval.kind)?.(approval, `Could not start after approval: ${message}`).catch(() => undefined);
  }

  return approval;
};

/** Mark overdue requests expired (runs on the scheduler tick) */
export const expireApprovals = async (now = new Date()): Promise<number> => {
  const overdue = await RunApprovalModel.findAll({ where: { status: 'pending', expiresAt: { [Op.lte]: now } } });
  let count = 0;

  for (const approval of overdue) {
    const [changed] = await RunApprovalModel.update(
      { status: 'expired', payload: '', decidedAt: now },
      { where: { id: approval.id, status: 'pending' } }
    );
    if (!changed) continue;
    count += 1;
    await auditLog('approval.expired', { target: `approval:${approval.id}`, metadata: { kind: approval.kind, title: approval.title } });
    await closers.get(approval.kind)?.(approval, 'The approval request expired').catch(err =>
      logger.log(`Closing approval ${approval.id} failed: ${err.message}`, 'WARN')
    );
  }

  return count;
};

/** Safe to show: never the held payload */
export const approvalJson = (approval: RunApprovalInstance, names: { [id: number]: string } = {}) => {
  let targets: ApprovalTarget[] = [];
  try {
    targets = JSON.parse(approval.targets);
  } catch {
    targets = [];
  }
  return {
    id: approval.id,
    kind: approval.kind,
    title: approval.title,
    why: approval.why.split(',').filter(Boolean),
    trigger: approval.trigger,
    reason: approval.reason,
    snippetId: approval.snippetId,
    runbookId: approval.runbookId,
    scheduleId: approval.scheduleId,
    scheduleRunId: approval.scheduleRunId,
    siteId: approval.siteId,
    targets,
    targetCount: approval.targetCount,
    status: approval.status,
    requestedBy: approval.requestedBy,
    requestedByName: approval.requestedBy ? names[approval.requestedBy] || null : null,
    decidedBy: approval.decidedBy,
    decidedByName: approval.decidedBy ? names[approval.decidedBy] || null : null,
    decisionComment: approval.decisionComment,
    decidedAt: approval.decidedAt,
    expiresAt: approval.expiresAt,
    result: approval.result,
    contentPreview: approval.contentPreview,
    siteIds: idList(approval.siteIds),
    createdAt: approval.createdAt
  };
};
