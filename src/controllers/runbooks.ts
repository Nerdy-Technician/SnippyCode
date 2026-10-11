import { Response, NextFunction } from 'express';
import { Op, WhereOptions } from 'sequelize';
import { sequelize } from '../db';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import {
  AgentJobModel,
  DeviceModel,
  RunbookModel,
  RunbookRunInstance,
  RunbookRunModel,
  RunbookRunStepModel,
  RunbookStepModel,
  SiteModel,
  SnippetModel,
  SnippetRunModel,
  UserModel
} from '../models';
import {
  ErrorResponse,
  VARIABLE_NAME_PATTERN,
  accessibleSiteIds,
  auditLog,
  canAccessSite,
  findAccessibleSite,
  afterRunbookStep,
  executeRunbookStep,
  requestIp,
  cleanStepValues,
  startRunbookRun as beginRunbookRun,
  approvalJson,
  approvalReasons,
  assertApprovalFresh,
  contentHash,
  approvedRunId,
  getApprovalSettings,
  isAdminRole,
  registerApprovalExecutor,
  replayHandler,
  requestApproval
} from '../utils';
import { runbookContent } from '../utils/scheduler';
import { describeRuns } from './runs';

const MAX_STEPS = 100;

const auditActor = (req: AuthenticatedRequest) => ({
  userId: req.user?.id || null,
  ipAddress: requestIp(req)
});

interface StepInput {
  id?: number;
  snippetId: number | null;
  title: string;
  note: string;
  values: Record<string, string>;
}

const readRunbook = (
  body: any,
  next: NextFunction
): { title: string; description: string; steps: StepInput[] } | null => {
  const title = String(body.title || '').trim();

  if (!title || title.length > 200) {
    next(new ErrorResponse(400, 'Runbook title is required (up to 200 characters)'));
    return null;
  }

  const rawSteps: any[] = Array.isArray(body.steps) ? body.steps : [];

  if (rawSteps.length > MAX_STEPS) {
    next(new ErrorResponse(400, `Runbooks are limited to ${MAX_STEPS} steps`));
    return null;
  }

  const steps = rawSteps.map(step => ({
    id: Number(step.id) || undefined,
    snippetId: Number(step.snippetId) || null,
    title: String(step.title || '').trim().slice(0, 200),
    note: String(step.note || '').slice(0, 5000),
    values: cleanStepValues(step.values)
  }));

  if (steps.some(step => !step.snippetId && !step.title)) {
    next(new ErrorResponse(400, 'Each step needs a snippet or a title'));
    return null;
  }

  return {
    title,
    description: String(body.description || '').slice(0, 5000),
    steps
  };
};

const stepsFor = async (runbookId: number) => {
  const steps = await RunbookStepModel.findAll({
    where: { runbookId },
    order: [['position', 'ASC']]
  });
  const snippetIds = steps.map(step => step.snippetId).filter(Boolean) as number[];
  const snippets = snippetIds.length
    ? await SnippetModel.findAll({
        where: { id: snippetIds },
        attributes: ['id', 'title', 'language', 'code', 'variables']
      })
    : [];

  return steps.map(step => {
    const snippet = snippets.find(item => item.id === step.snippetId);

    return {
      id: step.id,
      position: step.position,
      snippetId: step.snippetId,
      title: step.title,
      note: step.note,
      values: step.values || {},
      snippet: snippet
        ? { id: snippet.id, title: snippet.title, language: snippet.language, variables: snippet.variables }
        : null
    };
  });
};

/**
 * Replace steps in order, keeping ids of steps that were sent back so runs
 * already in progress keep their progress.
 */
const saveSteps = async (runbookId: number, steps: StepInput[]) => {
  await sequelize.transaction(async transaction => {
    const existing = await RunbookStepModel.findAll({ where: { runbookId }, transaction });
    const keepIds = steps
      .map(step => step.id)
      .filter((id): id is number => Boolean(id) && existing.some(item => item.id === id));
    const keep = new Set(keepIds);

    await RunbookStepModel.destroy({
      where: { runbookId, id: { [Op.notIn]: keepIds.length ? keepIds : [-1] } },
      transaction
    });

    for (const [position, step] of steps.entries()) {
      const fields = {
        runbookId,
        position,
        snippetId: step.snippetId,
        title: step.title,
        note: step.note,
        values: JSON.stringify(step.values || {}) as any
      };

      if (step.id && keep.has(step.id)) {
        await RunbookStepModel.update(fields, { where: { id: step.id }, transaction });
      } else {
        await RunbookStepModel.create(fields, { transaction });
      }
    }
  });
};

const runsVisibleTo = async (viewer: { id?: number; role?: string }) => {
  const ids = await accessibleSiteIds(viewer);

  return ids === 'all'
    ? {}
    : { [Op.or]: [{ siteId: null }, { siteId: ids.length ? ids : [-1] }] };
};

const describeRunbookRuns = async (runs: RunbookRunInstance[]) => {
  const siteIds = Array.from(new Set(runs.map(run => run.siteId).filter(Boolean))) as number[];
  const userIds = Array.from(new Set(runs.map(run => run.userId).filter(Boolean))) as number[];
  const runIds = runs.map(run => run.id);
  const deviceIds = Array.from(new Set(runs.map(run => run.deviceId).filter(Boolean))) as number[];
  const [sites, users, stepStates, devices] = await Promise.all([
    siteIds.length ? SiteModel.findAll({ where: { id: siteIds } }) : [],
    userIds.length ? UserModel.findAll({ where: { id: userIds }, attributes: ['id', 'displayName'] }) : [],
    runIds.length ? RunbookRunStepModel.findAll({ where: { runId: runIds }, raw: true }) : [],
    deviceIds.length ? DeviceModel.findAll({ where: { id: deviceIds }, attributes: ['id', 'name'] }) : []
  ]);

  return runs.map(run => {
    const site = sites.find(item => item.id === run.siteId);
    const user = users.find(item => item.id === run.userId);
    const states = stepStates.filter(state => state.runId === run.id);

    return {
      id: run.id,
      runbookId: run.runbookId,
      runbookTitle: run.runbookTitle,
      site: site ? { id: site.id, name: site.name, slug: site.slug } : null,
      user: user ? { id: user.id, displayName: user.displayName } : null,
      device: devices.find(item => item.id === run.deviceId)
        ? { id: run.deviceId, name: devices.find(item => item.id === run.deviceId)!.name }
        : null,
      scheduled: Boolean(run.scheduleRunId),
      status: run.status,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
      progress: {
        total: states.length,
        finished: states.filter(state => state.status === 'done' || state.status === 'skipped')
          .length,
        failed: states.filter(state => state.status === 'failed').length
      }
    };
  });
};

const findRunbook = async (req: AuthenticatedRequest, next: NextFunction) => {
  const runbook = await RunbookModel.findByPk(Number(req.params.id) || -1);

  if (!runbook) {
    next(new ErrorResponse(404, 'Runbook was not found'));
    return null;
  }

  return runbook;
};

const findVisibleRun = async (req: AuthenticatedRequest, next: NextFunction) => {
  const run = await RunbookRunModel.findOne({
    where: {
      [Op.and]: [{ id: Number(req.params.runId) || -1 }, await runsVisibleTo(req.user || {})]
    }
  });

  if (!run) {
    next(new ErrorResponse(404, 'Runbook run was not found'));
    return null;
  }

  return run;
};

/**
 * @description List runbooks with their latest run
 * @route /api/runbooks
 * @request GET
 */
export const getRunbooks = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const runbooks = await RunbookModel.findAll({ order: [['title', 'ASC']] });
    const ids = runbooks.map(runbook => runbook.id);
    const [steps, runs] = ids.length
      ? await Promise.all([
          RunbookStepModel.findAll({ where: { runbookId: ids }, attributes: ['runbookId'], raw: true }),
          RunbookRunModel.findAll({
            where: { [Op.and]: [{ runbookId: ids }, await runsVisibleTo(req.user || {})] },
            order: [['createdAt', 'DESC']]
          })
        ])
      : [[], []];
    const latest = await describeRunbookRuns(
      ids
        .map(id => runs.find(run => run.runbookId === id))
        .filter(Boolean) as RunbookRunInstance[]
    );

    res.status(200).json({
      data: runbooks.map(runbook => ({
        id: runbook.id,
        title: runbook.title,
        description: runbook.description,
        dangerous: runbook.dangerous,
        stepCount: steps.filter(step => step.runbookId === runbook.id).length,
        updatedAt: runbook.updatedAt,
        lastRun: latest.find(run => run.runbookId === runbook.id) || null
      }))
    });
  }
);

/**
 * @description Create a runbook
 * @route /api/runbooks
 * @request POST
 */
export const createRunbook = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const fields = readRunbook(req.body, next);

    if (!fields) {
      return;
    }

    const runbook = await RunbookModel.create({
      title: fields.title,
      description: fields.description,
      createdBy: req.user?.id || null
    });
    await saveSteps(runbook.id, fields.steps);

    await auditLog('runbook.created', {
      ...auditActor(req),
      target: `runbook:${runbook.id}`,
      metadata: { title: runbook.title, steps: fields.steps.length }
    });

    res.status(201).json({ data: { ...runbook.get({ plain: true }), steps: await stepsFor(runbook.id) } });
  }
);

/**
 * @description One runbook with its steps
 * @route /api/runbooks/:id
 * @request GET
 */
export const getRunbook = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const runbook = await findRunbook(req, next);

    if (!runbook) {
      return;
    }

    res.status(200).json({ data: { ...runbook.get({ plain: true }), steps: await stepsFor(runbook.id) } });
  }
);

/**
 * @description Update a runbook and its steps
 * @route /api/runbooks/:id
 * @request PUT
 */
export const updateRunbook = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const runbook = await findRunbook(req, next);
    const fields = runbook && readRunbook(req.body, next);

    if (!runbook || !fields) {
      return;
    }

    await runbook.update({ title: fields.title, description: fields.description });
    await saveSteps(runbook.id, fields.steps);

    await auditLog('runbook.updated', {
      ...auditActor(req),
      target: `runbook:${runbook.id}`,
      metadata: { title: runbook.title, steps: fields.steps.length }
    });

    res.status(200).json({ data: { ...runbook.get({ plain: true }), steps: await stepsFor(runbook.id) } });
  }
);

/**
 * @description Delete a runbook. Past runs stay in history.
 * @route /api/runbooks/:id
 * @request DELETE
 */
export const deleteRunbook = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const runbook = await findRunbook(req, next);

    if (!runbook) {
      return;
    }

    await runbook.destroy();

    await auditLog('runbook.deleted', {
      ...auditActor(req),
      target: `runbook:${req.params.id}`,
      metadata: { title: runbook.title }
    });

    res.status(200).json({ data: {} });
  }
);

/**
 * @description Start working through a runbook against a site
 * @route /api/runbooks/:id/runs
 * @request POST
 */
export const startRunbookRun = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const runbook = await findRunbook(req, next);

    if (!runbook) {
      return;
    }

    const site = req.body?.siteId
      ? await findAccessibleSite(req.user || {}, req.body.siteId)
      : null;

    if (req.body?.siteId && !site) {
      return next(new ErrorResponse(404, 'Site was not found'));
    }

    // A device must be enrolled at the chosen site
    const device = req.body?.deviceId
      ? await DeviceModel.findOne({
          where: { id: Number(req.body.deviceId) || -1, siteId: site?.id || -1, revokedAt: null, clonePendingApproval: false }
        })
      : null;

    if (req.body?.deviceId && !device) {
      return next(new ErrorResponse(404, 'Device was not found at this site'));
    }

    // Dangerous runbooks (flagged, or with a dangerous snippet) wait for an admin
    const content = await runbookContent(runbook);
    const hash = contentHash({ kind: 'runbook', id: runbook.id, steps: content.steps, siteId: site?.id || null, deviceId: device?.id || null });
    const approved = approvedRunId(req);
    if (approved) await assertApprovalFresh(approved, hash);
    if (!approved) {
      // A runbook run reaches one machine: the chosen device, or the server
      const why = approvalReasons({ dangerous: content.dangerous, targetCount: 1 }, await getApprovalSettings());

      if (why.length) {
        const approval = await requestApproval({
          kind: 'runbook',
          title: runbook.title,
          why,
          requestedBy: req.user?.id || null,
          reason: req.body?.reason,
          runbookId: runbook.id,
          siteId: site?.id || null,
          targets: [device ? { type: 'device', id: device.id, name: device.name } : { type: 'site', id: site?.id || null, name: site?.name || 'No site' }],
          targetCount: 1,
          payload: { siteId: req.body?.siteId, deviceId: req.body?.deviceId },
          ipAddress: requestIp(req),
          contentHash: hash,
          contentPreview: content.preview,
          siteIds: site ? [site.id] : []
        });
        res.status(202).json({ data: { approval: approvalJson(approval) } });
        return;
      }
    }

    let run: RunbookRunInstance;

    try {
      run = await beginRunbookRun({
        runbook,
        siteId: site?.id || null,
        deviceId: device?.id || null,
        userId: req.user?.id || null
      });
    } catch (err) {
      return next(new ErrorResponse(400, err instanceof Error ? err.message : 'Could not start'));
    }

    await auditLog('runbook.run_started', {
      ...auditActor(req),
      target: `runbook:${runbook.id}`,
      metadata: { title: runbook.title, site: site?.name, device: device?.name, runId: run.id }
    });

    res.status(201).json({ data: (await describeRunbookRuns([run]))[0] });
  }
);

/**
 * @description Runbook runs, newest first. Filter by siteId or runbookId.
 * @route /api/runbooks/runs
 * @request GET
 */
export const getRunbookRuns = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const where: WhereOptions[] = [<WhereOptions>await runsVisibleTo(req.user || {})];

    if (req.query.siteId) {
      const site = await findAccessibleSite(req.user || {}, req.query.siteId);

      if (!site) {
        return next(new ErrorResponse(404, 'Site was not found'));
      }

      where.push({ siteId: site.id });
    }

    if (req.query.runbookId) {
      where.push({ runbookId: Number(req.query.runbookId) || -1 });
    }

    const runs = await RunbookRunModel.findAll({
      where: { [Op.and]: where },
      order: [['createdAt', 'DESC']],
      limit: Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
    });

    res.status(200).json({ data: await describeRunbookRuns(runs) });
  }
);

const runDetail = async (run: RunbookRunInstance) => {
  const [summary] = await describeRunbookRuns([run]);
  const states = await RunbookRunStepModel.findAll({ where: { runId: run.id }, raw: true });
  const steps = run.runbookId ? await stepsFor(run.runbookId) : [];
  const snippetRuns = await SnippetRunModel.findAll({
    where: { id: states.map(state => state.snippetRunId).filter(Boolean) as number[] }
  });
  const runs = await describeRuns(snippetRuns, true);
  const users = await UserModel.findAll({
    where: { id: states.map(state => state.completedBy).filter(Boolean) as number[] },
    attributes: ['id', 'displayName']
  });

  return {
    ...summary,
    steps: steps
      .filter(step => states.some(state => state.stepId === step.id))
      .map(step => {
        const state = states.find(item => item.stepId === step.id)!;

        return {
          ...step,
          status: state.status,
          completedAt: state.completedAt,
          completedBy: users.find(user => user.id === state.completedBy)?.displayName || null,
          lastRun: runs.find(item => item.id === state.snippetRunId) || null
        };
      })
  };
};

/**
 * @description One runbook run with each step's state and output
 * @route /api/runbooks/runs/:runId
 * @request GET
 */
export const getRunbookRun = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const run = await findVisibleRun(req, next);

    if (!run) {
      return;
    }

    res.status(200).json({ data: await runDetail(run) });
  }
);

const readVariables = (input: unknown): Record<string, string> => {
  const values: Record<string, string> = {};

  if (input && typeof input === 'object') {
    Object.entries(input as Record<string, unknown>).forEach(([name, value]) => {
      if (VARIABLE_NAME_PATTERN.test(name) && typeof value === 'string') {
        values[name] = value;
      }
    });
  }

  return values;
};

/**
 * @description Run, complete, skip, or reset one step. Steps of a run with a
 * device are queued for its agent and finish when it reports back.
 * @route /api/runbooks/runs/:runId/steps/:stepId
 * @request POST
 */
export const updateRunbookRunStep = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const run = await findVisibleRun(req, next);

    if (!run) {
      return;
    }

    if (run.status === 'cancelled') {
      return next(new ErrorResponse(409, 'This run was cancelled'));
    }

    const state = await RunbookRunStepModel.findOne({
      where: { runId: run.id, stepId: Number(req.params.stepId) || -1 }
    });
    const step = state && (await RunbookStepModel.findByPk(state.stepId));

    if (!state || !step) {
      return next(new ErrorResponse(404, 'Step was not found in this run'));
    }

    // Site access may have been removed since the run started
    const site = run.siteId ? await SiteModel.findByPk(run.siteId) : null;

    if (site && !(await canAccessSite(req.user || {}, site))) {
      return next(new ErrorResponse(404, 'Runbook run was not found'));
    }

    const action = String(req.body?.action || '');

    if (state.status === 'running' && action !== 'reset') {
      return next(new ErrorResponse(409, 'This step is waiting for its device'));
    }

    // A person taking over an unattended run that stopped for them
    if (run.status === 'attention') {
      await run.update({ status: 'in_progress' });
    }

    if (action === 'run') {
      try {
        const { queued } = await executeRunbookStep(run, step.id, {
          userId: req.user?.id,
          explicit: readVariables(req.body?.variables)
        });

        await auditLog('runbook.step_ran', {
          ...auditActor(req),
          target: `runbook:${run.runbookId}`,
          metadata: {
            runbook: run.runbookTitle,
            runId: run.id,
            step: step.title || step.snippetId,
            site: site?.name,
            queuedForDevice: queued
          }
        });
      } catch (err) {
        return next(new ErrorResponse(400, err instanceof Error ? err.message : 'Could not run step'));
      }
    } else if (action === 'done' || action === 'skip') {
      await state.update({
        status: action === 'done' ? 'done' : 'skipped',
        completedBy: req.user?.id || null,
        completedAt: new Date()
      });
      await afterRunbookStep(run, step.id);
    } else if (action === 'reset') {
      if (state.status === 'running') {
        // Stop waiting for a device that may never answer
        await AgentJobModel.update(
          { status: 'expired', finishedAt: new Date(), payload: '', secretValues: '' },
          { where: { runbookRunId: run.id, runbookStepId: step.id, status: 'queued' } }
        );
      }

      await state.update({ status: 'pending', completedBy: null, completedAt: null });
      await afterRunbookStep(run, step.id);
    } else {
      return next(new ErrorResponse(400, 'Action must be run, done, skip, or reset'));
    }

    const fresh = (await RunbookRunModel.findByPk(run.id)) || run;
    res.status(200).json({ data: await runDetail(fresh) });
  }
);

/**
 * @description Cancel a runbook run
 * @route /api/runbooks/runs/:runId/cancel
 * @request POST
 */
export const cancelRunbookRun = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const run = await findVisibleRun(req, next);

    if (!run) {
      return;
    }

    await run.update({ status: 'cancelled', completedAt: new Date() });
    await AgentJobModel.update(
      { status: 'expired', finishedAt: new Date(), payload: '', secretValues: '' },
      { where: { runbookRunId: run.id, status: 'queued' } }
    );

    await auditLog('runbook.run_cancelled', {
      ...auditActor(req),
      target: `runbook:${run.runbookId}`,
      metadata: { title: run.runbookTitle, runId: run.id }
    });

    res.status(200).json({ data: await runDetail(run) });
  }
);

/**
 * @description Flag a runbook as dangerous (its runs need approval).
 * Editors can set the flag; only admins can clear it.
 * @route /api/runbooks/:id/dangerous
 * @request PUT
 */
export const setRunbookDangerous = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const runbook = await findRunbook(req, next);

    if (!runbook) {
      return;
    }

    const dangerous = Boolean(req.body?.dangerous);
    if (!dangerous && runbook.dangerous && !isAdminRole(req.user?.role)) {
      return next(new ErrorResponse(403, 'Only admins can clear the dangerous flag'));
    }

    if (dangerous !== runbook.dangerous) {
      await runbook.update({ dangerous });
      await auditLog(dangerous ? 'runbook.flagged_dangerous' : 'runbook.unflagged_dangerous', {
        ...auditActor(req),
        target: `runbook:${runbook.id}`,
        metadata: { title: runbook.title }
      });
    }

    res.status(200).json({ data: { id: runbook.id, dangerous } });
  }
);

registerApprovalExecutor('runbook', async (approval, payload, requester) => {
  const { body } = await replayHandler(startRunbookRun, {
    params: { id: String(approval.runbookId) },
    body: payload,
    user: requester,
    approvalId: approval.id
  });
  return `Runbook run #${body?.data?.id} started`;
});
