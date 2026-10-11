import { Request, Response, NextFunction } from 'express';
import { randomBytes, randomUUID } from 'crypto';
import { Op, Transaction } from 'sequelize';
import { sequelize } from '../db';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import {
  AgentJobModel,
  AgentJobInstance,
  DeviceMetricModel,
  DeviceEnrollmentModel,
  DeviceInstance,
  DeviceModel,
  SiteMemberModel,
  SiteModel,
  SnippetRunModel
} from '../models';
import {
  ErrorResponse,
  accessibleSiteIds,
  auditLog,
  decryptSecret,
  emitEvent,
  findAccessibleSite,
  finishAgentJob,
  hashApiKey,
  isDeviceOnline,
  requestIp,
  checkTokenHash,
  ACTION_TOOLS,
  READ_TOOLS,
  TOOL_LABELS,
  ToolError,
  ToolId,
  canAccessSite,
  deviceToolOs,
  isAdminRole,
  queueToolJob,
  recordFactsMetric,
  VIEW_TOOLS,
  takeDownload,
  readJson,
  DeviceFields,
  DeviceRemote,
  RemoteType,
  encryptSecret,
  parseIdList,
  setDeviceTagIds,
  tagIdsForNames
} from '../utils';
import { setLatestHeader } from './agentUpdate';
import { describeRuns } from './runs';

/** The agent version this server hands out; older agents update themselves. */
export const AGENT_VERSION = '1.4.0';

const versionParts = (value: string): number[] =>
  (value.match(/\d+/g) || []).slice(0, 3).map(Number);

export const isOlderVersion = (current: string, latest: string): boolean => {
  const a = versionParts(current);
  const b = versionParts(latest);

  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) {
      return (a[i] || 0) < (b[i] || 0);
    }
  }

  return false;
};

export interface DeviceFacts {
  osName?: string;
  kernel?: string;
  cpus?: number;
  memTotalMb?: number;
  memAvailableMb?: number;
  diskTotalGb?: number;
  diskUsedGb?: number;
  uptimeSeconds?: number;
  ip?: string;
  timezone?: string;
  load1?: number;
  load5?: number;
  load15?: number;
  cpuPercent?: number;
}

const readFacts = (raw: string): DeviceFacts => {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
};

const auditActor = (req: AuthenticatedRequest) => ({
  userId: req.user?.id || null,
  ipAddress: requestIp(req)
});

const newToken = async (kind: 'enroll' | 'dev') => {
  const token = `sc_${kind}_${randomBytes(24).toString('base64url')}`;
  return { token, hash: await hashApiKey(token), prefix: token.slice(0, 16) };
};

// Hashes are salted, so tokens are found by their stored prefix and then
// checked against each candidate's hash (normally exactly one)
const findByToken = async <T extends { tokenHash: string; update: (values: { tokenHash: string }, options?: object) => Promise<unknown> }>(
  token: string,
  candidates: T[],
  options: object = {}
): Promise<T | null> => {
  for (const candidate of candidates) {
    const check = await checkTokenHash(token, candidate.tokenHash);

    if (check.ok) {
      // Replace a migrated pre-v1.2.2 hash with a plain scrypt one
      if (check.upgrade) {
        await candidate.update({ tokenHash: check.upgrade }, options);
      }
      return candidate;
    }
  }
  return null;
};

export const deviceJson = (
  device: DeviceInstance,
  lastRun?: { id: number; snippetTitle: string; ok: boolean; createdAt: Date } | null
) => ({
  id: device.id,
  siteId: device.siteId,
  name: device.name,
  hostname: device.hostname,
  os: device.os,
  arch: device.arch,
  agentVersion: device.agentVersion,
  capabilities: device.capabilities ? device.capabilities.split(',') : [],
  tags: device.tags ? device.tags.split(',') : [],
  lastSeenAt: device.lastSeenAt,
  lastIp: device.lastIp,
  online: isDeviceOnline(device),
  tokenPrefix: device.tokenPrefix,
  agentId: device.agentId || null,
  clonedFrom: device.clonedFrom || null,
  clonePendingApproval: Boolean(device.clonePendingApproval),
  status: device.revokedAt ? 'revoked' : device.clonePendingApproval ? 'pending_approval' : 'active',
  fingerprintPendingReview: Boolean(device.fingerprintPendingReview),
  possibleDuplicate: Boolean(device.possibleDuplicate),
  duplicateOf: device.duplicateOf ? device.duplicateOf.split(',').map(Number).filter(Boolean) : [],
  createdAt: device.createdAt,
  facts: readFacts(device.facts),
  factsAt: device.factsAt,
  latestAgentVersion: AGENT_VERSION,
  updateAvailable: Boolean(device.agentVersion) && isOlderVersion(device.agentVersion, AGENT_VERSION),
  lastRun: lastRun
    ? { id: lastRun.id, snippetTitle: lastRun.snippetTitle, ok: lastRun.ok, createdAt: lastRun.createdAt }
    : null
});

const origin = (req: Request): string =>
  String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

// Signed-in users ----------------------------------------------------------

/**
 * @description Devices at sites the user can see. Filter with ?siteId=.
 * @route /api/devices
 * @request GET
 */
export const getDevices = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const ids = await accessibleSiteIds(req.user || {});
    const where: { [key: string]: unknown } = { revokedAt: null };

    if (req.query.siteId) {
      const site = await findAccessibleSite(req.user || {}, req.query.siteId);

      if (!site) {
        return next(new ErrorResponse(404, 'Site was not found'));
      }

      where.siteId = site.id;
    } else if (ids !== 'all') {
      where.siteId = ids.length ? ids : [-1];
    }

    const devices = await DeviceModel.findAll({ where, order: [['name', 'ASC']] });
    const lastRuns = devices.length
      ? await SnippetRunModel.findAll({
          where: { deviceId: devices.map(device => device.id) },
          attributes: ['id', 'deviceId', 'snippetTitle', 'ok', 'createdAt'],
          order: [['createdAt', 'DESC']],
          limit: 200
        })
      : [];

    const sites = devices.length
      ? await SiteModel.findAll({ where: { id: devices.map(device => device.siteId) }, attributes: ['id', 'name', 'slug'] })
      : [];

    res.status(200).json({
      data: devices.map(device => ({
        ...deviceJson(device, lastRuns.find(run => run.deviceId === device.id) || null),
        site: sites.find(site => site.id === device.siteId) || null
      }))
    });
  }
);

// Enrolment tokens ----------------------------------------------------------

const DAY_HOURS = 24;
const DEFAULT_EXPIRY_HOURS = 7 * DAY_HOURS;
const MAX_EXPIRY_HOURS = 365 * DAY_HOURS;
const MAX_USES_LIMIT = 10_000;

/**
 * Admins manage tokens for every site; site admins (members with the
 * 'admin' role) only for their own sites.
 */
export const canManageSiteEnrolment = async (
  user: { id?: number | null; role?: string } | undefined,
  siteId: number
): Promise<boolean> => {
  if (isAdminRole(user?.role)) {
    return true;
  }

  if (!user?.id) {
    return false;
  }

  return Boolean(await SiteMemberModel.findOne({ where: { siteId, userId: user.id, role: 'admin' } }));
};

const enrollmentStatus = (enrollment: { revokedAt: Date | null; expiresAt: Date; maxUses: number | null; uses: number }) =>
  enrollment.revokedAt
    ? 'revoked'
    : enrollment.expiresAt.getTime() < Date.now()
    ? 'expired'
    : enrollment.maxUses !== null && enrollment.uses >= enrollment.maxUses
    ? 'used'
    : 'active';

const enrollmentJson = (enrollment: InstanceType<typeof DeviceEnrollmentModel>, site?: { id: number; name: string } | null) => ({
  id: enrollment.id,
  siteId: enrollment.siteId,
  site: site || null,
  label: enrollment.label,
  allowReenrol: enrollment.allowReenrol,
  tokenPrefix: enrollment.tokenPrefix,
  maxUses: enrollment.maxUses,
  uses: enrollment.uses,
  expiresAt: enrollment.expiresAt,
  lastUsedAt: enrollment.lastUsedAt,
  revokedAt: enrollment.revokedAt,
  createdBy: enrollment.createdBy,
  createdAt: enrollment.createdAt,
  status: enrollmentStatus(enrollment)
});

export const installCommands = (base: string, token: string) => ({
  linux: `curl -fsSL ${base}/agent/install.sh | sudo bash -s -- --url ${base} --token ${token}`,
  windows: `& ([scriptblock]::Create((irm ${base}/agent/install.ps1))) -Url ${base} -Token ${token}`
});

/**
 * @description Create an enrolment token and install commands. maxUses:
 * a number, or null for unlimited (until expiry); omitted means one use.
 * The token itself is returned only here.
 * @route /api/devices/enrollments
 * @request POST
 */
export const createEnrollment = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const site = await SiteModel.findByPk(Number(req.body?.siteId) || -1);

    if (!site || !(await canManageSiteEnrolment(req.user, site.id))) {
      return next(new ErrorResponse(404, 'Site was not found'));
    }

    const body = req.body || {};
    const hours = Math.min(Math.max(Number(body.expiresHours) || DEFAULT_EXPIRY_HOURS, 1), MAX_EXPIRY_HOURS);
    const maxUses =
      body.maxUses === null || body.maxUses === ''
        ? null
        : Math.min(Math.max(Math.floor(Number(body.maxUses)) || 1, 1), MAX_USES_LIMIT);
    const label = clean(body.label, 120);
    // Re-enrolling machines that already have a device is an admin decision
    const allowReenrol = body.allowReenrol === true;

    if (allowReenrol && !isAdminRole(req.user?.role)) {
      return next(new ErrorResponse(403, 'Only admins can create tokens that may re-enrol existing machines'));
    }

    const { token, hash, prefix } = await newToken('enroll');
    // Every token expires, unlimited ones included
    const expiresAt = new Date(Date.now() + hours * 3600_000);

    const enrollment = await DeviceEnrollmentModel.create({
      siteId: site.id,
      tokenHash: hash,
      tokenPrefix: prefix,
      expiresAt,
      maxUses,
      label,
      allowReenrol,
      createdBy: req.user?.id || null
    });

    await auditLog('device.enrollment_created', {
      ...auditActor(req),
      target: `site:${site.id}`,
      metadata: { site: site.name, enrollmentId: enrollment.id, tokenPrefix: prefix, maxUses, expiresAt, label, allowReenrol }
    });

    res.status(201).json({
      data: {
        ...enrollmentJson(enrollment, { id: site.id, name: site.name }),
        token,
        ...installCommands(origin(req), token)
      }
    });
  }
);

/**
 * @description List enrolment tokens the user may manage (never the tokens)
 * @route /api/devices/enrollments
 * @request GET
 */
export const getEnrollments = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    let siteIds: number[] | 'all' = 'all';

    if (!isAdminRole(req.user?.role)) {
      const memberships = req.user?.id
        ? await SiteMemberModel.findAll({ where: { userId: req.user.id, role: 'admin' } })
        : [];
      siteIds = memberships.map(member => member.siteId);
    }

    const requested = Number(req.query.siteId) || null;
    const where: { siteId?: number | number[] } = {};

    if (requested) {
      if (siteIds !== 'all' && !siteIds.includes(requested)) {
        res.status(200).json({ data: [] });
        return;
      }
      where.siteId = requested;
    } else if (siteIds !== 'all') {
      where.siteId = siteIds;
    }

    const enrollments = await DeviceEnrollmentModel.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: 200
    });
    const sites = enrollments.length
      ? await SiteModel.findAll({ where: { id: enrollments.map(item => item.siteId) }, attributes: ['id', 'name'] })
      : [];

    res.status(200).json({
      data: enrollments.map(item =>
        enrollmentJson(item, sites.find(site => site.id === item.siteId) || null)
      )
    });
  }
);

/**
 * @description Revoke an enrolment token. Devices already enrolled keep
 * working; they have their own tokens.
 * @route /api/devices/enrollments/:id
 * @request DELETE
 */
export const revokeEnrollment = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const enrollment = await DeviceEnrollmentModel.findByPk(Number(req.params.id) || -1);

    if (!enrollment || !(await canManageSiteEnrolment(req.user, enrollment.siteId))) {
      return next(new ErrorResponse(404, 'Enrollment token was not found'));
    }

    if (!enrollment.revokedAt) {
      await enrollment.update({ revokedAt: new Date(), revokedBy: req.user?.id || null });
      await auditLog('device.enrollment_revoked', {
        ...auditActor(req),
        target: `site:${enrollment.siteId}`,
        metadata: { enrollmentId: enrollment.id, tokenPrefix: enrollment.tokenPrefix, uses: enrollment.uses }
      });
    }

    res.status(200).json({ data: enrollmentJson(enrollment) });
  }
);

const findManagedDevice = async (req: AuthenticatedRequest, next: NextFunction) => {
  const device = await DeviceModel.findOne({ where: { id: Number(req.params.id) || -1, revokedAt: null } });

  if (!device) {
    next(new ErrorResponse(404, 'Device was not found'));
    return null;
  }

  return device;
};

/**
 * @description Rename a device (admins)
 * @route /api/devices/:id
 * @request PATCH
 */
export const updateDevice = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const device = await findManagedDevice(req, next);
    const name = String(req.body?.name || '').trim().slice(0, 120);

    if (!device) {
      return;
    }

    if (!name) {
      return next(new ErrorResponse(400, 'A name is required'));
    }

    await device.update({ name });
    res.status(200).json({ data: deviceJson(device) });
  }
);

/**
 * @description Clear a device's possible-duplicate flag once someone has
 * checked it (admins)
 * @route /api/devices/:id/clear-duplicate
 * @request POST
 */
export const clearDeviceDuplicate = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const device = await findManagedDevice(req, next);

    if (!device) {
      return;
    }

    const before = { possibleDuplicate: Boolean(device.possibleDuplicate), duplicateOf: device.duplicateOf || '' };
    await device.update({ possibleDuplicate: false, duplicateOf: '' });
    await auditLog('device.duplicate_cleared', {
      ...auditActor(req),
      target: `device:${device.id}`,
      metadata: { name: device.name, before }
    });

    res.status(200).json({ data: deviceJson(device) });
  }
);

export const cleanDeviceTags = (value: unknown): string =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : String(value || '').split(','))
        .map(tag => String(tag).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 40))
        .filter(Boolean)
    )
  )
    .slice(0, 20)
    .join(',');

/**
 * @description Replace a device's tags (admins, or site admins of its site)
 * @route /api/devices/:id/tags
 * @request PUT
 */
export const updateDeviceTags = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const device = await DeviceModel.findOne({ where: { id: Number(req.params.id) || -1, revokedAt: null } });

    if (!device || !(await canManageSiteEnrolment(req.user, device.siteId))) {
      return next(new ErrorResponse(404, 'Device was not found'));
    }

    // Shared tags: by id (tagIds) and/or by name (tags; new names create tags)
    const before = device.tags;
    const ids = [
      ...parseIdList(req.body?.tagIds),
      ...(req.body?.tags !== undefined ? await tagIdsForNames(cleanDeviceTags(req.body.tags).split(',').filter(Boolean)) : [])
    ];
    await setDeviceTagIds(device.id, Array.from(new Set(ids)));
    await device.reload();
    await auditLog('device.tags_updated', {
      ...auditActor(req),
      target: `device:${device.id}`,
      metadata: { name: device.name, before, after: device.tags }
    });

    res.status(200).json({ data: deviceJson(device) });
  }
);

const expireDeviceJobs = async (deviceId: number) => {
  const pending = await AgentJobModel.findAll({
    where: { deviceId, status: { [Op.in]: ['queued', 'running'] } }
  });
  for (const job of pending) {
    await finishAgentJob(job, {
      exitCode: null,
      stdout: '',
      stderr: 'The device was revoked before it reported a result.',
      durationMs: 0,
      status: 'expired'
    });
  }
};

/**
 * @description Revoke a device; its agent can no longer connect (admins)
 * @route /api/devices/:id
 * @request DELETE
 */
export const revokeDevice = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const device = await findManagedDevice(req, next);

    if (!device) {
      return;
    }

    await device.update({ revokedAt: new Date(), tokenHash: `revoked:${device.tokenHash}` });
    await expireDeviceJobs(device.id);

    // Clones of a revoked device: pending ones always go with it; approved
    // ones only when asked (body or ?revokeClones=true), e.g. a compromise
    const revokeApproved = req.body?.revokeClones === true || req.query.revokeClones === 'true';
    const clones = await DeviceModel.findAll({
      where: { clonedFrom: device.id, revokedAt: null, ...(revokeApproved ? {} : { clonePendingApproval: true }) }
    });
    for (const clone of clones) {
      await clone.update({ revokedAt: new Date(), tokenHash: `revoked:${clone.tokenHash}`, clonePendingApproval: false });
      await expireDeviceJobs(clone.id);
    }
    if (clones.length) {
      await auditLog('device.clone_cascade_revoked', {
        ...auditActor(req),
        target: `device:${device.id}`,
        metadata: { clones: clones.map(clone => clone.id), approvedIncluded: revokeApproved }
      });
    }

    await auditLog('device.revoked', {
      ...auditActor(req),
      target: `device:${device.id}`,
      metadata: { name: device.name, siteId: device.siteId }
    });

    res.status(200).json({ data: { revokedClones: clones.map(clone => clone.id) } });
  }
);

/**
 * @description Status of queued device jobs (?ids=1,2), with results when done
 * @route /api/devices/jobs
 * @request GET
 */
export const getJobs = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const requested = String(req.query.ids || '')
      .split(',')
      .map(Number)
      .filter(id => Number.isSafeInteger(id) && id > 0)
      .slice(0, 100);
    const siteIds = await accessibleSiteIds(req.user || {});
    const jobs = requested.length
      ? await AgentJobModel.findAll({
          where: {
            id: requested,
            ...(siteIds === 'all' ? {} : { siteId: siteIds.length ? siteIds : [-1] })
          },
          attributes: { exclude: ['payload', 'secretValues'] }
        })
      : [];
    const runs = await SnippetRunModel.findAll({
      where: { id: jobs.map(job => job.snippetRunId).filter(Boolean) as number[] }
    });
    const described = await describeRuns(runs, true);
    const devices = await DeviceModel.findAll({
      where: { id: jobs.map(job => job.deviceId) },
      attributes: ['id', 'name']
    });

    res.status(200).json({
      data: jobs.map(job => ({
        id: job.id,
        status: job.status,
        deviceId: job.deviceId,
        deviceName: devices.find(device => device.id === job.deviceId)?.name || null,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        run: described.find(run => run.id === job.snippetRunId) || null
      }))
    });
  }
);

// Agents -------------------------------------------------------------------

export interface AgentRequest extends Request {
  device?: DeviceInstance;
}

const bearer = (req: Request): string =>
  String(req.header('authorization') || '').replace(/^Bearer\s+/i, '').trim();

export const requireAgent = async (
  req: AgentRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = bearer(req);
    const device = token.startsWith('sc_dev_')
      ? await findByToken(
          token,
          await DeviceModel.findAll({
            where: { tokenPrefix: token.slice(0, 16), revokedAt: null },
            limit: 5
          })
        )
      : null;

    if (!device) {
      return next(new ErrorResponse(401, 'Device token is not valid or was revoked'));
    }

    // Every device-token endpoint: a token copied to other hardware is
    // refused (and audited) before the handler can touch the device. The
    // fingerprint travels only in the X-Agent-Fingerprint header (never the
    // query string, which ends up in proxy logs). It catches accidental
    // clones and golden images; it is not authentication, because whoever
    // holds the token can replay the header.
    if ((await checkFingerprint(device, req.header('x-agent-fingerprint'), requestIp(req))) === 'mismatch') {
      res.set('X-Reenrol-Required', '1');
      res.status(409).json({
        error: 'reenrol_required',
        message: 'This device token belongs to other hardware. Enrol this machine as its own device.'
      });
      return;
    }

    // A clone waiting for approval may only poll (idle) and report facts
    if (device.clonePendingApproval && !['/next', '/facts'].includes(req.path)) {
      res.status(403).json({ error: 'pending_approval', message: 'This device is waiting for an admin to approve it.' });
      return;
    }

    req.device = device;
    next();
  } catch (err) {
    next(new ErrorResponse(401, 'Device token is not valid or was revoked'));
  }
};

const clean = (value: unknown, length: number): string =>
  String(value || '').replace(/[^\w .:@()+\-/]/g, '').trim().slice(0, length);

// Interpreter names the agent found, e.g. "bash,python3"
const cleanList = (value: unknown): string =>
  String(value || '')
    .split(',')
    .map(item => clean(item, 30))
    .filter(Boolean)
    .slice(0, 20)
    .join(',');

// Machine IDs: /etc/machine-id on Linux, MachineGuid on Windows
const cleanMachineId = (value: unknown): string | null => {
  const id = String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 128);
  return id.length >= 8 ? id : null;
};

// Agent IDs: a random UUID each agent generates on first run
const cleanAgentId = (value: unknown): string | null => {
  const id = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : null;
};

// Hardware fingerprints: a sha256 hex digest computed by the agent
export const cleanFingerprint = (value: unknown): string | null => {
  const hash = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
};

const mergeIds = (list: string, ids: number[]): string =>
  Array.from(new Set([...list.split(',').map(Number).filter(Boolean), ...ids])).sort((a, b) => a - b).join(',');

/**
 * Hint only, never a refusal: flag devices at the same site that share this
 * one's machine ID, or its hostname, OS and architecture.
 */
export const flagPossibleDuplicates = async (
  device: DeviceInstance,
  options: { transaction?: import('sequelize').Transaction } = {}
): Promise<number[]> => {
  const match: Array<{ [key: string]: unknown }> = [{ hostname: device.hostname, os: device.os, arch: device.arch }];
  if (device.machineId) match.push({ machineId: device.machineId });
  const others = await DeviceModel.findAll({
    where: { siteId: device.siteId, revokedAt: null, id: { [Op.ne]: device.id }, [Op.or]: match },
    transaction: options.transaction
  });
  if (!others.length) return [];
  for (const other of others) {
    await other.update({ possibleDuplicate: true, duplicateOf: mergeIds(other.duplicateOf || '', [device.id]) }, options);
  }
  await device.update(
    { possibleDuplicate: true, duplicateOf: mergeIds(device.duplicateOf || '', others.map(other => other.id)) },
    options
  );
  return others.map(other => other.id);
};

/**
 * @description Swap an enrolment token for a device token. Each machine
 * gets its own device and device token. Re-running the installer on the
 * same machine (same machine ID, or same hostname, OS and architecture when
 * no ID is sent) reuses that device and issues it a new token instead of
 * creating a duplicate. Send ?format=env for KEY=value lines.
 * @route /api/agent/enroll
 * @request POST
 */
export const enrollDevice = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const body = req.body || {};
    const token = String(body.token || bearer(req));
    const hostname = clean(body.hostname, 255) || 'unknown-host';
    const os = clean(body.os, 40);
    const arch = clean(body.arch, 40);
    const machineId = cleanMachineId(body.machineId || body.machine_id);
    let agentId = cleanAgentId(body.agentId || body.agent_id);
    // Header (preferred, like every agent request) or the form body; never the query string
    const fingerprint = cleanFingerprint(req.header('x-agent-fingerprint') || body.fingerprint);
    const ip = requestIp(req);
    // Set when this agent turns out to be a clone of another device
    let clonedFrom: number | null = null;

    const result = await sequelize.transaction(async transaction => {
      // Row locks serialise concurrent enrolments on the same token
      const enrollment = await findByToken(
        token,
        await DeviceEnrollmentModel.findAll({
          where: { tokenPrefix: token.slice(0, 16) },
          lock: transaction.LOCK.UPDATE,
          limit: 5,
          transaction
        }),
        { transaction }
      );

      if (!enrollment || enrollmentStatus(enrollment) !== 'active') {
        return null;
      }

      // Agents that send an agent ID are matched on it alone; a shared
      // hostname or machine ID (clones, golden images) is only a hint.
      // Older agents without one keep the machine ID / hostname match.
      let existing: DeviceInstance | null;
      if (agentId) {
        const holder = await DeviceModel.findOne({ where: { agentId }, lock: transaction.LOCK.UPDATE, transaction });
        if (holder && !holder.revokedAt && holder.fingerprint && fingerprint && holder.fingerprint !== fingerprint) {
          // Same agent ID, different hardware: a cloned disk or VM. It gets
          // a fresh agent ID and its own device; the original is untouched.
          clonedFrom = holder.id;
          agentId = randomUUID();
          existing = null;
        } else if (holder && holder.revokedAt) {
          // A revoked device gives up its agent ID
          await holder.update({ agentId: null }, { transaction });
          existing = null;
        } else if (holder && holder.siteId !== enrollment.siteId) {
          return { refused: true as const, enrollment, deviceId: holder.id };
        } else {
          existing = holder;
        }
      } else {
        existing = await DeviceModel.findOne({
          where: machineId
            ? { siteId: enrollment.siteId, machineId, revokedAt: null }
            : { siteId: enrollment.siteId, machineId: null, hostname, os, arch, revokedAt: null },
          order: [['id', 'ASC']],
          lock: transaction.LOCK.UPDATE,
          transaction
        });
      }

      // A machine that already has a device keeps it: a shared token could
      // otherwise take over any device whose machine ID it knows. Only tokens
      // an admin created with allowReenrol may rotate it, and re-enrolment
      // never uses up the token.
      // A clone activation token belongs to one pending clone and nothing else
      if (enrollment.forDeviceId && existing?.id !== enrollment.forDeviceId) {
        return null;
      }
      // Only a single-use activation token made for this clone activates it
      // (or an admin approval); bulk and multi-use tokens never do, and
      // nothing activates a clone whose source has been revoked
      const activatesClone = Boolean(
        existing?.clonePendingApproval &&
          enrollment.forDeviceId === existing.id &&
          enrollment.maxUses === 1 &&
          existing.siteId === enrollment.siteId
      );
      if (existing?.clonePendingApproval && !activatesClone) {
        return { refused: true as const, enrollment, deviceId: existing.id };
      }
      if (activatesClone && existing!.clonedFrom) {
        const source = await DeviceModel.findByPk(existing!.clonedFrom, { transaction });
        if (!source || source.revokedAt) {
          return { refused: true as const, enrollment, deviceId: existing!.id, sourceRevoked: true };
        }
      }
      if (existing && !enrollment.allowReenrol && !activatesClone) {
        return { refused: true as const, enrollment, deviceId: existing.id };
      }

      if (existing && !activatesClone) {
        await enrollment.update({ lastUsedAt: new Date() }, { transaction });
      } else {
        // Conditional increment: max uses can never be exceeded, even if two
        // requests got past the check above
        const [, claimed] = await sequelize.query(
          `UPDATE device_enrollments
              SET uses = uses + 1, "lastUsedAt" = NOW(), "updatedAt" = NOW()
            WHERE id = :id AND "revokedAt" IS NULL AND "expiresAt" > NOW()
              AND ("maxUses" IS NULL OR uses < "maxUses")`,
          { replacements: { id: enrollment.id }, transaction }
        );

        if (!Number((claimed as { rowCount?: number })?.rowCount ?? claimed)) {
          return null;
        }
      }

      const deviceToken = await newToken('dev');
      const values = {
        hostname,
        os,
        arch,
        agentVersion: clean(body.version, 40),
        capabilities: cleanList(body.capabilities),
        tokenHash: deviceToken.hash,
        tokenPrefix: deviceToken.prefix,
        machineId,
        ...(agentId ? { agentId } : {}),
        ...(fingerprint ? { fingerprint } : {}),
        ...(existing ? { clonePendingApproval: false } : {}),
        lastSeenAt: new Date(),
        lastIp: ip
      };

      const device = existing
        ? await existing.update(values, { transaction })
        : await DeviceModel.create(
            {
              ...values,
              siteId: enrollment.siteId,
              name: clean(body.name, 120) || hostname,
              ...(clonedFrom ? { clonedFrom, possibleDuplicate: true, duplicateOf: String(clonedFrom) } : {})
            },
            { transaction }
          );

      const duplicates = agentId ? await flagPossibleDuplicates(device, { transaction }) : [];

      return {
        refused: false as const,
        device,
        token: deviceToken.token,
        enrollment,
        reused: Boolean(existing),
        duplicates,
        clonedFrom,
        activatedClone: activatesClone
      };
    });

    if (result && !result.refused && result.activatedClone) {
      await auditLog('device.clone_activated', {
        ipAddress: ip,
        target: `device:${result.device.id}`,
        metadata: { enrollmentId: result.enrollment.id, tokenPrefix: result.enrollment.tokenPrefix, clonedFrom: result.device.clonedFrom }
      });
    }

    if (result?.refused) {
      await auditLog('sourceRevoked' in result && result.sourceRevoked ? 'device.clone_activation_refused' : 'device.reenrol_refused', {
        ipAddress: ip,
        target: `device:${result.deviceId}`,
        metadata: {
          hostname,
          machineId,
          agentId,
          enrollmentId: result.enrollment.id,
          tokenPrefix: result.enrollment.tokenPrefix
        }
      });
      return next(
        new ErrorResponse(
          409,
          'This machine is already enrolled. Ask an admin to revoke the device or issue a re-enrol token.'
        )
      );
    }

    if (!result) {
      await auditLog('device.enroll_failed', {
        ipAddress: ip,
        target: 'enrollment',
        metadata: { tokenPrefix: token.startsWith('sc_enroll_') ? token.slice(0, 16) : null, hostname }
      });
      return next(new ErrorResponse(401, 'Enrollment token is not valid, expired, revoked, or used up'));
    }

    const site = await SiteModel.findByPk(result.device.siteId);

    await auditLog(result.reused ? 'device.reenrolled' : 'device.enrolled', {
      ipAddress: ip,
      target: `device:${result.device.id}`,
      metadata: {
        name: result.device.name,
        site: site?.name,
        os: result.device.os,
        hostname: result.device.hostname,
        machineId: result.device.machineId,
        agentId: result.device.agentId,
        possibleDuplicateOf: result.duplicates,
        clonedFrom: result.clonedFrom,
        enrollmentId: result.enrollment.id,
        tokenPrefix: result.enrollment.tokenPrefix
      }
    });

    if (!result.reused) {
      emitEvent({
        event: 'device.enrolled',
        severity: 'info',
        title: `${result.device.name} joined ${site?.name || 'a site'}`,
        text: `${result.device.os || 'Unknown OS'} ${result.device.arch} · ${result.device.hostname}`,
        siteId: result.device.siteId,
        path: `/sites/${result.device.siteId}`,
        data: { deviceId: result.device.id }
      });
    }

    if (req.query.format === 'env') {
      res
        .type('text/plain')
        .status(201)
        .send(
          `DEVICE_ID=${result.device.id}\nDEVICE_TOKEN=${result.token}\nSITE=${site?.slug || ''}\n` +
            `AGENT_ID=${result.device.agentId || ''}\n`
        );
      return;
    }

    res.status(201).json({
      data: {
        deviceId: result.device.id,
        token: result.token,
        site: site?.slug,
        reused: result.reused,
        agentId: result.device.agentId,
        clonedFrom: result.clonedFrom,
        possibleDuplicate: result.device.possibleDuplicate
      }
    });
  }
);

/**
 * An agent with a valid device token that sends its agent ID for the first
 * time gets it registered on its existing device: no re-enrolment, no lost
 * history. An ID another live device already holds is never moved.
 */
export const backfillAgentId = async (device: DeviceInstance, value: unknown, ip?: string | null): Promise<void> => {
  const agentId = cleanAgentId(value);
  if (!agentId || device.agentId) return;
  const holder = await DeviceModel.findOne({ where: { agentId } });
  if (holder) {
    if (holder.id !== device.id) {
      await auditLog('device.agent_id_conflict', {
        ipAddress: ip || undefined,
        target: `device:${device.id}`,
        metadata: { agentId, heldBy: holder.id }
      });
    }
    return;
  }
  try {
    await device.update({ agentId });
  } catch {
    // Lost a race for the same ID; leave it unset
    return;
  }
  await flagPossibleDuplicates(device).catch(() => undefined);
  await auditLog('device.agent_id_registered', {
    ipAddress: ip || undefined,
    target: `device:${device.id}`,
    metadata: { agentId }
  });
};

export const FINGERPRINT_BINDING_DAYS = 7;

const bindingWindowOpen = async (): Promise<boolean> => {
  const [rows] = (await sequelize.query(`SELECT value FROM settings WHERE key = 'fingerprintBindingSince'`)) as [
    Array<{ value: string }>,
    unknown
  ];
  const since = rows[0] ? new Date(rows[0].value).getTime() : NaN;
  return Number.isFinite(since) && Date.now() - since < FINGERPRINT_BINDING_DAYS * 86400_000;
};

/**
 * Fingerprint check for every device-token request (header only).
 * - The device has a fingerprint: the request must carry the same one.
 *   Missing, malformed or different is a mismatch (409 reenrol_required).
 * - The device has none yet (enrolled before migration 25): the first one
 *   is bound. It is trusted when the request comes from the device's last
 *   known address, or within 7 days of migration 25. Otherwise it is still
 *   bound, so the agent keeps working, but the device is flagged
 *   fingerprintPendingReview and admins are alerted.
 * This detects accidental clones; it does not stop a token thief, who can
 * replay the original fingerprint.
 */
export const checkFingerprint = async (
  device: DeviceInstance,
  value: unknown,
  ip?: string | null
): Promise<'ok' | 'mismatch'> => {
  const fingerprint = cleanFingerprint(value);
  if (!device.fingerprint) {
    if (!fingerprint) return 'ok';
    // Only the device's last known address is trusted. Inside the 7-day
    // window after migration 25 the agent still gets access, but a binding
    // from anywhere else is flagged for review all the same
    const sameIp = Boolean(ip) && ip === device.lastIp;
    const windowOpen = sameIp ? false : await bindingWindowOpen();
    const trusted = sameIp;
    // Only bind if nobody else did in the meantime
    const [, bound] = await sequelize.query(
      `UPDATE devices SET fingerprint = :fingerprint, "fingerprintPendingReview" = :review, "updatedAt" = NOW()
        WHERE id = :id AND fingerprint IS NULL`,
      { replacements: { id: device.id, fingerprint, review: !trusted } }
    );
    await device.reload();
    if (!Number((bound as { rowCount?: number })?.rowCount ?? bound)) {
      return device.fingerprint === fingerprint ? 'ok' : 'mismatch';
    }
    await auditLog(trusted ? 'device.fingerprint_bound' : 'device.fingerprint_pending_review', {
      ipAddress: ip || undefined,
      target: `device:${device.id}`,
      metadata: { lastIp: device.lastIp, trusted, bindingWindow: windowOpen }
    });
    if (!trusted) {
      emitEvent({
        event: 'device.fingerprint_review',
        severity: 'warning',
        title: `${device.name}: hardware fingerprint needs review`,
        text: `First fingerprint came from ${ip || 'an unknown address'}, not the last known address ${device.lastIp || 'unknown'}.`,
        siteId: device.siteId,
        path: `/devices/${device.id}`,
        data: { deviceId: device.id }
      });
    }
    return 'ok';
  }
  if (fingerprint && device.fingerprint === fingerprint) return 'ok';
  await auditLog('device.fingerprint_mismatch', {
    ipAddress: ip || undefined,
    target: `device:${device.id}`,
    metadata: { reason: 'reenrol_required', fingerprint: fingerprint ? 'different' : 'missing' }
  });
  return 'mismatch';
};

export const CLONE_ENROLL_PER_HOUR = Number(process.env.CLONE_ENROLL_PER_HOUR) || 5;
export const CLONE_MAX_PER_SOURCE = Number(process.env.CLONE_MAX_PER_SOURCE) || 20;
export const CLONE_GLOBAL_PER_HOUR = Number(process.env.CLONE_GLOBAL_PER_HOUR) || 50;

class CloneLimit extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Atomic per-window counter: the UPSERT locks the row, so concurrent
 * requests serialise and each sees the true count. Runs inside the clone
 * transaction, so a refused or failed attempt rolls its increment back.
 */
const bumpCounter = async (scope: string, limit: number, transaction: Transaction): Promise<void> => {
  const [rows] = (await sequelize.query(
    `INSERT INTO clone_enroll_counters (scope, "windowStart", count)
     VALUES (:scope, date_trunc('hour', NOW()), 1)
     ON CONFLICT (scope, "windowStart") DO UPDATE SET count = clone_enroll_counters.count + 1
     RETURNING count`,
    { replacements: { scope }, transaction }
  )) as [Array<{ count: number }>, unknown];
  if (Number(rows[0]?.count) > limit) throw new CloneLimit(scope === 'global' ? 'global_rate_limited' : 'rate_limited');
};

/**
 * @description Clone self-enrol. A machine whose device token was refused
 * with reenrol_required (a cloned disk or VM) swaps that token for a new
 * device at the same site, flagged possibleDuplicate with clonedFrom. The
 * new device starts INACTIVE (pending approval): no jobs, scripts, secrets
 * or schedule values until an admin approves it or a fresh enrolment token
 * activates it. The source device is never modified. Guards: one clone per
 * (source, fingerprint); a lifetime cap per source; hourly limits per source
 * and instance-wide (race-safe counters; refusals are not counted); revoked
 * or pending sources refused. Every attempt is audited and each clone
 * raises a notification.
 * @route /api/agent/clone-enroll
 * @request POST
 */
export const cloneEnrollDevice = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const body = req.body || {};
    const token = bearer(req);
    // Header only, like every other device-token request
    const fingerprint = cleanFingerprint(req.header('x-agent-fingerprint'));
    const sentAgentId = cleanAgentId(body.agentId || body.agent_id);
    const ip = requestIp(req);

    type Outcome = {
      status: number;
      reason: string;
      source: DeviceInstance | null;
      device?: DeviceInstance;
      token?: string;
    };

    const outcome: Outcome = await sequelize
      .transaction(async (transaction): Promise<Outcome> => {
        const source = token.startsWith('sc_dev_')
          ? await findByToken(
              token,
              await DeviceModel.findAll({
                where: { tokenPrefix: token.slice(0, 16) },
                lock: transaction.LOCK.UPDATE,
                limit: 5,
                transaction
              }),
              { transaction }
            )
          : null;

        if (!source) {
          // Revoking prefixes the stored hash with "revoked:"; recognise such
          // a token so the refusal is reported (and audited) against its device
          if (token.startsWith('sc_dev_')) {
            const revokedCandidates = await DeviceModel.findAll({
              where: { tokenPrefix: token.slice(0, 16), revokedAt: { [Op.ne]: null } },
              limit: 5,
              transaction
            });
            for (const candidate of revokedCandidates) {
              const stored = candidate.tokenHash.replace(/^revoked:/, '');
              if ((await checkTokenHash(token, stored)).ok) return { status: 403, reason: 'source_revoked', source: candidate };
            }
          }
          return { status: 401, reason: 'bad_token', source: null };
        }
        if (source.revokedAt) return { status: 403, reason: 'source_revoked', source };
        if (source.clonePendingApproval) return { status: 403, reason: 'source_pending_approval', source };
        if (!fingerprint) return { status: 400, reason: 'bad_fingerprint', source };
        if (!source.fingerprint || source.fingerprint === fingerprint) {
          return { status: 400, reason: 'not_a_clone', source };
        }

        // Safer option: never re-issue a token for a clone that already exists
        const already = await DeviceModel.findOne({ where: { clonedFrom: source.id, fingerprint }, transaction });
        if (already) return { status: 409, reason: 'already_cloned', source };

        const lifetime = await DeviceModel.count({ where: { clonedFrom: source.id }, transaction });
        if (lifetime >= CLONE_MAX_PER_SOURCE) return { status: 429, reason: 'lifetime_cap', source };

        await bumpCounter(`device:${source.id}`, CLONE_ENROLL_PER_HOUR, transaction);
        await bumpCounter('global', CLONE_GLOBAL_PER_HOUR, transaction);

        const deviceToken = await newToken('dev');
        const device = await DeviceModel.create(
          {
            siteId: source.siteId,
            name: `${source.name} (clone)`.slice(0, 120),
            hostname: clean(body.hostname, 255) || source.hostname,
            os: source.os,
            arch: source.arch,
            agentVersion: clean(body.version, 40) || source.agentVersion,
            capabilities: source.capabilities,
            tokenHash: deviceToken.hash,
            tokenPrefix: deviceToken.prefix,
            agentId: randomUUID(),
            fingerprint,
            clonedFrom: source.id,
            clonePendingApproval: true,
            possibleDuplicate: true,
            duplicateOf: String(source.id),
            lastSeenAt: new Date(),
            lastIp: ip
          },
          { transaction }
        );
        return { status: 201, reason: 'created', source, device, token: deviceToken.token };
      })
      .catch(async (err): Promise<Outcome> => {
        if (err instanceof CloneLimit) {
          // Rolled back, so nothing was counted; report it against the source
          const source = token.startsWith('sc_dev_')
            ? await findByToken(token, await DeviceModel.findAll({ where: { tokenPrefix: token.slice(0, 16) }, limit: 5 }))
            : null;
          return { status: 429, reason: err.reason, source };
        }
        // The unique (clonedFrom, fingerprint) index caught a concurrent repeat
        if (err?.name === 'SequelizeUniqueConstraintError') return { status: 409, reason: 'already_cloned', source: null };
        throw err;
      });

    await auditLog(outcome.status === 201 ? 'device.clone_enroll' : 'device.clone_enroll_refused', {
      ipAddress: ip,
      target: outcome.source ? `device:${outcome.source.id}` : 'device',
      metadata: {
        reason: outcome.reason,
        agentId: sentAgentId,
        ...(outcome.device ? { cloneDeviceId: outcome.device.id } : {})
      }
    });

    if (!outcome.device) {
      const messages: { [reason: string]: string } = {
        bad_fingerprint: 'Send the hardware fingerprint in the X-Agent-Fingerprint header',
        not_a_clone: 'This device token matches this hardware; there is nothing to clone',
        bad_token: 'Device token is not valid',
        source_revoked: 'The source device was revoked',
        source_pending_approval: 'The source device is itself waiting for approval',
        already_cloned: 'A clone device already exists for this hardware. Ask an admin to issue a re-enrol token.',
        lifetime_cap: 'This device has reached its clone limit. Ask an admin to enrol the machine.',
        rate_limited: 'Too many clone enrolments for this device. Try again later.',
        global_rate_limited: 'Too many clone enrolments right now. Try again later.'
      };
      return next(new ErrorResponse(outcome.status, messages[outcome.reason] || 'Clone enrolment failed'));
    }

    const clone = outcome.device;
    await flagPossibleDuplicates(clone).catch(() => undefined);
    const site = await SiteModel.findByPk(clone.siteId);
    emitEvent({
      event: 'device.clone_pending',
      severity: 'warning',
      title: `Clone of ${outcome.source!.name} is waiting for approval`,
      text: `${clone.hostname} enrolled itself as a clone from ${ip || 'an unknown address'}. Approve or deny it.`,
      siteId: clone.siteId,
      path: `/devices/${clone.id}`,
      data: { deviceId: clone.id, clonedFrom: outcome.source!.id }
    });

    if (req.query.format === 'env') {
      res
        .type('text/plain')
        .status(201)
        .send(
          `DEVICE_ID=${clone.id}\nDEVICE_TOKEN=${outcome.token}\nSITE=${site?.slug || ''}\n` +
            `AGENT_ID=${clone.agentId}\nSTATUS=pending_approval\n`
        );
      return;
    }
    res.status(201).json({
      data: {
        deviceId: clone.id,
        token: outcome.token,
        agentId: clone.agentId,
        site: site?.slug,
        clonedFrom: outcome.source!.id,
        possibleDuplicate: true,
        status: 'pending_approval'
      }
    });
  }
);

const findCloneForDecision = async (req: AuthenticatedRequest, next: NextFunction) => {
  if (!isAdminRole(req.user?.role)) {
    next(new ErrorResponse(403, 'Only admins can approve or deny clones'));
    return null;
  }
  const device = await DeviceModel.findOne({ where: { id: Number(req.params.id) || -1, revokedAt: null } });
  if (!device || !(await canManageSiteEnrolment(req.user, device.siteId))) {
    next(new ErrorResponse(404, 'Device was not found'));
    return null;
  }
  if (!device.clonePendingApproval) {
    next(new ErrorResponse(409, 'This device is not waiting for clone approval'));
    return null;
  }
  return device;
};

/**
 * @description Approve a self-enrolled clone: it starts getting jobs (admins)
 * @route /api/devices/:id/approve-clone
 * @request POST
 */
export const approveClone = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const device = await findCloneForDecision(req, next);
    if (!device) return;
    const source = device.clonedFrom ? await DeviceModel.findByPk(device.clonedFrom) : null;
    if (device.clonedFrom && (!source || source.revokedAt)) {
      await auditLog('device.clone_activation_refused', {
        ...auditActor(req),
        target: `device:${device.id}`,
        metadata: { reason: 'source_revoked', clonedFrom: device.clonedFrom }
      });
      return next(new ErrorResponse(409, 'The device this was cloned from is revoked, so the clone cannot be approved'));
    }
    await device.update({ clonePendingApproval: false });
    await auditLog('device.clone_approved', {
      ...auditActor(req),
      target: `device:${device.id}`,
      metadata: { name: device.name, clonedFrom: device.clonedFrom }
    });
    res.status(200).json({ data: deviceJson(device) });
  }
);

/**
 * @description Deny a self-enrolled clone: revoke it and delete its token (admins)
 * @route /api/devices/:id/deny-clone
 * @request POST
 */
export const denyClone = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const device = await findCloneForDecision(req, next);
    if (!device) return;
    await device.update({
      revokedAt: new Date(),
      // The token is gone: no hash that any token can match
      tokenHash: 'denied',
      tokenPrefix: `denied-${device.id}`.slice(0, 20),
      agentId: null,
      clonePendingApproval: false
    });
    await auditLog('device.clone_denied', {
      ...auditActor(req),
      target: `device:${device.id}`,
      metadata: { name: device.name, clonedFrom: device.clonedFrom }
    });
    res.status(200).json({ data: deviceJson(device) });
  }
);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Claim the oldest queued job for a device, skipping jobs another poll took.
 */
const claimJob = async (deviceId: number) =>
  sequelize.transaction(async transaction => {
    const job = await AgentJobModel.findOne({
      where: { deviceId, status: 'queued' },
      order: [['createdAt', 'ASC']],
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
      transaction
    });

    if (job) {
      await job.update({ status: 'running', startedAt: new Date() }, { transaction });
    }

    return job;
  });

/**
 * @description Long-poll for the next job. 204 when there is nothing to do;
 * otherwise the code as the body, with X-Job-Id, X-Job-Language and
 * X-Job-Timeout-Ms headers.
 * @route /api/agent/next
 * @request GET
 */
export const nextJob = asyncWrapper(
  async (req: AgentRequest, res: Response): Promise<void> => {
    const device = req.device!;
    const wasOffline = Boolean(device.offlineNotifiedAt);
    await backfillAgentId(device, req.query.agentId, requestIp(req));

    await device.update({
      lastSeenAt: new Date(),
      lastIp: requestIp(req),
      offlineNotifiedAt: null,
      ...(req.query.caps !== undefined ? { capabilities: cleanList(req.query.caps) } : {}),
      ...(req.query.version ? { agentVersion: clean(req.query.version, 40) } : {})
    });

    if (wasOffline) {
      emitEvent({
        event: 'device.offline',
        severity: 'success',
        title: `${device.name} is back online`,
        text: `Last address ${device.lastIp || 'unknown'}.`,
        siteId: device.siteId,
        path: `/sites/${device.siteId}`,
        data: { deviceId: device.id, online: true }
      });
    }

    // Agents compare this with their own version and update themselves;
    // only devices the staged rollout (or a pin) includes are told
    await setLatestHeader(res, device);

    // A clone waiting for approval stays idle: nothing is ever dispatched
    if (device.clonePendingApproval) {
      res.set('X-Device-Status', 'pending_approval');
      res.status(204).end();
      return;
    }

    const waitMs = Math.min(Math.max(Number(req.query.wait) || 0, 0), 30) * 1000;
    const until = Date.now() + waitMs;
    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    do {
      const job = await claimJob(device.id);

      if (job) {
        let code: string;

        try {
          code = decryptSecret(job.payload);
        } catch {
          await finishAgentJob(job, {
            exitCode: null,
            stdout: '',
            stderr: 'The job could not be decrypted on the server.',
            durationMs: 0,
            status: 'failed'
          });
          continue;
        }

        res
          .status(200)
          .type('text/plain')
          .set({
            'X-Job-Id': String(job.id),
            'X-Job-Language': job.language,
            'X-Job-Timeout-Ms': String(job.timeoutMs),
            'Cache-Control': 'no-store'
          })
          .send(code);
        return;
      }

      if (closed || Date.now() >= until) {
        break;
      }

      await sleep(1000);
    } while (Date.now() < until && !closed);

    res.status(204).end();
  }
);

/**
 * @description Report a job result. Accepts JSON, or multipart form fields
 * (stdout and stderr may be files) from curl -F.
 * @route /api/agent/jobs/:id/result
 * @request POST
 */
export const submitJobResult = asyncWrapper(
  async (req: AgentRequest, res: Response, next: NextFunction): Promise<void> => {
    const job = await AgentJobModel.findOne({
      where: { id: Number(req.params.id) || -1, deviceId: req.device!.id }
    });

    if (!job) {
      return next(new ErrorResponse(404, 'Job was not found for this device'));
    }

    const files = (req as Request & { files?: { [field: string]: { buffer: Buffer }[] } }).files || {};
    const text = (field: string): string =>
      files[field]?.[0]
        ? files[field][0].buffer.toString('utf8')
        : typeof req.body?.[field] === 'string'
        ? req.body[field]
        : '';
    const exitRaw = req.body?.exitCode;
    const exitCode = exitRaw === undefined || exitRaw === '' || exitRaw === null ? null : Number(exitRaw);

    await req.device!.update({ lastSeenAt: new Date() });

    const run = await finishAgentJob(job, {
      exitCode: Number.isFinite(exitCode) ? exitCode : null,
      stdout: text('stdout'),
      stderr: text('stderr'),
      durationMs: Number(req.body?.durationMs) || 0,
      timedOut: String(req.body?.timedOut) === 'true'
    });

    res.status(200).json({ data: { accepted: Boolean(run), runId: run?.id || null } });
  }
);

const number = (value: unknown, max: number): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(Math.round(parsed * 10) / 10, max) : undefined;
};

/**
 * @description The agent reports what the machine is: OS, memory, disk,
 * uptime, and address. Sent on start and every few minutes.
 * @route /api/agent/facts
 * @request POST
 */
export const submitFacts = asyncWrapper(
  async (req: AgentRequest, res: Response): Promise<void> => {
    const body = req.body || {};
    const facts: DeviceFacts = {
      osName: clean(body.osName, 120) || undefined,
      kernel: clean(body.kernel, 120) || undefined,
      cpus: number(body.cpus, 4096),
      memTotalMb: number(body.memTotalMb, 1e8),
      memAvailableMb: number(body.memAvailableMb, 1e8),
      diskTotalGb: number(body.diskTotalGb, 1e7),
      diskUsedGb: number(body.diskUsedGb, 1e7),
      uptimeSeconds: number(body.uptimeSeconds, 1e10),
      ip: clean(body.ip, 64) || undefined,
      timezone: clean(body.timezone, 64) || undefined,
      load1: number(body.load1, 10000),
      load5: number(body.load5, 10000),
      load15: number(body.load15, 10000),
      cpuPercent: number(body.cpuPercent, 100)
    };

    await req.device!.update({
      facts: JSON.stringify(facts),
      factsAt: new Date(),
      lastSeenAt: new Date(),
      ...(body.version ? { agentVersion: clean(body.version, 40) } : {}),
      ...(body.hostname ? { hostname: clean(body.hostname, 255) } : {})
    });

    await recordFactsMetric(req.device!, facts).catch(() => undefined);

    await setLatestHeader(res, req.device!);
    res.status(200).json({ data: { latest: AGENT_VERSION } });
  }
);

// Device page and tools ------------------------------------------------------

const roleRank: { [key: string]: number } = { viewer: 10, user: 20, editor: 30, admin: 40, owner: 50 };

/**
 * A device the user may see (through its site). Null after reporting 404.
 */
const findVisibleDevice = async (req: AuthenticatedRequest, next: NextFunction) => {
  const device = await DeviceModel.findOne({ where: { id: Number(req.params.id) || -1, revokedAt: null } });
  const site = device ? await SiteModel.findByPk(device.siteId) : null;

  if (!device || !site || !(await canAccessSite(req.user || {}, site))) {
    next(new ErrorResponse(404, 'Device was not found'));
    return null;
  }

  return { device, site };
};

const readInventory = (device: DeviceInstance): Record<string, unknown> => {
  try {
    return JSON.parse(device.inventory || '{}');
  } catch {
    return {};
  }
};

const jobJson = (job: AgentJobInstance) => ({
  id: job.id,
  status: job.status,
  tool: job.tool,
  title: job.snippetTitle,
  createdAt: job.createdAt
});

/**
 * @description One device with its site, cached tool results, and the tools
 * it supports
 * @route /api/devices/:id
 * @request GET
 */
export const getDevice = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const found = await findVisibleDevice(req, next);

    if (!found) {
      return;
    }

    const { device, site } = found;
    const [lastRun, pending] = await Promise.all([
      SnippetRunModel.findOne({
        where: { deviceId: device.id, kind: 'snippet' },
        order: [['createdAt', 'DESC']],
        attributes: ['id', 'snippetTitle', 'ok', 'createdAt']
      }),
      AgentJobModel.findAll({
        where: { deviceId: device.id, status: { [Op.in]: ['queued', 'running'] } },
        attributes: { exclude: ['payload', 'secretValues'] },
        order: [['createdAt', 'ASC']]
      })
    ]);
    const os = deviceToolOs(device);

    res.status(200).json({
      data: {
        ...deviceJson(device, lastRun),
        site: { id: site.id, name: site.name, slug: site.slug },
        toolOs: os,
        tools: os ? READ_TOOLS.map(tool => ({ id: tool, label: TOOL_LABELS[tool] })) : [],
        inventory: readInventory(device),
        fields: readJson(device.fields),
        remote: publicRemote(device),
        pendingJobs: pending.map(jobJson),
        canAct: (roleRank[req.user?.role || ''] || 0) >= roleRank.editor
      }
    });
  }
);

/**
 * @description Run a device tool. Read tools (services, tasks, ...) refresh
 * the device's inventory; action tools (service, task, process, shell) change
 * the machine and need an editor.
 * @route /api/devices/:id/tools/:tool
 * @request POST
 */
export const runDeviceTool = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const found = await findVisibleDevice(req, next);

    if (!found) {
      return;
    }

    const { device, site } = found;
    const tool = String(req.params.tool) as ToolId;
    const isRead = (READ_TOOLS as string[]).includes(tool);
    const isAction = (ACTION_TOOLS as string[]).includes(tool);

    if (!isRead && !isAction) {
      return next(new ErrorResponse(404, 'Unknown tool'));
    }

    const viewOnly = (VIEW_TOOLS as string[]).includes(tool);

    if (isAction && !viewOnly && (roleRank[req.user?.role || ''] || 0) < roleRank.editor) {
      return next(new ErrorResponse(403, 'Editors can make changes on devices'));
    }

    // The shell runs anything; keep it to admins unless opened up
    if (tool === 'shell' && !isAdminRole(req.user?.role) && process.env.DEVICE_SHELL_FOR_EDITORS !== 'true') {
      return next(new ErrorResponse(403, 'Only admins can use the device shell'));
    }

    // One refresh of each kind at a time
    if (isRead) {
      const running = await AgentJobModel.findOne({
        where: { deviceId: device.id, tool, status: { [Op.in]: ['queued', 'running'] } }
      });

      if (running) {
        res.status(202).json({ data: jobJson(running) });
        return;
      }
    }

    let job: AgentJobInstance;

    try {
      job = await queueToolJob({ device, tool, args: req.body?.args || {}, userId: req.user?.id });
    } catch (err) {
      return next(new ErrorResponse(400, err instanceof ToolError || err instanceof Error ? err.message : 'Could not queue'));
    }

    // Browsing folders is routine; everything else that acts is audited
    if (isAction && !viewOnly) {
      await auditLog('device.tool', {
        ...auditActor(req),
        target: `device:${device.id}`,
        metadata: {
          device: device.name,
          site: site.name,
          action: job.snippetTitle,
          ...(tool === 'shell' ? { command: String(req.body?.args?.code || '').slice(0, 500) } : {})
        }
      });
    }

    res.status(202).json({ data: jobJson(job) });
  }
);

// Fields, remote access, metrics, downloads ------------------------------------

const publicRemote = (device: DeviceInstance) => {
  const remote = readJson<DeviceRemote>(device.remote);
  return { ...remote, password: undefined, hasPassword: Boolean(remote.password) };
};

const cleanText = (value: unknown, length: number): string | undefined => {
  const text = typeof value === 'string' ? value.trim().slice(0, length) : '';
  return text || undefined;
};

/**
 * @description Asset tag, owner, location, warranty, notes and custom fields
 * @route /api/devices/:id/fields
 * @request PUT
 */
export const updateDeviceFields = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const found = await findVisibleDevice(req, next);
    if (!found) return;

    if ((roleRank[req.user?.role || ''] || 0) < roleRank.editor) {
      return next(new ErrorResponse(403, 'Editors can change device details'));
    }

    const body = req.body || {};
    const custom: Record<string, string> = {};
    Object.entries(body.custom && typeof body.custom === 'object' ? body.custom : {}).forEach(([key, value]) => {
      const name = key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      if (/^[A-Z][A-Z0-9_]{0,50}$/.test(name) && String(value).trim()) {
        custom[name] = String(value).trim().slice(0, 500);
      }
    });

    const fields: DeviceFields = {
      assetTag: cleanText(body.assetTag, 120),
      owner: cleanText(body.owner, 120),
      location: cleanText(body.location, 200),
      warranty: cleanText(body.warranty, 40),
      notes: cleanText(body.notes, 5000),
      custom
    };

    await found.device.update({ fields: JSON.stringify(fields) });
    res.status(200).json({ data: fields });
  }
);

/**
 * @description Remote access details. Send password to change it, or an
 * empty string to clear it; leave it out to keep it.
 * @route /api/devices/:id/remote
 * @request PUT
 */
export const updateDeviceRemote = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const found = await findVisibleDevice(req, next);
    if (!found) return;

    if ((roleRank[req.user?.role || ''] || 0) < roleRank.editor) {
      return next(new ErrorResponse(403, 'Editors can change remote access'));
    }

    const body = req.body || {};
    const type = ['rustdesk', 'vnc', 'rdp', 'ssh', 'url'].includes(body.type) ? (body.type as RemoteType) : undefined;
    const current = readJson<DeviceRemote>(found.device.remote);
    const remote: DeviceRemote = {
      type,
      address: cleanText(body.address, 255),
      port: Number(body.port) > 0 && Number(body.port) < 65536 ? Number(body.port) : undefined,
      username: cleanText(body.username, 120),
      remoteId: cleanText(body.remoteId, 60),
      password:
        body.password === undefined ? current.password : body.password ? encryptSecret(String(body.password).slice(0, 500)) : undefined
    };

    await found.device.update({ remote: JSON.stringify(remote) });
    await auditLog('device.remote_updated', {
      ...auditActor(req),
      target: `device:${found.device.id}`,
      metadata: { device: found.device.name, type }
    });

    res.status(200).json({ data: publicRemote(found.device) });
  }
);

/**
 * @description Show the stored remote access password (audited)
 * @route /api/devices/:id/remote/password
 * @request GET
 */
export const revealRemotePassword = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const found = await findVisibleDevice(req, next);
    if (!found) return;

    if ((roleRank[req.user?.role || ''] || 0) < roleRank.editor) {
      return next(new ErrorResponse(403, 'Editors can see remote access passwords'));
    }

    const remote = readJson<DeviceRemote>(found.device.remote);
    await auditLog('device.remote_password_revealed', {
      ...auditActor(req),
      target: `device:${found.device.id}`,
      metadata: { device: found.device.name }
    });

    res.status(200).json({ data: { password: remote.password ? decryptSecret(remote.password) : '' } });
  }
);

/**
 * @description An .rdp file for Windows Remote Desktop
 * @route /api/devices/:id/remote.rdp
 * @request GET
 */
export const downloadRdpFile = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const found = await findVisibleDevice(req, next);
    if (!found) return;

    const remote = readJson<DeviceRemote>(found.device.remote);
    const facts = readJson<{ ip?: string }>(found.device.facts);
    const address = (remote.address || facts.ip || found.device.hostname).replace(/[\r\n]/g, '');
    const lines = [
      `full address:s:${address}${remote.port ? `:${remote.port}` : ''}`,
      remote.username ? `username:s:${remote.username.replace(/[\r\n]/g, '')}` : '',
      'prompt for credentials:i:1',
      'screen mode id:i:2'
    ].filter(Boolean);

    res
      .type('application/x-rdp')
      .set('Content-Disposition', `attachment; filename="${found.device.name.replace(/[^\w.-]/g, '_')}.rdp"`)
      .send(`${lines.join('\r\n')}\r\n`);
  }
);

/**
 * @description Trend data for graphs: averages per time bucket
 * @route /api/devices/:id/metrics?range=24h|7d|30d
 * @request GET
 */
export const getDeviceMetrics = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const found = await findVisibleDevice(req, next);
    if (!found) return;

    const ranges: { [key: string]: number } = { '24h': 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000 };
    const range = ranges[String(req.query.range)] ? String(req.query.range) : '24h';
    const span = ranges[range];
    const buckets = 96;
    const bucketMs = span / buckets;
    const since = new Date(Date.now() - span);
    const rows = await DeviceMetricModel.findAll({
      where: { deviceId: found.device.id, at: { [Op.gte]: since } },
      order: [['at', 'ASC']],
      raw: true
    });

    const series = Array.from({ length: buckets }, (_, index) => ({
      at: new Date(since.getTime() + index * bucketMs).toISOString(),
      cpu: [] as number[],
      memory: [] as number[],
      disk: [] as number[],
      online: 0,
      samples: 0
    }));

    rows.forEach(row => {
      const bucket = series[Math.min(buckets - 1, Math.floor((new Date(row.at).getTime() - since.getTime()) / bucketMs))];
      if (!bucket) return;
      bucket.samples += 1;
      if (row.online) bucket.online += 1;
      if (row.cpu !== null) bucket.cpu.push(row.cpu);
      if (row.memory !== null) bucket.memory.push(row.memory);
      if (row.disk !== null) bucket.disk.push(row.disk);
    });

    const avg = (values: number[]) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null);
    const withSamples = series.filter(bucket => bucket.samples);

    res.status(200).json({
      data: {
        range,
        points: series.map(bucket => ({
          at: bucket.at,
          cpu: avg(bucket.cpu),
          memory: avg(bucket.memory),
          disk: avg(bucket.disk),
          online: bucket.samples ? Math.round((bucket.online / bucket.samples) * 100) : null
        })),
        availability: withSamples.length
          ? Math.round((withSamples.reduce((sum, bucket) => sum + bucket.online / bucket.samples, 0) / withSamples.length) * 1000) / 10
          : null
      }
    });
  }
);

/**
 * @description Collect a file the device sent back (base64), once it is ready
 * @route /api/devices/jobs/:jobId/file
 * @request GET
 */
export const getJobFile = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const job = await AgentJobModel.findByPk(Number(req.params.jobId) || -1);
    const site = job?.siteId ? await SiteModel.findByPk(job.siteId) : null;

    if (!job || !['fileget', 'files'].includes(job.tool || '') || !site || !(await canAccessSite(req.user || {}, site))) {
      return next(new ErrorResponse(404, 'File was not found'));
    }

    const content = takeDownload(job.id);
    if (content === null) {
      return next(new ErrorResponse(410, 'The download has expired; fetch the file again'));
    }

    res.status(200).json({ data: job.tool === 'files' ? { entries: JSON.parse(content) } : { content } });
  }
);

/**
 * @description Create a single-use activation token for one pending clone
 * (admins). Only this token, or an approval, activates the clone.
 * @route /api/devices/:id/activation-token
 * @request POST
 */
export const createCloneActivationToken = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const device = await findCloneForDecision(req, next);
    if (!device) return;
    const source = device.clonedFrom ? await DeviceModel.findByPk(device.clonedFrom) : null;
    if (device.clonedFrom && (!source || source.revokedAt)) {
      return next(new ErrorResponse(409, 'The device this was cloned from is revoked, so the clone cannot be activated'));
    }
    const token = await newToken('enroll');
    const enrollment = await DeviceEnrollmentModel.create({
      siteId: device.siteId,
      tokenHash: token.hash,
      tokenPrefix: token.prefix,
      expiresAt: new Date(Date.now() + 24 * 3_600_000),
      maxUses: 1,
      createdBy: req.user?.id || null,
      label: `Activate clone ${device.name}`.slice(0, 120),
      forDeviceId: device.id
    });
    await auditLog('device.clone_activation_token_created', {
      ...auditActor(req),
      target: `device:${device.id}`,
      metadata: { enrollmentId: enrollment.id, tokenPrefix: enrollment.tokenPrefix, expiresAt: enrollment.expiresAt }
    });
    res.status(201).json({ data: { token: token.token, expiresAt: enrollment.expiresAt, enrollmentId: enrollment.id } });
  }
);

/**
 * @description Resolve a fingerprint review (admins): approve keeps the
 * bound fingerprint; reset clears it so the next poll binds again.
 * @route /api/devices/:id/fingerprint-review
 * @request POST
 */
export const reviewDeviceFingerprint = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!isAdminRole(req.user?.role)) {
      return next(new ErrorResponse(403, 'Only admins can review fingerprints'));
    }
    const device = await DeviceModel.findOne({ where: { id: Number(req.params.id) || -1, revokedAt: null } });
    if (!device) return next(new ErrorResponse(404, 'Device was not found'));
    const action = req.body?.action;
    if (action !== 'approve' && action !== 'reset') {
      return next(new ErrorResponse(400, 'action must be approve or reset'));
    }
    await device.update(
      action === 'approve' ? { fingerprintPendingReview: false } : { fingerprintPendingReview: false, fingerprint: null }
    );
    await auditLog(`device.fingerprint_review_${action === 'approve' ? 'approved' : 'reset'}`, {
      ...auditActor(req),
      target: `device:${device.id}`,
      metadata: { name: device.name }
    });
    res.status(200).json({ data: deviceJson(device) });
  }
);
