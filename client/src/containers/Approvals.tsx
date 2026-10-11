import { useCallback, useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { AuthContext } from '../store';
import { Card, Layout } from '../components/UI';
import { apiError } from '../components/Variables/VariableFields';
import { RunApproval, dateParser, describeWhy, hasMinimumRole } from '../utils';

interface Settings {
  enabled: boolean;
  deviceThreshold: number;
  expiryHours: number;
}

const whatLink = (item: RunApproval) =>
  item.kind === 'snippet' && item.snippetId
    ? `/snippets/${item.snippetId}`
    : item.kind === 'runbook' && item.runbookId
    ? `/runbooks/${item.runbookId}`
    : item.scheduleId
    ? `/schedules/${item.scheduleId}`
    : null;

const Targets = ({ item }: { item: RunApproval }) => (
  <span title={item.targets.map(t => t.name).join(', ')}>
    {item.targets.slice(0, 3).map(t => t.name).join(', ')}
    {item.targetCount > 3 ? ` and ${item.targetCount - 3} more` : ''}
  </span>
);

const PendingRow = ({ item, onDone }: { item: RunApproval; onDone: () => void }) => {
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const link = whatLink(item);

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError('');
    try {
      await axios.post(`/api/approvals/${item.id}/${approve ? 'approve' : 'deny'}`, { comment });
      onDone();
    } catch (err) {
      setError(apiError(err, 'Could not save the decision.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className='approval-item'>
      <div className='d-flex justify-content-between flex-wrap gap-2'>
        <div>
          <strong>{link ? <Link to={link}>{item.title}</Link> : item.title}</strong>{' '}
          <span className='badge bg-warning text-dark'>{describeWhy(item.why)}</span>{' '}
          <span className='text-muted small'>
            {item.kind} · {item.trigger === 'schedule' ? 'scheduled' : 'manual'} · {item.targetCount} target(s)
          </span>
          <div className='small'>
            Requested by {item.requestedByName || 'unknown'} {dateParser(item.createdAt).relative}, expires{' '}
            {dateParser(item.expiresAt).relative}
          </div>
          <div className='small'>
            Targets: <Targets item={item} />
          </div>
          {item.reason && <div className='small'>Reason: {item.reason}</div>}
          {item.contentPreview ? (
            <details className='small mt-1'>
              <summary>What will run</summary>
              <pre className='approval-preview'>{item.contentPreview}</pre>
            </details>
          ) : (
            <></>
          )}
        </div>
        {item.canDecide ? (
          <div className='approval-actions d-flex gap-2 align-items-start'>
            <input
              className='form-control form-control-sm'
              placeholder='Comment (optional)'
              aria-label='Comment'
              value={comment}
              onChange={e => setComment(e.target.value)}
            />
            <button type='button' className='btn btn-sm btn-success' disabled={busy} onClick={() => decide(true)}>
              Approve
            </button>
            <button type='button' className='btn btn-sm btn-outline-danger' disabled={busy} onClick={() => decide(false)}>
              Deny
            </button>
          </div>
        ) : (
          <span className='text-muted small'>Waiting for another admin</span>
        )}
      </div>
      {error && <div className='alert alert-danger mt-2 mb-0'>{error}</div>}
    </li>
  );
};

const SettingsCard = () => {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState('');

  useEffect(() => {
    axios.get<{ data: Settings }>('/api/approvals/settings').then(res => setSettings(res.data.data)).catch(() => undefined);
  }, []);

  if (!settings) return <></>;

  const save = async () => {
    const res = await axios.put<{ data: Settings }>('/api/approvals/settings', settings);
    setSettings(res.data.data);
    setSaved('Saved');
  };

  return (
    <Card classes='variables-card approval-settings'>
      <h2 className='h6'>Settings</h2>
      <label className='form-check form-switch'>
        <input
          className='form-check-input'
          type='checkbox'
          checked={settings.enabled}
          onChange={e => setSettings({ ...settings, enabled: e.target.checked })}
        />
        <span className='form-check-label'>Require approval for risky runs</span>
      </label>
      <div className='form-text'>Only the owner can change these settings; every change is audited and notified.</div>
      <label className='form-label mt-2'>
        Large run: more than this many devices
        <input
          className='form-control'
          type='number'
          min={2}
          value={settings.deviceThreshold}
          onChange={e => setSettings({ ...settings, deviceThreshold: Number(e.target.value) })}
        />
      </label>
      <label className='form-label'>
        Requests expire after (hours)
        <input
          className='form-control'
          type='number'
          min={1}
          max={336}
          value={settings.expiryHours}
          onChange={e => setSettings({ ...settings, expiryHours: Number(e.target.value) })}
        />
      </label>
      <div className='d-flex gap-2 align-items-center'>
        <button type='button' className='btn btn-primary btn-sm' onClick={save}>
          Save
        </button>
        {saved && <span className='text-muted small'>{saved}</span>}
      </div>
    </Card>
  );
};

export const Approvals = (): JSX.Element => {
  const { user } = useContext(AuthContext);
  const isAdmin = hasMinimumRole(user?.role, 'admin');
  const [pending, setPending] = useState<RunApproval[] | null>(null);
  const [history, setHistory] = useState<RunApproval[] | null>(null);

  const load = useCallback(() => {
    axios.get<{ data: RunApproval[] }>('/api/approvals').then(res => setPending(res.data.data)).catch(() => setPending([]));
    axios
      .get<{ data: RunApproval[] }>('/api/approvals', { params: { status: 'history' } })
      .then(res => setHistory(res.data.data))
      .catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <Layout>
      <div className='col-12'>
        <section className='variables-intro'>
          <p className='eyebrow'>Approvals</p>
          <h1>Risky runs wait for an admin</h1>
          <p>
            Runs of dangerous snippets or runbooks, and runs on many devices, start only once another admin
            approves them. {isAdmin ? 'You cannot approve your own requests.' : 'You see your own requests here.'}
          </p>
        </section>
      </div>
      <div className='col-12 col-lg-8 d-grid gap-4 align-content-start'>
        <Card classes='variables-card'>
          <h2 className='h6'>Pending</h2>
          {pending === null && <p className='text-muted mb-0'>Loading…</p>}
          {pending?.length === 0 && <p className='text-muted mb-0'>Nothing is waiting.</p>}
          <ul className='list-unstyled approval-list mb-0'>
            {pending?.map(item => (
              <PendingRow key={item.id} item={item} onDone={load} />
            ))}
          </ul>
        </Card>
        <Card classes='variables-card'>
          <h2 className='h6'>History</h2>
          {history?.length === 0 && <p className='text-muted mb-0'>No decisions yet.</p>}
          {!!history?.length && (
            <div className='table-responsive'>
              <table className='table table-sm approval-history'>
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Status</th>
                    <th>Requested by</th>
                    <th>Decided by</th>
                    <th>Comment / result</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(item => (
                    <tr key={item.id}>
                      <td>
                        {item.title} <span className='text-muted small'>({describeWhy(item.why)})</span>
                      </td>
                      <td>{item.status}</td>
                      <td>{item.requestedByName || '-'}</td>
                      <td>{item.decidedByName || '-'}</td>
                      <td>{[item.decisionComment, item.result].filter(Boolean).join(' · ') || '-'}</td>
                      <td>{item.decidedAt ? dateParser(item.decidedAt).relative : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      {isAdmin ? (
        <div className='col-12 col-lg-4'>
          <SettingsCard />
        </div>
      ) : (
        <></>
      )}
    </Layout>
  );
};
