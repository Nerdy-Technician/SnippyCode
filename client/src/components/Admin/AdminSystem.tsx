import { useContext, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { AuthContext } from '../../store';
import { BackupScheduleSettings, Response, StoredBackup } from '../../typescript/interfaces';
import { dateParser } from '../../utils';
import { Card } from '../UI';
import { apiError } from '../Variables/VariableFields';

const size = (bytes: number): string =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const SANDBOX: { [mode: string]: string } = {
  bwrap: 'bubblewrap: no network, read-only system, memory and process limits',
  docker: 'Docker: a throwaway container per run with no network and resource limits',
  none: 'Not sandboxed'
};

export const AdminSystem = (): JSX.Element => {
  const { snippetRun } = useContext(AuthContext);
  const [backups, setBackups] = useState<StoredBackup[]>([]);
  const [schedule, setSchedule] = useState<BackupScheduleSettings | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [autoPassphrase, setAutoPassphrase] = useState<string | undefined>(undefined);
  const [lintTools, setLintTools] = useState<{ [language: string]: { tool: string; available: boolean } }>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [restoreName, setRestoreName] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const file = useRef<HTMLInputElement>(null);

  const load = () =>
    axios
      .get<Response<{ backups: StoredBackup[]; schedule: BackupScheduleSettings }>>('/api/admin/backups')
      .then(res => {
        setBackups(res.data.data.backups);
        setSchedule(res.data.data.schedule);
      });

  useEffect(() => {
    load();
    axios.get<Response<typeof lintTools>>('/api/snippets/lint').then(res => setLintTools(res.data.data)).catch(() => undefined);
  }, []);

  const backupNow = async () => {
    setBusy(true);
    setError('');
    setMessage('');

    try {
      const res = await axios.post<Response<StoredBackup>>('/api/admin/backups', { passphrase });
      setMessage(`Saved ${res.data.data.name}.`);
      setPassphrase('');
      load();
    } catch (err) {
      setError(apiError(err, 'Backup failed.'));
    } finally {
      setBusy(false);
    }
  };

  const saveSchedule = async () => {
    if (!schedule) {
      return;
    }

    try {
      const res = await axios.put<Response<BackupScheduleSettings>>('/api/admin/backups/schedule', {
        ...schedule,
        ...(autoPassphrase !== undefined ? { passphrase: autoPassphrase } : {})
      });
      setSchedule(res.data.data);
      setAutoPassphrase(undefined);
      setMessage('Automatic backup settings saved.');
    } catch (err) {
      setError(apiError(err, 'Could not save the settings.'));
    }
  };

  const remove = async (name: string) => {
    if (window.confirm(`Delete ${name}?`)) {
      await axios.delete(`/api/admin/backups/${encodeURIComponent(name)}`);
      load();
    }
  };

  const restore = async () => {
    const upload = file.current?.files?.[0];

    if (!upload && !restoreName) {
      setError('Choose a stored backup or upload a file.');
      return;
    }

    setBusy(true);
    setError('');

    const form = new FormData();
    form.append('confirm', confirm);
    form.append('passphrase', restorePassphrase);
    if (upload) {
      form.append('file', upload);
    } else {
      form.append('name', restoreName);
    }

    try {
      await axios.post('/api/admin/backups/restore', form);
      window.alert('Restored. Everyone has been signed out; sign in again with an account from the backup.');
      window.location.href = '/';
    } catch (err) {
      setError(apiError(err, 'Restore failed. Nothing was changed.'));
      setBusy(false);
    }
  };

  return (
    <div className='d-grid gap-3'>
      <Card classes='task-panel admin-tab-panel-wide'>
        <p className='eyebrow'>Server runs</p>
        <h5 className='card-title'>Sandbox</h5>
        <div className={`alert ${snippetRun.sandbox === 'none' ? 'alert-warning' : 'alert-success'} mb-2`}>
          <strong>{SANDBOX[snippetRun.sandbox || 'none']}</strong>
          {snippetRun.sandbox === 'none' && (
            <>
              <br />
              {snippetRun.sandboxReason}. Snippets run as the SnippyCode process and can reach its
              network. Install bubblewrap in the image (it is included in the official image) or set{' '}
              <code>SNIPPET_RUN_SANDBOX=docker</code> with access to a Docker daemon.
            </>
          )}
        </div>
        <p className='form-text mb-0'>
          Server runs are {snippetRun.enabled ? 'on' : 'off'} (<code>SNIPPET_RUN_ENABLED</code>) ·{' '}
          {snippetRun.memoryMb || 256} MB · {Math.round(snippetRun.timeoutMs / 1000)}s ·{' '}
          network {snippetRun.network ? 'allowed' : 'blocked'} · languages{' '}
          {snippetRun.languages.join(', ') || 'none'}
        </p>
        <hr />
        <p className='eyebrow'>Linting</p>
        <p className='form-text mb-0'>
          {Object.entries(lintTools).map(([language, info]) => (
            <span key={language} className='lint-tool'>
              <span className={`device-dot ${info.available ? 'is-online' : ''}`} /> {info.tool} ({language}){' '}
              {info.available ? '' : 'not installed'}
            </span>
          ))}
        </p>
      </Card>

      <Card classes='task-panel admin-tab-panel-wide'>
        <p className='eyebrow'>Backup</p>
        <h5 className='card-title'>Back up everything</h5>
        <p className='form-text'>
          Snippets, history, users, settings, sites, variables and secrets, runbooks, schedules,
          devices, notification channels and avatars. With a passphrase the file is encrypted and
          restores on any server. Without one, it only restores where{' '}
          <code>VARIABLES_SECRET_KEY</code> is the same, and anyone with the file can read it.
        </p>
        {message && <div className='alert alert-info'>{message}</div>}
        {error && <div className='alert alert-danger'>{error}</div>}
        <div className='run-target'>
          <label>
            <span>Passphrase (recommended)</span>
            <input className='form-control' type='password' autoComplete='new-password' value={passphrase} onChange={e => setPassphrase(e.target.value)} placeholder='At least 8 characters' />
          </label>
          <button type='button' className='btn btn-primary' onClick={backupNow} disabled={busy || (passphrase.length > 0 && passphrase.length < 8)}>
            {busy ? 'Working…' : 'Back up now'}
          </button>
        </div>

        {schedule && (
          <div className='backup-schedule'>
            <label className='schedule-enabled'>
              <input type='checkbox' className='form-check-input' checked={schedule.enabled} onChange={e => setSchedule({ ...schedule, enabled: e.target.checked })} />
              <span>Automatic backups</span>
            </label>
            <label>
              <span>Every</span>
              <select className='form-control form-control-sm' value={schedule.everyHours} onChange={e => setSchedule({ ...schedule, everyHours: Number(e.target.value) })}>
                {[1, 6, 12, 24, 168].map(hours => (
                  <option key={hours} value={hours}>
                    {hours === 168 ? 'week' : hours === 24 ? 'day' : `${hours} hours`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Keep</span>
              <input className='form-control form-control-sm' type='number' min={1} max={365} value={schedule.keep} onChange={e => setSchedule({ ...schedule, keep: Number(e.target.value) })} />
            </label>
            <label>
              <span>Passphrase</span>
              <input
                className='form-control form-control-sm'
                type='password'
                autoComplete='new-password'
                value={autoPassphrase ?? ''}
                onChange={e => setAutoPassphrase(e.target.value)}
                placeholder={schedule.hasPassphrase ? 'Set. Type to change' : 'None'}
              />
            </label>
            <button type='button' className='btn btn-sm btn-outline-secondary' onClick={saveSchedule}>
              Save
            </button>
            <p className='form-text mb-0 backup-schedule-status'>
              {schedule.lastBackupAt ? `Last automatic backup ${dateParser(schedule.lastBackupAt).relative}` : 'No automatic backup yet'}
              {schedule.lastError && <span className='text-danger'> · {schedule.lastError}</span>}
              {' · '}stored in <code>data/backups</code> on the server volume
            </p>
          </div>
        )}

        <ul className='run-list mt-3'>
          {backups.length === 0 && <li className='p-2 text-muted'>No backups stored yet.</li>}
          {backups.map(backup => (
            <li key={backup.name}>
              <div className='run-row'>
                <span className={`run-status ${backup.encrypted ? 'is-ok' : ''}`}>{backup.encrypted ? 'Encrypted' : 'Plain'}</span>
                <span className='run-row-main'>
                  <strong>{backup.name}</strong>
                  <span>{size(backup.size)}</span>
                </span>
                <span className='variable-row-actions'>
                  <a className='btn btn-sm btn-outline-secondary' href={`/api/admin/backups/${encodeURIComponent(backup.name)}`}>
                    Download
                  </a>
                  <button type='button' className='btn btn-sm btn-outline-danger' onClick={() => remove(backup.name)}>
                    Delete
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card classes='task-panel admin-tab-panel-wide restore-panel'>
        <p className='eyebrow'>Restore</p>
        <h5 className='card-title'>Replace all data with a backup</h5>
        <p className='form-text'>
          Everything is replaced in one step, and a safety backup of the current data is saved first.
          Everyone is signed out afterwards. From a shell:{' '}
          <code>docker compose exec snippycode node build/backupCli.js restore FILE --yes</code>
        </p>
        <div className='restore-grid'>
          <label>
            <span>Stored backup</span>
            <select className='form-control' value={restoreName} onChange={e => setRestoreName(e.target.value)}>
              <option value=''>Upload a file instead…</option>
              {backups.map(backup => (
                <option key={backup.name} value={backup.name}>
                  {backup.name}
                </option>
              ))}
            </select>
          </label>
          {!restoreName && (
            <label>
              <span>Backup file</span>
              <input ref={file} className='form-control' type='file' accept='.json,application/json' />
            </label>
          )}
          <label>
            <span>Passphrase (if encrypted)</span>
            <input className='form-control' type='password' autoComplete='off' value={restorePassphrase} onChange={e => setRestorePassphrase(e.target.value)} />
          </label>
          <label>
            <span>Type RESTORE to confirm</span>
            <input className='form-control' value={confirm} onChange={e => setConfirm(e.target.value)} />
          </label>
        </div>
        <button type='button' className='btn btn-danger mt-2' onClick={restore} disabled={busy || confirm !== 'RESTORE'}>
          {busy ? 'Restoring…' : 'Restore'}
        </button>
      </Card>
    </div>
  );
};
