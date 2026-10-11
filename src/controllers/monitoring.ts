import { Response, NextFunction } from 'express';
import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../db';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import {
  AgentJobModel,
  AlertInstance,
  AlertModel,
  DeviceInstance,
  DeviceModel,
  MonitorType,
  PolicyInstance,
  PolicyModel,
  PolicyMonitorModel,
  ScheduleModel,
  SiteInstance,
  SiteModel,
  SnippetRunModel,
  UserModel
} from '../models';
import {
  ErrorResponse,
  MONITOR_TYPES,
  PolicyScope,
  PolicySettings,
  accessibleSiteIds,
  auditLog,
  deviceToolOs,
  devicesForPolicy,
  findAccessibleSite,
  isDeviceOnline,
  isValidTimezone,
  nextPatchRun,
  parseCron,
  policyMatches,
  policyScope,
  policySettings,
  readJson,
  requestIp
} from '../utils';

const auditActor = (req: AuthenticatedRequest) => ({
  userId: req.user?.id || null,
  ipAddress: requestIp(req)
});

const roleRank: { [key: string]: number } = { viewer: 10, user: 20, editor: 30, admin: 40, owner: 50 };
const atLeast = (req: AuthenticatedRequest, role: string) => (roleRank[req.user?.role || ''] || 0) >= roleRank[role];

const siteFilter = async (req: AuthenticatedRequest) => {
  const ids = await accessibleSiteIds(req.user || {});
  return ids === 'all' ? {} : { siteId: ids.length ? ids : [-1] };
};

// Alerts ---------------------------------------------------------------------

const alertJson = async (alerts: AlertInstance[]) => {
  const deviceIds = Array.from(new Set(alerts.map(alert => alert.deviceId)));
  const siteIds = Array.from(new Set(alerts.map(alert => alert.siteId).filter(Boolean))) as number[];
  const policyIds = Array.from(new Set(alerts.map(alert => alert.policyId).filter(Boolean))) as number[];
  const userIds = Array.from(
    new Set(alerts.flatMap(alert => [alert.acknowledgedBy, alert.resolvedBy]).filter(Boolean))
  ) as number[];
  const [devices, sites, policies, users] = await Promise.all([
    deviceIds.length ? DeviceModel.findAll({ where: { id: deviceIds }, attributes: ['id', 'name', 'os', 'lastSeenAt'] }) : [],
    siteIds.length ? SiteModel.findAll({ where: { id: siteIds }, attributes: ['id', 'name'] }) : [],
    policyIds.length ? PolicyModel.findAll({ where: { id: policyIds }, attributes: ['id', 'name'] }) : [],
    userIds.length ? UserModel.findAll({ where: { id: userIds }, attributes: ['id', 'displayName'] }) : []
  ]);
  const now = Date.now();

  return alerts.map(alert => {
    const device = devices.find(item => item.id === alert.deviceId);
    const site = sites.find(item => item.id === alert.siteId);
    return {
      id: alert.id,
      type: alert.type,
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
      status: alert.status,
      snoozed: Boolean(alert.snoozedUntil && new Date(alert.snoozedUntil).getTime() > now),
      snoozedUntil: alert.snoozedUntil,
      device: device ? { id: device.id, name: device.name, os: device.os, online: isDeviceOnline(device, now) } : null,
      site: site ? { id: site.id, name: site.name } : null,
      policy: policies.find(item => item.id === alert.policyId)?.name || null,
      createdAt: alert.createdAt,
      lastSeenAt: alert.lastSeenAt,
      acknowledgedAt: alert.acknowledgedAt,
      acknowledgedBy: users.find(user => user.id === alert.acknowledgedBy)?.displayName || null,
      resolvedAt: alert.resolvedAt,
      resolvedBy: alert.autoResolved ? 'auto' : users.find(user => user.id === alert.resolvedBy)?.displayName || null
    };
  });
};

/**
 * @description Alerts across the sites the user can see. status is active
 * (open or acknowledged, the default), open, acknowledged, resolved or all.
 * @route /api/alerts?status=&siteId=&deviceId=&severity=
 * @request GET
 */
export const getAlerts = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const status = String(req.query.status || 'active');
    const where: any = { ...(await siteFilter(req)) };

    if (status === 'active') where.status = { [Op.in]: ['open', 'acknowledged'] };
    else if (['open', 'acknowledged', 'resolved'].includes(status)) where.status = status;

    if (Number(req.query.siteId)) {
      where[Op.and] = [{ siteId: Number(req.query.siteId) }];
    }
    if (Number(req.query.deviceId)) where.deviceId = Number(req.query.deviceId);
    if (['warning', 'critical'].includes(String(req.query.severity))) where.severity = String(req.query.severity);

    const alerts = await AlertModel.findAll({
      where,
      order: [
        ['status', 'DESC'],
        ['createdAt', 'DESC']
      ],
      limit: Math.min(Number(req.query.limit) || 300, 1000)
    });

    const active = await AlertModel.findAll({
      where: { ...(await siteFilter(req)), status: { [Op.in]: ['open', 'acknowledged'] } },
      attributes: ['severity', 'status', 'snoozedUntil']
    });
    const now = Date.now();

    res.status(200).json({
      data: await alertJson(alerts),
      counts: {
        active: active.length,
        critical: active.filter(alert => alert.severity === 'critical').length,
        unacknowledged: active.filter(alert => alert.status === 'open').length,
        snoozed: active.filter(alert => alert.snoozedUntil && new Date(alert.snoozedUntil).getTime() > now).length
      }
    });
  }
);

/**
 * @description Acknowledge, snooze, resolve or reopen several alerts
 * @route /api/alerts/action
 * @request POST
 * @body { ids: number[], action: 'acknowledge'|'unacknowledge'|'snooze'|'unsnooze'|'resolve', minutes? }
 */
export const alertAction = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!atLeast(req, 'user')) {
      return next(new ErrorResponse(403, 'Viewers cannot change alerts'));
    }

    const ids: number[] = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean).slice(0, 500);
    const action = String(req.body?.action || '');
    const minutes = Math.min(Math.max(Number(req.body?.minutes) || 60, 5), 60 * 24 * 30);

    if (!ids.length || !['acknowledge', 'unacknowledge', 'snooze', 'unsnooze', 'resolve'].includes(action)) {
      return next(new ErrorResponse(400, 'Choose alerts and an action'));
    }

    const alerts = await AlertModel.findAll({ where: { id: ids, ...(await siteFilter(req)) } });
    const now = new Date();

    for (const alert of alerts) {
      if (action === 'acknowledge' && alert.status === 'open') {
        await alert.update({ status: 'acknowledged', acknowledgedAt: now, acknowledgedBy: req.user?.id || null });
      } else if (action === 'unacknowledge' && alert.status === 'acknowledged') {
        await alert.update({ status: 'open', acknowledgedAt: null, acknowledgedBy: null });
      } else if (action === 'snooze' && alert.status !== 'resolved') {
        await alert.update({ snoozedUntil: new Date(now.getTime() + minutes * 60_000) });
      } else if (action === 'unsnooze') {
        await alert.update({ snoozedUntil: null });
      } else if (action === 'resolve' && alert.status !== 'resolved') {
        // If the problem is still there the monitor opens a fresh alert
        await alert.update({ status: 'resolved', resolvedAt: now, resolvedBy: req.user?.id || null, autoResolved: false });
      }
    }

    await auditLog(`alert.${action}`, {
      ...auditActor(req),
      target: alerts.length === 1 ? `alert:${alerts[0].id}` : null,
      metadata: { ids: alerts.map(alert => alert.id), minutes: action === 'snooze' ? minutes : undefined }
    });

    res.status(200).json({ data: await alertJson(alerts) });
  }
);

// Policies -------------------------------------------------------------------

const cleanScope = (value: any): PolicyScope => ({
  all: Boolean(value?.all),
  siteIds: (Array.isArray(value?.siteIds) ? value.siteIds : []).map(Number).filter(Boolean),
  tags: (Array.isArray(value?.tags) ? value.tags : [])
    .map((tag: unknown) => String(tag).trim().toLowerCase())
    .filter(Boolean),
  deviceIds: (Array.isArray(value?.deviceIds) ? value.deviceIds : []).map(Number).filter(Boolean),
  os: ['linux', 'windows'].includes(value?.os) ? value.os : 'any'
});

const cleanParams = (type: MonitorType, params: any): Record<string, unknown> => {
  const num = (value: unknown, min: number, max: number, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  };
  const name = String(params?.name || '').trim().slice(0, 200);

  switch (type) {
    case 'offline':
      return { minutes: num(params?.minutes, 2, 10080, 10) };
    case 'disk':
      return { percent: num(params?.percent, 1, 100, 90) };
    case 'memory':
      return { percent: num(params?.percent, 1, 100, 90), minutes: num(params?.minutes, 1, 1440, 10) };
    case 'cpu':
      return { percent: num(params?.percent, 1, 1000, 90), minutes: num(params?.minutes, 1, 1440, 15) };
    case 'service':
      return { name, autoRestart: Boolean(params?.autoRestart), maxRestarts: num(params?.maxRestarts, 1, 20, 3) };
    case 'process':
      return { name };
    case 'updates':
      return { count: num(params?.count, 1, 1000, 1), securityOnly: params?.securityOnly !== false };
    default:
      return {};
  }
};

const readPolicy = (req: AuthenticatedRequest, next: NextFunction) => {
  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 120);

  if (!name) {
    next(new ErrorResponse(400, 'Give the policy a name'));
    return null;
  }

  const patch = body.settings?.patch || {};
  const settings: PolicySettings = {
    patch: {
      enabled: Boolean(patch.enabled),
      cron: String(patch.cron || '0 3 * * 0').trim(),
      timezone: String(patch.timezone || 'UTC').trim(),
      mode: patch.mode === 'all' ? 'all' : 'security',
      reboot: ['always', 'if-required'].includes(patch.reboot) ? patch.reboot : 'never'
    }
  };

  if (settings.patch?.enabled) {
    try {
      parseCron(settings.patch.cron!);
    } catch (err) {
      next(new ErrorResponse(400, `Patch window: ${err instanceof Error ? err.message : 'invalid cron'}`));
      return null;
    }
    if (!isValidTimezone(settings.patch.timezone!)) {
      next(new ErrorResponse(400, `Unknown timezone ${settings.patch.timezone}`));
      return null;
    }
  }

  const monitors: { id?: number; type: MonitorType; params: string; severity: 'warning' | 'critical'; enabled: boolean }[] = [];
  for (const raw of Array.isArray(body.monitors) ? body.monitors.slice(0, 50) : []) {
    const type = raw?.type as MonitorType;
    if (!(MONITOR_TYPES as readonly string[]).includes(type)) {
      next(new ErrorResponse(400, `Unknown monitor type ${type}`));
      return null;
    }
    const params = cleanParams(type, raw.params);
    if ((type === 'service' || type === 'process') && !params.name) {
      next(new ErrorResponse(400, `Name the ${type} to watch`));
      return null;
    }
    monitors.push({
      id: Number(raw.id) || undefined,
      type,
      params: JSON.stringify(params),
      severity: raw.severity === 'critical' ? 'critical' : 'warning',
      enabled: raw.enabled !== false
    });
  }

  return {
    policy: {
      name,
      description: String(body.description || '').slice(0, 2000),
      enabled: body.enabled !== false,
      scope: JSON.stringify(cleanScope(body.scope)),
      settings: JSON.stringify(settings),
      nextPatchAt: nextPatchRun(settings)
    },
    monitors
  };
};

const policyJson = async (policies: PolicyInstance[]) => {
  const ids = policies.map(policy => policy.id);
  const [monitors, alerts, schedules, devices, sites] = await Promise.all([
    ids.length ? PolicyMonitorModel.findAll({ where: { policyId: ids }, order: [['id', 'ASC']] }) : [],
    ids.length
      ? AlertModel.findAll({ where: { policyId: ids, status: { [Op.in]: ['open', 'acknowledged'] } }, attributes: ['policyId'] })
      : [],
    ids.length ? ScheduleModel.findAll({ where: { policyId: ids }, attributes: ['id', 'name', 'policyId', 'cron', 'enabled'] }) : [],
    DeviceModel.findAll({ where: { revokedAt: null } }),
    SiteModel.findAll()
  ]);

  return policies.map(policy => {
    const scope = policyScope(policy);
    return {
      id: policy.id,
      name: policy.name,
      description: policy.description,
      enabled: policy.enabled,
      scope,
      settings: policySettings(policy),
      monitors: monitors
        .filter(monitor => monitor.policyId === policy.id)
        .map(monitor => ({
          id: monitor.id,
          type: monitor.type,
          params: readJson(monitor.params),
          severity: monitor.severity,
          enabled: monitor.enabled
        })),
      schedules: schedules
        .filter(schedule => schedule.policyId === policy.id)
        .map(schedule => ({ id: schedule.id, name: schedule.name, cron: schedule.cron, enabled: schedule.enabled })),
      deviceCount: devices.filter(device => policyMatches(scope, device, sites.find(site => site.id === device.siteId))).length,
      openAlerts: alerts.filter(alert => alert.policyId === policy.id).length,
      lastPatchAt: policy.lastPatchAt,
      nextPatchAt: policy.enabled ? policy.nextPatchAt : null,
      updatedAt: policy.updatedAt
    };
  });
};

/**
 * @description All policies with their monitors
 * @route /api/policies
 * @request GET
 */
export const getPolicies = asyncWrapper(
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const policies = await PolicyModel.findAll({ order: [['name', 'ASC']] });
    res.status(200).json({ data: await policyJson(policies) });
  }
);

/**
 * @description Which devices a scope would cover
 * @route /api/policies/preview
 * @request POST
 */
export const previewPolicy = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const scope = cleanScope(req.body?.scope);
    const [devices, sites] = await Promise.all([
      DeviceModel.findAll({ where: { revokedAt: null }, order: [['name', 'ASC']] }),
      SiteModel.findAll()
    ]);
    const matched = devices.filter(device => policyMatches(scope, device, sites.find(site => site.id === device.siteId)));

    res.status(200).json({
      data: matched.map(device => ({
        id: device.id,
        name: device.name,
        os: device.os,
        site: sites.find(site => site.id === device.siteId)?.name || null,
        online: isDeviceOnline(device)
      }))
    });
  }
);

const saveMonitors = async (policyId: number, monitors: NonNullable<ReturnType<typeof readPolicy>>['monitors']) => {
  const existing = await PolicyMonitorModel.findAll({ where: { policyId } });
  const keep = new Set<number>();

  for (const monitor of monitors) {
    const current = monitor.id ? existing.find(item => item.id === monitor.id) : undefined;
    // Changing what a monitor checks starts it afresh
    if (current && current.type === monitor.type) {
      await current.update({ params: monitor.params, severity: monitor.severity, enabled: monitor.enabled });
      keep.add(current.id);
    } else {
      const created = await PolicyMonitorModel.create({ ...monitor, id: undefined, policyId });
      keep.add(created.id);
    }
  }

  const removed = existing.filter(item => !keep.has(item.id)).map(item => item.id);
  if (removed.length) {
    await AlertModel.update(
      { status: 'resolved', resolvedAt: new Date(), autoResolved: true },
      { where: { monitorId: removed, status: { [Op.in]: ['open', 'acknowledged'] } } }
    );
    await PolicyMonitorModel.destroy({ where: { id: removed } });
  }
};

/**
 * @description Create a policy
 * @route /api/policies
 * @request POST
 */
export const createPolicy = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const data = readPolicy(req, next);
    if (!data) return;

    const policy = await PolicyModel.create({ ...data.policy, createdBy: req.user?.id || null });
    await saveMonitors(policy.id, data.monitors);
    await auditLog('policy.created', { ...auditActor(req), target: `policy:${policy.id}`, metadata: { name: policy.name } });

    res.status(201).json({ data: (await policyJson([policy]))[0] });
  }
);

/**
 * @description Update a policy and its monitors
 * @route /api/policies/:id
 * @request PUT
 */
export const updatePolicy = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const policy = await PolicyModel.findByPk(Number(req.params.id) || -1);
    if (!policy) return next(new ErrorResponse(404, 'Policy was not found'));

    const data = readPolicy(req, next);
    if (!data) return;

    await policy.update(data.policy);
    await saveMonitors(policy.id, data.monitors);
    if (!policy.enabled) {
      await AlertModel.update(
        { status: 'resolved', resolvedAt: new Date(), autoResolved: true },
        { where: { policyId: policy.id, status: { [Op.in]: ['open', 'acknowledged'] } } }
      );
    }
    await auditLog('policy.updated', { ...auditActor(req), target: `policy:${policy.id}`, metadata: { name: policy.name } });

    res.status(200).json({ data: (await policyJson([policy]))[0] });
  }
);

/**
 * @description Delete a policy; its open alerts resolve and its schedules go
 * @route /api/policies/:id
 * @request DELETE
 */
export const deletePolicy = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const policy = await PolicyModel.findByPk(Number(req.params.id) || -1);
    if (!policy) return next(new ErrorResponse(404, 'Policy was not found'));

    await AlertModel.update(
      { status: 'resolved', resolvedAt: new Date(), autoResolved: true },
      { where: { policyId: policy.id, status: { [Op.in]: ['open', 'acknowledged'] } } }
    );
    await policy.destroy();
    await auditLog('policy.deleted', { ...auditActor(req), target: `policy:${policy.id}`, metadata: { name: policy.name } });

    res.status(200).json({ data: {} });
  }
);

/**
 * @description Start a policy's patch run now on all its devices
 * @route /api/policies/:id/patch
 * @request POST
 */
export const patchPolicyNow = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const policy = await PolicyModel.findByPk(Number(req.params.id) || -1);
    if (!policy) return next(new ErrorResponse(404, 'Policy was not found'));

    // Pull the window forward; the next tick queues the jobs and sets the next one
    const settings = policySettings(policy);
    if (!settings.patch?.enabled) {
      return next(new ErrorResponse(400, 'Turn on patching for this policy first'));
    }
    await policy.update({ nextPatchAt: new Date() });
    await auditLog('policy.patch_now', { ...auditActor(req), target: `policy:${policy.id}`, metadata: { name: policy.name } });

    res.status(200).json({ data: { devices: (await devicesForPolicy(policy)).length } });
  }
);

// Site health, patching and reports -------------------------------------------

const COMPLIANCE_MAX_AGE_MS = 7 * 86400_000;

interface PatchState {
  checkedAt: string | null;
  pending: number;
  security: number;
  reboot: boolean;
  compliant: boolean | null;
}

const patchState = (device: DeviceInstance, now = Date.now()): PatchState => {
  const entry = readJson<Record<string, { at: string; data?: any }>>(device.inventory).updates;
  const updates: any[] = entry?.data?.updates || [];
  const security = updates.filter(update => update.security).length;
  const reboot = Boolean(entry?.data?.reboot);
  const fresh = entry ? now - new Date(entry.at).getTime() < COMPLIANCE_MAX_AGE_MS : false;

  return {
    checkedAt: entry?.at || null,
    pending: updates.length,
    security,
    reboot,
    // Unknown until the device has reported its updates recently
    compliant: fresh && entry?.data ? security === 0 && !reboot : null
  };
};

const compliancePercent = (states: PatchState[]) => {
  const known = states.filter(state => state.compliant !== null);
  return known.length ? Math.round((known.filter(state => state.compliant).length / known.length) * 100) : null;
};

/**
 * @description Health for each visible site: devices, alerts, patching, activity
 * @route /api/sites/health
 * @request GET
 */
export const getSitesHealth = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const filter = await siteFilter(req);
    const [devices, alerts, lastRuns, lastJobs] = await Promise.all([
      DeviceModel.findAll({ where: { revokedAt: null, ...filter } }),
      AlertModel.findAll({ where: { status: { [Op.in]: ['open', 'acknowledged'] }, ...filter }, attributes: ['siteId', 'severity'] }),
      sequelize.query<{ siteId: number; at: Date; runs: number }>(
        `SELECT "siteId", MAX("createdAt") AS at, COUNT(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '30 days')::int AS runs
           FROM snippet_runs WHERE "siteId" IS NOT NULL GROUP BY "siteId"`,
        { type: QueryTypes.SELECT }
      ),
      sequelize.query<{ siteId: number; at: Date }>(
        `SELECT "siteId", MAX("createdAt") AS at FROM agent_jobs WHERE "siteId" IS NOT NULL GROUP BY "siteId"`,
        { type: QueryTypes.SELECT }
      )
    ]);
    const now = Date.now();
    const siteIds = Array.from(new Set([...devices.map(device => device.siteId), ...alerts.map(alert => alert.siteId)])).filter(Boolean);
    const data: Record<number, unknown> = {};

    siteIds.concat(lastRuns.map(row => row.siteId)).forEach(id => {
      if (!id || data[id]) return;
      const siteDevices = devices.filter(device => device.siteId === id);
      const siteAlerts = alerts.filter(alert => alert.siteId === id);
      const run = lastRuns.find(row => row.siteId === id);
      const job = lastJobs.find(row => row.siteId === id);
      const last = [run?.at, job?.at].filter(Boolean).map(at => new Date(at as Date).getTime());

      data[id as number] = {
        devices: siteDevices.length,
        online: siteDevices.filter(device => isDeviceOnline(device, now)).length,
        alerts: siteAlerts.length,
        critical: siteAlerts.filter(alert => alert.severity === 'critical').length,
        compliance: compliancePercent(siteDevices.map(device => patchState(device, now))),
        runs30d: run?.runs || 0,
        lastActivityAt: last.length ? new Date(Math.max(...last)).toISOString() : null
      };
    });

    res.status(200).json({ data });
  }
);

/**
 * @description Patch compliance for each device of a site
 * @route /api/sites/:id/patching
 * @request GET
 */
export const getSitePatching = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const site = await findAccessibleSite(req.user || {}, req.params.id);
    if (!site) return next(new ErrorResponse(404, 'Site was not found'));

    const devices = await DeviceModel.findAll({ where: { siteId: site.id, revokedAt: null }, order: [['name', 'ASC']] });
    const patchJobs = await AgentJobModel.findAll({
      where: { deviceId: devices.length ? devices.map(device => device.id) : [-1], tool: 'patch' },
      order: [['createdAt', 'DESC']],
      attributes: ['id', 'deviceId', 'status', 'createdAt', 'finishedAt', 'snippetRunId']
    });
    const policies = await PolicyModel.findAll({ where: { enabled: true } });
    const now = Date.now();

    const rows = devices.map(device => {
      const job = patchJobs.find(item => item.deviceId === device.id);
      const window = policies.find(
        policy => policySettings(policy).patch?.enabled && policyMatches(policyScope(policy), device, site)
      );
      return {
        id: device.id,
        name: device.name,
        os: device.os,
        toolOs: deviceToolOs(device),
        online: isDeviceOnline(device, now),
        ...patchState(device, now),
        lastPatch: job
          ? { id: job.id, status: job.status, at: job.finishedAt || job.createdAt, runId: job.snippetRunId }
          : null,
        window: window ? { policy: window.name, nextAt: window.nextPatchAt } : null
      };
    });

    res.status(200).json({
      data: {
        compliance: compliancePercent(rows),
        devices: rows
      }
    });
  }
);

const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

const formatDuration = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return hours < 48 ? `${Math.round(hours * 10) / 10} h` : `${Math.round(hours / 24)} d`;
};

const sparkline = (values: (number | null)[], width = 140, height = 28) => {
  const points = values
    .map((value, index) => (value === null ? null : { x: (index / Math.max(values.length - 1, 1)) * width, y: height - (value / 100) * height }))
    .filter(Boolean) as { x: number; y: number }[];
  if (points.length < 2) return '<span class="muted">—</span>';
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><line x1="0" y1="${height * 0.1}" x2="${width}" y2="${height * 0.1}" stroke="#e0b4b4" stroke-dasharray="3 3"/><path d="${path}" fill="none" stroke="#4c6ef5" stroke-width="1.6"/></svg>`;
};

interface ReportData {
  site: { id: number; name: string };
  month: string;
  from: Date;
  to: Date;
  generatedAt: Date;
  devices: {
    id: number;
    name: string;
    os: string;
    availability: number | null;
    diskStart: number | null;
    diskEnd: number | null;
    diskDaily: (number | null)[];
    patch: PatchState;
    alerts: number;
  }[];
  availability: number | null;
  alerts: { title: string; device: string; severity: string; openedAt: Date; resolvedAt: Date | null; durationMs: number | null }[];
  alertsOpened: number;
  alertsResolved: number;
  mttrMs: number | null;
  runs: { total: number; ok: number; failed: number; top: { title: string; count: number; failed: number }[] };
  patchJobs: { total: number; ok: number; failed: number };
  compliance: number | null;
}

export const buildSiteReport = async (site: SiteInstance, month: string): Promise<ReportData> => {
  const [year, mon] = month.split('-').map(Number);
  const from = new Date(Date.UTC(year, mon - 1, 1));
  const to = new Date(Date.UTC(year, mon, 1));
  const end = new Date(Math.min(to.getTime(), Date.now()));
  const days = Math.max(1, Math.ceil((end.getTime() - from.getTime()) / 86400_000));

  const devices = await DeviceModel.findAll({ where: { siteId: site.id, revokedAt: null }, order: [['name', 'ASC']] });
  const deviceIds = devices.length ? devices.map(device => device.id) : [-1];

  // Hourly buckets: an hour is up if the device checked in at all during it
  const hours = await sequelize.query<{ deviceId: number; up: boolean }>(
    `SELECT "deviceId", date_trunc('hour', at) AS h, bool_or(online) AS up
       FROM device_metrics WHERE "deviceId" IN (:ids) AND at >= :from AND at < :to
      GROUP BY 1, 2`,
    { type: QueryTypes.SELECT, replacements: { ids: deviceIds, from, to } }
  );
  const disk = await sequelize.query<{ deviceId: number; d: string; disk: number }>(
    `SELECT "deviceId", to_char(date_trunc('day', at), 'YYYY-MM-DD') AS d, AVG(disk)::float AS disk
       FROM device_metrics WHERE "deviceId" IN (:ids) AND at >= :from AND at < :to AND disk IS NOT NULL
      GROUP BY 1, 2 ORDER BY 2`,
    { type: QueryTypes.SELECT, replacements: { ids: deviceIds, from, to } }
  );

  const alerts = await AlertModel.findAll({
    where: { siteId: site.id, createdAt: { [Op.gte]: from, [Op.lt]: to } },
    order: [['createdAt', 'ASC']]
  });
  const resolved = alerts.filter(alert => alert.resolvedAt);
  const durations = resolved.map(alert => new Date(alert.resolvedAt!).getTime() - new Date(alert.createdAt).getTime());

  const runs = await SnippetRunModel.findAll({
    where: { siteId: site.id, createdAt: { [Op.gte]: from, [Op.lt]: to } },
    attributes: ['snippetTitle', 'ok', 'kind']
  });
  const top = new Map<string, { title: string; count: number; failed: number }>();
  runs
    .filter(run => run.kind !== 'tool')
    .forEach(run => {
      const item = top.get(run.snippetTitle) || { title: run.snippetTitle, count: 0, failed: 0 };
      item.count += 1;
      if (!run.ok) item.failed += 1;
      top.set(run.snippetTitle, item);
    });

  const patchJobs = await AgentJobModel.findAll({
    where: { siteId: site.id, tool: 'patch', createdAt: { [Op.gte]: from, [Op.lt]: to } },
    attributes: ['status']
  });

  const deviceRows = devices.map(device => {
    const own = hours.filter(row => row.deviceId === device.id);
    const daily = Array.from({ length: days }, (_, index) => {
      const key = new Date(from.getTime() + index * 86400_000).toISOString().slice(0, 10);
      const row = disk.find(item => item.deviceId === device.id && item.d === key);
      return row ? Math.round(row.disk * 10) / 10 : null;
    });
    const known = daily.filter((value): value is number => value !== null);
    return {
      id: device.id,
      name: device.name,
      os: device.os,
      availability: own.length ? Math.round((own.filter(row => row.up).length / own.length) * 1000) / 10 : null,
      diskStart: known.length ? known[0] : null,
      diskEnd: known.length ? known[known.length - 1] : null,
      diskDaily: daily,
      patch: patchState(device),
      alerts: alerts.filter(alert => alert.deviceId === device.id).length
    };
  });
  const measured = deviceRows.filter(row => row.availability !== null);

  return {
    site: { id: site.id, name: site.name },
    month,
    from,
    to,
    generatedAt: new Date(),
    devices: deviceRows,
    availability: measured.length
      ? Math.round((measured.reduce((sum, row) => sum + row.availability!, 0) / measured.length) * 10) / 10
      : null,
    alerts: alerts.map(alert => ({
      title: alert.title,
      device: devices.find(device => device.id === alert.deviceId)?.name || 'Removed device',
      severity: alert.severity,
      openedAt: alert.createdAt,
      resolvedAt: alert.resolvedAt,
      durationMs: alert.resolvedAt ? new Date(alert.resolvedAt).getTime() - new Date(alert.createdAt).getTime() : null
    })),
    alertsOpened: alerts.length,
    alertsResolved: resolved.length,
    mttrMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    runs: {
      total: runs.length,
      ok: runs.filter(run => run.ok).length,
      failed: runs.filter(run => !run.ok).length,
      top: Array.from(top.values()).sort((a, b) => b.count - a.count).slice(0, 10)
    },
    patchJobs: {
      total: patchJobs.length,
      ok: patchJobs.filter(job => job.status === 'done').length,
      failed: patchJobs.filter(job => job.status === 'failed' || job.status === 'expired').length
    },
    compliance: compliancePercent(deviceRows.map(row => row.patch))
  };
};

const renderReportHtml = (report: ReportData) => {
  const monthName = report.from.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const pct = (value: number | null) => (value === null ? '—' : `${value}%`);
  const date = (value: Date | null) =>
    value ? new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
  const kpi = (label: string, value: string, note = '') =>
    `<div class="kpi"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div>${note ? `<div class="note">${escapeHtml(note)}</div>` : ''}</div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(report.site.name)} — ${escapeHtml(monthName)} report</title>
<style>
  :root { --ink:#1d2433; --muted:#6b7385; --line:#e3e6ee; --accent:#4c6ef5; --good:#2f9e6b; --warn:#c7851a; --bad:#d64545; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); margin: 0; background: #f5f6fa; }
  main { max-width: 960px; margin: 24px auto; background: #fff; padding: 40px 44px; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  header { display:flex; justify-content:space-between; align-items:flex-end; border-bottom: 3px solid var(--accent); padding-bottom: 16px; margin-bottom: 24px; }
  h1 { margin: 0; font-size: 26px; } h2 { font-size: 16px; margin: 32px 0 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .muted, .note { color: var(--muted); font-size: 12px; }
  .kpis { display:grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .kpi { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
  .kpi .label { font-size: 12px; color: var(--muted); } .kpi .value { font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { font-weight: 600; color: var(--muted); font-size: 12px; } td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display:inline-block; padding: 1px 8px; border-radius: 99px; font-size: 12px; font-weight: 600; }
  .ok { background:#e3f5ec; color: var(--good); } .warn { background:#fdf1dc; color: var(--warn); } .bad { background:#fbe4e4; color: var(--bad); } .unk { background:#eef0f5; color: var(--muted); }
  .toolbar { max-width:960px; margin: 16px auto 0; text-align:right; } .toolbar button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--line); background:#fff; cursor:pointer; }
  @media (max-width: 700px) { main { padding: 20px 16px; margin: 0; border-radius: 0; } .kpis { grid-template-columns: repeat(2, 1fr); } .wide { overflow-x:auto; } }
  @media print { body { background:#fff; } main { box-shadow:none; margin:0; max-width:none; padding: 0; } .toolbar { display:none; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
</style></head>
<body>
<div class="toolbar"><button onclick="window.print()">Print / save as PDF</button></div>
<main>
<header>
  <div><div class="muted">Monthly IT report</div><h1>${escapeHtml(report.site.name)}</h1></div>
  <div style="text-align:right"><strong>${escapeHtml(monthName)}</strong><div class="muted">Generated ${escapeHtml(date(report.generatedAt))}</div></div>
</header>

<section class="kpis">
  ${kpi('Availability', pct(report.availability), `${report.devices.length} device${report.devices.length === 1 ? '' : 's'}`)}
  ${kpi('Patch compliance', pct(report.compliance), 'no security updates or restarts pending')}
  ${kpi('Alerts', String(report.alertsOpened), `${report.alertsResolved} resolved${report.mttrMs !== null ? `, avg ${formatDuration(report.mttrMs)} to fix` : ''}`)}
  ${kpi('Jobs run', String(report.runs.total), `${report.runs.failed} failed · ${report.patchJobs.total} patch runs`)}
</section>

<h2>Devices</h2>
<div class="wide"><table>
  <thead><tr><th>Device</th><th>OS</th><th class="num">Uptime</th><th>Disk use over the month</th><th class="num">Disk</th><th class="num">Updates</th><th>Patch status</th><th class="num">Alerts</th></tr></thead>
  <tbody>
  ${
    report.devices
      .map(device => {
        const status =
          device.patch.compliant === null
            ? '<span class="pill unk">Not checked</span>'
            : device.patch.compliant
            ? '<span class="pill ok">Compliant</span>'
            : `<span class="pill ${device.patch.security ? 'bad' : 'warn'}">${device.patch.security ? `${device.patch.security} security` : 'Restart needed'}</span>`;
        return `<tr><td><strong>${escapeHtml(device.name)}</strong></td><td class="muted">${escapeHtml(device.os)}</td>
          <td class="num">${pct(device.availability)}</td><td>${sparkline(device.diskDaily)}</td>
          <td class="num">${device.diskEnd === null ? '—' : `${device.diskStart}% → ${device.diskEnd}%`}</td>
          <td class="num">${device.patch.checkedAt ? device.patch.pending : '—'}</td><td>${status}</td><td class="num">${device.alerts}</td></tr>`;
      })
      .join('') || '<tr><td colspan="8" class="muted">No devices are enrolled at this site.</td></tr>'
  }
  </tbody></table></div>
  <p class="muted">Uptime counts the hours in which each device checked in. The dashed line marks 90% disk use.</p>

<h2>Alerts</h2>
${
  report.alerts.length
    ? `<div class="wide"><table><thead><tr><th>Alert</th><th>Device</th><th>Severity</th><th>Opened</th><th class="num">Time to resolve</th></tr></thead><tbody>
      ${report.alerts
        .slice(0, 60)
        .map(
          alert => `<tr><td>${escapeHtml(alert.title)}</td><td>${escapeHtml(alert.device)}</td>
          <td><span class="pill ${alert.severity === 'critical' ? 'bad' : 'warn'}">${escapeHtml(alert.severity)}</span></td>
          <td class="muted">${escapeHtml(date(alert.openedAt))}</td>
          <td class="num">${alert.durationMs === null ? '<span class="pill warn">Open</span>' : formatDuration(alert.durationMs)}</td></tr>`
        )
        .join('')}</tbody></table></div>${report.alerts.length > 60 ? `<p class="muted">And ${report.alerts.length - 60} more.</p>` : ''}`
    : '<p class="muted">No alerts this month.</p>'
}

<h2>Work carried out</h2>
${
  report.runs.top.length
    ? `<table><thead><tr><th>Snippet</th><th class="num">Runs</th><th class="num">Failed</th></tr></thead><tbody>
      ${report.runs.top.map(item => `<tr><td>${escapeHtml(item.title)}</td><td class="num">${item.count}</td><td class="num">${item.failed}</td></tr>`).join('')}
      </tbody></table>`
    : '<p class="muted">No snippets were run for this site this month.</p>'
}
<p class="muted">${report.patchJobs.total} patch run${report.patchJobs.total === 1 ? '' : 's'}: ${report.patchJobs.ok} succeeded, ${report.patchJobs.failed} failed.</p>
</main>
</body></html>`;
};

/**
 * @description Monthly site report as printable HTML (or JSON with format=json)
 * @route /api/sites/:id/report?month=YYYY-MM&format=html|json
 * @request GET
 */
export const getSiteReport = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const site = await findAccessibleSite(req.user || {}, req.params.id);
    if (!site) return next(new ErrorResponse(404, 'Site was not found'));

    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month))
      ? String(req.query.month)
      : new Date().toISOString().slice(0, 7);
    const report = await buildSiteReport(site, month);

    if (req.query.format === 'json') {
      res.status(200).json({ data: report });
      return;
    }

    res
      .status(200)
      .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:")
      .set('X-Frame-Options', 'SAMEORIGIN')
      .type('html');
    if (req.query.download) {
      res.set('Content-Disposition', `attachment; filename="${site.slug}-${month}-report.html"`);
    }
    res.send(renderReportHtml(report));
  }
);
