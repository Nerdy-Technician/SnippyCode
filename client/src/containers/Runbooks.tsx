import { useContext, useEffect, useState } from 'react';
import { Link, useHistory, useParams } from 'react-router-dom';
import axios from 'axios';
import { AuthContext, SnippetsContext } from '../store';
import { Card, Layout } from '../components/UI';
import {
  Device,
  Response,
  Runbook,
  RunbookListItem,
  RunbookRunSummary,
  RunbookStep
} from '../typescript/interfaces';
import { canEditSnippets, dateParser } from '../utils';
import { apiError } from '../components/Variables/VariableFields';

export const statusLabel: { [status: string]: string } = {
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
  attention: 'Needs a person'
};

export const RunbookRunList = (props: {
  runs: RunbookRunSummary[] | null;
  showSite?: boolean;
  showRunbook?: boolean;
  empty: string;
}): JSX.Element => {
  const { runs, showSite = true, showRunbook = true, empty } = props;

  if (!runs) {
    return <p className='text-muted mb-0'>Loading…</p>;
  }

  if (!runs.length) {
    return <p className='text-muted mb-0'>{empty}</p>;
  }

  return (
    <ul className='run-list'>
      {runs.map(run => (
        <li key={run.id}>
          <Link to={`/runbooks/runs/${run.id}`} className='run-row'>
            <span className={`run-status is-${run.status}`}>{statusLabel[run.status]}</span>
            <span className='run-row-main'>
              {showRunbook && <strong>{run.runbookTitle}</strong>}
              {showSite && (
                <span>
                  {run.site ? run.site.name : 'No site'}
                  {run.device ? ` / ${run.device.name}` : ''}
                </span>
              )}
              {run.scheduled && <span>scheduled</span>}
              <span>
                {run.progress.finished}/{run.progress.total} steps
                {run.progress.failed ? ` · ${run.progress.failed} failed` : ''}
              </span>
            </span>
            <span className='run-row-time'>
              {run.user?.displayName || 'Unknown'} · {dateParser(run.createdAt).relative}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
};

const RunbookList = (): JSX.Element => {
  const history = useHistory();
  const { user } = useContext(AuthContext);
  const canEdit = canEditSnippets(user?.role);
  const [runbooks, setRunbooks] = useState<RunbookListItem[] | null>(null);
  const [runs, setRuns] = useState<RunbookRunSummary[] | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    axios
      .get<Response<RunbookListItem[]>>('/api/runbooks')
      .then(res => setRunbooks(res.data.data))
      .catch(() => setRunbooks([]));
    axios
      .get<Response<RunbookRunSummary[]>>('/api/runbooks/runs', { params: { limit: 20 } })
      .then(res => setRuns(res.data.data))
      .catch(() => setRuns([]));
  }, []);

  const create = async () => {
    try {
      const res = await axios.post<Response<Runbook>>('/api/runbooks', { title, steps: [] });
      history.push(`/runbooks/${res.data.data.id}?edit=1`);
    } catch (err) {
      setError(apiError(err, 'Could not create the runbook.'));
    }
  };

  return (
    <Layout>
      <div className='col-12'>
        <section className='variables-intro'>
          <p className='eyebrow'>Runbooks</p>
          <h1>Repeatable checklists for each site</h1>
          <p>
            Chain snippets and manual steps in order, then work through them for one customer or
            site. Each step fills in that site's values, and server runs are kept in its history.
          </p>
        </section>
      </div>

      <div className='col-12 col-lg-7 d-grid gap-4 align-content-start'>
        {error && <div className='alert alert-danger mb-0'>{error}</div>}
        {canEdit && (
          <Card classes='variables-card'>
            <form
              className='runbook-create'
              onSubmit={e => {
                e.preventDefault();
                if (title.trim()) {
                  create();
                }
              }}
            >
              <input
                className='form-control'
                placeholder='New runbook, e.g. "Onboard a customer"'
                value={title}
                onChange={e => setTitle(e.target.value)}
              />
              <button type='submit' className='btn btn-primary' disabled={!title.trim()}>
                Create
              </button>
            </form>
          </Card>
        )}
        {runbooks === null ? (
          <p className='text-muted'>Loading…</p>
        ) : runbooks.length === 0 ? (
          <Card classes='variables-card'>
            <p className='text-muted mb-0'>No runbooks yet.</p>
          </Card>
        ) : (
          runbooks.map(runbook => (
            <Card key={runbook.id} classes='variables-card'>
              <div className='variables-card-header mb-0'>
                <div>
                  <h5 className='card-title mb-1'>
                    <Link to={`/runbooks/${runbook.id}`}>{runbook.title}</Link>
                  </h5>
                  {runbook.description && (
                    <p className='text-muted mb-1'>{runbook.description}</p>
                  )}
                  <p className='form-text mb-0'>
                    {runbook.stepCount} {runbook.stepCount === 1 ? 'step' : 'steps'}
                    {runbook.lastRun &&
                      ` · last run ${dateParser(runbook.lastRun.createdAt).relative}${
                        runbook.lastRun.site ? ` for ${runbook.lastRun.site.name}` : ''
                      }`}
                  </p>
                </div>
                <Link to={`/runbooks/${runbook.id}`} className='btn btn-sm btn-outline-secondary'>
                  Open
                </Link>
              </div>
            </Card>
          ))
        )}
      </div>

      <div className='col-12 col-lg-5'>
        <Card classes='variables-card'>
          <p className='eyebrow'>Recent runs</p>
          <RunbookRunList runs={runs} empty='No runbook runs yet.' />
        </Card>
      </div>
    </Layout>
  );
};

const RunbookDetail = (props: { id: number }): JSX.Element => {
  const history = useHistory();
  const { user, snippetRun } = useContext(AuthContext);
  const { snippets, getSnippets, sites, selectedSiteId } = useContext(SnippetsContext);
  const canEdit = canEditSnippets(user?.role);
  const [runbook, setRunbook] = useState<Runbook | null>(null);
  const [editing, setEditing] = useState(
    new URLSearchParams(window.location.search).get('edit') === '1'
  );
  const [draft, setDraft] = useState<{ title: string; description: string; steps: RunbookStep[] }>({
    title: '',
    description: '',
    steps: []
  });
  const [siteId, setSiteId] = useState<string>(selectedSiteId ? String(selectedSiteId) : '');
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [runs, setRuns] = useState<RunbookRunSummary[] | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => {
    axios
      .get<Response<Runbook>>(`/api/runbooks/${props.id}`)
      .then(res => {
        setRunbook(res.data.data);
        setDraft({
          title: res.data.data.title,
          description: res.data.data.description,
          steps: res.data.data.steps
        });
      })
      .catch(() => setError('Runbook was not found.'));
  };

  useEffect(() => {
    load();
    getSnippets();
    axios
      .get<Response<RunbookRunSummary[]>>('/api/runbooks/runs', { params: { runbookId: props.id } })
      .then(res => setRuns(res.data.data))
      .catch(() => setRuns([]));
  }, [props.id]);

  useEffect(() => {
    setDeviceId('');
    setDevices([]);

    if (siteId) {
      axios
        .get<Response<Device[]>>('/api/devices', { params: { siteId } })
        .then(res => setDevices(res.data.data))
        .catch(() => setDevices([]));
    }
  }, [siteId]);

  const updateStep = (index: number, patch: Partial<RunbookStep>) =>
    setDraft(current => ({
      ...current,
      steps: current.steps.map((step, i) => (i === index ? { ...step, ...patch } : step))
    }));

  const moveStep = (index: number, delta: number) =>
    setDraft(current => {
      const steps = [...current.steps];
      const target = index + delta;

      if (target < 0 || target >= steps.length) {
        return current;
      }

      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...current, steps };
    });

  const save = async () => {
    setSaving(true);
    setError('');

    try {
      const res = await axios.put<Response<Runbook>>(`/api/runbooks/${props.id}`, draft);
      setRunbook(res.data.data);
      setDraft({ ...draft, steps: res.data.data.steps });
      setEditing(false);
      history.replace(`/runbooks/${props.id}`);
    } catch (err) {
      setError(apiError(err, 'Could not save the runbook.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this runbook? Past runs stay in history.')) {
      return;
    }

    await axios.delete(`/api/runbooks/${props.id}`);
    history.push('/runbooks');
  };

  const start = async () => {
    try {
      const res = await axios.post<Response<RunbookRunSummary>>(`/api/runbooks/${props.id}/runs`, {
        siteId: Number(siteId) || undefined,
        deviceId: Number(deviceId) || undefined
      });
      history.push(`/runbooks/runs/${res.data.data.id}`);
    } catch (err) {
      setError(apiError(err, 'Could not start the runbook.'));
    }
  };

  const sortedSnippets = [...snippets].sort((a, b) => a.title.localeCompare(b.title));
  const runnable = (language?: string) =>
    Boolean(language) && snippetRun.enabled && snippetRun.languages.includes(language!.toLowerCase());

  if (!runbook) {
    return (
      <Layout>
        <div className='col-12'>{error || 'Loading…'}</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className='col-12'>
        <Link to='/runbooks' className='back-link'>
          All runbooks
        </Link>
      </div>

      <div className='col-12 col-lg-8 d-grid gap-4 align-content-start'>
        {error && <div className='alert alert-danger mb-0'>{error}</div>}
        <Card classes='variables-card'>
          {editing ? (
            <div className='runbook-editor'>
              <label>
                <span>Title</span>
                <input
                  className='form-control'
                  value={draft.title}
                  onChange={e => setDraft({ ...draft, title: e.target.value })}
                />
              </label>
              <label>
                <span>Description</span>
                <textarea
                  className='form-control'
                  rows={2}
                  value={draft.description}
                  onChange={e => setDraft({ ...draft, description: e.target.value })}
                />
              </label>

              <p className='eyebrow mt-3 mb-2'>Steps</p>
              {draft.steps.length === 0 && (
                <p className='text-muted'>Add snippets to run or copy, and manual steps to tick off.</p>
              )}
              <ol className='runbook-steps is-editing'>
                {draft.steps.map((step, index) => (
                  <li key={step.id || `new-${index}`} className='runbook-step'>
                    <div className='runbook-step-fields'>
                      <select
                        className='form-control form-control-sm'
                        value={step.snippetId || ''}
                        onChange={e => updateStep(index, { snippetId: Number(e.target.value) || null })}
                      >
                        <option value=''>Manual step (no snippet)</option>
                        {sortedSnippets.map(snippet => (
                          <option key={snippet.id} value={snippet.id}>
                            {snippet.title} · {snippet.language}
                          </option>
                        ))}
                      </select>
                      <input
                        className='form-control form-control-sm'
                        placeholder={step.snippetId ? 'Title (optional, defaults to the snippet)' : 'What to do'}
                        value={step.title}
                        onChange={e => updateStep(index, { title: e.target.value })}
                      />
                      <textarea
                        className='form-control form-control-sm'
                        rows={2}
                        placeholder='Notes (optional)'
                        value={step.note}
                        onChange={e => updateStep(index, { note: e.target.value })}
                      />
                    </div>
                    <div className='runbook-step-order'>
                      <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => moveStep(index, -1)} disabled={index === 0} aria-label='Move up'>
                        ↑
                      </button>
                      <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => moveStep(index, 1)} disabled={index === draft.steps.length - 1} aria-label='Move down'>
                        ↓
                      </button>
                      <button
                        type='button'
                        className='btn btn-sm btn-outline-danger'
                        onClick={() =>
                          setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })
                        }
                        aria-label='Remove step'
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
              <div className='variable-editor-actions'>
                <button
                  type='button'
                  className='btn btn-sm btn-outline-secondary'
                  onClick={() =>
                    setDraft({
                      ...draft,
                      steps: [...draft.steps, { snippetId: sortedSnippets[0]?.id || null, title: '', note: '' }]
                    })
                  }
                >
                  Add snippet step
                </button>
                <button
                  type='button'
                  className='btn btn-sm btn-outline-secondary'
                  onClick={() =>
                    setDraft({ ...draft, steps: [...draft.steps, { snippetId: null, title: '', note: '' }] })
                  }
                >
                  Add manual step
                </button>
              </div>
              <hr />
              <div className='variable-editor-actions'>
                <button type='button' className='btn btn-primary' onClick={save} disabled={saving || !draft.title.trim()}>
                  {saving ? 'Saving…' : 'Save runbook'}
                </button>
                <button
                  type='button'
                  className='btn btn-outline-secondary'
                  onClick={() => {
                    setDraft({ title: runbook.title, description: runbook.description, steps: runbook.steps });
                    setEditing(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className='variables-card-header'>
                <div>
                  <p className='eyebrow'>Runbook</p>
                  <h2 className='runbook-title'>{runbook.title}</h2>
                  {runbook.description && <p className='text-muted mb-0'>{runbook.description}</p>}
                </div>
                {canEdit && (
                  <div className='variable-row-actions'>
                    <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => setEditing(true)}>
                      Edit
                    </button>
                    <button type='button' className='btn btn-sm btn-outline-danger' onClick={remove}>
                      Delete
                    </button>
                  </div>
                )}
              </div>
              <ol className='runbook-steps'>
                {runbook.steps.map(step => (
                  <li key={step.id} className='runbook-step'>
                    <div>
                      <strong>{step.title || step.snippet?.title || 'Missing snippet'}</strong>
                      {step.snippet ? (
                        <span className='runbook-step-kind'>
                          <Link to={`/snippet/${step.snippet.id}`}>{step.snippet.title}</Link> ·{' '}
                          {step.snippet.language}
                          {runnable(step.snippet.language) ? ' · can run on server' : ' · copy and run'}
                        </span>
                      ) : (
                        <span className='runbook-step-kind'>
                          {step.snippetId === null ? 'Manual step' : 'Snippet was deleted'}
                        </span>
                      )}
                      {step.note && <p className='runbook-step-note'>{step.note}</p>}
                    </div>
                  </li>
                ))}
              </ol>
              {runbook.steps.length === 0 && <p className='text-muted mb-0'>No steps yet.</p>}
            </>
          )}
        </Card>
      </div>

      <div className='col-12 col-lg-4 d-grid gap-4 align-content-start'>
        {canEdit && !editing && (
          <Card classes='variables-card'>
            <p className='eyebrow'>Start a run</p>
            <select className='form-control mb-2' value={siteId} onChange={e => setSiteId(e.target.value)}>
              <option value=''>No site (team values)</option>
              {sites.map(site => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
            {devices.length > 0 && (
              <select className='form-control mb-2' value={deviceId} onChange={e => setDeviceId(e.target.value)}>
                <option value=''>Run steps on the SnippyCode server</option>
                {devices.map(device => (
                  <option key={device.id} value={device.id}>
                    Run steps on {device.name}
                    {device.online ? '' : ' (offline)'}
                  </option>
                ))}
              </select>
            )}
            <button
              type='button'
              className='btn btn-primary w-100'
              onClick={start}
              disabled={runbook.steps.length === 0}
            >
              Start runbook
            </button>
          </Card>
        )}
        <Card classes='variables-card'>
          <p className='eyebrow'>Runs</p>
          <RunbookRunList runs={runs} showRunbook={false} empty='Not run yet.' />
        </Card>
      </div>
    </Layout>
  );
};

export const Runbooks = (): JSX.Element => {
  const { id } = useParams<{ id?: string }>();

  return id ? <RunbookDetail id={Number(id)} /> : <RunbookList />;
};
