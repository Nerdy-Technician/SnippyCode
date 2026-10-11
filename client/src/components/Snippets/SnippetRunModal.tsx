import { useContext, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { AuthContext } from '../../store';
import { AgentJobState, Device, Response, Site, Snippet } from '../../typescript/interfaces';
import { apiError } from '../Variables/VariableFields';
import { RunOutput } from '../Runs/RunHistory';

interface ServerResult {
  runId: number;
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs?: number;
  sandbox?: string;
}

interface Props {
  snippet: Snippet;
  site: Site | null;
  inputs: Record<string, string>;
  onClose: () => void;
}

const sandboxLabel: { [mode: string]: string } = {
  bwrap: 'Sandboxed with bubblewrap',
  docker: 'Sandboxed in a Docker container',
  none: 'Not sandboxed'
};

const jobLabel = (job: AgentJobState): string =>
  ({
    queued: 'Waiting for the device',
    running: 'Running',
    done: 'Done',
    failed: 'Failed',
    expired: 'Expired'
  }[job.status]);

export const SnippetRunModal = (props: Props): JSX.Element => {
  const { snippet, site, inputs, onClose } = props;
  const { snippetRun } = useContext(AuthContext);
  const serverCan =
    snippetRun.enabled && snippetRun.languages.includes(snippet.language.toLowerCase());
  const [devices, setDevices] = useState<Device[]>([]);
  const [target, setTarget] = useState<string>(serverCan ? 'server' : site ? 'all' : 'server');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [serverResult, setServerResult] = useState<ServerResult | null>(null);
  const [jobs, setJobs] = useState<AgentJobState[]>([]);
  const poller = useRef<number | null>(null);

  useEffect(() => {
    if (site) {
      axios
        .get<Response<Device[]>>('/api/devices', { params: { siteId: site.id } })
        .then(res => {
          setDevices(res.data.data);
          if (!serverCan && res.data.data.length) {
            setTarget('all');
          }
        })
        .catch(() => setDevices([]));
    }

    return () => {
      if (poller.current) {
        window.clearInterval(poller.current);
      }
    };
  }, [site?.id]);

  const pollJobs = (ids: number[]) => {
    const check = async () => {
      const res = await axios.get<Response<AgentJobState[]>>('/api/devices/jobs', {
        params: { ids: ids.join(',') }
      });
      setJobs(res.data.data);

      if (res.data.data.every(job => ['done', 'failed', 'expired'].includes(job.status))) {
        window.clearInterval(poller.current!);
        poller.current = null;
        setRunning(false);
      }
    };

    poller.current = window.setInterval(() => check().catch(() => undefined), 2000);
    check().catch(() => undefined);
  };

  const run = async () => {
    const where =
      target === 'server'
        ? 'the SnippyCode server'
        : target === 'all'
        ? `every device at ${site?.name}`
        : devices.find(device => String(device.id) === target)?.name;

    if (!window.confirm(`Run "${snippet.title}" on ${where}${site ? ` with ${site.name} values` : ''}?`)) {
      return;
    }

    setRunning(true);
    setError('');
    setServerResult(null);
    setJobs([]);

    try {
      if (target === 'server') {
        const res = await axios.post<Response<ServerResult>>(`/api/snippets/${snippet.id}/run`, {
          siteId: site?.id,
          variables: inputs
        });
        setServerResult(res.data.data);
        setRunning(false);
      } else {
        const res = await axios.post<Response<{ jobs: AgentJobState[] }>>(`/api/snippets/${snippet.id}/run`, {
          siteId: site?.id,
          deviceIds: target === 'all' ? 'all' : [Number(target)],
          variables: inputs
        });
        setJobs(res.data.data.jobs);
        pollJobs(res.data.data.jobs.map(job => job.id));
      }
    } catch (err) {
      setError(apiError(err, 'Could not start the run.'));
      setRunning(false);
    }
  };

  return (
    <div className='raw-modal-backdrop' role='dialog' aria-modal='true'>
      <div className='raw-modal'>
        <div className='raw-modal-header'>
          <div>
            <p className='eyebrow'>Run</p>
            <h3>{snippet.title}</h3>
          </div>
          <button type='button' onClick={onClose}>
            Close
          </button>
        </div>

        <div className='run-target'>
          <label>
            <span>Run on</span>
            <select
              className='form-control'
              value={target}
              onChange={e => setTarget(e.target.value)}
              disabled={running}
            >
              {serverCan && <option value='server'>SnippyCode server</option>}
              {site && devices.length > 0 && (
                <option value='all'>
                  {devices.length === 1 ? `The device at ${site.name}` : `All ${devices.length} devices at ${site.name}`}
                </option>
              )}
              {devices.map(device => (
                <option key={device.id} value={device.id}>
                  {device.online ? '● ' : '○ '}
                  {device.name}
                  {device.online ? '' : ' (offline, runs when it reconnects)'}
                </option>
              ))}
            </select>
          </label>
          <button type='button' className='btn btn-primary' onClick={run} disabled={running || (!serverCan && !devices.length)}>
            {running ? 'Running…' : 'Run'}
          </button>
        </div>

        {target === 'server' && serverCan && (
          <p className={`form-text ${snippetRun.sandbox === 'none' ? 'text-warning' : ''}`}>
            {sandboxLabel[snippetRun.sandbox || 'none']}
            {snippetRun.sandbox !== 'none'
              ? ` · no network${snippetRun.network ? ' limits (network allowed)' : ''} · ${snippetRun.memoryMb || 256} MB · ${Math.round(snippetRun.timeoutMs / 1000)}s`
              : ` · ${snippetRun.sandboxReason || ''}`}
          </p>
        )}
        {!serverCan && !devices.length && (
          <p className='form-text'>
            {site
              ? `${site.name} has no devices, and the server cannot run ${snippet.language}.`
              : 'Choose a site with devices, or enable server runs for this language.'}
          </p>
        )}
        {site && <p className='form-text'>Uses {site.name} values, secrets included. Output is saved with secrets masked.</p>}

        {error && <div className='alert alert-danger'>{error}</div>}

        {serverResult && (
          <>
            <div className='profile-meta'>
              <span>Result</span>
              <strong>
                {serverResult.timedOut ? 'Timed out' : serverResult.ok ? 'Exit 0' : `Exit ${serverResult.exitCode}`}
              </strong>
            </div>
            <label className='form-label'>stdout</label>
            <pre className='run-output'>{serverResult.stdout || '(empty)'}</pre>
            <label className='form-label'>stderr</label>
            <pre className='run-output'>{serverResult.stderr || '(empty)'}</pre>
          </>
        )}

        {jobs.length > 0 && (
          <ul className='run-list'>
            {jobs.map(job => (
              <li key={job.id} className='is-open'>
                <div className='run-row'>
                  <span
                    className={`run-status ${
                      job.status === 'done' ? 'is-ok' : job.status === 'failed' || job.status === 'expired' ? 'is-bad' : 'is-in_progress'
                    }`}
                  >
                    {jobLabel(job)}
                  </span>
                  <span className='run-row-main'>
                    <strong>{job.deviceName || `Device ${job.deviceId}`}</strong>
                    {job.run && (
                      <span>
                        {job.run.timedOut ? 'timed out' : `exit ${job.run.exitCode ?? '—'}`} ·{' '}
                        {(job.run.durationMs / 1000).toFixed(1)}s
                      </span>
                    )}
                  </span>
                </div>
                {job.run && <RunOutput run={job.run} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
