import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { approvalMessage, heldApproval } from '../../utils/approvals';
import { SnippetsContext } from '../../store';
import { AgentJobState, Device, Response } from '../../typescript/interfaces';
import { apiError } from '../Variables/VariableFields';
import { RunHistory, RunOutput } from '../Runs/RunHistory';

interface Props {
  device: Device;
  siteId: number;
  siteName: string;
  mode: 'run' | 'history';
  onClose: () => void;
  onFinished: () => void;
}

/**
 * Pick a snippet and run it on one device, or browse what ran there.
 */
export const DeviceRunModal = (props: Props): JSX.Element => {
  const { device, siteId, siteName, onClose, onFinished } = props;
  const { snippets, getSnippets } = useContext(SnippetsContext);
  const [mode, setMode] = useState(props.mode);
  const [query, setQuery] = useState('');
  const [snippetId, setSnippetId] = useState<number | null>(null);
  const [job, setJob] = useState<AgentJobState | null>(null);
  const [error, setError] = useState('');
  const poller = useRef<number | null>(null);

  useEffect(() => {
    if (!snippets.length) {
      getSnippets();
    }

    return () => {
      if (poller.current) {
        window.clearInterval(poller.current);
      }
    };
  }, []);

  const matches = useMemo(() => {
    const term = query.trim().toLowerCase();
    return [...snippets]
      .filter(snippet => !term || `${snippet.title} ${snippet.language} ${(snippet.tags || []).join(' ')}`.toLowerCase().includes(term))
      .sort((a, b) => a.title.localeCompare(b.title))
      .slice(0, 50);
  }, [snippets, query]);

  const chosen = snippets.find(snippet => snippet.id === snippetId) || null;
  const finished = job && ['done', 'failed', 'expired'].includes(job.status);

  const run = async () => {
    if (!chosen) {
      return;
    }

    setError('');
    setJob(null);

    try {
      const res = await axios.post<Response<{ jobs: AgentJobState[] }>>(`/api/snippets/${chosen.id}/run`, {
        siteId,
        deviceIds: [device.id],
        reason: chosen.dangerous ? window.prompt('This snippet is flagged dangerous. Why are you running it?') || '' : ''
      });
      const approval = heldApproval(res.data.data);
      if (approval) {
        setError(approvalMessage(approval));
        return;
      }
      const queued = res.data.data.jobs[0];
      setJob(queued);

      const check = async () => {
        const status = await axios.get<Response<AgentJobState[]>>('/api/devices/jobs', { params: { ids: queued.id } });
        const current = status.data.data[0];
        setJob(current);

        if (current && ['done', 'failed', 'expired'].includes(current.status)) {
          window.clearInterval(poller.current!);
          poller.current = null;
          onFinished();
        }
      };

      poller.current = window.setInterval(() => check().catch(() => undefined), 1500);
    } catch (err) {
      setError(apiError(err, 'Could not queue the snippet.'));
    }
  };

  return (
    <div className='raw-modal-backdrop' role='dialog' aria-modal='true' aria-label={`${device.name}`}>
      <div className='raw-modal'>
        <div className='raw-modal-header'>
          <div>
            <p className='eyebrow'>
              {device.name} · {siteName}
            </p>
            <div className='segmented'>
              <button type='button' className={mode === 'run' ? 'is-active' : ''} onClick={() => setMode('run')}>
                Run a snippet
              </button>
              <button type='button' className={mode === 'history' ? 'is-active' : ''} onClick={() => setMode('history')}>
                History
              </button>
            </div>
          </div>
          <button type='button' onClick={onClose}>
            Close
          </button>
        </div>

        {mode === 'history' ? (
          <RunHistory query={{ deviceId: device.id }} showSite={false} empty={`Nothing has run on ${device.name} yet.`} />
        ) : (
          <>
            {!device.online && (
              <p className='raw-token-notice'>
                {device.name} is offline. The job waits up to 15 minutes for it to reconnect.
              </p>
            )}
            <input
              className='form-control mb-2'
              placeholder='Find a snippet by name, language or tag'
              value={query}
              onChange={event => setQuery(event.target.value)}
              autoFocus
            />
            <ul className='device-snippet-list' role='listbox' aria-label='Snippets'>
              {matches.map(snippet => {
                const runnable = device.capabilities.length === 0 || runnableOn(device, snippet.language);

                return (
                  <li key={snippet.id}>
                    <button
                      type='button'
                      role='option'
                      aria-selected={snippetId === snippet.id}
                      className={snippetId === snippet.id ? 'is-active' : ''}
                      onClick={() => setSnippetId(snippet.id)}
                    >
                      <span>{snippet.title}</span>
                      <span className={`device-chip ${runnable ? '' : 'is-missing'}`} title={runnable ? '' : `${device.name} has no ${snippet.language} interpreter`}>
                        {snippet.language}
                      </span>
                    </button>
                  </li>
                );
              })}
              {matches.length === 0 && <li className='text-muted p-2'>No snippets match.</li>}
            </ul>
            {error && <div className='alert alert-danger mt-2'>{error}</div>}
            <div className='variable-editor-actions mt-2'>
              <button type='button' className='btn btn-primary' onClick={run} disabled={!chosen || Boolean(job && !finished)}>
                {job && !finished ? 'Running…' : `Run${chosen ? ` “${chosen.title}”` : ''} on ${device.name}`}
              </button>
            </div>
            <p className='form-text mt-2 mb-0'>Uses {siteName} values, secrets included. Output is saved with secrets masked.</p>

            {job && (
              <div className='mt-3'>
                <p className='form-text mb-1'>
                  <span
                    className={`run-status ${
                      job.status === 'done' ? 'is-ok' : job.status === 'failed' || job.status === 'expired' ? 'is-bad' : 'is-in_progress'
                    }`}
                  >
                    {{ queued: 'Waiting for the device', running: 'Running', done: 'Done', failed: 'Failed', expired: 'Expired' }[job.status]}
                  </span>{' '}
                  {job.run && `${job.run.timedOut ? 'timed out' : `exit ${job.run.exitCode ?? '—'}`} · ${(job.run.durationMs / 1000).toFixed(1)}s`}
                </p>
                {job.run && <RunOutput run={job.run} />}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const INTERPRETERS: { [language: string]: string[] } = {
  bash: ['bash'],
  shell: ['bash'],
  sh: ['sh', 'bash'],
  python: ['python3', 'python'],
  javascript: ['node'],
  js: ['node'],
  powershell: ['powershell', 'pwsh'],
  bat: ['cmd'],
  batch: ['cmd']
};

export const runnableOn = (device: Device, language: string): boolean =>
  (INTERPRETERS[language.toLowerCase()] || []).some(bin => device.capabilities.includes(bin));
