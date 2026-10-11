import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { Op } from 'sequelize';
import { sequelize } from '../db';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import {
  AgentJobModel,
  AgentJobInstance,
  DeviceMetricModel,
  DeviceEnrollmentModel,
  DeviceInstance,
  DeviceModel,
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
  verifyTokenHash,
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
  encryptSecret
} from '../utils';
import { describeRuns } from './runs';

/** The agent version this server hands out; older agents update themselves. */
export const AGENT_VERSION = '1.3.0';

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

const newToken = (kind: 'enroll' | 'dev') => {
  const token = `sc_${kind}_${randomBytes(24).toString('base64url')}`;
  return { token, hash: hashApiKey(token), prefix: token.slice(0, 16) };
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
  lastSeenAt: device.lastSeenAt,
  lastIp: device.lastIp,
  online: isDeviceOnline(device),
  tokenPrefix: device.tokenPrefix,
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

/**
 * @description Create an enrollment token and install commands (admins)
 * @route /api/devices/enrollments
 * @request POST
 */
export const createEnrollment = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const site = await SiteModel.findByPk(Number(req.body?.siteId) || -1);

    if (!site) {
      return next(new ErrorResponse(404, 'Site was not found'));
    }

    const hours = Math.min(Math.max(Number(req.body?.expiresHours) || 24, 1), 24 * 30);
    const maxUses = Math.min(Math.max(Number(req.body?.maxUses) || 1, 1), 500);
    const { token, hash, prefix } = newToken('enroll');
    const expiresAt = new Date(Date.now() + hours * 3600_000);

    await DeviceEnrollmentModel.create({
      siteId: site.id,
      tokenHash: hash,
      tokenPrefix: prefix,
      expiresAt,
      maxUses,
      createdBy: req.user?.id || null
    });

    await auditLog('device.enrollment_created', {
      ...auditActor(req),
      target: `site:${site.id}`,
      metadata: { site: site.name, maxUses, expiresAt }
    });

    const base = origin(req);

    res.status(201).json({
      data: {
        token,
        expiresAt,
        maxUses,
        linux: `curl -fsSL ${base}/agent/install.sh | sudo bash -s -- --url ${base} --token ${token}`,
        windows: `& ([scriptblock]::Create((irm ${base}/agent/install.ps1))) -Url ${base} -Token ${token}`
      }
    });
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
    const pending = await AgentJobModel.findAll({
      where: { deviceId: device.id, status: { [Op.in]: ['queued', 'running'] } }
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

    await auditLog('device.revoked', {
      ...auditActor(req),
      target: `device:${device.id}`,
      metadata: { name: device.name, siteId: device.siteId }
    });

    res.status(200).json({ data: {} });
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
      ? await DeviceModel.findOne({ where: { tokenHash: hashApiKey(token), revokedAt: null } })
      : null;

    if (!device || !verifyTokenHash(token, device.tokenHash)) {
      return next(new ErrorResponse(401, 'Device token is not valid or was revoked'));
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

/**
 * @description Swap an enrollment token for a device token. Send
 * ?format=env for KEY=value lines (easy to read from shell scripts).
 * @route /api/agent/enroll
 * @request POST
 */
export const enrollDevice = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const body = req.body || {};
    const token = String(body.token || bearer(req));
    const hostname = clean(body.hostname, 255) || 'unknown-host';

    const result = await sequelize.transaction(async transaction => {
      const enrollment = await DeviceEnrollmentModel.findOne({
        where: { tokenHash: hashApiKey(token) },
        lock: transaction.LOCK.UPDATE,
        transaction
      });

      if (
        !enrollment ||
        !verifyTokenHash(token, enrollment.tokenHash) ||
        enrollment.expiresAt.getTime() < Date.now() ||
        enrollment.uses >= enrollment.maxUses
      ) {
        return null;
      }

      await enrollment.update({ uses: enrollment.uses + 1 }, { transaction });
      const deviceToken = newToken('dev');
      const device = await DeviceModel.create(
        {
          siteId: enrollment.siteId,
          name: clean(body.name, 120) || hostname,
          hostname,
          os: clean(body.os, 40),
          arch: clean(body.arch, 40),
          agentVersion: clean(body.version, 40),
          capabilities: cleanList(body.capabilities),
          tokenHash: deviceToken.hash,
          tokenPrefix: deviceToken.prefix,
          lastSeenAt: new Date(),
          lastIp: requestIp(req)
        },
        { transaction }
      );

      return { device, token: deviceToken.token };
    });

    if (!result) {
      return next(new ErrorResponse(401, 'Enrollment token is not valid, expired, or used up'));
    }

    const site = await SiteModel.findByPk(result.device.siteId);

    await auditLog('device.enrolled', {
      ipAddress: requestIp(req),
      target: `device:${result.device.id}`,
      metadata: { name: result.device.name, site: site?.name, os: result.device.os }
    });
    emitEvent({
      event: 'device.enrolled',
      severity: 'info',
      title: `${result.device.name} joined ${site?.name || 'a site'}`,
      text: `${result.device.os || 'Unknown OS'} ${result.device.arch} · ${result.device.hostname}`,
      siteId: result.device.siteId,
      path: `/sites/${result.device.siteId}`,
      data: { deviceId: result.device.id }
    });

    if (req.query.format === 'env') {
      res
        .type('text/plain')
        .status(201)
        .send(`DEVICE_ID=${result.device.id}\nDEVICE_TOKEN=${result.token}\nSITE=${site?.slug || ''}\n`);
      return;
    }

    res.status(201).json({ data: { deviceId: result.device.id, token: result.token, site: site?.slug } });
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

    // Agents compare this with their own version and update themselves
    res.set('X-Agent-Latest', AGENT_VERSION);

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

    res.set('X-Agent-Latest', AGENT_VERSION).status(200).json({ data: { latest: AGENT_VERSION } });
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
