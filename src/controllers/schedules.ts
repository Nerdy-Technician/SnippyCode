import { decryptScheduleVariables, maskScheduleVariables, restoreMaskedValues } from '../utils/scheduleVariables';
import { Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import {
  AgentJobModel,
  DeviceModel,
  PolicyModel,
  RunbookModel,
  RunbookRunModel,
  ScheduleInstance,
  ScheduleModel,
  ScheduleRunModel,
  SiteModel,
  SnippetModel,
  SnippetRunModel,
  UserModel,
  TagModel
} from '../models';
import {
  ErrorResponse,
  accessibleSiteIds,
  auditLog,
  canAccessSite,
  computeNextRun,
  isAdminRole,
  isValidTimezone,
  nextCronTimes,
  parseCron,
  requestIp,
  startScheduleRun,
  applyDefinitions,
  cleanStepValues,
  findTemplateVariables,
  cleanTagName,
  parseIdList,
  tagIdsForNames
} from '../utils';
import { describeRuns } from './runs';

const auditActor = (req: AuthenticatedRequest) => ({
  userId: req.user?.id || null,
  ipAddress: requestIp(req)
});

const scheduleJson = async (schedules: ScheduleInstance[]) => {
  const snippetIds = schedules.map(item => item.snippetId).filter(Boolean) as number[];
  const runbookIds = schedules.map(item => item.runbookId).filter(Boolean) as number[];
  const userIds = schedules.map(item => item.createdBy).filter(Boolean) as number[];
  const tagIdsUsed = Array.from(new Set(schedules.flatMap(item => parseIdList(item.deviceTagIds))));
  const tags = tagIdsUsed.length ? await TagModel.findAll({ where: { id: tagIdsUsed } }) : [];
  const [snippets, runbooks, users, sites, policies] = await Promise.all([
    snippetIds.length ? SnippetModel.findAll({ where: { id: snippetIds }, attributes: ['id', 'title', 'language'] }) : [],
    runbookIds.length ? RunbookModel.findAll({ where: { id: runbookIds }, attributes: ['id', 'title'] }) : [],
    userIds.length ? UserModel.findAll({ where: { id: userIds }, attributes: ['id', 'displayName'] }) : [],
    SiteModel.findAll({ attributes: ['id', 'name'] }),
    PolicyModel.findAll({ attributes: ['id', 'name'] })
  ]);

  return schedules.map(schedule => {
    const siteIds = schedule.siteIds.split(',').map(Number).filter(Boolean);
    const snippet = snippets.find(item => item.id === schedule.snippetId);
    const runbook = runbooks.find(item => item.id === schedule.runbookId);

    return {
      id: schedule.id,
      name: schedule.name,
      targetType: schedule.targetType,
      snippetId: schedule.snippetId,
      runbookId: schedule.runbookId,
      target: snippet
        ? { id: snippet.id, title: snippet.title, language: snippet.language }
        : runbook
        ? { id: runbook.id, title: runbook.title }
        : null,
      cron: schedule.cron,
      timezone: schedule.timezone,
      siteMode: schedule.siteMode,
      siteIds,
      siteNames: sites.filter(site => siteIds.includes(site.id)).map(site => site.name),
      siteTag: schedule.siteTag,
      deviceIds: (schedule.deviceIds || '').split(',').map(Number).filter(Boolean),
      deviceTag: schedule.deviceTag || '',
      deviceTagIds: parseIdList(schedule.deviceTagIds),
      deviceTags: tags
        .filter(tag => parseIdList(schedule.deviceTagIds).includes(tag.id))
        .map(tag => ({ id: tag.id, name: tag.name, color: tag.color || null })),
      variables: maskScheduleVariables(schedule.variables),
      policyId: schedule.policyId,
      policyName: policies.find(policy => policy.id === schedule.policyId)?.name || null,
      runOn: schedule.runOn,
      notifyOn: schedule.notifyOn,
      enabled: schedule.enabled,
      createdBy: users.find(user => user.id === schedule.createdBy)?.displayName || null,
      lastRunAt: schedule.lastRunAt,
      lastStatus: schedule.lastStatus,
      nextRunAt: schedule.enabled ? schedule.nextRunAt : null,
      updatedAt: schedule.updatedAt
    };
  });
};

/**
 * Check a schedule body. Returns the fields to save, or null after reporting
 * the problem.
 */
const readSchedule = async (req: AuthenticatedRequest, next: NextFunction) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const targetType = body.targetType === 'runbook' ? 'runbook' : 'snippet';
  const cron = String(body.cron || '').trim();
  const timezone = String(body.timezone || 'UTC').trim();
  const siteMode = ['none', 'sites', 'tag', 'all', 'policy', 'devices'].includes(body.siteMode) ? body.siteMode : 'none';
  // Policies and picked devices are sets of devices, so they always run on them
  const runOn = body.runOn === 'devices' || siteMode === 'policy' || siteMode === 'devices' ? 'devices' : 'server';
  const notifyOn = ['failure', 'always', 'never'].includes(body.notifyOn) ? body.notifyOn : 'failure';

  if (!name || name.length > 200) {
    next(new ErrorResponse(400, 'Give the schedule a name'));
    return null;
  }

  try {
    parseCron(cron);
  } catch (err) {
    next(new ErrorResponse(400, `Cron: ${err instanceof Error ? err.message : 'invalid'}`));
    return null;
  }

  if (!isValidTimezone(timezone)) {
    next(new ErrorResponse(400, `Unknown timezone ${timezone}`));
    return null;
  }

  const snippetId = targetType === 'snippet' ? Number(body.snippetId) || null : null;
  const runbookId = targetType === 'runbook' ? Number(body.runbookId) || null : null;

  const targetSnippet = targetType === 'snippet' && snippetId ? await SnippetModel.findByPk(snippetId) : null;

  if (targetType === 'snippet' && !targetSnippet) {
    next(new ErrorResponse(400, 'Choose a snippet to run'));
    return null;
  }

  // Stored values: typed against the snippet's definitions; required ones
  // must have a value here or a default (secret-refs come from the store)
  const variables = cleanStepValues(body.variables);
  if (targetSnippet) {
    const applied = applyDefinitions(targetSnippet.variables || [], variables);
    const missing = (targetSnippet.variables || [])
      .filter(def => def.required && def.type !== 'secret-ref' && !def.default && !applied.explicit[def.name])
      .map(def => `${def.name} needs a value`);
    if (applied.errors.length || missing.length) {
      next(new ErrorResponse(400, [...applied.errors, ...missing].join('; ')));
      return null;
    }
    // Keep values for defined variables and placeholders in the code only
    const known = new Set([
      ...(targetSnippet.variables || []).map(def => def.name),
      ...findTemplateVariables(targetSnippet.code).map(item => item.name)
    ]);
    Object.keys(variables).forEach(name => {
      if (known.has(name) && name in applied.explicit) variables[name] = applied.explicit[name];
      else delete variables[name];
    });
  }

  if (targetType === 'runbook' && !(runbookId && (await RunbookModel.findByPk(runbookId)))) {
    next(new ErrorResponse(400, 'Choose a runbook to run'));
    return null;
  }

  // Schedules act for every site they cover, so their creator must be able
  // to see those sites; "all" and tag schedules can reach any site
  let siteIds: number[] = [];

  if (siteMode === 'sites') {
    const requested: number[] = Array.isArray(body.siteIds) ? body.siteIds.map(Number) : [];
    const sites = await SiteModel.findAll({ where: { id: requested.length ? requested : [-1] } });

    for (const site of sites) {
      if (!(await canAccessSite(req.user || {}, site))) {
        next(new ErrorResponse(403, `You do not have access to ${site.name}`));
        return null;
      }
    }

    siteIds = sites.map(site => site.id);

    if (!siteIds.length) {
      next(new ErrorResponse(400, 'Choose at least one site'));
      return null;
    }
  }

  if ((siteMode === 'all' || siteMode === 'tag' || siteMode === 'policy') && !isAdminRole(req.user?.role)) {
    next(new ErrorResponse(403, 'Only admins can schedule work for all sites, a tag or a policy'));
    return null;
  }

  const policyId = siteMode === 'policy' ? Number(body.policyId) || null : null;

  if (siteMode === 'policy' && !(policyId && (await PolicyModel.findByPk(policyId)))) {
    next(new ErrorResponse(400, 'Choose a policy'));
    return null;
  }

  const siteTag = siteMode === 'tag' ? String(body.siteTag || '').trim().toLowerCase().slice(0, 60) : '';

  if (siteMode === 'tag' && !siteTag) {
    next(new ErrorResponse(400, 'Choose a site tag'));
    return null;
  }

  if (runOn === 'devices' && siteMode === 'none') {
    next(new ErrorResponse(400, 'Device runs need sites to find their devices'));
    return null;
  }

  // Device targeting: picked devices and/or shared tags (by id; a legacy
  // deviceTag name is accepted and creates the shared tag if needed)
  let tagIds = runOn === 'devices' ? parseIdList(body.deviceTagIds).slice(0, 20) : [];
  const legacyTag = runOn === 'devices' ? cleanTagName(body.deviceTag) : '';
  if (legacyTag && !tagIds.length) {
    // Devices can carry a tag name (enrolment, agents, older data) before
    // anyone made it a shared tag, so a legacy name creates the tag
    tagIds = await tagIdsForNames([legacyTag]);
  }
  const tagRows = tagIds.length ? await TagModel.findAll({ where: { id: tagIds } }) : [];
  if (tagRows.length !== tagIds.length) {
    next(new ErrorResponse(400, 'Some of the chosen tags were not found'));
    return null;
  }
  const deviceTag = tagRows.map(tag => tag.name).sort().join(',').slice(0, 60);
  const requestedDevices: number[] =
    runOn === 'devices' && Array.isArray(body.deviceIds)
      ? Array.from(new Set(body.deviceIds.map(Number).filter((id: number) => Number.isSafeInteger(id) && id > 0)))
      : [];
  const devices = requestedDevices.length
    ? await DeviceModel.findAll({ where: { id: requestedDevices, revokedAt: null } })
    : [];

  if (devices.length !== requestedDevices.length) {
    next(new ErrorResponse(400, 'Some of the chosen devices were not found'));
    return null;
  }

  if (devices.length) {
    const allowed = await accessibleSiteIds(req.user || {});

    if (allowed !== 'all' && devices.some(device => !allowed.includes(device.siteId))) {
      // Same answer as a missing device, so other sites' devices stay hidden
      next(new ErrorResponse(400, 'Some of the chosen devices were not found'));
      return null;
    }
  }

  // Shared device tags span every site in "devices" mode, like site tags
  if (siteMode === 'devices' && tagIds.length && !isAdminRole(req.user?.role)) {
    next(new ErrorResponse(403, 'Only admins can target a device tag across all sites; pick sites or devices'));
    return null;
  }

  if (siteMode === 'devices' && !devices.length && !tagIds.length) {
    next(new ErrorResponse(400, 'Choose devices or a device tag'));
    return null;
  }

  return {
    name,
    targetType: targetType as 'snippet' | 'runbook',
    snippetId,
    runbookId,
    cron,
    timezone,
    siteMode: siteMode as 'none' | 'sites' | 'tag' | 'all' | 'policy' | 'devices',
    policyId,
    siteIds: siteIds.join(','),
    siteTag,
    deviceIds: devices.map(device => device.id).join(','),
    deviceTag,
    deviceTagIds: tagIds.join(','),
    variables: JSON.stringify(variables) as any,
    runOn: runOn as 'server' | 'devices',
    notifyOn: notifyOn as 'failure' | 'always' | 'never',
    enabled: body.enabled !== false,
    nextRunAt: computeNextRun({ cron, timezone })
  };
};

/**
 * Can this user act on the schedule as it is now? Admins can. Everyone else
 * needs access to every site and device it currently targets; schedules
 * reaching all sites, site tags, policies or shared device tags are admin-only.
 */
export const canManageSchedule = async (user: AuthenticatedRequest['user'], schedule: ScheduleInstance): Promise<boolean> => {
  if (isAdminRole(user?.role)) return true;
  if (['all', 'tag', 'policy'].includes(schedule.siteMode)) return false;
  if (schedule.siteMode === 'devices' && parseIdList(schedule.deviceTagIds).length) return false;
  const allowed = await accessibleSiteIds(user || {});
  if (allowed === 'all') return true;
  const siteIds = (schedule.siteIds || '').split(',').map(Number).filter(Boolean);
  const deviceIds = (schedule.deviceIds || '').split(',').map(Number).filter(Boolean);
  const devices = deviceIds.length ? await DeviceModel.findAll({ where: { id: deviceIds }, attributes: ['id', 'siteId'] }) : [];
  return [...siteIds, ...devices.map(device => device.siteId)].every(id => allowed.includes(id));
};

/** findSchedule, then 404 (same as missing) unless the caller may act on it */
const findManagedSchedule = async (req: AuthenticatedRequest, next: NextFunction) => {
  const schedule = await ScheduleModel.findByPk(Number(req.params.id) || -1);

  if (!schedule || !(await canManageSchedule(req.user, schedule))) {
    if (schedule) {
      await auditLog('schedule.access_refused', {
        ...auditActor(req),
        target: `schedule:${schedule.id}`,
        metadata: { method: req.method, path: req.path }
      });
    }
    next(new ErrorResponse(404, 'Schedule was not found'));
    return null;
  }

  return schedule;
};

const findSchedule = async (req: AuthenticatedRequest, next: NextFunction) => {
  const schedule = await ScheduleModel.findByPk(Number(req.params.id) || -1);

  if (!schedule) {
    next(new ErrorResponse(404, 'Schedule was not found'));
    return null;
  }

  return schedule;
};

/**
 * @description All schedules
 * @route /api/schedules
 * @request GET
 */
export const getSchedules = asyncWrapper(
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const schedules = await ScheduleModel.findAll({ order: [['name', 'ASC']] });
    res.status(200).json({ data: await scheduleJson(schedules) });
  }
);

/**
 * @description Next run times for a cron expression, for the editor
 * @route /api/schedules/preview
 * @request GET
 */
export const previewSchedule = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const cron = String(req.query.cron || '');
    const timezone = String(req.query.timezone || 'UTC');

    try {
      if (!isValidTimezone(timezone)) {
        throw new Error(`Unknown timezone ${timezone}`);
      }

      res.status(200).json({
        data: { valid: true, next: nextCronTimes(cron, timezone, new Date(), 5) }
      });
    } catch (err) {
      res.status(200).json({
        data: { valid: false, error: err instanceof Error ? err.message : 'Invalid', next: [] }
      });
    }
  }
);

/**
 * @description Create a schedule
 * @route /api/schedules
 * @request POST
 */
export const createSchedule = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const fields = await readSchedule(req, next);

    if (!fields) {
      return;
    }

    const schedule = await ScheduleModel.create({ ...fields, createdBy: req.user?.id || null, updatedBy: req.user?.id || null });

    await auditLog('schedule.created', {
      ...auditActor(req),
      target: `schedule:${schedule.id}`,
      metadata: {
        name: schedule.name,
        cron: schedule.cron,
        timezone: schedule.timezone,
        siteMode: schedule.siteMode,
        deviceIds: schedule.deviceIds,
        deviceTag: schedule.deviceTag
      }
    });

    res.status(201).json({ data: (await scheduleJson([schedule]))[0] });
  }
);

/**
 * @description Update a schedule
 * @route /api/schedules/:id
 * @request PUT
 */
export const updateSchedule = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const schedule = await findManagedSchedule(req, next);
    if (schedule && req.body && req.body.variables) {
      req.body.variables = restoreMaskedValues(req.body.variables, schedule.variables, schedule.id);
    }
    const fields = schedule && (await readSchedule(req, next));

    if (!schedule || !fields) {
      return;
    }

    await schedule.update({ ...fields, updatedBy: req.user?.id || null });

    await auditLog('schedule.updated', {
      ...auditActor(req),
      target: `schedule:${schedule.id}`,
      metadata: {
        name: schedule.name,
        cron: schedule.cron,
        enabled: schedule.enabled,
        siteMode: schedule.siteMode,
        deviceIds: schedule.deviceIds,
        deviceTag: schedule.deviceTag
      }
    });

    res.status(200).json({ data: (await scheduleJson([schedule]))[0] });
  }
);

/**
 * @description Delete a schedule and its history
 * @route /api/schedules/:id
 * @request DELETE
 */
export const deleteSchedule = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const schedule = await findManagedSchedule(req, next);

    if (!schedule) {
      return;
    }

    await schedule.destroy();

    await auditLog('schedule.deleted', {
      ...auditActor(req),
      target: `schedule:${req.params.id}`,
      metadata: { name: schedule.name }
    });

    res.status(200).json({ data: {} });
  }
);

/**
 * @description Run a schedule now
 * @route /api/schedules/:id/run
 * @request POST
 */
export const runScheduleNow = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const schedule = await findManagedSchedule(req, next);

    if (!schedule) {
      return;
    }

    const run = await startScheduleRun(schedule, 'manual', req.user?.id || null);

    await auditLog('schedule.ran', {
      ...auditActor(req),
      target: `schedule:${schedule.id}`,
      metadata: { name: schedule.name, scheduleRunId: run.id }
    });

    res.status(202).json({ data: { id: run.id, status: run.status } });
  }
);

/**
 * @description The decrypted variable values, for the edit form (editors only)
 * @route /api/schedules/:id/edit
 * @request GET
 */
export const getScheduleForEdit = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const schedule = await findManagedSchedule(req, next);

    if (!schedule) {
      return;
    }

    await auditLog('schedule.variables_viewed', { ...auditActor(req), target: `schedule:${schedule.id}` });
    res.status(200).json({
      data: { ...(await scheduleJson([schedule]))[0], variables: decryptScheduleVariables(schedule.variables, schedule.id) }
    });
  }
);

/**
 * @description A schedule with its recent runs and their results
 * @route /api/schedules/:id
 * @request GET
 */
export const getSchedule = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const schedule = await findSchedule(req, next);

    if (!schedule) {
      return;
    }

    const scheduleRuns = await ScheduleRunModel.findAll({
      where: { scheduleId: schedule.id },
      order: [['createdAt', 'DESC']],
      limit: 20
    });
    const runIds = scheduleRuns.map(run => run.id);
    const [snippetRuns, runbookRuns, pending] = runIds.length
      ? await Promise.all([
          SnippetRunModel.findAll({
            where: { scheduleRunId: runIds, runbookRunId: null },
            order: [['createdAt', 'ASC']]
          }),
          RunbookRunModel.findAll({ where: { scheduleRunId: runIds } }),
          AgentJobModel.findAll({
            where: { scheduleRunId: runIds, status: { [Op.in]: ['queued', 'running'] }, runbookRunId: null },
            attributes: ['id', 'scheduleRunId', 'deviceId', 'status']
          })
        ])
      : [[], [], []];
    // Only results from sites the viewer can access
    const allowed = await accessibleSiteIds(req.user || {});
    const visible = (siteId: number | null) => allowed === 'all' || siteId === null || allowed.includes(siteId);
    const visibleRuns = snippetRuns.filter(run => visible(run.siteId));
    const described = await describeRuns(visibleRuns);
    const sites = await SiteModel.findAll({ attributes: ['id', 'name'] });

    res.status(200).json({
      data: {
        ...(await scheduleJson([schedule]))[0],
        runs: scheduleRuns.map(run => ({
          id: run.id,
          status: run.status,
          trigger: run.trigger,
          createdAt: run.createdAt,
          finishedAt: run.finishedAt,
          pendingJobs: pending.filter(job => job.scheduleRunId === run.id).length,
          results: described.filter((_, index) => visibleRuns[index].scheduleRunId === run.id),
          runbookRuns: runbookRuns
            .filter(item => item.scheduleRunId === run.id && visible(item.siteId))
            .map(item => ({
              id: item.id,
              status: item.status,
              site: sites.find(site => site.id === item.siteId)?.name || null
            }))
        }))
      }
    });
  }
);

/**
 * @description One schedule run with a result per device: status, exit
 * code, output and start/end times. Only devices in sites the viewer can
 * access are included.
 * @route /api/schedules/:id/runs/:runId
 * @request GET
 */
export const getScheduleRunDevices = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const run = await ScheduleRunModel.findOne({
      where: { id: Number(req.params.runId) || -1, scheduleId: Number(req.params.id) || -1 }
    });

    if (!run) {
      return next(new ErrorResponse(404, 'Schedule run was not found'));
    }

    const allowed = await accessibleSiteIds(req.user || {});
    const siteScope = allowed === 'all' ? {} : { siteId: allowed.length ? allowed : [-1] };
    const [jobs, runbookRuns] = await Promise.all([
      AgentJobModel.findAll({
        where: { scheduleRunId: run.id, runbookRunId: null, ...siteScope },
        order: [['id', 'ASC']]
      }),
      RunbookRunModel.findAll({
        where: { scheduleRunId: run.id, deviceId: { [Op.ne]: null }, ...siteScope },
        order: [['id', 'ASC']]
      })
    ]);
    const snippetRunIds = jobs.map(job => job.snippetRunId).filter(Boolean) as number[];
    const deviceIds = Array.from(
      new Set([...jobs.map(job => job.deviceId), ...runbookRuns.map(item => item.deviceId!)])
    );
    const [snippetRuns, devices, sites] = await Promise.all([
      snippetRunIds.length ? SnippetRunModel.findAll({ where: { id: snippetRunIds } }) : [],
      deviceIds.length ? DeviceModel.findAll({ where: { id: deviceIds }, attributes: ['id', 'name', 'siteId'] }) : [],
      SiteModel.findAll({ attributes: ['id', 'name'] })
    ]);
    const deviceInfo = (deviceId: number) => {
      const device = devices.find(item => item.id === deviceId);
      return {
        deviceId,
        deviceName: device?.name || `Device ${deviceId}`,
        site: sites.find(site => site.id === device?.siteId)?.name || null
      };
    };

    res.status(200).json({
      data: {
        id: run.id,
        status: run.status,
        trigger: run.trigger,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        devices: [
          ...jobs.map(job => {
            const result = snippetRuns.find(item => item.id === job.snippetRunId);
            return {
              ...deviceInfo(job.deviceId),
              kind: 'snippet',
              status: job.status,
              ok: result ? result.ok : null,
              exitCode: result ? result.exitCode : null,
              timedOut: result ? result.timedOut : false,
              stdout: result?.stdout || '',
              stderr: result?.stderr || '',
              snippetRunId: job.snippetRunId,
              startedAt: job.startedAt,
              finishedAt: job.finishedAt
            };
          }),
          ...runbookRuns.map(item => ({
            ...deviceInfo(item.deviceId!),
            kind: 'runbook',
            status: item.status,
            ok: item.status === 'completed' ? true : item.status === 'failed' ? false : null,
            exitCode: null,
            timedOut: false,
            stdout: '',
            stderr: '',
            runbookRunId: item.id,
            startedAt: item.createdAt,
            finishedAt: item.completedAt
          }))
        ]
      }
    });
  }
);
