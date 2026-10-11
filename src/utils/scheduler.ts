import { Op } from 'sequelize';
import { sequelize } from '../db';
import {
  DeviceModel,
  RunbookModel,
  ScheduleInstance,
  ScheduleModel,
  ScheduleRunInstance,
  ScheduleRunModel,
  SiteModel,
  SnippetModel
} from '../models';
import {
  DEVICE_ONLINE_MS,
  checkScheduleRun,
  expireStaleJobs,
  queueAgentJob,
  startRunbookRun
} from './automation';
import { nextCronTime } from './cron';
import { emitEvent } from './notify';
import { isSnippetRunEnabled } from './runSnippet';
import { renderSnippetFor, runAndRecord } from './snippetRender';
import { Logger } from './Logger';
import { deviceVariableValues } from './deviceFields';
import { devicesForPolicy } from './monitoring';
import { PolicyModel } from '../models';

const logger = new Logger('scheduler');
const LOCK_KEY = 7_311_842;
const TICK_MS = 30_000;

export const computeNextRun = (schedule: Pick<ScheduleInstance, 'cron' | 'timezone'>, after = new Date()) =>
  nextCronTime(schedule.cron, schedule.timezone, after);

const policyDevices = async (schedule: ScheduleInstance) => {
  const policy = schedule.policyId ? await PolicyModel.findByPk(schedule.policyId) : null;
  return policy ? devicesForPolicy(policy) : [];
};

const scheduleSites = async (schedule: ScheduleInstance): Promise<Array<{ id: number; name: string } | null>> => {
  if (schedule.siteMode === 'none') {
    return [null];
  }

  if (schedule.siteMode === 'all') {
    return SiteModel.findAll({ order: [['name', 'ASC']] });
  }

  if (schedule.siteMode === 'policy') {
    const devices = await policyDevices(schedule);
    const ids = Array.from(new Set(devices.map(device => device.siteId)));
    return ids.length ? SiteModel.findAll({ where: { id: ids }, order: [['name', 'ASC']] }) : [];
  }

  if (schedule.siteMode === 'tag') {
    const tag = schedule.siteTag.toLowerCase();
    const sites = await SiteModel.findAll({ order: [['name', 'ASC']] });
    return sites.filter(site => site.tags.split(',').includes(tag));
  }

  const ids = schedule.siteIds.split(',').map(Number).filter(Boolean);
  return ids.length ? SiteModel.findAll({ where: { id: ids }, order: [['name', 'ASC']] }) : [];
};

const failScheduleRun = async (run: ScheduleRunInstance, schedule: ScheduleInstance, reason: string) => {
  await run.update({ status: 'failed', finishedAt: new Date() });
  await schedule.update({ lastStatus: 'failed' });

  if (schedule.notifyOn !== 'never') {
    emitEvent({
      event: 'schedule.failed',
      severity: 'error',
      title: `${schedule.name} could not run`,
      text: reason,
      path: `/schedules/${schedule.id}`,
      data: { scheduleId: schedule.id, scheduleRunId: run.id }
    });
  }
};

/**
 * Start one run of a schedule. Server work runs in the background; device
 * work is queued. The schedule run closes itself once everything reports in.
 */
export const startScheduleRun = async (
  schedule: ScheduleInstance,
  trigger: 'schedule' | 'manual',
  userId: number | null = null
): Promise<ScheduleRunInstance> => {
  const run = await ScheduleRunModel.create({
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    trigger,
    triggeredBy: userId
  });
  await schedule.update({ lastRunAt: new Date(), lastStatus: 'running' });

  const snippet =
    schedule.targetType === 'snippet' && schedule.snippetId
      ? await SnippetModel.findByPk(schedule.snippetId)
      : null;
  const runbook =
    schedule.targetType === 'runbook' && schedule.runbookId
      ? await RunbookModel.findByPk(schedule.runbookId)
      : null;

  if (!snippet && !runbook) {
    await failScheduleRun(run, schedule, 'Its snippet or runbook was deleted.');
    return run;
  }

  const sites = await scheduleSites(schedule);

  if (!sites.length) {
    await failScheduleRun(run, schedule, 'No sites match this schedule.');
    return run;
  }

  // Scheduled work runs as whoever created the schedule, without their
  // personal values, so results don't depend on who is signed in
  const owner = schedule.createdBy;

  if (schedule.runOn === 'devices') {
    const devices =
      schedule.siteMode === 'policy'
        ? await policyDevices(schedule)
        : await DeviceModel.findAll({
            where: {
              revokedAt: null,
              siteId: sites.filter(Boolean).map(site => site!.id)
            },
            order: [['name', 'ASC']]
          });

    if (!devices.length) {
      await failScheduleRun(run, schedule, 'None of its sites have enrolled devices.');
      return run;
    }

    for (const device of devices) {
      if (runbook) {
        await startRunbookRun({
          runbook,
          siteId: device.siteId,
          deviceId: device.id,
          userId: owner,
          scheduleRunId: run.id
        }).catch(err => logger.log(`Runbook start failed: ${err.message}`, 'WARN'));
      } else if (snippet) {
        const site = sites.find(item => item?.id === device.siteId);
        const rendered = await renderSnippetFor({
          code: snippet.code,
          siteId: device.siteId,
          deviceValues: deviceVariableValues(device, site?.name),
          includeSecrets: true
        });
        await queueAgentJob({
          device,
          snippet,
          code: rendered.code,
          secretValues: rendered.secretValues,
          userId: owner,
          scheduleRunId: run.id
        });
      }
    }

    await checkScheduleRun(run.id);
    return run;
  }

  if (!isSnippetRunEnabled()) {
    await failScheduleRun(run, schedule, 'Server runs are disabled. Set SNIPPET_RUN_ENABLED=true.');
    return run;
  }

  // Server work runs one site after another without holding up the caller
  (async () => {
    for (const site of sites) {
      try {
        if (runbook) {
          await startRunbookRun({
            runbook,
            siteId: site?.id || null,
            userId: owner,
            scheduleRunId: run.id
          });
        } else if (snippet) {
          const rendered = await renderSnippetFor({
            code: snippet.code,
            siteId: site?.id || null,
            includeSecrets: true
          });
          const snippetRun = await runAndRecord({
            snippet,
            code: rendered.code,
            secretValues: rendered.secretValues,
            siteId: site?.id || null,
            userId: owner
          });
          await snippetRun.update({ scheduleRunId: run.id });
        }
      } catch (err) {
        logger.log(`Schedule ${schedule.id} failed for ${site?.name || 'no site'}: ${err instanceof Error ? err.message : err}`, 'WARN');
      }
    }

    await checkScheduleRun(run.id);
  })().catch(err => logger.log(`Schedule ${schedule.id} crashed: ${err.message}`, 'ERROR'));

  return run;
};

/**
 * Tell people when a device stops checking in, once per outage.
 */
const noticeOfflineDevices = async (now: number) => {
  const devices = await DeviceModel.findAll({
    where: {
      revokedAt: null,
      offlineNotifiedAt: null,
      lastSeenAt: { [Op.lt]: new Date(now - Math.max(DEVICE_ONLINE_MS, 5 * 60_000)) }
    }
  });

  for (const device of devices) {
    await device.update({ offlineNotifiedAt: new Date(now) });
    emitEvent({
      event: 'device.offline',
      severity: 'warning',
      title: `${device.name} went offline`,
      text: `Last seen ${device.lastSeenAt?.toISOString()} from ${device.lastIp || 'an unknown address'}.`,
      siteId: device.siteId,
      path: `/sites/${device.siteId}`,
      data: { deviceId: device.id, online: false }
    });
  }
};

type Hook = (now: Date) => Promise<void>;
const extraHooks: Hook[] = [];

/** Other periodic work (such as automatic backups) joins the same tick. */
export const onSchedulerTick = (hook: Hook): void => {
  extraHooks.push(hook);
};

/**
 * One pass: start due schedules, expire stuck jobs, and flag offline
 * devices. A Postgres advisory lock keeps several SnippyCode instances from
 * starting the same schedule twice.
 */
export const tickScheduler = async (now = new Date()): Promise<number> =>
  // The lock lives as long as this transaction, on its own pooled connection,
  // so it is always released even if the tick fails
  sequelize.transaction(async transaction => {
    const [[lock]] = (await sequelize.query('SELECT pg_try_advisory_xact_lock(:key) AS locked', {
      replacements: { key: LOCK_KEY },
      transaction
    })) as [Array<{ locked: boolean }>, unknown];

    if (!lock?.locked) {
      return 0;
    }

    const due = await ScheduleModel.findAll({
      where: { enabled: true, nextRunAt: { [Op.lte]: now } }
    });

    for (const schedule of due) {
      // Skip missed runs (e.g. after downtime) rather than replaying them
      await schedule.update({ nextRunAt: computeNextRun(schedule, now) });
      await startScheduleRun(schedule, 'schedule');
    }

    await expireStaleJobs(now.getTime());
    await noticeOfflineDevices(now.getTime());

    for (const hook of extraHooks) {
      await hook(now).catch(err => logger.log(`Tick hook failed: ${err.message}`, 'WARN'));
    }

    return due.length;
  });

let timer: NodeJS.Timeout | null = null;

export const startScheduler = (): void => {
  if (timer || process.env.SCHEDULER_ENABLED === 'false') {
    return;
  }

  const tick = () =>
    tickScheduler().catch(err => logger.log(`Scheduler tick failed: ${err.message}`, 'ERROR'));

  timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 5000);
  logger.log('Scheduler started');
};
