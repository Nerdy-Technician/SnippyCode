/**
 * Shared automation: queueing work for device agents, finishing jobs, running
 * runbook steps (by hand or unattended), and closing out schedule runs.
 */
import { Op } from 'sequelize';
import {
  AgentJobInstance,
  AgentJobModel,
  DeviceInstance,
  DeviceModel,
  RunbookRunInstance,
  RunbookRunModel,
  RunbookRunStepModel,
  RunbookStepModel,
  ScheduleModel,
  ScheduleRunModel,
  SiteModel,
  SnippetModel,
  SnippetRunInstance,
  SnippetRunModel,
  UserModel
} from '../models';
import { decryptSecret, encryptSecret, maskSecrets } from './secretBox';
import { renderSnippetFor, runAndRecord } from './snippetRender';
import { isSnippetRunEnabled, snippetRunLanguages } from './runSnippet';
import { emitEvent } from './notify';
import { recordSnippetUsage } from './snippetUsage';
import { deviceVariableValues } from './deviceFields';
import {
  READ_TOOLS,
  ReadTool,
  ToolId,
  ToolOs,
  buildToolScript,
  deviceToolOs,
  parseFileList,
  parseToolOutput,
  toolTimeoutMs
} from './deviceTools';

// Devices ------------------------------------------------------------------

/** Agents poll every ~25s; a device is online if seen within 90s. */
export const DEVICE_ONLINE_MS = 90_000;
/** Jobs a device has not collected within this long are expired. */
export const JOB_QUEUE_TTL_MS = 15 * 60_000;
export const AGENT_MAX_TIMEOUT_MS = 30 * 60_000;

export const isDeviceOnline = (device: { lastSeenAt: Date | null }, now = Date.now()): boolean =>
  Boolean(device.lastSeenAt && now - new Date(device.lastSeenAt).getTime() < DEVICE_ONLINE_MS);

const agentTimeoutMs = (): number =>
  Math.min(
    Math.max(Number(process.env.AGENT_RUN_TIMEOUT_MS) || 5 * 60_000, 5000),
    AGENT_MAX_TIMEOUT_MS
  );

// Events -------------------------------------------------------------------

const tail = (text: string, length = 600): string =>
  text.length > length ? `…${text.slice(-length)}` : text;

/**
 * Announce a finished run, unless a schedule will report it as part of its
 * summary.
 */
export const announceRun = async (run: SnippetRunInstance): Promise<void> => {
  if (run.scheduleRunId) {
    return;
  }

  const [site, user] = await Promise.all([
    run.siteId ? SiteModel.findByPk(run.siteId) : null,
    run.userId ? UserModel.findByPk(run.userId) : null
  ]);
  const where = [site?.name, run.deviceName].filter(Boolean).join(' / ') || 'SnippyCode server';

  emitEvent({
    event: run.ok ? 'run.succeeded' : 'run.failed',
    severity: run.ok ? 'success' : 'error',
    title: `${run.snippetTitle} ${run.ok ? 'succeeded' : run.timedOut ? 'timed out' : 'failed'} on ${where}`,
    text: run.ok ? tail(run.stdout || '(no output)') : tail(run.stderr || run.stdout || '(no output)'),
    siteId: run.siteId,
    path: run.snippetId ? `/snippet/${run.snippetId}` : undefined,
    fields: [
      { label: 'Exit code', value: run.timedOut ? 'timed out' : String(run.exitCode) },
      { label: 'Duration', value: `${(run.durationMs / 1000).toFixed(1)}s` },
      { label: 'By', value: user?.displayName || 'SnippyCode' }
    ],
    data: { runId: run.id, snippetId: run.snippetId, siteId: run.siteId, deviceId: run.deviceId }
  });
};

// Agent jobs ---------------------------------------------------------------

export const queueAgentJob = async (options: {
  device: DeviceInstance;
  snippet: { id: number; title: string; language: string };
  code: string;
  secretValues: string[];
  userId?: number | null;
  runbookRunId?: number | null;
  runbookStepId?: number | null;
  scheduleRunId?: number | null;
}): Promise<AgentJobInstance> => {
  // Backstop: a clone waiting for approval never gets code or secrets
  if (options.device.clonePendingApproval) {
    throw new Error(`${options.device.name} is waiting for clone approval`);
  }
  return AgentJobModel.create({
    deviceId: options.device.id,
    siteId: options.device.siteId,
    snippetId: options.snippet.id,
    snippetTitle: options.snippet.title,
    userId: options.userId || null,
    language: options.snippet.language.toLowerCase(),
    // The rendered code carries secret values, so it is stored encrypted
    payload: encryptSecret(options.code),
    secretValues: options.secretValues.length
      ? encryptSecret(JSON.stringify(options.secretValues))
      : '',
    timeoutMs: agentTimeoutMs(),
    runbookRunId: options.runbookRunId || null,
    runbookStepId: options.runbookStepId || null,
    scheduleRunId: options.scheduleRunId || null
  });
};

/**
 * Queue a built-in tool (services, tasks, shell...) for a device.
 */
export const queueToolJob = async (options: {
  device: DeviceInstance;
  tool: ToolId;
  args?: Record<string, unknown>;
  userId?: number | null;
}): Promise<AgentJobInstance> => {
  if (options.device.clonePendingApproval) {
    throw new Error(`${options.device.name} is waiting for clone approval`);
  }
  const os = deviceToolOs(options.device);

  if (!os) {
    throw new Error('Device tools are available on Linux and Windows devices');
  }

  const plan = buildToolScript(options.tool, os, options.args || {});

  return AgentJobModel.create({
    deviceId: options.device.id,
    siteId: options.device.siteId,
    snippetId: null,
    snippetTitle: plan.title.slice(0, 255),
    userId: options.userId || null,
    language: plan.language,
    payload: encryptSecret(plan.code),
    secretValues: '',
    timeoutMs: options.tool === 'shell' ? agentTimeoutMs() : toolTimeoutMs(options.tool),
    kind: 'tool',
    tool: options.tool
  });
};

const summarize = (tool: ReadTool, data: any): string => {
  const count = (items: unknown) => (Array.isArray(items) ? items.length : 0);
  switch (tool) {
    case 'system':
      return `${data?.os || 'System'} · ${count(data?.disks)} disks · ${count(data?.networks)} networks`;
    case 'updates':
      return `${count(data?.updates)} updates pending${data?.reboot ? ' · reboot required' : ''}`;
    default:
      return `${count(data)} ${tool}`;
  }
};

/**
 * Keep the parsed result of a read-only tool on the device, so its page
 * opens with the last known state.
 */
const storeInventory = async (
  job: AgentJobInstance,
  result: { stdout: string; stderr: string; exitCode: number | null }
): Promise<string> => {
  const tool = job.tool as ReadTool;
  const device = await DeviceModel.findByPk(job.deviceId);
  const os = device && deviceToolOs(device);

  if (!device || !os) {
    return result.stdout;
  }

  let inventory: Record<string, unknown> = {};
  try {
    inventory = JSON.parse(device.inventory || '{}');
  } catch {
    inventory = {};
  }

  try {
    const data = parseToolOutput(tool, os as ToolOs, result.stdout);
    inventory[tool] = { at: new Date().toISOString(), data, error: result.exitCode === 0 ? null : result.stderr.slice(0, 500) || null };
    await device.update({ inventory: JSON.stringify(inventory) });
    return summarize(tool, data);
  } catch (err) {
    inventory[tool] = {
      ...(inventory[tool] as object),
      at: new Date().toISOString(),
      error: `Could not read the device's answer: ${err instanceof Error ? err.message : err}. ${result.stderr.slice(0, 300)}`
    };
    await device.update({ inventory: JSON.stringify(inventory) });
    return result.stdout.slice(0, 2000);
  }
};

// Downloaded files wait here briefly for the browser to collect them; they
// are too large for run history and should not be kept.
const downloads = new Map<number, { content: string; expires: number }>();

export const takeDownload = (jobId: number): string | null => {
  const now = Date.now();
  downloads.forEach((value, key) => value.expires < now && downloads.delete(key));
  const entry = downloads.get(jobId);
  return entry ? entry.content : null;
};

const jobSecrets = (job: AgentJobInstance): string[] => {
  try {
    return job.secretValues ? JSON.parse(decryptSecret(job.secretValues)) : [];
  } catch {
    return [];
  }
};

/**
 * Record what came back from a device (or why nothing did) and move any
 * runbook or schedule it belongs to along.
 */
export const finishAgentJob = async (
  job: AgentJobInstance,
  result: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut?: boolean;
    status?: 'done' | 'failed' | 'expired';
  }
): Promise<SnippetRunInstance | null> => {
  // Only one result per job, even if an agent retries the upload
  const [claimed] = await AgentJobModel.update(
    { status: result.status || (result.exitCode === 0 ? 'done' : 'failed'), finishedAt: new Date() },
    { where: { id: job.id, status: { [Op.in]: ['queued', 'running'] } } }
  );

  if (!claimed) {
    return null;
  }

  const device = await DeviceModel.findByPk(job.deviceId);
  const secrets = jobSecrets(job);
  const ok = !result.timedOut && result.exitCode === 0 && result.status !== 'expired';
  const readTool = job.kind === 'tool' && (READ_TOOLS as string[]).includes(job.tool || '');

  // Read-only tools: parse the full answer and keep a one-line summary
  let stdout =
    readTool && result.status !== 'expired' ? await storeInventory(job, result) : result.stdout;

  if (job.tool === 'fileget' && ok) {
    downloads.set(job.id, { content: result.stdout.trim(), expires: Date.now() + 10 * 60_000 });
    stdout = `Downloaded ${Math.round((result.stdout.trim().length * 3) / 4 / 1024)} KB`;
  }

  // Folder listings can be long; hand them to the browser parsed, not as history
  if (job.tool === 'files' && ok && device) {
    try {
      const entries = parseFileList(deviceToolOs(device) as ToolOs, result.stdout);
      downloads.set(job.id, { content: JSON.stringify(entries), expires: Date.now() + 10 * 60_000 });
      stdout = `${entries.length} item${entries.length === 1 ? '' : 's'}`;
    } catch (err) {
      stdout = `Could not read the listing: ${err instanceof Error ? err.message : err}\n${result.stdout.slice(0, 2000)}`;
    }
  }
  const run = await SnippetRunModel.create({
    snippetId: job.snippetId,
    snippetTitle: job.snippetTitle,
    siteId: job.siteId,
    userId: job.userId,
    runbookRunId: job.runbookRunId,
    scheduleRunId: job.scheduleRunId,
    deviceId: job.deviceId,
    deviceName: device?.name || null,
    language: job.language,
    ok,
    exitCode: result.exitCode,
    timedOut: Boolean(result.timedOut),
    stdout: maskSecrets(stdout.slice(0, 64_000), secrets),
    stderr: maskSecrets(result.stderr.slice(0, 64_000), secrets),
    durationMs: Math.max(0, Math.round(result.durationMs || 0)),
    sandbox: 'device',
    kind: job.kind || 'snippet'
  });

  // The code is no longer needed once it has run
  await AgentJobModel.update({ snippetRunId: run.id, payload: '', secretValues: '' }, { where: { id: job.id } });

  if (job.snippetId) {
    recordSnippetUsage(job.snippetId, 'run', job.userId).catch(() => undefined);
  }

  if (job.runbookRunId && job.runbookStepId) {
    await RunbookRunStepModel.update(
      {
        status: ok ? 'done' : 'failed',
        snippetRunId: run.id,
        completedAt: new Date()
      },
      { where: { runId: job.runbookRunId, stepId: job.runbookStepId } }
    );
    const runbookRun = await RunbookRunModel.findByPk(job.runbookRunId);

    if (runbookRun) {
      await afterRunbookStep(runbookRun, job.runbookStepId);
    }
  } else if (job.scheduleRunId) {
    await checkScheduleRun(job.scheduleRunId);
  }

  // Patching results matter to people; other tool runs are routine
  if (!job.runbookRunId && (job.kind !== 'tool' || job.tool === 'patch')) {
    await announceRun(run);
  }

  return run;
};

/**
 * Expire jobs no device collected, and jobs whose device never reported back.
 */
export const expireStaleJobs = async (now = Date.now()): Promise<number> => {
  const stale = await AgentJobModel.findAll({
    where: {
      [Op.or]: [
        { status: 'queued', createdAt: { [Op.lt]: new Date(now - JOB_QUEUE_TTL_MS) } },
        { status: 'running', startedAt: { [Op.lt]: new Date(now - AGENT_MAX_TIMEOUT_MS - 120_000) } }
      ]
    }
  });

  for (const job of stale) {
    await finishAgentJob(job, {
      exitCode: null,
      stdout: '',
      stderr:
        job.status === 'queued'
          ? 'The device did not collect this job in time. Is the agent running?'
          : 'The device started this job but never reported a result.',
      durationMs: 0,
      status: 'expired'
    });
  }

  return stale.length;
};

// Runbooks -----------------------------------------------------------------

const canServerRun = (language: string): boolean =>
  isSnippetRunEnabled() && snippetRunLanguages().includes(language.toLowerCase());

/**
 * Run one step: on the run's device if it has one, otherwise on the server.
 * Device steps finish later, when the agent reports back.
 */
/** Replace only the placeholders a step sets; everything else is filled later as usual */
const applyStepValues = (code: string, values: Record<string, string>): string =>
  Object.keys(values).length
    ? code.replace(/(\$?)\{\{([A-Z][A-Z0-9_]{0,63})(?::[^}\n]*)?\}\}/g, (whole, dollar, name) =>
        !dollar && values[name] !== undefined ? values[name] : whole
      )
    : code;

export const executeRunbookStep = async (
  run: RunbookRunInstance,
  stepId: number,
  options: { userId?: number | null; explicit?: Record<string, string> } = {}
): Promise<{ queued: boolean }> => {
  const step = await RunbookStepModel.findByPk(stepId);
  const snippet = step?.snippetId ? await SnippetModel.findByPk(step.snippetId) : null;

  if (!step || !snippet) {
    throw new Error('This step has no snippet to run');
  }

  const device = run.deviceId ? await DeviceModel.findByPk(run.deviceId) : null;

  if (run.deviceId && (!device || device.revokedAt)) {
    throw new Error('The device for this run is no longer enrolled');
  }

  if (!device && !canServerRun(snippet.language)) {
    throw new Error(
      isSnippetRunEnabled()
        ? `The server cannot run ${snippet.language}`
        : 'Server runs are disabled. Set SNIPPET_RUN_ENABLED=true.'
    );
  }

  const site = run.siteId ? await SiteModel.findByPk(run.siteId) : null;
  // Step values are applied first; a value can pass another one through,
  // e.g. {{SITE_SHARE}}, which is then filled like any other placeholder
  const stepValues = Object.fromEntries(
    Object.entries(step.values || {}).filter(([name]) => !(options.explicit && name in options.explicit))
  );
  const rendered = await renderSnippetFor({
    code: applyStepValues(snippet.code, stepValues),
    definitions: snippet.variables,
    userId: options.userId,
    siteId: run.siteId,
    explicit: options.explicit,
    deviceValues: device ? deviceVariableValues(device, site?.name) : undefined,
    includeSecrets: true
  });

  if (rendered.errors.length || rendered.missingRequired.length) {
    throw new Error(
      [...rendered.errors, ...rendered.missingRequired.map(name => `${name} needs a value`)].join('; ')
    );
  }

  if (device) {
    await queueAgentJob({
      device,
      snippet,
      code: rendered.code,
      secretValues: rendered.secretValues,
      userId: options.userId,
      runbookRunId: run.id,
      runbookStepId: step.id,
      scheduleRunId: run.scheduleRunId
    });
    await RunbookRunStepModel.update(
      { status: 'running', completedBy: options.userId || null, completedAt: null, snippetRunId: null },
      { where: { runId: run.id, stepId: step.id } }
    );

    return { queued: true };
  }

  const snippetRun = await runAndRecord({
    snippet,
    code: rendered.code,
    secretValues: rendered.secretValues,
    siteId: run.siteId,
    userId: options.userId,
    runbookRunId: run.id
  });
  if (run.scheduleRunId) {
    await snippetRun.update({ scheduleRunId: run.scheduleRunId });
  }
  recordSnippetUsage(snippet.id, 'run', options.userId).catch(() => undefined);

  await RunbookRunStepModel.update(
    {
      status: snippetRun.ok ? 'done' : 'failed',
      snippetRunId: snippetRun.id,
      completedBy: options.userId || null,
      completedAt: new Date()
    },
    { where: { runId: run.id, stepId: step.id } }
  );
  await afterRunbookStep(run, step.id);

  return { queued: false };
};

const runbookLabel = async (run: RunbookRunInstance) => {
  const [site, device] = await Promise.all([
    run.siteId ? SiteModel.findByPk(run.siteId) : null,
    run.deviceId ? DeviceModel.findByPk(run.deviceId) : null
  ]);

  return [site?.name, device?.name].filter(Boolean).join(' / ') || 'team values';
};

/**
 * After a step changes: finish the run if everything is done, report
 * failures, and for unattended runs start the next step.
 */
export const afterRunbookStep = async (
  input: RunbookRunInstance,
  changedStepId?: number
): Promise<void> => {
  const run = (await RunbookRunModel.findByPk(input.id)) || input;
  const steps = await RunbookStepModel.findAll({
    where: { runbookId: run.runbookId || -1 },
    order: [['position', 'ASC']]
  });
  const states = await RunbookRunStepModel.findAll({ where: { runId: run.id } });
  const ordered = steps
    .map(step => ({ step, state: states.find(state => state.stepId === step.id) }))
    .filter(item => item.state);
  const changed = ordered.find(item => item.step.id === changedStepId);
  const unattended = Boolean(run.scheduleRunId);
  const label = await runbookLabel(run);

  if (changed?.state?.status === 'failed') {
    emitEvent({
      event: 'runbook.failed',
      severity: 'error',
      title: `${run.runbookTitle}: "${changed.step.title || 'step'}" failed on ${label}`,
      text: unattended ? 'The scheduled runbook stopped at this step.' : 'Open the run to retry or skip the step.',
      siteId: run.siteId,
      path: `/runbooks/runs/${run.id}`,
      data: { runbookRunId: run.id, stepId: changed.step.id }
    });

    if (unattended) {
      await run.update({ status: 'failed', completedAt: new Date() });
      await checkScheduleRun(run.scheduleRunId!);
      return;
    }
  }

  const finished = ordered.every(
    item => item.state!.status === 'done' || item.state!.status === 'skipped'
  );

  if (finished) {
    if (run.status !== 'completed') {
      await run.update({ status: 'completed', completedAt: new Date() });
      emitEvent({
        event: 'runbook.completed',
        severity: 'success',
        title: `${run.runbookTitle} finished on ${label}`,
        text: `${ordered.length} steps done.`,
        siteId: run.siteId,
        path: `/runbooks/runs/${run.id}`,
        data: { runbookRunId: run.id }
      });
    }
  } else if (run.status === 'completed') {
    await run.update({ status: 'in_progress', completedAt: null });
  }

  if (unattended && !finished && run.status === 'in_progress') {
    const busy = ordered.some(item => item.state!.status === 'running');
    const next = ordered.find(item => item.state!.status === 'pending');

    if (!busy && next) {
      const snippet = next.step.snippetId ? await SnippetModel.findByPk(next.step.snippetId) : null;
      const runnable = snippet && (run.deviceId || canServerRun(snippet.language));

      if (!runnable) {
        // A manual step (or one the server cannot run) needs a person
        await run.update({ status: 'attention' });
        emitEvent({
          event: 'runbook.attention',
          severity: 'warning',
          title: `${run.runbookTitle} on ${label} is waiting for a person`,
          text: `Step "${next.step.title || snippet?.title || 'manual step'}" cannot run on its own.`,
          siteId: run.siteId,
          path: `/runbooks/runs/${run.id}`,
          data: { runbookRunId: run.id, stepId: next.step.id }
        });
      } else {
        try {
          await executeRunbookStep(run, next.step.id, { userId: run.userId });
          return;
        } catch (err) {
          await RunbookRunStepModel.update(
            { status: 'failed', completedAt: new Date() },
            { where: { runId: run.id, stepId: next.step.id } }
          );
          return afterRunbookStep(run, next.step.id);
        }
      }
    }
  }

  // Completed, failed or waiting for a person: let the schedule run tally up
  if (run.scheduleRunId && run.status !== 'in_progress') {
    await checkScheduleRun(run.scheduleRunId);
  }
};

/** Start a runbook run and (for unattended runs) its first step. */
export const startRunbookRun = async (options: {
  runbook: { id: number; title: string };
  siteId: number | null;
  deviceId?: number | null;
  userId: number | null;
  scheduleRunId?: number | null;
}): Promise<RunbookRunInstance> => {
  const steps = await RunbookStepModel.findAll({ where: { runbookId: options.runbook.id } });

  if (!steps.length) {
    throw new Error('Add at least one step before starting');
  }

  const run = await RunbookRunModel.create({
    runbookId: options.runbook.id,
    runbookTitle: options.runbook.title,
    siteId: options.siteId,
    deviceId: options.deviceId || null,
    userId: options.userId,
    scheduleRunId: options.scheduleRunId || null
  });
  await RunbookRunStepModel.bulkCreate(steps.map(step => ({ runId: run.id, stepId: step.id })));

  if (run.scheduleRunId) {
    await afterRunbookStep(run);
  }

  return run;
};

// Schedule runs ------------------------------------------------------------

/**
 * Close a schedule run once nothing is pending, then notify.
 */
export const checkScheduleRun = async (scheduleRunId: number): Promise<void> => {
  const scheduleRun = await ScheduleRunModel.findByPk(scheduleRunId);

  if (!scheduleRun || scheduleRun.status !== 'running') {
    return;
  }

  const [pendingJobs, runbookRuns, runs] = await Promise.all([
    AgentJobModel.count({
      where: { scheduleRunId, status: { [Op.in]: ['queued', 'running'] }, runbookRunId: null }
    }),
    RunbookRunModel.findAll({ where: { scheduleRunId } }),
    SnippetRunModel.findAll({ where: { scheduleRunId, runbookRunId: null } })
  ]);

  if (pendingJobs || runbookRuns.some(run => run.status === 'in_progress')) {
    return;
  }

  const failedRuns = runs.filter(run => !run.ok);
  const failedBooks = runbookRuns.filter(run => run.status === 'failed' || run.status === 'cancelled');
  const attention = runbookRuns.filter(run => run.status === 'attention');
  const status =
    failedRuns.length || failedBooks.length ? 'failed' : attention.length ? 'attention' : 'succeeded';

  // Guard against two finishers racing
  const [updated] = await ScheduleRunModel.update(
    { status, finishedAt: new Date() },
    { where: { id: scheduleRunId, status: 'running' } }
  );

  if (!updated) {
    return;
  }

  const schedule = await ScheduleModel.findByPk(scheduleRun.scheduleId);
  await schedule?.update({ lastStatus: status });

  const shouldNotify =
    schedule &&
    (schedule.notifyOn === 'always' || (schedule.notifyOn === 'failure' && status !== 'succeeded'));

  if (!shouldNotify) {
    return;
  }

  const sites = await SiteModel.findAll({
    where: {
      id: Array.from(
        new Set([...runs, ...runbookRuns].map(run => run.siteId).filter(Boolean) as number[])
      )
    }
  });
  const siteName = (id: number | null) => sites.find(site => site.id === id)?.name || 'No site';
  const lines = [
    ...runs.map(
      run =>
        `${run.ok ? '✅' : '❌'} ${siteName(run.siteId)}${run.deviceName ? ` / ${run.deviceName}` : ''}: ${
          run.ok ? 'ok' : run.timedOut ? 'timed out' : `exit ${run.exitCode ?? '—'}`
        }`
    ),
    ...runbookRuns.map(
      run =>
        `${run.status === 'completed' ? '✅' : run.status === 'attention' ? '⚠️' : '❌'} ${siteName(run.siteId)}: runbook ${run.status.replace('_', ' ')}`
    )
  ];
  const total = runs.length + runbookRuns.length;
  const bad = failedRuns.length + failedBooks.length;

  emitEvent({
    event: status === 'succeeded' ? 'schedule.succeeded' : 'schedule.failed',
    severity: status === 'succeeded' ? 'success' : status === 'attention' ? 'warning' : 'error',
    title:
      status === 'succeeded'
        ? `${scheduleRun.scheduleName}: all ${total} targets succeeded`
        : status === 'attention'
        ? `${scheduleRun.scheduleName}: ${attention.length} of ${total} need a person`
        : `${scheduleRun.scheduleName}: ${bad} of ${total} failed`,
    text: lines.slice(0, 40).join('\n') || 'Nothing ran.',
    siteId: sites.length === 1 ? sites[0].id : null,
    path: `/schedules/${scheduleRun.scheduleId}`,
    data: { scheduleId: scheduleRun.scheduleId, scheduleRunId, status }
  });
};
