import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { AgentJobState } from '../../typescript/interfaces';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type RunTool = (tool: string, args?: Record<string, unknown>, key?: string) => Promise<AgentJobState | null>;

const OS_USER = /^[a-z_][a-z0-9_.-]{0,31}$/;
const WINDOWS_USER = /^[A-Za-z0-9_][A-Za-z0-9_. $'-]{0,63}$/;

interface SessionView {
  id: string;
  status: 'starting' | 'open' | 'closed';
  shell: string;
  user: string;
  activeUser: string;
  privileged: boolean | null;
  tty: boolean | null;
  canSwitchUser: boolean;
  output: string;
  next: number;
  reset: boolean;
  message: string;
  closing: boolean;
  attached?: boolean;
}

const apiError = (err: unknown, fallback: string): string =>
  (axios.isAxiosError(err) && (err.response?.data as { error?: string })?.error) || fallback;

export const InteractiveTerminal = (props: {
  deviceId: number;
  name: string;
  windows: boolean;
  online: boolean;
  suggestedUsers: string[];
  runTool: RunTool;
}) => {
  const shells = props.windows ? ['powershell', 'cmd'] : ['bash', 'sh'];
  const [shell, setShell] = useState(shells[0]);
  const [account, setAccount] = useState('');
  const [accounts, setAccounts] = useState<string[]>(props.suggestedUsers);
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState('');
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const screen = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const live = useRef<SessionView | null>(null);
  const since = useRef(0);
  const size = useRef({ cols: 100, rows: 32 });
  live.current = session;

  // Real terminal emulator: colours, cursor moves and the alternate screen,
  // so vim, top, less and htop draw properly.
  useEffect(() => {
    if (!screen.current) return undefined;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#0d1117', foreground: '#e6edf3' }
    });
    const fitter = new FitAddon();
    terminal.loadAddon(fitter);
    terminal.open(screen.current);
    term.current = terminal;
    fit.current = fitter;
    const measure = () => {
      try {
        fitter.fit();
      } catch {
        return;
      }
      size.current = { cols: terminal.cols, rows: terminal.rows };
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(screen.current);
    window.addEventListener('resize', measure);
    const typing = terminal.onData(data => sendRef.current(data));
    terminal.writeln('Connect to start a session.');
    return () => {
      typing.dispose();
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      terminal.dispose();
      term.current = null;
    };
  }, []);

  const sessionId = session?.id;
  const sessionStatus = session?.status;

  useEffect(() => {
    if (!sessionId || sessionStatus === 'closed') return undefined;
    const controller = new AbortController();
    let stopped = false;

    const pump = async () => {
      while (!stopped) {
        try {
          const res = await axios.get<{ data: SessionView }>(`/api/devices/${props.deviceId}/terminal/session`, {
            params: { since: since.current, wait: 2, cols: size.current.cols, rows: size.current.rows },
            signal: controller.signal,
            timeout: 15000
          });
          const data = res.data.data;
          if (!data || data.id !== sessionId) {
            if (!data) break;
            continue;
          }
          since.current = data.next;
          if (data.reset) {
            term.current?.reset();
            term.current?.write(data.output);
          } else if (data.output) term.current?.write(data.output);
          setSession(current => (current && current.id === data.id ? { ...current, ...data } : current));
          if (data.status === 'closed') break;
        } catch (err) {
          if (stopped || controller.signal.aborted) break;
          setError(apiError(err, 'The terminal connection dropped.'));
          await new Promise(resolve => window.setTimeout(resolve, 1000));
        }
      }
    };

    pump();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [props.deviceId, sessionId, sessionStatus]);

  const connect = async () => {
    setError('');
    term.current?.reset();
    since.current = 0;
    try {
      const res = await axios.post<{ data: SessionView }>(`/api/devices/${props.deviceId}/terminal/session`, {
        shell,
        user: account.trim()
      });
      since.current = res.data.data.next || 0;
      if (res.data.data.reset || res.data.data.output) term.current?.write(res.data.data.output || '');
      setSession(res.data.data);
      window.setTimeout(() => term.current?.focus(), 0);
    } catch (err) {
      setError(apiError(err, 'Could not open a terminal.'));
    }
  };

  const send = (data: string) => {
    const current = live.current;
    if (!current || current.status === 'closed') return;
    axios.post(`/api/devices/${props.deviceId}/terminal/session/input`, { session: current.id, data }).catch(err => {
      setError(apiError(err, 'Could not send that keystroke.'));
    });
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  const close = async () => {
    if (!session) return;
    try {
      await axios.post(`/api/devices/${props.deviceId}/terminal/session/close`, { session: session.id });
    } catch (err) {
      setError(apiError(err, 'Could not close the session.'));
    }
  };

  const switchUser = async () => {
    if (!session) return;
    setError('');
    try {
      await axios.post(`/api/devices/${props.deviceId}/terminal/session/user`, { session: session.id, user: account.trim() });
    } catch (err) {
      setError(apiError(err, 'Could not switch user.'));
    }
  };

  const loadAccounts = async () => {
    setLoadingAccounts(true);
    setError('');
    const job = await props.runTool(
      'shell',
      props.windows
        ? {
            // Signed-in users (console or remote desktop): the ones a SYSTEM agent can open a shell as.
            code: "quser 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_.Trim().TrimStart('>') -split '\\s+')[0] }",
            shell: 'powershell'
          }
        : {
            code: "getent passwd 2>/dev/null | awk -F: '($3==0 || $3>=1000) && $7 !~ /(nologin|false)$/ { print $1 }'",
            shell: 'bash'
          },
      'terminal-users'
    );
    setLoadingAccounts(false);
    const names = (job?.run?.stdout || '')
      .split(/\r?\n/)
      .map(item => item.trim())
      .filter(item => (props.windows ? WINDOWS_USER.test(item) : OS_USER.test(item)) && !item.includes('..'));
    if (!job) return;
    if (!names.length) {
      setError(job.run?.stderr || (props.windows ? 'Nobody is signed in on this machine.' : 'No local accounts were listed.'));
      return;
    }
    setAccounts(Array.from(new Set([...accounts, ...names])));
  };

  const open = Boolean(session && session.status !== 'closed');
  const who = session?.activeUser || session?.user || (props.windows ? 'the service account' : 'the agent account');

  return (
    <div className='terminal-tab'>
      <div className='device-toolbar'>
        <div className='segmented' role='group' aria-label='Shell'>
          {shells.map(item => (
            <button key={item} type='button' className={shell === item ? 'is-active' : ''} onClick={() => setShell(item)} disabled={open}>
              {item === 'powershell' ? 'PowerShell' : item}
            </button>
          ))}
        </div>
        <label className='terminal-user-field' htmlFor='terminal-user'>
          {props.windows ? 'Windows user' : 'OS user'}
          <input
            id='terminal-user'
            className='form-control form-control-sm'
            list='terminal-user-list'
            value={account}
            placeholder={props.windows ? 'service account' : 'agent account'}
            disabled={open && session?.canSwitchUser === false}
            onChange={event => setAccount(event.target.value)}
            autoCapitalize='off'
            autoCorrect='off'
            spellCheck={false}
          />
          <datalist id='terminal-user-list'>
            {!props.windows && <option value='root' />}
            {accounts.map(item => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </label>
        {!open && (
          <button type='button' className='btn btn-sm btn-outline-secondary' onClick={loadAccounts} disabled={loadingAccounts || !props.online}>
            {loadingAccounts ? 'Looking up accounts…' : 'Load accounts'}
          </button>
        )}
        {!open ? (
          <button type='button' className='btn btn-sm btn-primary' onClick={connect} disabled={!props.online}>
            Connect
          </button>
        ) : (
          <>
            <button type='button' className='btn btn-sm btn-outline-secondary' onClick={switchUser} disabled={!account.trim() || session?.canSwitchUser === false}>
              Switch user
            </button>
            <button type='button' className='btn btn-sm btn-outline-secondary' onClick={close}>
              Close session
            </button>
          </>
        )}
      </div>
      {error && <p className='terminal-error'>{error}</p>}
      <p className='form-text'>
        {open
          ? `Connected as ${who} on ${props.name}. ${
              session?.tty === false
                ? 'This Windows build has no pseudo console, so full-screen programs and some prompts will not work. '
                : ''
            }Keystrokes are not stored. Close the session when you are done.`
          : props.windows
            ? `Opens a shell on ${props.name}. Leave the user empty for the agent account, or pick someone signed in (console or remote desktop) to open the shell as them.`
            : `Opens a shell on ${props.name}. Leave the user empty for the agent account. Switching needs a root agent or passwordless sudo; otherwise su asks for the password here.`}
        {session?.status === 'starting' && ' Waiting for the agent…'}
        {session?.closing && ' Closing…'}
        {session?.status === 'closed' && session.message ? ` ${session.message}` : ''}
      </p>
      <div className='terminal-screen terminal-live terminal-xterm' ref={screen} role='application' aria-label='Terminal' />
    </div>
  );
};
