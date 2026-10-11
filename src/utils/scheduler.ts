import { decryptScheduleVariables, needsRebinding } from './scheduleVariables';
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
import { PolicyModel, UserModel } from '../models';
import { accessibleSiteIds } from './siteAccess';
import { approvalReasons, assertApprovalFresh, expireApprovals, getApprovalSettings, registerApprovalExecutor, requestApproval } from './approvals';
import { contentHash, dangerousContent, isSnippetDangerous } from './dangerousContent';
import { RunApprovalModel, RunbookStepModel } from '../models';
import { deviceIdsWithTags, parseIdList } from './deviceTags';
import { SnippetRunModel } from '../models';
import { auditLog } from './audit';
import { cleanupDue, isMissedRun, retentionCutoff, runRetentionDays } from './runHousekeeping';

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

/**
 * The sites a schedule may reach at run time: the NARROWER of what its
 * creator and its last editor can access (a non-admin editor cannot widen a
 * schedule an admin made, and an admin's edit cannot widen a member's).
 * Deleted users are ignored; null means nobody is responsible for it any
 * more, so it must not run until an admin saves it.
 */
export const scheduleReach = async (
  schedule: Pick<ScheduleInstance, 'createdBy' | 'updatedBy'>
): Promise<number[] | 'all' | null> => {
  const ids = Array.from(new Set([schedule.createdBy, schedule.updatedBy].filter((id): id is number => Boolean(id))));
  const users = ids.length ? await UserModel.findAll({ where: { id: ids } }) : [];
  if (!users.length) return null;
  let reach: number[] | 'all' = 'all';
  for (const user of users) {
    const allowed = await accessibleSiteIds({ id: user.id, role: user.role });
    if (allowed === 'all') continue;
    reach = reach === 'all' ? allowed : reach.filter(id => allowed.includes(id));
  }
  return reach;
};

/** Sites a server run covers, narrowed to the schedule's reach */
const reachableSites = async (schedule: ScheduleInstance) => {
  const reach = await scheduleReach(schedule);
  if (reach === null) return [];
  const sites = await scheduleSites(schedule);
  return reach === 'all' ? sites : sites.filter(site => site === null || reach.includes(site.id));
};

/**
 * The devices a device schedule runs on, worked out at run time so devices
 * that joined a site or got a tag since are included:
 * - devices in the schedule's sites (or policy), or every device with the
 *   device tag when devices are picked by tag only,
 * - narrowed to the device tag when one is set,
 * - plus devices picked one by one.
 * Schedules made by non-admins only ever reach sites their creator can still
 * access, so a schedule cannot leak across sites after access changes.
 */
export const scheduleDevices = async (schedule: ScheduleInstance) => {
  // Shared tags by id: a device matches when it has ANY of them
  const tagIds = parseIdList(schedule.deviceTagIds);
  const tagged = tagIds.length ? new Set(await deviceIdsWithTags(tagIds)) : null;
  const picked = (schedule.deviceIds || '').split(',').map(Number).filter(Boolean);
  let base: Array<InstanceType<typeof DeviceModel>> = [];

  if (schedule.siteMode === 'policy') {
    base = await policyDevices(schedule);
  } else if (schedule.siteMode === 'devices') {
    base = tagged ? await DeviceModel.findAll({ where: { revokedAt: null, clonePendingApproval: false, id: Array.from(tagged) } }) : [];
  } else if (schedule.siteMode !== 'none') {
    const sites = (await scheduleSites(schedule)).filter(Boolean).map(site => site!.id);
    base = sites.length ? await DeviceModel.findAll({ where: { revokedAt: null, clonePendingApproval: false, siteId: sites } }) : [];
  }

  if (tagged) {
    base = base.filter(device => tagged.has(device.id));
  }

  const extra = picked.length
    ? await DeviceModel.findAll({ where: { id: picked, revokedAt: null, clonePendingApproval: false } })
    : [];
  const byId = new Map<number, InstanceType<typeof DeviceModel>>();
  [...base, ...extra].forEach(device => byId.set(device.id, device));
  let devices = Array.from(byId.values());

  const reach = await scheduleReach(schedule);
  if (reach === null) return [];
  if (reach !== 'all') {
    devices = devices.filter(device => reach.includes(device.siteId));
  }

  return devices.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
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
  userId: number | null = null,
  options: { approved?: boolean; approvalId?: number; run?: ScheduleRunInstance } = {}
): Promise<ScheduleRunInstance> => {
  // Legacy (unbound) values are read once and rewritten bound to this schedule
  if (needsRebinding(schedule.variables)) {
    schedule.changed('variables', true);
    await schedule.save({ fields: ['variables'] });
  }
  const run =
    options.run ||
    (await ScheduleRunModel.create({
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      trigger,
      triggeredBy: userId
    }));
  if (options.run) {
    await run.update({ status: 'running' });
  }
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

  // Scheduled work runs as whoever created the schedule, without their
  // personal values, so results don't depend on who is signed in
  const owner = schedule.createdBy;

  if ((await scheduleReach(schedule)) === null) {
    await failScheduleRun(run, schedule, 'Nobody owns this schedule any more. An admin must save it before it can run.');
    return run;
  }

  // Risky runs wait for an admin. Everything the run would do (schedule
  // definition, values, code or steps, and the devices/sites it resolves to
  // right now) is hashed; an approved run is refused if any of it changed.
  const settings = await getApprovalSettings();
  const resolvedDevices = schedule.runOn === 'devices' ? await scheduleDevices(schedule) : [];
  const resolvedSites = schedule.runOn === 'devices' ? [] : await reachableSites(schedule);
  const content = runbook ? await runbookContent(runbook) : null;
  const scheduleHash = contentHash({
    kind: 'schedule',
    id: schedule.id,
    targetType: schedule.targetType,
    runOn: schedule.runOn,
    variables: decryptScheduleVariables(schedule.variables, schedule.id),
    snippet: snippet ? { id: snippet.id, language: snippet.language, code: snippet.code, definitions: snippet.variables || [] } : null,
    runbook: runbook ? { id: runbook.id, steps: content!.steps } : null,
    devices: resolvedDevices.map(device => device.id).sort((a, b) => a - b),
    sites: resolvedSites.map(site => site?.id || 0).sort((a, b) => a - b)
  });
  if (options.approved) {
    if (!options.approvalId) throw new Error('An approved schedule run needs its approval');
    await assertApprovalFresh(options.approvalId, scheduleHash);
  }
  if (!options.approved) {
    // Real reach: every device it queues on, or every site it runs for
    const targetCount = schedule.runOn === 'devices' ? resolvedDevices.length : resolvedSites.length;
    const why = approvalReasons({ dangerous: snippet ? isSnippetDangerous(snippet) : content!.dangerous, targetCount }, settings);

    if (why.length) {
      const waiting = await RunApprovalModel.findOne({ where: { scheduleId: schedule.id, status: 'pending' } });

      if (waiting) {
        await failScheduleRun(run, schedule, `Skipped: an earlier run (approval #${waiting.id}) is still waiting for approval.`);
        return run;
      }

      await run.update({ status: 'awaiting_approval' });
      await schedule.update({ lastStatus: 'awaiting_approval' });
      await requestApproval({
        kind: 'schedule',
        title: `${schedule.name} (${snippet ? snippet.title : runbook!.title})`,
        why,
        // Scheduled runs are requested by the schedule's last editor (or
        // its owner); neither of them, nor whoever pressed Run now, may approve
        requestedBy: userId || schedule.updatedBy || owner,
        excludedApprovers: [owner, schedule.updatedBy, userId],
        trigger,
        reason: trigger === 'schedule' ? 'Scheduled run' : 'Run now',
        snippetId: snippet?.id || null,
        runbookId: runbook?.id || null,
        scheduleId: schedule.id,
        scheduleRunId: run.id,
        targets: [{ type: 'schedule', id: schedule.id, name: schedule.name }],
        targetCount,
        contentHash: scheduleHash,
        contentPreview: [
          `# Schedule: ${schedule.name} (runs on ${schedule.runOn}, ${targetCount} target(s))`,
          snippet ? `${dangerousContent(snippet.code).length ? `# Matched rules: ${dangerousContent(snippet.code).join(', ')}\n` : ''}# ${snippet.language}\n${snippet.code}` : content!.preview
        ].join('\n\n'),
        siteIds: schedule.runOn === 'devices' ? resolvedDevices.map(device => device.siteId) : resolvedSites.map(site => site?.id || 0)
      });
      return run;
    }
  }

  if (schedule.runOn === 'devices') {
    const devices = await scheduleDevices(schedule);

    if (!devices.length) {
      await failScheduleRun(run, schedule, 'No enrolled devices match this schedule.');
      return run;
    }

    const siteIds = Array.from(new Set(devices.map(device => device.siteId)));
    const sites = await SiteModel.findAll({ where: { id: siteIds } });

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
          language: snippet.language,
          definitions: snippet.variables,
          siteId: device.siteId,
          deviceValues: deviceVariableValues(device, site?.name),
          explicit: decryptScheduleVariables(schedule.variables, schedule.id),
          includeSecrets: true
        });
        if (rendered.errors.length) {
          // A value that doesn't fit its type never reaches the device
          logger.log(`Schedule ${schedule.id}: skipped device ${device.id}: ${rendered.errors.join('; ')}`, 'WARN');
          await auditLog('schedule.value_refused', { target: `schedule:${schedule.id}`, metadata: { deviceId: device.id, errors: rendered.errors } });
          continue;
        }
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

  const sites = await reachableSites(schedule);

  if (!sites.length) {
    await failScheduleRun(run, schedule, 'No sites match this schedule.');
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
            language: snippet.language,
            definitions: snippet.variables,
            siteId: site?.id || null,
            explicit: decryptScheduleVariables(schedule.variables, schedule.id),
            includeSecrets: true
          });
          if (rendered.errors.length) throw new Error(rendered.errors.join('; '));
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
 * Everything a runbook would run, for approval: its steps with each
 * snippet's code and values (hashed for TOCTOU), a readable preview, and
 * whether any of it is dangerous (flag or content rules).
 */
export const runbookContent = async (runbook: { id: number; title: string; dangerous?: boolean }) => {
  const steps = await RunbookStepModel.findAll({ where: { runbookId: runbook.id }, order: [['position', 'ASC']] });
  const ids = steps.map(step => step.snippetId).filter(Boolean) as number[];
  const snippets = ids.length ? await SnippetModel.findAll({ where: { id: ids } }) : [];
  const byId = new Map(snippets.map(snippet => [snippet.id, snippet]));
  const items = steps.map(step => {
    const snippet = step.snippetId ? byId.get(step.snippetId) : undefined;
    return {
      position: step.position,
      title: step.title,
      note: step.note,
      values: step.values || {},
      snippetId: step.snippetId,
      language: snippet?.language || null,
      code: snippet?.code ?? null,
      definitions: snippet?.variables || []
    };
  });
  const dangerous = Boolean(runbook.dangerous) || snippets.some(snippet => isSnippetDangerous(snippet));
  const rules = Array.from(new Set(snippets.flatMap(snippet => dangerousContent(snippet.code))));
  const preview = [
    `# Runbook: ${runbook.title}`,
    ...(rules.length ? [`# Matched rules: ${rules.join(', ')}`] : []),
    ...items.map(item =>
      item.code === null
        ? `## ${item.position + 1}. ${item.title} (manual step)\n${item.note}`
        : `## ${item.position + 1}. ${item.title} [${item.language}]\n${item.code}`
    )
  ].join('\n\n');
  return { steps: items, dangerous, preview };
};

/** A runbook is dangerous when it is flagged, or any of its snippets is (flag or content) */
export const runbookIsDangerous = async (runbookId: number, flagged = false): Promise<boolean> => {
  if (flagged) return true;
  const runbook = await RunbookModel.findByPk(runbookId);
  return runbook ? (await runbookContent(runbook)).dangerous : false;
};

// Approved schedule runs carry on from where they were held
registerApprovalExecutor(
  'schedule',
  async approval => {
    const schedule = await ScheduleModel.findByPk(approval.scheduleId || -1);
    const run = await ScheduleRunModel.findByPk(approval.scheduleRunId || -1);
    if (!schedule || !run) throw new Error('The schedule was deleted');
    await startScheduleRun(schedule, run.trigger, run.triggeredBy, { approved: true, approvalId: approval.id, run });
    return `Schedule run #${run.id} started`;
  },
  async (approval, message) => {
    const schedule = await ScheduleModel.findByPk(approval.scheduleId || -1);
    const run = await ScheduleRunModel.findByPk(approval.scheduleRunId || -1);
    // The executor may already have marked the run running before a stale
    // approval was refused; either way it never ran, so close it as failed
    if (schedule && run && ['awaiting_approval', 'running'].includes(run.status)) {
      await failScheduleRun(run, schedule, message);
    }
  }
);

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

/** Record a skipped run in the run history and the audit log. */
export const recordMissedRun = async (schedule: ScheduleInstance, missedAt: Date, now: Date): Promise<void> => {
  const run = await ScheduleRunModel.create({
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    trigger: 'schedule',
    status: 'missed',
    finishedAt: now
  });
  await auditLog('schedule.missed', {
    target: `schedule:${schedule.id}`,
    metadata: { scheduleId: schedule.id, scheduleRunId: run.id, name: schedule.name, missedAt: missedAt.toISOString() }
  });
  logger.log(`Skipped missed run of schedule ${schedule.id} due at ${missedAt.toISOString()}`, 'WARN');
};

let lastCleanupAt: Date | null = null;

/** Daily: delete run output older than RUN_OUTPUT_RETENTION_DAYS (default 90, 0/blank = off). */
export const cleanupRunOutput = async (now: Date): Promise<number> => {
  if (!cleanupDue(lastCleanupAt, now)) {
    return 0;
  }

  lastCleanupAt = now;
  const cutoff = retentionCutoff(now, runRetentionDays());

  if (!cutoff) {
    return 0;
  }

  const removed = await SnippetRunModel.destroy({ where: { createdAt: { [Op.lt]: cutoff } } });

  if (removed) {
    logger.log(`Deleted ${removed} run output record(s) older than ${cutoff.toISOString()}`);
  }

  return removed;
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
      // Skip missed runs (e.g. after downtime) rather than replaying them:
      // log a 'missed' entry instead of a catch-up run
      const missedAt = schedule.nextRunAt;
      await schedule.update({ nextRunAt: computeNextRun(schedule, now) });

      if (isMissedRun(missedAt, now)) {
        await recordMissedRun(schedule, missedAt!, now);
        continue;
      }

      await startScheduleRun(schedule, 'schedule');
    }

    await cleanupRunOutput(now).catch(err => logger.log(`Run output cleanup failed: ${err.message}`, 'WARN'));

    await expireStaleJobs(now.getTime());
    await expireApprovals(now);
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
