import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { Response, SnippetRunRecord } from '../../typescript/interfaces';
import { dateParser } from '../../utils';

interface Props {
  query: { snippetId?: number; siteId?: number; runbookRunId?: number; deviceId?: number };
  showSnippet?: boolean;
  showSite?: boolean;
  limit?: number;
  empty?: string;
}

const resultLabel = (run: SnippetRunRecord): string =>
  run.timedOut ? 'Timed out' : run.ok ? 'OK' : `Exit ${run.exitCode}`;

export const RunOutput = (props: { run: SnippetRunRecord }): JSX.Element => (
  <div className='run-record-output'>
    {props.run.stdout && <pre className='run-output'>{props.run.stdout}</pre>}
    {props.run.stderr && <pre className='run-output is-stderr'>{props.run.stderr}</pre>}
    {!props.run.stdout && !props.run.stderr && <p className='text-muted mb-0'>No output.</p>}
  </div>
);

export const RunHistory = (props: Props): JSX.Element => {
  const { query, showSnippet = true, showSite = true, limit = 50, empty } = props;
  const [runs, setRuns] = useState<SnippetRunRecord[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<SnippetRunRecord | null>(null);
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    setRuns(null);
    setError('');
    axios
      .get<Response<SnippetRunRecord[]>>('/api/runs', { params: { ...query, limit } })
      .then(res => setRuns(res.data.data))
      .catch(() => setError('Could not load run history.'));
  }, [queryKey]);

  const toggle = async (run: SnippetRunRecord) => {
    if (open?.id === run.id) {
      setOpen(null);
      return;
    }

    // Lists carry a preview; load the full saved output
    setOpen(run);
    if (run.truncated) {
      const res = await axios.get<Response<SnippetRunRecord>>(`/api/runs/${run.id}`);
      setOpen(res.data.data);
    }
  };

  if (error) {
    return <p className='text-muted mb-0'>{error}</p>;
  }

  if (!runs) {
    return <p className='text-muted mb-0'>Loading…</p>;
  }

  if (!runs.length) {
    return <p className='text-muted mb-0'>{empty || 'No server runs yet.'}</p>;
  }

  return (
    <ul className='run-list'>
      {runs.map(run => (
        <li key={run.id} className={open?.id === run.id ? 'is-open' : ''}>
          <button type='button' className='run-row' onClick={() => toggle(run)}>
            <span className={`run-status ${run.ok ? 'is-ok' : 'is-bad'}`}>{resultLabel(run)}</span>
            <span className='run-row-main'>
              {showSnippet && <strong>{run.snippetTitle}</strong>}
              {showSite && <span>{run.site ? run.site.name : 'No site'}</span>}
              {run.deviceName && <span>on {run.deviceName}</span>}
              <span>{run.user?.displayName || 'Unknown user'}</span>
            </span>
            <span className='run-row-time' title={dateParser(run.createdAt).formatted}>
              {dateParser(run.createdAt).relative} · {(run.durationMs / 1000).toFixed(1)}s
            </span>
          </button>
          {open?.id === run.id && (
            <>
              <RunOutput run={open} />
              {run.snippetId && showSnippet && (
                <Link to={`/snippet/${run.snippetId}`} className='run-row-link'>
                  Open snippet
                </Link>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
};
