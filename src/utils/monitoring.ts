/**
 * Monitoring: policies apply monitors (and patch windows) to devices, alerts
 * open and resolve themselves, and device check-ins become trend metrics.
 */
import { Op } from 'sequelize';
import {
  AgentJobModel,
  AlertInstance,
  AlertModel,
  DeviceInstance,
  DeviceMetricModel,
  DeviceModel,
  PolicyInstance,
  PolicyModel,
  PolicyMonitorInstance,
  PolicyMonitorModel,
  SiteInstance,
  SiteModel
} from '../models';
import { isDeviceOnline, queueToolJob } from './automation';
import { nextCronTime } from './cron';
import { deviceToolOs, ReadTool } from './deviceTools';
import { emitEvent } from './notify';
import { readJson } from './deviceFields';
import { Logger } from './Logger';

const logger = new Logger('monitoring');

export interface PolicyScope {
  all?: boolean;
  siteIds?: number[];
  tags?: string[];
  deviceIds?: number[];
  os?: 'any' | 'linux' | 'windows';
}

export interface PatchSettings {
  enabled?: boolean;
  cron?: string;
  timezone?: string;
  mode?: 'security' | 'all';
  reboot?: 'never' | 'if-required' | 'always';
}

export interface PolicySettings {
  patch?: PatchSettings;
}

export const MONITOR_TYPES = [
  'offline',
  'disk',
  'memory',
  'cpu',
  'service',
  'process',
  'failed_units',
  'reboot',
  'updates'
] as const;

// Metrics ------------------------------------------------------------------

const METRIC_RETENTION_DAYS = 90;
const AVAILABILITY_SAMPLE_MS = 10 * 60_000;

const percentOf = (used?: number, total?: number): number | null =>
  total && used !== undefined && used !== null ? Math.round((used / total) * 1000) / 10 : null;

/**
 * Store one trend point from a check-in. CPU is the Windows load percentage,
 * or the Linux 1-minute load average as a percentage of CPU count (so it can
 * go above 100 on an overloaded machine).
 */
export const recordFactsMetric = async (
  device: DeviceInstance,
  facts: {
    cpus?: number;
    load1?: number;
    cpuPercent?: number;
    memTotalMb?: number;
    memAvailableMb?: number;
    diskTotalGb?: number;
    diskUsedGb?: number;
  }
): Promise<void> => {
  const cpu =
    facts.cpuPercent !== undefined
      ? facts.cpuPercent
      : facts.load1 !== undefined && facts.cpus
      ? Math.round((facts.load1 / facts.cpus) * 1000) / 10
      : null;
  const memory =
    facts.memTotalMb !== undefined && facts.memAvailableMb !== undefined
      ? percentOf(facts.memTotalMb - facts.memAvailableMb, facts.memTotalMb)
      : null;

  await DeviceMetricModel.create({
    deviceId: device.id,
    at: new Date(),
    online: true,
    cpu,
    memory,
    disk: percentOf(facts.diskUsedGb, facts.diskTotalGb)
  });
};

/** Offline devices send nothing, so note their absence for uptime figures */
const sampleAvailability = async (now: Date) => {
  const devices = await DeviceModel.findAll({ where: { revokedAt: null } });

  for (const device of devices) {
    if (isDeviceOnline(device, now.getTime())) continue;

    const last = await DeviceMetricModel.findOne({
      where: { deviceId: device.id },
      order: [['at', 'DESC']],
      attributes: ['at']
    });

    if (!last || now.getTime() - new Date(last.at).getTime() >= AVAILABILITY_SAMPLE_MS) {
      await DeviceMetricModel.create({ deviceId: device.id, at: now, online: false });
    }
  }
};

let lastPrune = 0;

const pruneMetrics = async (now: Date) => {
  if (now.getTime() - lastPrune < 3600_000) return;
  lastPrune = now.getTime();
  await DeviceMetricModel.destroy({
    where: { at: { [Op.lt]: new Date(now.getTime() - METRIC_RETENTION_DAYS * 86400_000) } }
  });
};

// Policies -----------------------------------------------------------------

export const policyScope = (policy: PolicyInstance): PolicyScope => readJson<PolicyScope>(policy.scope);
export const policySettings = (policy: PolicyInstance): PolicySettings => readJson<PolicySettings>(policy.settings);

export const policyMatches = (scope: PolicyScope, device: DeviceInstance, site: SiteInstance | null | undefined): boolean => {
  const os = deviceToolOs(device);
  const osOk = !scope.os || scope.os === 'any' || os === scope.os;
  const siteTags = site ? site.tags.split(',').filter(Boolean) : [];
  const targeted =
    Boolean(scope.all) ||
    Boolean(scope.siteIds?.includes(device.siteId)) ||
    Boolean(scope.deviceIds?.includes(device.id)) ||
    Boolean(scope.tags?.some(tag => siteTags.includes(tag)));

  return osOk && targeted;
};

export const devicesForPolicy = async (policy: PolicyInstance): Promise<DeviceInstance[]> => {
  const scope = policyScope(policy);
  const [devices, sites] = await Promise.all([
    DeviceModel.findAll({ where: { revokedAt: null }, order: [['name', 'ASC']] }),
    SiteModel.findAll()
  ]);

  return devices.filter(device => policyMatches(scope, device, sites.find(site => site.id === device.siteId)));
};

// Monitors -----------------------------------------------------------------

type Params = Record<string, any>;

interface Verdict {
  firing: boolean;
  title: string;
  detail?: string;
  severity?: 'warning' | 'critical';
}

const INVENTORY_MAX_AGE: { [tool in ReadTool]?: number } = {
  services: 5 * 60_000,
  processes: 5 * 60_000,
  updates: 6 * 3600_000
};

const inventoryOf = (device: DeviceInstance) =>
  readJson<Record<string, { at: string; data?: any; error?: string | null }>>(device.inventory);

/**
 * Queue a read tool when its data is too old for monitoring, unless one is
 * already waiting. Returns true while the data is still fresh enough to use.
 */
const ensureFresh = async (device: DeviceInstance, tool: ReadTool, now: Date, notOlderThan?: Date): Promise<boolean> => {
  const entry = inventoryOf(device)[tool];
  const age = entry ? now.getTime() - new Date(entry.at).getTime() : Infinity;
  const stale = age > (INVENTORY_MAX_AGE[tool] || 3600_000) || Boolean(notOlderThan && entry && new Date(entry.at) < notOlderThan);

  if (stale && isDeviceOnline(device, now.getTime())) {
    const pending = await AgentJobModel.findOne({
      where: { deviceId: device.id, tool, status: { [Op.in]: ['queued', 'running'] } }
    });

    if (!pending) {
      await queueToolJob({ device, tool }).catch(err => logger.log(`Refresh ${tool} failed: ${err.message}`, 'WARN'));
    }
  }

  return Boolean(entry && entry.data !== undefined);
};

const sustained = async (deviceId: number, field: 'cpu' | 'memory', percent: number, minutes: number, now: Date) => {
  const samples = await DeviceMetricModel.findAll({
    where: { deviceId, online: true, at: { [Op.gte]: new Date(now.getTime() - Math.max(minutes, 2) * 60_000) } },
    attributes: [field, 'at'],
    order: [['at', 'ASC']]
  });
  const values = samples.map(sample => sample[field]).filter((value): value is number => value !== null);
  // Short windows need one reading; longer ones at least two, all over the line
  const enough = minutes <= 2 ? values.length >= 1 : values.length >= 2;
  return { firing: enough && values.every(value => value >= percent), latest: values[values.length - 1] };
};

const findService = (services: any[], name: string) => {
  const wanted = name.toLowerCase();
  return services.find(
    service =>
      service.name.toLowerCase() === wanted ||
      service.name.toLowerCase() === `${wanted}.service` ||
      String(service.displayName || '').toLowerCase() === wanted
  );
};

const restartTitle = (name: string) => `Service ${name}: start`;

const evaluate = async (
  monitor: PolicyMonitorInstance,
  params: Params,
  device: DeviceInstance,
  now: Date
): Promise<Verdict | null> => {
  const online = isDeviceOnline(device, now.getTime());
  const facts = readJson<any>(device.facts);

  if (monitor.type === 'offline') {
    const minutes = Number(params.minutes) || 10;
    const since = device.lastSeenAt ? now.getTime() - new Date(device.lastSeenAt).getTime() : Infinity;
    return {
      firing: !online && since >= minutes * 60_000,
      title: `${device.name} is offline`,
      detail: device.lastSeenAt ? `Last seen ${new Date(device.lastSeenAt).toISOString()}` : 'Never checked in'
    };
  }

  // Everything else needs a live device; keep the current state otherwise
  if (!online) return null;

  switch (monitor.type) {
    case 'disk': {
      const percent = Number(params.percent) || 90;
      const audit = inventoryOf(device).system?.data;
      const disks: { mount: string; used: number }[] = (audit?.disks || [])
        .filter((disk: any) => disk.totalGb > 0)
        .map((disk: any) => ({ mount: disk.mount, used: Math.round((disk.usedGb / disk.totalGb) * 100) }));
      if (!disks.length && facts.diskTotalGb) {
        disks.push({ mount: '/', used: Math.round((facts.diskUsedGb / facts.diskTotalGb) * 100) });
      }
      const full = disks.filter(disk => disk.used >= percent);
      return {
        firing: full.length > 0,
        title: `Disk over ${percent}% on ${device.name}`,
        detail: full.map(disk => `${disk.mount} ${disk.used}%`).join(', ')
      };
    }
    case 'memory':
    case 'cpu': {
      const percent = Number(params.percent) || 90;
      const minutes = Number(params.minutes) || (monitor.type === 'cpu' ? 15 : 10);
      const result = await sustained(device.id, monitor.type, percent, minutes, now);
      return {
        firing: result.firing,
        title: `${monitor.type === 'cpu' ? 'CPU' : 'Memory'} over ${percent}% for ${minutes} min on ${device.name}`,
        detail: result.latest !== undefined ? `Now ${result.latest}%` : ''
      };
    }
    case 'service': {
      const name = String(params.name || '').trim();
      if (!name) return null;

      // After a restart, wait for fresh data before judging again
      const lastRestart = await AgentJobModel.findOne({
        where: { deviceId: device.id, tool: 'service', snippetTitle: restartTitle(name) },
        order: [['createdAt', 'DESC']]
      });
      const fresh = await ensureFresh(device, 'services', now, lastRestart?.finishedAt || undefined);
      if (!fresh) return null;

      const service = findService(inventoryOf(device).services?.data || [], name);
      if (!service) {
        return { firing: true, title: `Service ${name} is missing on ${device.name}`, detail: 'Not installed or misspelled' };
      }
      if (service.status === 'running') {
        return { firing: false, title: `Service ${name} stopped on ${device.name}` };
      }

      if (params.autoRestart) {
        const max = Number(params.maxRestarts) || 3;
        const recent = await AgentJobModel.count({
          where: {
            deviceId: device.id,
            tool: 'service',
            snippetTitle: restartTitle(service.name),
            createdAt: { [Op.gte]: new Date(now.getTime() - 3600_000) }
          }
        });
        const waiting = await AgentJobModel.findOne({
          where: { deviceId: device.id, tool: 'service', snippetTitle: restartTitle(service.name), status: { [Op.in]: ['queued', 'running'] } }
        });

        if (waiting) return null;

        if (recent < max) {
          await queueToolJob({ device, tool: 'service', args: { name: service.name, action: 'start' } });
          logger.log(`Restarting ${service.name} on ${device.name} (${recent + 1}/${max})`);
          return null;
        }

        return {
          firing: true,
          severity: 'critical',
          title: `Service ${name} keeps stopping on ${device.name}`,
          detail: `Restarted ${recent} times in the last hour and it is ${service.state}`
        };
      }

      return { firing: true, title: `Service ${name} stopped on ${device.name}`, detail: `State: ${service.state}` };
    }
    case 'failed_units': {
      if (!(await ensureFresh(device, 'services', now))) return null;
      const failed = (inventoryOf(device).services?.data || []).filter((service: any) => service.status === 'failed');
      return {
        firing: failed.length > 0,
        title: `${failed.length || 'Some'} failed service${failed.length === 1 ? '' : 's'} on ${device.name}`,
        detail: failed.map((service: any) => service.name).slice(0, 20).join(', ')
      };
    }
    case 'process': {
      const name = String(params.name || '').trim();
      if (!name || !(await ensureFresh(device, 'processes', now))) return null;
      const running = (inventoryOf(device).processes?.data || []).some(
        (process: any) => process.name.toLowerCase() === name.toLowerCase()
      );
      return { firing: !running, title: `Process ${name} is not running on ${device.name}` };
    }
    case 'reboot': {
      if (!(await ensureFresh(device, 'updates', now))) return null;
      return {
        firing: Boolean(inventoryOf(device).updates?.data?.reboot),
        title: `${device.name} needs a restart`,
        detail: 'Updates are waiting for a restart'
      };
    }
    case 'updates': {
      if (!(await ensureFresh(device, 'updates', now))) return null;
      const updates = inventoryOf(device).updates?.data?.updates || [];
      const securityOnly = params.securityOnly !== false;
      const count = updates.filter((update: any) => !securityOnly || update.security).length;
      const threshold = Number(params.count) || 1;
      return {
        firing: count >= threshold,
        title: `${count} ${securityOnly ? 'security ' : ''}update${count === 1 ? '' : 's'} pending on ${device.name}`,
        detail: updates.filter((update: any) => !securityOnly || update.security).slice(0, 10).map((update: any) => update.name).join(', ')
      };
    }
    default:
      return null;
  }
};

// Alerts -------------------------------------------------------------------

const announce = (alert: AlertInstance, opened: boolean, siteName?: string) => {
  if (alert.snoozedUntil && new Date(alert.snoozedUntil) > new Date()) return;

  emitEvent({
    event: opened ? 'alert.opened' : 'alert.resolved',
    severity: opened ? (alert.severity === 'critical' ? 'error' : 'warning') : 'success',
    title: opened ? alert.title : `Resolved: ${alert.title}`,
    text: alert.detail || (opened ? 'A monitor is failing.' : 'The monitor is healthy again.'),
    siteId: alert.siteId,
    path: `/devices/${alert.deviceId}?tab=alerts`,
    fields: siteName ? [{ label: 'Site', value: siteName }] : [],
    data: { alertId: alert.id, deviceId: alert.deviceId, severity: alert.severity }
  });
};

const applyVerdict = async (
  verdict: Verdict,
  monitor: PolicyMonitorInstance,
  device: DeviceInstance,
  site: SiteInstance | null | undefined,
  now: Date
) => {
  const current = await AlertModel.findOne({
    where: { deviceId: device.id, monitorId: monitor.id, status: { [Op.in]: ['open', 'acknowledged'] } }
  });
  const severity = verdict.severity || monitor.severity;

  if (verdict.firing) {
    if (current) {
      const escalated = severity === 'critical' && current.severity !== 'critical';
      await current.update({ lastSeenAt: now, detail: verdict.detail || current.detail, title: verdict.title, severity });
      if (escalated) announce(current, true, site?.name);
      return;
    }

    const alert = await AlertModel.create({
      deviceId: device.id,
      siteId: device.siteId,
      policyId: monitor.policyId,
      monitorId: monitor.id,
      type: monitor.type,
      severity,
      title: verdict.title.slice(0, 255),
      detail: verdict.detail || '',
      lastSeenAt: now
    });
    announce(alert, true, site?.name);
  } else if (current) {
    await current.update({ status: 'resolved', resolvedAt: now, autoResolved: true });
    announce(current, false, site?.name);
  }
};

/** Alerts whose monitor, policy or device is gone should not stay open */
const resolveOrphans = async (now: Date, live: Set<string>) => {
  const open = await AlertModel.findAll({ where: { status: { [Op.in]: ['open', 'acknowledged'] }, monitorId: { [Op.ne]: null } } });

  for (const alert of open) {
    if (!live.has(`${alert.deviceId}:${alert.monitorId}`)) {
      await alert.update({ status: 'resolved', resolvedAt: now, autoResolved: true, detail: `${alert.detail}\nNo longer monitored.`.trim() });
    }
  }
};

export const evaluateMonitors = async (now = new Date()): Promise<void> => {
  const [policies, monitors, devices, sites] = await Promise.all([
    PolicyModel.findAll({ where: { enabled: true } }),
    PolicyMonitorModel.findAll({ where: { enabled: true } }),
    DeviceModel.findAll({ where: { revokedAt: null } }),
    SiteModel.findAll()
  ]);
  const live = new Set<string>();

  for (const policy of policies) {
    const scope = policyScope(policy);
    const policyMonitors = monitors.filter(monitor => monitor.policyId === policy.id);
    if (!policyMonitors.length) continue;

    for (const device of devices) {
      const site = sites.find(item => item.id === device.siteId);
      if (!policyMatches(scope, device, site)) continue;

      for (const monitor of policyMonitors) {
        // Linux-only checks do not apply to Windows and vice versa
        if (monitor.type === 'failed_units' && deviceToolOs(device) !== 'linux') continue;
        live.add(`${device.id}:${monitor.id}`);

        try {
          const verdict = await evaluate(monitor, readJson<Params>(monitor.params), device, now);
          if (verdict) {
            await applyVerdict(verdict, monitor, device, site, now);
          }
        } catch (err) {
          logger.log(`Monitor ${monitor.id} on ${device.name} failed: ${err instanceof Error ? err.message : err}`, 'WARN');
        }
      }
    }
  }

  await resolveOrphans(now, live);
};

// Patching -----------------------------------------------------------------

export const nextPatchRun = (settings: PolicySettings, after = new Date()): Date | null => {
  const patch = settings.patch;
  if (!patch?.enabled || !patch.cron) return null;
  try {
    return nextCronTime(patch.cron, patch.timezone || 'UTC', after);
  } catch {
    return null;
  }
};

const runPatchWindows = async (now: Date) => {
  const due = await PolicyModel.findAll({ where: { enabled: true, nextPatchAt: { [Op.lte]: now } } });

  for (const policy of due) {
    const settings = policySettings(policy);
    await policy.update({ lastPatchAt: now, nextPatchAt: nextPatchRun(settings, now) });

    if (!settings.patch?.enabled) continue;

    const devices = (await devicesForPolicy(policy)).filter(device => deviceToolOs(device));
    for (const device of devices) {
      await queueToolJob({
        device,
        tool: 'patch',
        args: { mode: settings.patch.mode || 'security', reboot: settings.patch.reboot || 'never' },
        userId: policy.createdBy
      }).catch(err => logger.log(`Patch queue failed for ${device.name}: ${err.message}`, 'WARN'));
    }

    logger.log(`Patch window for "${policy.name}": ${devices.length} devices`);
  }
};

/** Everything monitoring does on each scheduler tick */
export const monitoringTick = async (now = new Date()): Promise<void> => {
  await sampleAvailability(now);
  await evaluateMonitors(now);
  await runPatchWindows(now);
  await pruneMetrics(now);
};
