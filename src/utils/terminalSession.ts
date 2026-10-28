/**
 * Live terminal sessions between a browser and a device agent.
 *
 * One-shot shell jobs are unchanged: the agent still runs them with stdin
 * closed. A session is a separate job (language "pty") whose bytes live only
 * in memory. Keystrokes are not written to the audit log.
 */
import { randomBytes } from 'crypto';
import { ToolOs } from './deviceTools';

export const PTY_CAPABILITY = 'pty';
export const TERMINAL_IDLE_MS = 15 * 60_000;
export const TERMINAL_MAX_MS = 4 * 60 * 60_000;
export const TERMINAL_OUTPUT_CAP = 400_000;
const INPUT_CAP = 64_000;
const INPUT_POST_CAP = 16_000;
const OUTPUT_POST_CAP = 256_000;
const AGENT_SILENCE_MS = 25_000;

export class TerminalError extends Error {}

export type TerminalSignal = 'INT' | 'TERM';
export type TerminalStatus = 'starting' | 'open' | 'closed';

export interface AgentUpdate {
  output?: string;
  user?: string;
  alive?: boolean;
  privileged?: boolean;
  tty?: boolean;
  exitCode?: number | null;
  message?: string;
}

export interface AgentInstruction {
  input: string;
  signal: TerminalSignal | null;
  user: string | null;
  close: boolean;
  cols: number;
  rows: number;
}

export interface TerminalSession {
  id: string;
  deviceId: number;
  jobId: number;
  os: ToolOs;
  shell: string;
  user: string;
  activeUser: string;
  privileged: boolean | null;
  tty: boolean | null;
  /** Raw PTY bytes, possibly trimmed from the front */
  output: string;
  /** Absolute offset of output[0] in the session stream */
  base: number;
  pendingInput: string;
  signal: TerminalSignal | null;
  switchUser: string | null;
  cols: number;
  rows: number;
  createdAt: number;
  lastInputAt: number;
  lastOutputAt: number;
  lastAgentAt: number;
  lastHeartbeat: number;
  status: TerminalStatus;
  close: boolean;
  exitCode: number | null;
  message: string;
  jobFinished: boolean;
  agentWaiters: Array<() => void>;
  outputWaiters: Array<() => void>;
}

const byId = new Map<string, TerminalSession>();
const byJob = new Map<number, TerminalSession>();
const byDevice = new Map<number, string>();

const OS_USER = /^[a-z_][a-z0-9_.-]{0,31}$/;
// Windows account names: no \ / [ ] : ; | = , + * ? < > " @ and not only dots/spaces.
const WINDOWS_USER = /^[A-Za-z0-9_][A-Za-z0-9_. $'-]{0,63}$/;

const validUser = (user: string, os: ToolOs): boolean =>
  os === 'windows' ? WINDOWS_USER.test(user) && !user.endsWith('.') : OS_USER.test(user);

export const resetTerminalSessions = (): void => {
  byId.clear();
  byJob.clear();
  byDevice.clear();
};

export const assertOsUser = (user: unknown, os: ToolOs): string => {
  const trimmed = String(user || '').trim();
  if (!trimmed) {
    return '';
  }
  if (os === 'windows') {
    if (!validUser(trimmed, os)) {
      throw new TerminalError('Enter a Windows account name (letters, digits, spaces, _, . and -).');
    }
    return trimmed;
  }
  if (!OS_USER.test(trimmed) || trimmed.includes('..') || trimmed.startsWith('.') || trimmed.startsWith('-')) {
    throw new TerminalError('Enter a local account name using letters, digits, _, . and -.');
  }
  return trimmed;
};

export const assertShell = (shell: unknown, os: ToolOs): string => {
  const value = String(shell || (os === 'windows' ? 'powershell' : 'bash'));
  const allowed = os === 'windows' ? ['powershell', 'cmd'] : ['bash', 'sh'];
  if (!allowed.includes(value)) {
    throw new TerminalError('Unknown shell');
  }
  return value;
};

/** Spec file the agent parses. Values are already allow-listed. */
export const terminalSpec = (shell: string, user: string): string => `v=1\nshell=${shell}\nuser=${user}\n`;

const wake = (waiters: Array<() => void>): void => {
  waiters.splice(0).forEach(fn => fn());
};

/** Release browser polls that are waiting for output (client disconnected). */
export const wakeTerminalReaders = (session: TerminalSession): void => {
  wake(session.outputWaiters);
};

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

export const sessionForDevice = (deviceId: number): TerminalSession | null => {
  const id = byDevice.get(deviceId);
  const session = id ? byId.get(id) : undefined;
  return session && session.status !== 'closed' ? session : null;
};

export const sessionForJob = (jobId: number): TerminalSession | null => byJob.get(jobId) || null;

export const openTerminalSession = (options: {
  deviceId: number;
  jobId: number;
  os: ToolOs;
  shell: string;
  user: string;
}): TerminalSession => {
  const existing = sessionForDevice(options.deviceId);
  if (existing) {
    return existing;
  }
  const now = Date.now();
  const session: TerminalSession = {
    id: randomBytes(16).toString('base64url'),
    deviceId: options.deviceId,
    jobId: options.jobId,
    os: options.os,
    shell: options.shell,
    user: options.user,
    activeUser: options.user,
    privileged: null,
    tty: null,
    output: '',
    base: 0,
    pendingInput: '',
    signal: null,
    switchUser: null,
    cols: 100,
    rows: 32,
    createdAt: now,
    lastInputAt: now,
    lastOutputAt: now,
    lastAgentAt: 0,
    lastHeartbeat: 0,
    status: 'starting',
    close: false,
    exitCode: null,
    message: '',
    jobFinished: false,
    agentWaiters: [],
    outputWaiters: []
  };
  byId.set(session.id, session);
  byJob.set(session.jobId, session);
  byDevice.set(session.deviceId, session.id);
  return session;
};

const appendOutput = (session: TerminalSession, text: string): void => {
  if (!text) return;
  session.output += text;
  session.lastOutputAt = Date.now();
  if (session.output.length > TERMINAL_OUTPUT_CAP) {
    const extra = session.output.length - TERMINAL_OUTPUT_CAP;
    session.output = session.output.slice(extra);
    session.base += extra;
  }
  wake(session.outputWaiters);
};

export const markSessionClosed = (session: TerminalSession, message: string, exitCode: number | null = null): void => {
  if (session.status === 'closed') {
    if (message && !session.message) session.message = message;
    return;
  }
  session.status = 'closed';
  session.close = true;
  session.exitCode = exitCode;
  session.message = message;
  if (message) {
    appendOutput(session, `\r\n${message}\r\n`);
  }
  wake(session.agentWaiters);
  wake(session.outputWaiters);
};

/**
 * Close a session that has been idle, has hit the time limit, or whose agent
 * has gone quiet. Returns a message when this call is the one that closed it.
 */
export const expireSessionIfNeeded = (session: TerminalSession, now = Date.now()): string | null => {
  if (session.status === 'closed') return null;
  if (now - session.createdAt > TERMINAL_MAX_MS) {
    const message = 'The session reached the 4 hour limit.';
    markSessionClosed(session, message);
    return message;
  }
  if (session.status === 'open') {
    const activity = Math.max(session.lastInputAt, session.lastOutputAt);
    if (now - activity > TERMINAL_IDLE_MS) {
      const message = 'The session was closed after 15 minutes with nothing typed and no output.';
      markSessionClosed(session, message);
      return message;
    }
    if (session.lastAgentAt && now - session.lastAgentAt > AGENT_SILENCE_MS) {
      const message = 'The agent stopped answering. The session was closed.';
      markSessionClosed(session, message);
      return message;
    }
  }
  return null;
};

export const pushTerminalInput = (session: TerminalSession, data: unknown): void => {
  if (session.status === 'closed' || session.close) {
    throw new TerminalError('This session is closed.');
  }
  const text = String(data ?? '');
  if (!text) return;
  if (text.length > INPUT_POST_CAP) {
    throw new TerminalError('That input is too large.');
  }
  if (session.pendingInput.length + text.length > INPUT_CAP) {
    throw new TerminalError('The session is still catching up. Wait a moment and try again.');
  }
  session.pendingInput += text;
  session.lastInputAt = Date.now();
  wake(session.agentWaiters);
};

export const requestTerminalSignal = (session: TerminalSession, signal: unknown): void => {
  if (session.status === 'closed') {
    throw new TerminalError('This session is closed.');
  }
  if (signal !== 'INT' && signal !== 'TERM') {
    throw new TerminalError('Unknown signal');
  }
  session.signal = signal;
  session.lastInputAt = Date.now();
  wake(session.agentWaiters);
};

export const requestTerminalUser = (session: TerminalSession, user: unknown): string => {
  const next = assertOsUser(user, session.os);
  if (!next) {
    throw new TerminalError('Enter the account to switch to.');
  }
  if (session.status === 'closed') {
    throw new TerminalError('This session is closed.');
  }
  session.switchUser = next;
  session.lastInputAt = Date.now();
  wake(session.agentWaiters);
  return next;
};

export const requestTerminalClose = (session: TerminalSession): void => {
  session.close = true;
  if (session.status === 'starting') {
    markSessionClosed(session, 'Session closed before the device connected.');
    return;
  }
  wake(session.agentWaiters);
};

export const setTerminalSize = (session: TerminalSession, cols: unknown, rows: unknown): void => {
  session.cols = clamp(cols, 20, 400, session.cols);
  session.rows = clamp(rows, 5, 200, session.rows);
};

export interface TerminalView {
  id: string;
  deviceId: number;
  jobId: number;
  status: TerminalStatus;
  os: ToolOs;
  shell: string;
  user: string;
  activeUser: string;
  privileged: boolean | null;
  tty: boolean | null;
  canSwitchUser: boolean;
  output: string;
  next: number;
  reset: boolean;
  exitCode: number | null;
  message: string;
  closing: boolean;
}

export const readTerminalOutput = (session: TerminalSession, since: number): { output: string; next: number; reset: boolean } => {
  const next = session.base + session.output.length;
  if (!Number.isFinite(since) || since < session.base || since > next) {
    return { output: session.output, next, reset: true };
  }
  return { output: session.output.slice(since - session.base), next, reset: false };
};

export const terminalView = (session: TerminalSession, since: number): TerminalView => {
  const output = readTerminalOutput(session, since);
  return {
    id: session.id,
    deviceId: session.deviceId,
    jobId: session.jobId,
    status: session.status,
    os: session.os,
    shell: session.shell,
    user: session.user,
    activeUser: session.activeUser,
    privileged: session.privileged,
    tty: session.tty,
    canSwitchUser: session.status !== 'closed',
    output: output.output,
    next: output.next,
    reset: output.reset,
    exitCode: session.exitCode,
    message: session.message,
    closing: session.close && session.status !== 'closed'
  };
};

export const waitForTerminalOutput = (session: TerminalSession, since: number, waitMs: number): Promise<TerminalView> => {
  const ready = (): boolean => {
    const view = readTerminalOutput(session, since);
    return Boolean(view.output) || view.reset || session.status === 'closed' || session.close;
  };
  if (ready() || waitMs <= 0) {
    return Promise.resolve(terminalView(session, since));
  }
  return new Promise(resolve => {
    const finish = (): void => {
      clearTimeout(timer);
      const index = session.outputWaiters.indexOf(finish);
      if (index >= 0) session.outputWaiters.splice(index, 1);
      resolve(terminalView(session, since));
    };
    const timer = setTimeout(finish, waitMs);
    session.outputWaiters.push(finish);
  });
};

const takeInstruction = (session: TerminalSession): AgentInstruction => ({
  input: Buffer.from(session.pendingInput, 'utf8').toString('base64'),
  signal: session.signal,
  user: session.switchUser,
  close: session.close || session.status === 'closed',
  cols: session.cols,
  rows: session.rows
});

const instructionReady = (session: TerminalSession): boolean =>
  Boolean(session.pendingInput) || Boolean(session.signal) || Boolean(session.switchUser) || session.close || session.status === 'closed';

/**
 * Apply a chunk from the agent and return whatever the browser has queued.
 * `waitMs` holds the agent when there is nothing to send, so keystrokes are
 * not delayed by a poll interval.
 */
export const exchangeTerminal = async (
  session: TerminalSession,
  update: AgentUpdate,
  waitMs: number
): Promise<AgentInstruction> => {
  const output = update.output ? Buffer.from(update.output, 'base64') : Buffer.alloc(0);
  if (update.output && output.length === 0 && update.output.trim()) {
    // Ignore a chunk that is not valid base64 rather than killing the session.
  } else if (output.length > OUTPUT_POST_CAP) {
    appendOutput(session, '\r\nSnippyCode: dropped an oversized output chunk.\r\n');
  } else if (output.length) {
    appendOutput(session, output.toString('utf8'));
  }

  if (typeof update.user === 'string') {
    const reported = update.user.trim();
    if (!reported || validUser(reported, session.os)) {
      session.activeUser = reported;
    }
  }
  if (typeof update.privileged === 'boolean') {
    session.privileged = update.privileged;
  }
  if (typeof update.tty === 'boolean') {
    session.tty = update.tty;
  }
  session.lastAgentAt = Date.now();
  if (session.status === 'starting' && update.alive !== false) {
    session.status = 'open';
  }

  if (update.alive === false) {
    const code = update.exitCode === null || update.exitCode === undefined ? null : Number(update.exitCode);
    markSessionClosed(session, String(update.message || 'The shell exited.'), Number.isFinite(code) ? code : null);
  }

  // The instruction we are about to return consumes the queued input.
  const deliver = (): AgentInstruction => {
    const instruction = takeInstruction(session);
    session.pendingInput = '';
    session.signal = null;
    session.switchUser = null;
    return instruction;
  };

  if (instructionReady(session) || waitMs <= 0) {
    return deliver();
  }

  await new Promise<void>(resolve => {
    const finish = (): void => {
      clearTimeout(timer);
      const index = session.agentWaiters.indexOf(finish);
      if (index >= 0) session.agentWaiters.splice(index, 1);
      resolve();
    };
    const timer = setTimeout(finish, waitMs);
    session.agentWaiters.push(finish);
  });

  return deliver();
};

export const sessionNeedsHeartbeat = (session: TerminalSession, now = Date.now()): boolean => {
  if (session.status === 'closed' || session.close) return false;
  return now - session.lastHeartbeat > 60_000;
};

export const noteSessionHeartbeat = (session: TerminalSession, now = Date.now()): void => {
  session.lastHeartbeat = now;
};

export const noteSessionJobFinished = (session: TerminalSession): void => {
  session.jobFinished = true;
};

export const sessionJobFinished = (session: TerminalSession): boolean => session.jobFinished;

/** Drop closed sessions so a long-lived process does not keep their scrollback. */
export const sweepTerminalSessions = (now = Date.now()): void => {
  for (const session of byId.values()) {
    if (session.status === 'closed' && now - Math.max(session.lastAgentAt, session.createdAt) > 10 * 60_000) {
      byId.delete(session.id);
      byJob.delete(session.jobId);
      if (byDevice.get(session.deviceId) === session.id) {
        byDevice.delete(session.deviceId);
      }
    }
  }
};
