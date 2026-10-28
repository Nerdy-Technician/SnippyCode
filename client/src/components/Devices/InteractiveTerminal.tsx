import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { AgentJobState } from '../../typescript/interfaces';
import { renderTerminal } from '../../utils/terminalText';

type RunTool = (tool: string, args?: Record<string, unknown>, key?: string) => Promise<AgentJobState | null>;

const OS_USER = /^[a-z_][a-z0-9_.-]{0,31}$/;

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
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const screen = useRef<HTMLPreElement>(null);
  const since = useRef(0);
  const size = useRef({ cols: 100, rows: 32 });

  useEffect(() => {
    screen.current?.scrollTo({ top: screen.current.scrollHeight });
  }, [raw, session?.status]);

  useEffect(() => {
    const box = screen.current;
    if (!box) return;
    const measure = () => {
      const style = window.getComputedStyle(box);
      const font = parseFloat(style.fontSize) || 14;
      const cols = Math.max(40, Math.floor(box.clientWidth / (font * 0.62)));
      const rows = Math.max(12, Math.floor(box.clientHeight / (font * 1.45)));
      size.current = { cols, rows };
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [session?.id]);

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
          if (data.reset) setRaw(data.output);
          else if (data.output) setRaw(current => current + data.output);
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
    setRaw('');
    since.current = 0;
    try {
      const res = await axios.post<{ data: SessionView }>(`/api/devices/${props.deviceId}/terminal/session`, {
        shell,
        user: props.windows ? '' : account.trim()
      });
      since.current = res.data.data.next || 0;
      if (res.data.data.reset || res.data.data.output) setRaw(res.data.data.output || '');
      setSession(res.data.data);
      window.setTimeout(() => screen.current?.focus(), 0);
    } catch (err) {
      setError(apiError(err, 'Could not open a terminal.'));
    }
  };

  const send = (data: string) => {
    if (!session || session.status === 'closed') return;
    axios.post(`/api/devices/${props.deviceId}/terminal/session/input`, { session: session.id, data }).catch(err => {
      setError(apiError(err, 'Could not send that keystroke.'));
    });
  };

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
      {
        code: "getent passwd 2>/dev/null | awk -F: '($3==0 || $3>=1000) && $7 !~ /(nologin|false)$/ { print $1 }'",
        shell: 'bash'
      },
      'terminal-users'
    );
    setLoadingAccounts(false);
    const names = (job?.run?.stdout || '')
      .split(/\r?\n/)
      .map(item => item.trim())
      .filter(item => OS_USER.test(item) && !item.includes('..'));
    if (!job) return;
    if (!names.length) {
      setError(job.run?.stderr || 'No local accounts were listed.');
      return;
    }
    setAccounts(Array.from(new Set([...accounts, ...names])));
  };

  const onKey = (event: React.KeyboardEvent<HTMLPreElement>) => {
    if (!session || session.status === 'closed') return;
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      send('\r');
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      send('\u007f');
    } else if (event.key === 'Tab') {
      event.preventDefault();
      send('\t');
    } else if (event.key === 'c' && event.ctrlKey) {
      event.preventDefault();
      axios.post(`/api/devices/${props.deviceId}/terminal/session/signal`, { session: session.id, signal: 'INT' }).catch(() => undefined);
    } else if (event.key === 'd' && event.ctrlKey) {
      event.preventDefault();
      send('\u0004');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      send('\u001b[A');
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      send('\u001b[B');
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      send('\u001b[C');
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      send('\u001b[D');
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      send(event.key);
    }
  };

  const onPaste = (event: React.ClipboardEvent<HTMLPreElement>) => {
    const text = event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    send(text.replace(/\r?\n/g, '\r'));
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
        {props.windows ? (
          <span className='form-text'>Runs as the agent service account (usually SYSTEM). Windows cannot switch users from here.</span>
        ) : (
          <label className='terminal-user-field' htmlFor='terminal-user'>
            OS user
            <input
              id='terminal-user'
              className='form-control form-control-sm'
              list='terminal-user-list'
              value={account}
              placeholder='agent account'
              disabled={open && session?.canSwitchUser === false}
              onChange={event => setAccount(event.target.value)}
              autoCapitalize='off'
              autoCorrect='off'
              spellCheck={false}
            />
            <datalist id='terminal-user-list'>
              <option value='root' />
              {accounts.map(item => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </label>
        )}
        {!props.windows && !open && (
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
            {!props.windows && (
              <button type='button' className='btn btn-sm btn-outline-secondary' onClick={switchUser} disabled={!account.trim() || session?.canSwitchUser === false}>
                Switch user
              </button>
            )}
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
                ? 'Stdin is connected, but this is not a full console, so some password prompts can still refuse. '
                : ''
            }Keystrokes are not stored. Ctrl+C interrupts. Close the session when you are done.`
          : `Opens a shell on ${props.name} and sends what you type, including passwords and y/n answers. Pick an account before connecting. Full-screen programs (editors, top) are not supported.`}
        {session?.status === 'starting' && ' Waiting for the agent…'}
        {session?.closing && ' Closing…'}
        {session?.status === 'closed' && session.message ? ` ${session.message}` : ''}
      </p>
      <pre
        className='terminal-screen terminal-live mono'
        ref={screen}
        tabIndex={0}
        role='log'
        aria-label='Terminal'
        onKeyDown={onKey}
        onPaste={onPaste}
        onClick={() => screen.current?.focus()}
      >
        {raw ? renderTerminal(raw) : open ? '' : 'Connect to start a session.'}
      </pre>
    </div>
  );
};
