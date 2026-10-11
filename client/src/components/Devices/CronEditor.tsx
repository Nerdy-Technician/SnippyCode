import { useEffect, useMemo, useState } from 'react';
import { AgentJobState } from '../../typescript/interfaces';

export const CRON_OFF_MARKER = '#off# ';

type RunTool = (tool: string, args?: Record<string, unknown>, key?: string) => Promise<AgentJobState | null>;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Plain English for the common cron shapes; the raw expression otherwise */
export const describeCron = (schedule: string): string => {
  const special: { [key: string]: string } = {
    '@reboot': 'At startup',
    '@hourly': 'Every hour',
    '@daily': 'Every day at midnight',
    '@midnight': 'Every day at midnight',
    '@weekly': 'Every Sunday at midnight',
    '@monthly': 'On the 1st at midnight',
    '@yearly': 'Every 1 January',
    '@annually': 'Every 1 January',
    hourly: 'Hourly (cron.hourly)',
    daily: 'Daily (cron.daily)',
    weekly: 'Weekly (cron.weekly)',
    monthly: 'Monthly (cron.monthly)'
  };

  if (special[schedule]) return special[schedule];

  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;
  const [minute, hour, day, month, weekday] = parts;
  const hhmm = /^\d+$/.test(minute) && /^\d+$/.test(hour) ? `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}` : null;

  if (schedule.trim() === '* * * * *') return 'Every minute';
  if (/^\*\/\d+$/.test(minute) && hour === '*' && day === '*' && month === '*' && weekday === '*') return `Every ${minute.slice(2)} minutes`;
  if (/^\d+$/.test(minute) && hour === '*' && day === '*' && month === '*' && weekday === '*') return `Hourly at :${minute.padStart(2, '0')}`;
  if (/^\d+$/.test(minute) && /^\*\/\d+$/.test(hour) && day === '*' && month === '*' && weekday === '*') return `Every ${hour.slice(2)} hours at :${minute.padStart(2, '0')}`;
  if (hhmm && day === '*' && month === '*' && weekday === '*') return `Daily at ${hhmm}`;
  if (hhmm && day === '*' && month === '*' && /^\d$/.test(weekday)) return `${DAYS[Number(weekday)]}s at ${hhmm}`;
  if (hhmm && day === '*' && month === '*' && weekday === '1-5') return `Weekdays at ${hhmm}`;
  if (hhmm && /^\d+$/.test(day) && month === '*' && weekday === '*') return `Monthly on day ${day} at ${hhmm}`;
  return schedule;
};

const PRESETS: { label: string; schedule: string }[] = [
  { label: 'Every 5 minutes', schedule: '*/5 * * * *' },
  { label: 'Every 15 minutes', schedule: '*/15 * * * *' },
  { label: 'Every hour', schedule: '0 * * * *' },
  { label: 'Every day at 02:00', schedule: '0 2 * * *' },
  { label: 'Weekdays at 09:00', schedule: '0 9 * * 1-5' },
  { label: 'Sundays at 03:00', schedule: '0 3 * * 0' },
  { label: '1st of the month at 04:00', schedule: '0 4 1 * *' },
  { label: 'At startup', schedule: '@reboot' }
];

const FIELD_LABELS = ['Minute', 'Hour', 'Day', 'Month', 'Weekday'];
const FIELD_HINTS = ['0-59', '0-23', '1-31', '1-12', '0-6 (Sun=0)'];

export const targetLabel = (target: string): string =>
  target.startsWith('user:') ? `${target.slice(5)}'s crontab` : target;

export const isSystemTarget = (target: string): boolean => !target.startsWith('user:');

/** Split a cron line into schedule, user (system files) and command */
export const parseLine = (line: string, system: boolean) => {
  const parts = line.trim().split(/\s+/);
  const keyword = /^@/.test(parts[0] || '');
  const count = keyword ? 1 : 5;
  return {
    schedule: parts.slice(0, count).join(' '),
    user: system ? parts[count] || 'root' : '',
    command: parts.slice(count + (system ? 1 : 0)).join(' ')
  };
};

export const buildLine = (schedule: string, user: string, command: string, system: boolean): string =>
  [schedule.trim(), system ? user.trim() || 'root' : '', command.trim()].filter(Boolean).join(' ');

/** Read a crontab or cron file from the device */
export const readCron = async (runTool: RunTool, target: string): Promise<string> => {
  const job = await runTool('crontab', { op: 'read', target }, 'cron:read');

  if (!job || job.status !== 'done' || !job.run) {
    throw new Error(job?.run?.stderr || 'The device did not answer');
  }

  return job.run.stdout;
};

/** Write a whole crontab or cron file back; the device checks it first */
export const writeCron = async (runTool: RunTool, target: string, content: string): Promise<void> => {
  const job = await runTool('crontab', { op: 'write', target, content }, 'cron:write');

  if (!job || job.status !== 'done') {
    throw new Error(job?.run?.stderr?.trim() || job?.run?.stdout?.trim() || 'The device did not save the file');
  }
};

/** Change one line in place: disable, enable, or delete it */
export const changeCronLine = async (
  runTool: RunTool,
  target: string,
  raw: string,
  enabled: boolean,
  change: 'enable' | 'disable' | 'delete'
): Promise<void> => {
  const content = await readCron(runTool, target);
  const lines = content.split('\n');
  const current = enabled ? raw : `${CRON_OFF_MARKER}${raw}`;
  const index = lines.findIndex(line => line === current);

  if (index < 0) {
    throw new Error('That line has changed on the device since the list was loaded. Refresh and try again.');
  }

  if (change === 'delete') {
    lines.splice(index, 1);
  } else {
    lines[index] = change === 'disable' ? `${CRON_OFF_MARKER}${raw}` : raw;
  }

  await writeCron(runTool, target, lines.join('\n'));
};

interface Props {
  deviceName: string;
  target: string;
  /** Edit this existing line (as in the file); otherwise add a new job */
  editLine?: { raw: string; enabled: boolean };
  runTool: RunTool;
  onClose: () => void;
  onSaved: () => void;
}

export const CronEditor = (props: Props): JSX.Element => {
  const { deviceName, target, editLine, runTool, onClose, onSaved } = props;
  const system = isSystemTarget(target);
  const [content, setContent] = useState<string | null>(null);
  const [original, setOriginal] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<'job' | 'file'>('job');
  const initial = editLine ? parseLine(editLine.raw, system) : { schedule: '0 2 * * *', user: 'root', command: '' };
  const [schedule, setSchedule] = useState(initial.schedule);
  const [user, setUser] = useState(initial.user || 'root');
  const [command, setCommand] = useState(initial.command);

  useEffect(() => {
    readCron(runTool, target)
      .then(text => {
        setContent(text);
        setOriginal(text);
      })
      .catch(err => {
        // A new /etc/cron.d file or an empty crontab reads as nothing
        setContent('');
        setOriginal('');
        if (!/no crontab/i.test(err.message)) {
          setError(err.message);
        }
      });
  }, [target]);

  const fields = schedule.startsWith('@') ? null : schedule.trim().split(/\s+/);
  const validSchedule = /^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)$/.test(schedule.trim()) || (fields?.length === 5 && fields.every(field => /^[\d*,\/-]+$|^[a-z]{3}$/i.test(field)));
  const line = buildLine(schedule, user, command, system);
  const lineReady = validSchedule && command.trim() && (!system || /^[a-z_][a-z0-9_-]*$/.test(user.trim()));

  // The file with this job added or replaced, for saving and preview
  const updated = useMemo(() => {
    if (content === null) return null;
    const lines = content.split('\n');

    if (editLine) {
      const current = editLine.enabled ? editLine.raw : `${CRON_OFF_MARKER}${editLine.raw}`;
      const index = lines.findIndex(item => item === current);
      if (index < 0) return null;
      lines[index] = editLine.enabled ? line : `${CRON_OFF_MARKER}${line}`;
      return lines.join('\n');
    }

    const body = content.replace(/\n*$/, '');
    return `${body ? `${body}\n` : ''}${line}\n`;
  }, [content, line, editLine]);

  const save = async () => {
    const next = view === 'file' ? content : updated;

    if (next === null) {
      setError('That line has changed on the device since the list was loaded. Close, refresh and try again.');
      return;
    }

    setSaving(true);
    setError('');

    try {
      await writeCron(runTool, target, next);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const setField = (index: number, value: string) => {
    const next = (fields || ['*', '*', '*', '*', '*']).slice();
    next[index] = value.replace(/\s/g, '') || '*';
    setSchedule(next.join(' '));
  };

  const loading = content === null;
  const dirty = view === 'file' ? content !== original : Boolean(lineReady);

  return (
    <div className='raw-modal-backdrop' role='dialog' aria-modal='true' aria-label={`Edit ${targetLabel(target)}`}>
      <div className='raw-modal cron-editor'>
        <div className='raw-modal-header'>
          <div>
            <p className='eyebrow'>
              {deviceName} · {targetLabel(target)}
            </p>
            <h3>{editLine ? 'Edit cron job' : 'Cron'}</h3>
          </div>
          <button type='button' onClick={onClose}>
            Close
          </button>
        </div>

        <div className='segmented mb-3'>
          <button type='button' className={view === 'job' ? 'is-active' : ''} onClick={() => setView('job')}>
            {editLine ? 'This job' : 'Add a job'}
          </button>
          <button type='button' className={view === 'file' ? 'is-active' : ''} onClick={() => setView('file')}>
            Whole file
          </button>
        </div>

        {loading ? (
          <p className='text-muted'>
            <span className='enroll-waiting' aria-hidden='true' /> Reading {targetLabel(target)} from {deviceName}…
          </p>
        ) : view === 'job' ? (
          <div className='cron-builder'>
            <label>
              <span>When</span>
              <select
                className='form-control'
                value={PRESETS.some(preset => preset.schedule === schedule) ? schedule : 'custom'}
                onChange={event => event.target.value !== 'custom' && setSchedule(event.target.value)}
              >
                {PRESETS.map(preset => (
                  <option key={preset.schedule} value={preset.schedule}>
                    {preset.label}
                  </option>
                ))}
                <option value='custom'>Custom…</option>
              </select>
            </label>

            {fields && (
              <div className='cron-fields'>
                {FIELD_LABELS.map((label, index) => (
                  <label key={label}>
                    <span>{label}</span>
                    <input
                      className='form-control mono'
                      value={fields[index] ?? '*'}
                      onChange={event => setField(index, event.target.value)}
                      aria-describedby={`cron-hint-${index}`}
                      spellCheck={false}
                    />
                    <small id={`cron-hint-${index}`}>{FIELD_HINTS[index]}</small>
                  </label>
                ))}
              </div>
            )}

            <p className={`cron-preview ${validSchedule ? '' : 'is-bad'}`}>
              {validSchedule ? describeCron(schedule) : 'That schedule is not valid cron'} · <code>{schedule}</code>
            </p>

            {system && (
              <label>
                <span>Run as user</span>
                <input className='form-control mono' value={user} onChange={event => setUser(event.target.value)} spellCheck={false} />
              </label>
            )}

            <label>
              <span>Command</span>
              <input
                className='form-control mono'
                value={command}
                onChange={event => setCommand(event.target.value)}
                placeholder='/usr/local/bin/backup.sh >> /var/log/backup.log 2>&1'
                spellCheck={false}
                autoFocus
              />
              <small>
                In cron, <code>%</code> means a new line; write <code>\%</code> for a literal percent sign.
              </small>
            </label>

            <div className='cron-line'>
              <span>Line to {editLine ? 'save' : 'add'}</span>
              <code>{lineReady ? line : '…'}</code>
            </div>
          </div>
        ) : (
          <>
            <textarea
              className='form-control mono cron-file'
              rows={16}
              value={content || ''}
              onChange={event => setContent(event.target.value)}
              spellCheck={false}
              aria-label={`Contents of ${targetLabel(target)}`}
            />
            <p className='form-text'>
              {system
                ? 'Each line: minute hour day month weekday user command. The device checks every line and keeps a backup in /var/backups/snippycode before saving.'
                : 'Each line: minute hour day month weekday command. crontab checks the file and refuses it if anything is wrong.'}{' '}
              Lines starting with <code>#off#</code> are jobs switched off in SnippyCode.
            </p>
          </>
        )}

        {error && <div className='alert alert-danger mt-2 cron-error'>{error}</div>}

        <div className='variable-editor-actions mt-3'>
          <button type='button' className='btn btn-primary' onClick={save} disabled={loading || saving || !dirty}>
            {saving ? 'Saving on the device…' : editLine ? 'Save job' : view === 'file' ? 'Save file' : 'Add job'}
          </button>
          <button type='button' className='btn btn-outline-secondary' onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
