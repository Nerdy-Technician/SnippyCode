import { Response, NextFunction } from 'express';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import { sequelize } from '../db';
import { AgentJobModel, DeviceModel, SiteModel, SnippetRunModel } from '../models';
import { AgentRequest } from './devices';
import {
  ErrorResponse,
  TerminalError,
  TerminalSession,
  assertOsUser,
  assertShell,
  auditLog,
  canAccessSite,
  deviceToolOs,
  exchangeTerminal,
  expireSessionIfNeeded,
  finishAgentJob,
  isAdminRole,
  markSessionClosed,
  noteSessionHeartbeat,
  noteSessionJobFinished,
  openTerminalSession as registerTerminalSession,
  pushTerminalInput,
  queuePtyJob,
  requestIp,
  requestTerminalClose,
  requestTerminalSignal,
  requestTerminalUser,
  sessionForDevice,
  sessionForJob,
  sessionJobFinished,
  sessionNeedsHeartbeat,
  setTerminalSize,
  sweepTerminalSessions,
  terminalSpec,
  terminalView,
  waitForTerminalOutput,
  wakeTerminalReaders
} from '../utils';

const shellRank: { [key: string]: number } = { viewer: 10, user: 20, editor: 30, admin: 40, owner: 50 };

const canShell = (role?: string): boolean => {
  if ((shellRank[role || ''] || 0) < shellRank.editor) return false;
  return isAdminRole(role) || process.env.DEVICE_SHELL_FOR_EDITORS === 'true';
};

const actor = (req: AuthenticatedRequest) => ({
  userId: req.user?.id || null,
  ipAddress: requestIp(req)
});

const loadDevice = async (req: AuthenticatedRequest, next: NextFunction) => {
  const device = await DeviceModel.findOne({ where: { id: Number(req.params.id) || -1, revokedAt: null } });
  const site = device ? await SiteModel.findByPk(device.siteId) : null;
  if (!device || !site || !(await canAccessSite(req.user || {}, site))) {
    next(new ErrorResponse(404, 'Device was not found'));
    return null;
  }
  return { device, site };
};

const requireShell = (req: AuthenticatedRequest, next: NextFunction): boolean => {
  if (!canShell(req.user?.role)) {
    next(new ErrorResponse(403, 'Only admins can use the device shell'));
    return false;
  }
  return true;
};

const opening = new Set<number>();

const finishSessionJob = async (session: TerminalSession, stderr = ''): Promise<void> => {
  if (sessionJobFinished(session)) return;
  noteSessionJobFinished(session);
  const job = await AgentJobModel.findByPk(session.jobId);
  if (!job) return;
  const code = session.exitCode;
  await finishAgentJob(job, {
    exitCode: code,
    stdout: `Interactive terminal (${session.shell}) as ${session.activeUser || session.user || 'the agent account'}.`,
    stderr: (stderr || session.message).slice(0, 2000),
    durationMs: Math.max(0, Date.now() - session.createdAt),
    status: code === null || code === 0 ? 'done' : 'failed'
  });
};

const syncSession = async (session: TerminalSession): Promise<void> => {
  const expired = expireSessionIfNeeded(session);
  if (expired) {
    await finishSessionJob(session, expired);
    return;
  }
  if (session.status !== 'starting') return;
  const job = await AgentJobModel.findByPk(session.jobId);
  if (!job || !['done', 'failed', 'expired'].includes(job.status)) return;
  const run = job.snippetRunId ? await SnippetRunModel.findByPk(job.snippetRunId) : null;
  markSessionClosed(session, (run?.stderr || run?.stdout || 'The device did not open the session.').slice(0, 500));
  noteSessionJobFinished(session);
};

const currentSession = async (deviceId: number): Promise<TerminalSession | null> => {
  const session = sessionForDevice(deviceId);
  if (!session) return null;
  await syncSession(session);
  return session.status === 'closed' ? null : session;
};

/**
 * @description The device's open terminal session, if there is one
 * @route /api/devices/:id/terminal/session
 * @request GET
 */
export const getTerminalSession = asyncWrapper(async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  const found = await loadDevice(req, next);
  if (!found || !requireShell(req, next)) return;

  sweepTerminalSessions();
  const session = await currentSession(found.device.id);
  if (!session) {
    res.status(200).json({ data: null });
    return;
  }

  setTerminalSize(session, req.query.cols, req.query.rows);
  const since = Number(req.query.since);
  const waitMs = Math.min(Math.max(Number(req.query.wait) || 0, 0), 8_000);
  let closed = false;
  req.on('close', () => {
    closed = true;
    wakeTerminalReaders(session);
  });
  const view = await waitForTerminalOutput(session, Number.isFinite(since) ? since : 0, closed ? 0 : waitMs);
  if (closed) return;
  res.status(200).json({ data: view });
});

/**
 * @description Open an interactive shell on the device, or attach to the one
 * already open. `user` is a local account (Linux, and only when the agent is
 * root). Windows always runs as the agent service account.
 * @route /api/devices/:id/terminal/session
 * @request POST
 */
export const openTerminalSession = asyncWrapper(async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  const found = await loadDevice(req, next);
  if (!found || !requireShell(req, next)) return;

  const os = deviceToolOs(found.device);
  if (!os) {
    return next(new ErrorResponse(400, 'Terminal sessions are available on Linux and Windows devices'));
  }

  const existing = await currentSession(found.device.id);
  if (existing) {
    res.status(200).json({ data: { ...terminalView(existing, Number(req.query.since) || 0), attached: true } });
    return;
  }

  let shell = 'bash';
  let user = '';
  try {
    shell = assertShell(req.body?.shell, os);
    user = assertOsUser(req.body?.user, os);
  } catch (err) {
    return next(new ErrorResponse(400, err instanceof TerminalError ? err.message : 'Could not open a session'));
  }

  if (opening.has(found.device.id)) {
    return next(new ErrorResponse(409, 'A terminal session is already opening'));
  }
  opening.add(found.device.id);

  const spec = terminalSpec(shell, user);
  let session: TerminalSession;
  let created = false;
  try {
    session = await sequelize.transaction(async transaction => {
      const again = sessionForDevice(found.device.id);
      if (again) return again;
      const job = await queuePtyJob({
        device: found.device,
        code: spec,
        title: `Terminal: ${user || 'agent account'} (${shell})`,
        userId: req.user?.id,
        transaction
      });
      created = true;
      // Registered before the transaction commits, so the agent cannot pick
      // the job up before the session exists.
      return registerTerminalSession({ deviceId: found.device.id, jobId: job.id, os, shell, user });
    });
  } catch (err) {
    return next(new ErrorResponse(400, err instanceof Error ? err.message : 'Could not open a session'));
  } finally {
    opening.delete(found.device.id);
  }

  if (!created) {
    res.status(200).json({ data: { ...terminalView(session, 0), attached: true } });
    return;
  }

  await auditLog('device.terminal_open', {
    ...actor(req),
    target: `device:${found.device.id}`,
    metadata: { device: found.device.name, site: found.site.name, shell, user: user || 'agent account', session: session.id }
  });

  res.status(201).json({ data: { ...terminalView(session, 0), attached: false } });
});

const ownedSession = async (req: AuthenticatedRequest, next: NextFunction): Promise<TerminalSession | null> => {
  const found = await loadDevice(req, next);
  if (!found || !requireShell(req, next)) return null;
  const session = await currentSession(found.device.id);
  if (!session) {
    next(new ErrorResponse(404, 'There is no open terminal session'));
    return null;
  }
  const claimed = String(req.body?.session || '');
  if (claimed && claimed !== session.id) {
    next(new ErrorResponse(409, 'This terminal session is no longer current. Reload it.'));
    return null;
  }
  return session;
};

/**
 * @description Keystrokes for the open session, including answers to prompts
 * @route /api/devices/:id/terminal/session/input
 * @request POST
 */
export const writeTerminalInput = asyncWrapper(async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  const session = await ownedSession(req, next);
  if (!session) return;
  try {
    pushTerminalInput(session, req.body?.data);
  } catch (err) {
    return next(new ErrorResponse(400, err instanceof TerminalError ? err.message : 'Could not send input'));
  }
  res.status(204).end();
});

/**
 * @description Interrupt or terminate the foreground process (Ctrl+C)
 * @route /api/devices/:id/terminal/session/signal
 * @request POST
 */
export const signalTerminalSession = asyncWrapper(async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  const session = await ownedSession(req, next);
  if (!session) return;
  try {
    requestTerminalSignal(session, req.body?.signal);
  } catch (err) {
    return next(new ErrorResponse(400, err instanceof TerminalError ? err.message : 'Could not signal the session'));
  }
  res.status(204).end();
});

/**
 * @description Switch the Linux shell to another local account. The agent
 * does this only when it is root. Windows is refused.
 * @route /api/devices/:id/terminal/session/user
 * @request POST
 */
export const switchTerminalUser = asyncWrapper(async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  const found = await loadDevice(req, next);
  if (!found || !requireShell(req, next)) return;
  const session = await currentSession(found.device.id);
  if (!session) {
    return next(new ErrorResponse(404, 'There is no open terminal session'));
  }
  if (req.body?.session && String(req.body.session) !== session.id) {
    return next(new ErrorResponse(409, 'This terminal session is no longer current. Reload it.'));
  }
  let user = '';
  try {
    user = requestTerminalUser(session, req.body?.user);
  } catch (err) {
    return next(new ErrorResponse(400, err instanceof TerminalError ? err.message : 'Could not switch user'));
  }
  await auditLog('device.terminal_switch', {
    ...actor(req),
    target: `device:${found.device.id}`,
    metadata: { device: found.device.name, from: session.activeUser || session.user || 'agent account', to: user, session: session.id }
  });
  res.status(202).json({ data: { user } });
});

/**
 * @description Close the session and the shell on the device
 * @route /api/devices/:id/terminal/session/close
 * @request POST
 */
export const closeTerminal = asyncWrapper(async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  const found = await loadDevice(req, next);
  if (!found || !requireShell(req, next)) return;
  const session = sessionForDevice(found.device.id);
  if (!session) {
    res.status(204).end();
    return;
  }
  if (req.body?.session && String(req.body.session) !== session.id) {
    return next(new ErrorResponse(409, 'This terminal session is no longer current. Reload it.'));
  }
  const wasStarting = session.status === 'starting';
  requestTerminalClose(session);
  if (wasStarting || session.status === 'closed') {
    await finishSessionJob(session, 'Session closed.');
    await auditLog('device.terminal_close', {
      ...actor(req),
      target: `device:${found.device.id}`,
      metadata: { device: found.device.name, session: session.id, shell: session.shell }
    });
  }
  res.status(204).end();
});

/**
 * @description Agent side of a pty session: upload output, receive input.
 * One-shot jobs do not call this.
 * @route /api/agent/jobs/:id/tty
 * @request POST
 */
export const exchangeAgentTerminal = asyncWrapper(async (req: AgentRequest, res: Response, next: NextFunction): Promise<void> => {
  const device = req.device!;
  const job = await AgentJobModel.findOne({ where: { id: Number(req.params.id) || -1, deviceId: device.id } });
  if (!job || job.language !== 'pty') {
    return next(new ErrorResponse(404, 'Terminal session was not found'));
  }

  const session = sessionForJob(job.id);
  if (!session || session.deviceId !== device.id) {
    if (['queued', 'running'].includes(job.status)) {
      await finishAgentJob(job, {
        exitCode: null,
        stdout: '',
        stderr: 'The terminal session is gone.',
        durationMs: 0,
        status: 'failed'
      });
    }
    res.status(200).json({ data: { input: '', signal: null, user: null, close: true, cols: 0, rows: 0 } });
    return;
  }

  const waitMs = Math.min(Math.max(Number(req.query.wait) || 0, 0), 2_000);
  const body = req.body || {};
  const instruction = await exchangeTerminal(
    session,
    {
      output: typeof body.output === 'string' ? body.output : '',
      user: typeof body.user === 'string' ? body.user : undefined,
      alive: body.alive !== false && body.alive !== 'false',
      privileged: typeof body.privileged === 'boolean' ? body.privileged : undefined,
      tty: typeof body.tty === 'boolean' ? body.tty : undefined,
      exitCode: body.exitCode === null || body.exitCode === undefined || body.exitCode === '' ? null : Number(body.exitCode),
      message: typeof body.message === 'string' ? body.message : ''
    },
    waitMs
  );

  if (session.status === 'closed') {
    await finishSessionJob(session);
  } else if (sessionNeedsHeartbeat(session)) {
    await AgentJobModel.update({ startedAt: new Date() }, { where: { id: job.id, status: 'running' } });
    noteSessionHeartbeat(session);
  }

  // Touch lastSeen so a long session does not look offline. Not on every chunk.
  if (Date.now() - new Date(device.lastSeenAt || 0).getTime() > 15_000) {
    await device.update({ lastSeenAt: new Date() });
  }
  res.status(200).json({ data: instruction });
});
