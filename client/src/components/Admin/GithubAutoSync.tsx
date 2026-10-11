import { useEffect, useState } from 'react';
import axios from 'axios';
import { Response } from '../../typescript/interfaces';
import { dateParser } from '../../utils';
import { apiError } from '../Variables/VariableFields';

export interface GithubSyncStatus {
  settings: {
    uploadEnabled: boolean;
    downloadEnabled: boolean;
    intervalMinutes: number;
    intervals: number[];
    lastRunAt: string | null;
    lastStatus: string | null;
    lastError: string | null;
    failures: number;
    nextAttemptAt: string | null;
  };
  runs: Array<{
    id: number;
    trigger: string;
    status: string;
    uploaded: number;
    downloaded: number;
    conflicts: number;
    unchanged: number;
    backup: string | null;
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
  }>;
  conflicts: Array<{
    id: number;
    itemType: 'snippet' | 'runbook';
    itemId: number | null;
    title: string | null;
    conflictItemId: number | null;
    conflictTitle: string | null;
    conflictAt: string | null;
  }>;
}

export const describeInterval = (minutes: number): string =>
  minutes % 1440 === 0
    ? `every ${minutes / 1440 === 1 ? 'day' : `${minutes / 1440} days`}`
    : minutes % 60 === 0
    ? `every ${minutes / 60 === 1 ? 'hour' : `${minutes / 60} hours`}`
    : `every ${minutes} minutes`;

/**
 * Automatic two-way sync (owners). Upload and download are separate toggles
 * sharing one interval: each run downloads and uploads together, so
 * conflicts are spotted in a single pass.
 */
export const GithubAutoSync = (): JSX.Element => {
  const [status, setStatus] = useState<GithubSyncStatus | null>(null);
  const [notice, setNotice] = useState('');

  const load = () =>
    axios
      .get<Response<GithubSyncStatus>>('/api/admin/github/sync')
      .then(res => setStatus(res.data.data))
      .catch(err => setNotice(apiError(err, 'Could not load sync status.')));

  useEffect(() => {
    load();
  }, []);

  const save = async (patch: Partial<GithubSyncStatus['settings']>) => {
    setNotice('');
    try {
      await axios.put('/api/admin/github/sync', patch);
      await load();
    } catch (err) {
      setNotice(apiError(err, 'Could not save sync settings.'));
    }
  };

  const runNow = async () => {
    setNotice('Syncing…');
    try {
      const res = await axios.post<Response<{ status: string; uploaded: number; downloaded: number; conflicts: number; error?: string }>>(
        '/api/admin/github/sync/run'
      );
      const result = res.data.data;
      setNotice(
        result.status === 'failed'
          ? `Sync failed: ${result.error}`
          : `Sync ${result.status}: ${result.uploaded} up, ${result.downloaded} down, ${result.conflicts} conflicts.`
      );
      await load();
    } catch (err) {
      setNotice(apiError(err, 'Sync failed.'));
    }
  };

  const resolve = async (id: number, keep: 'local' | 'remote' | 'both') => {
    try {
      await axios.post(`/api/admin/github/sync/conflicts/${id}`, { keep });
      await load();
    } catch (err) {
      setNotice(apiError(err, 'Could not resolve the conflict.'));
    }
  };

  if (!status) {
    return <p className='text-muted'>{notice || 'Loading automatic sync…'}</p>;
  }

  const { settings } = status;

  return (
    <section className='github-auto-sync' aria-label='Automatic sync'>
      <h6>Automatic sync (snippets and runbooks)</h6>
      <div className='github-auto-sync-controls'>
        <label className='form-check'>
          <input
            type='checkbox'
            className='form-check-input'
            checked={settings.uploadEnabled}
            onChange={e => save({ uploadEnabled: e.target.checked })}
          />{' '}
          Auto-upload
        </label>
        <label className='form-check'>
          <input
            type='checkbox'
            className='form-check-input'
            checked={settings.downloadEnabled}
            onChange={e => save({ downloadEnabled: e.target.checked })}
          />{' '}
          Auto-download
        </label>
        <label>
          <span className='visually-hidden'>Interval</span>
          <select
            className='form-select form-select-sm'
            value={settings.intervalMinutes}
            onChange={e => save({ intervalMinutes: Number(e.target.value) })}
            aria-label='Sync interval'
          >
            {settings.intervals.map(minutes => (
              <option key={minutes} value={minutes}>
                {describeInterval(minutes)}
              </option>
            ))}
          </select>
        </label>
        <button type='button' className='btn btn-sm btn-outline-secondary' onClick={runNow}>
          Sync now
        </button>
      </div>
      <p className='form-text'>
        Last run: {settings.lastRunAt ? `${dateParser(settings.lastRunAt).relative} (${settings.lastStatus})` : 'never'}
        {settings.nextAttemptAt ? ` · next ${dateParser(settings.nextAttemptAt).relative}` : ''}
        {settings.failures ? ` · ${settings.failures} failed in a row, backing off` : ''}
        {settings.lastError ? ` · ${settings.lastError}` : ''}
      </p>
      <p className='form-text'>
        Items changed on both sides are kept twice and listed below; nothing is overwritten. Deletes are not synced.
        A backup is taken before any download that changes local data.
      </p>
      {notice && <p className='form-text' role='status'>{notice}</p>}

      {status.conflicts.length > 0 && (
        <div className='github-conflicts'>
          <strong>Conflicts ({status.conflicts.length})</strong>
          <ul className='list-unstyled'>
            {status.conflicts.map(conflict => (
              <li key={conflict.id} className='github-conflict'>
                <span>
                  {conflict.itemType} <strong>{conflict.title || '(deleted)'}</strong>
                  {conflict.conflictTitle ? ` · GitHub copy: ${conflict.conflictTitle}` : ' · GitHub copy not downloaded'}
                </span>
                <span className='github-conflict-actions'>
                  <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => resolve(conflict.id, 'local')}>
                    Keep local
                  </button>
                  <button
                    type='button'
                    className='btn btn-sm btn-outline-secondary'
                    onClick={() => resolve(conflict.id, 'remote')}
                    disabled={!conflict.conflictItemId}
                  >
                    Use GitHub
                  </button>
                  <button
                    type='button'
                    className='btn btn-sm btn-outline-secondary'
                    onClick={() => resolve(conflict.id, 'both')}
                    disabled={!conflict.conflictItemId}
                  >
                    Keep both
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <table className='table table-sm github-sync-log'>
        <thead>
          <tr>
            <th scope='col'>When</th>
            <th scope='col'>Result</th>
            <th scope='col'>Up</th>
            <th scope='col'>Down</th>
            <th scope='col'>Conflicts</th>
            <th scope='col'>Error</th>
          </tr>
        </thead>
        <tbody>
          {status.runs.length === 0 ? (
            <tr>
              <td colSpan={6} className='text-muted'>
                No sync runs yet.
              </td>
            </tr>
          ) : (
            status.runs.map(run => (
              <tr key={run.id}>
                <td>{dateParser(run.startedAt).formatted}</td>
                <td>
                  {run.status}
                  {run.trigger === 'manual' ? ' (manual)' : ''}
                </td>
                <td>{run.uploaded}</td>
                <td>{run.downloaded}</td>
                <td>{run.conflicts}</td>
                <td className='text-muted small'>{run.error || ''}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
};
