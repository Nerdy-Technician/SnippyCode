import { useEffect, useRef, useState } from 'react';
import { AgentJobState } from '../../typescript/interfaces';

const CWD_MARKER = '__SNIPPYCODE_CWD__';

type RunTool = (tool: string, args?: Record<string, unknown>, key?: string) => Promise<AgentJobState | null>;

interface Entry {
  cwd: string;
  command: string;
  output: string;
  error: string;
  exit: number | null;
  status: 'running' | 'done' | 'failed' | 'lost';
  seconds?: number;
}

/** Split the working folder marker off the end of the output */
const splitCwd = (stdout: string): { output: string; cwd: string | null } => {
  const index = stdout.lastIndexOf(CWD_MARKER);
  if (index < 0) return { output: stdout, cwd: null };
  const cwd = stdout.slice(index + CWD_MARKER.length).split(/\r?\n/)[0].trim();
  return { output: stdout.slice(0, index).replace(/\s+$/, ''), cwd: cwd || null };
};

export const TerminalTab = (props: { name: string; windows: boolean; online: boolean; runTool: RunTool; busy: boolean }) => {
  const shells = props.windows ? ['powershell', 'cmd'] : ['bash'];
  const [shell, setShell] = useState(shells[0]);
  const [cwd, setCwd] = useState(props.windows ? 'C:\\' : '/');
  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const screen = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const running = entries.some(entry => entry.status === 'running');

  useEffect(() => {
    screen.current?.scrollTo({ top: screen.current.scrollHeight });
  }, [entries]);

  const prompt = (folder: string) =>
    props.windows ? (shell === 'cmd' ? `${folder}>` : `PS ${folder}>`) : `root@${props.name}:${folder}#`;

  const run = async () => {
    const command = input.trim();
    if (!command || running) return;

    setInput('');
    setCursor(null);
    setHistory(current => [command, ...current.filter(item => item !== command)].slice(0, 100));

    if (command === 'clear' || command === 'cls') {
      setEntries([]);
      return;
    }

    const started = Date.now();
    const at = cwd;
    setEntries(current => [...current, { cwd: at, command, output: '', error: '', exit: null, status: 'running' } as Entry].slice(-200));

    const job = await props.runTool('shell', { code: command, shell, terminal: true, cwd: at }, 'terminal');
    const run = job?.run;
    const { output, cwd: next } = splitCwd(run?.stdout || '');
    if (next) setCwd(next);

    setEntries(current =>
      current.map(entry =>
        entry.status === 'running' && entry.command === command && entry.cwd === at
          ? {
              ...entry,
              output,
              error: (run?.stderr || '').replace(/\s+$/, ''),
              exit: run?.exitCode ?? null,
              status: !job || job.status === 'expired' ? 'lost' : run?.ok ? 'done' : 'failed',
              seconds: Math.round((Date.now() - started) / 100) / 10
            }
          : entry
      )
    );
    window.setTimeout(() => field.current?.focus(), 0);
  };

  const onKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowUp' && history.length) {
      event.preventDefault();
      const next = cursor === null ? 0 : Math.min(cursor + 1, history.length - 1);
      setCursor(next);
      setInput(history[next]);
    } else if (event.key === 'ArrowDown' && cursor !== null) {
      event.preventDefault();
      const next = cursor - 1;
      setCursor(next < 0 ? null : next);
      setInput(next < 0 ? '' : history[next]);
    } else if (event.key === 'l' && event.ctrlKey) {
      event.preventDefault();
      setEntries([]);
    }
  };

  return (
    <div className='terminal-tab'>
      <div className='device-toolbar'>
        {shells.length > 1 && (
          <div className='segmented' role='group' aria-label='Shell'>
            {shells.map(item => (
              <button key={item} type='button' className={shell === item ? 'is-active' : ''} onClick={() => setShell(item)} disabled={running}>
                {item === 'powershell' ? 'PowerShell' : 'cmd'}
              </button>
            ))}
          </div>
        )}
        <span className='form-text'>
          Runs as {props.windows ? 'SYSTEM' : 'root'} on {props.name}. Every command is kept in the audit log.
        </span>
      </div>

      <div className='terminal-screen mono' ref={screen} onClick={() => field.current?.focus()}>
        {entries.length === 0 && (
          <div className='terminal-hint'>
            Commands run one at a time through the agent, in the folder shown in the prompt; <code>cd</code> carries over between
            commands. Programs that wait for keyboard input (editors, <code>top</code>, password prompts) will not work, variables
            you set do not carry over, and each command stops after two minutes. ↑/↓ recall earlier commands; Ctrl+L clears.
          </div>
        )}
        {entries.map((entry, index) => (
          <div key={index} className='terminal-entry'>
            <div>
              <span className='terminal-prompt'>{prompt(entry.cwd)}</span> {entry.command}
            </div>
            {entry.status === 'running' ? (
              <div className='terminal-muted'>
                <span className='enroll-waiting' aria-hidden='true' /> waiting for {props.name}…
              </div>
            ) : (
              <>
                {entry.output && <pre>{entry.output}</pre>}
                {entry.error && <pre className='terminal-error'>{entry.error}</pre>}
                {entry.status === 'lost' ? (
                  <div className='terminal-error'>The device did not answer.</div>
                ) : (
                  entry.status === 'failed' && <div className='terminal-muted'>exit {entry.exit ?? '—'} · {entry.seconds}s</div>
                )}
              </>
            )}
          </div>
        ))}
        <form
          className='terminal-input'
          onSubmit={event => {
            event.preventDefault();
            run();
          }}
        >
          <label htmlFor='terminal-command' className='terminal-prompt'>
            {prompt(cwd)}
          </label>
          <input
            id='terminal-command'
            ref={field}
            value={input}
            onChange={event => setInput(event.target.value)}
            onKeyDown={onKey}
            disabled={running || !props.online}
            autoComplete='off'
            autoCapitalize='off'
            spellCheck={false}
            placeholder={props.online ? '' : 'device is offline'}
            aria-label='Command'
          />
        </form>
      </div>
    </div>
  );
};
