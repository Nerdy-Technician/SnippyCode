import { Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import {
  AgentJobModel,
  PolicyModel,
  RunbookModel,
  RunbookRunModel,
  ScheduleInstance,
  ScheduleModel,
  ScheduleRunModel,
  SiteModel,
  SnippetModel,
  SnippetRunModel,
  UserModel
} from '../models';
import {
  ErrorResponse,
  auditLog,
  canAccessSite,
  computeNextRun,
  isAdminRole,
  isValidTimezone,
  nextCronTimes,
  parseCron,
  requestIp,
  startScheduleRun
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
  const siteMode = ['none', 'sites', 'tag', 'all', 'policy'].includes(body.siteMode) ? body.siteMode : 'none';
  // A policy is a set of devices, so its schedules always run on them
  const runOn = body.runOn === 'devices' || siteMode === 'policy' ? 'devices' : 'server';
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

  if (targetType === 'snippet' && !(snippetId && (await SnippetModel.findByPk(snippetId)))) {
    next(new ErrorResponse(400, 'Choose a snippet to run'));
    return null;
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

  return {
    name,
    targetType: targetType as 'snippet' | 'runbook',
    snippetId,
    runbookId,
    cron,
    timezone,
    siteMode: siteMode as 'none' | 'sites' | 'tag' | 'all' | 'policy',
    policyId,
    siteIds: siteIds.join(','),
    siteTag,
    runOn: runOn as 'server' | 'devices',
    notifyOn: notifyOn as 'failure' | 'always' | 'never',
    enabled: body.enabled !== false,
    nextRunAt: computeNextRun({ cron, timezone })
  };
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

    const schedule = await ScheduleModel.create({ ...fields, createdBy: req.user?.id || null });

    await auditLog('schedule.created', {
      ...auditActor(req),
      target: `schedule:${schedule.id}`,
      metadata: { name: schedule.name, cron: schedule.cron, timezone: schedule.timezone }
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
    const schedule = await findSchedule(req, next);
    const fields = schedule && (await readSchedule(req, next));

    if (!schedule || !fields) {
      return;
    }

    await schedule.update(fields);

    await auditLog('schedule.updated', {
      ...auditActor(req),
      target: `schedule:${schedule.id}`,
      metadata: { name: schedule.name, cron: schedule.cron, enabled: schedule.enabled }
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
    const schedule = await findSchedule(req, next);

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
    const schedule = await findSchedule(req, next);

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
    const described = await describeRuns(snippetRuns);
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
          results: described.filter((_, index) => snippetRuns[index].scheduleRunId === run.id),
          runbookRuns: runbookRuns
            .filter(item => item.scheduleRunId === run.id)
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
