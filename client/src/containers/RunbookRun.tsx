import { useContext, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import axios from 'axios';
import { AuthContext, SnippetsContext } from '../store';
import { Card, Layout } from '../components/UI';
import { SnippetCode } from '../components/Snippets/SnippetCode';
import { RunOutput } from '../components/Runs/RunHistory';
import { apiError } from '../components/Variables/VariableFields';
import { RenderResult, Response, RunbookRunDetail, RunbookRunStepState } from '../typescript/interfaces';
import { canEditSnippets, copyAsync, dateParser, renderForDisplay, resolveVariables } from '../utils';
import { statusLabel } from './Runbooks';

const stepStatusLabel: { [status: string]: string } = {
  pending: 'To do',
  running: 'On the device…',
  done: 'Done',
  skipped: 'Skipped',
  failed: 'Failed'
};

export const RunbookRun = (): JSX.Element => {
  const { runId } = useParams<{ runId: string }>();
  const { user, snippetRun } = useContext(AuthContext);
  const { snippets, getSnippets, variables, getVariables } = useContext(SnippetsContext);
  const canEdit = canEditSnippets(user?.role);
  const [run, setRun] = useState<RunbookRunDetail | null>(null);
  const [busyStep, setBusyStep] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ stepId: number; text: string } | null>(null);
  const [error, setError] = useState('');

  const load = () =>
    axios
      .get<Response<RunbookRunDetail>>(`/api/runbooks/runs/${runId}`)
      .then(res => setRun(res.data.data))
      .catch(() => setError('This run does not exist or you do not have access to it.'));

  useEffect(() => {
    getSnippets();
    getVariables();
    load();
  }, [runId]);

  // While a device is working on a step (or an unattended run is moving), refresh
  const waiting = Boolean(
    run && (run.steps.some(step => step.status === 'running') || (run.scheduled && run.status === 'in_progress'))
  );

  useEffect(() => {
    if (!waiting) {
      return;
    }

    const timer = window.setInterval(load, 2500);
    return () => window.clearInterval(timer);
  }, [waiting, runId]);

  if (!run) {
    return (
      <Layout>
        <div className='col-12'>{error || 'Loading…'}</div>
      </Layout>
    );
  }

  const active = run.status !== 'cancelled';
  const siteVariables = run.site ? variables.site.filter(item => item.siteId === run.site!.id) : [];
  const percent = run.progress.total
    ? Math.round((run.steps.filter(step => step.status === 'done' || step.status === 'skipped').length / run.progress.total) * 100)
    : 0;

  const act = async (step: RunbookRunStepState, action: 'run' | 'done' | 'skip' | 'reset') => {
    if (
      action === 'run' &&
      !window.confirm(
        `Run "${step.title || step.snippet?.title}" on the SnippyCode server${
          run.site ? ` for ${run.site.name}` : ''
        }?`
      )
    ) {
      return;
    }

    setBusyStep(step.id);
    setError('');

    try {
      const res = await axios.post<Response<RunbookRunDetail>>(
        `/api/runbooks/runs/${run.id}/steps/${step.id}`,
        { action }
      );
      setRun(res.data.data);
    } catch (err) {
      setError(apiError(err, 'Could not update the step.'));
    } finally {
      setBusyStep(null);
    }
  };

  const copyStep = async (step: RunbookRunStepState) => {
    if (!step.snippetId) {
      return;
    }

    try {
      const rendered = axios
        .post<Response<RenderResult>>(`/api/snippets/${step.snippetId}/render`, {
          siteId: run.site?.id,
          purpose: 'copy'
        })
        .then(res => res.data.data);
      await copyAsync(rendered.then(result => result.code));
      const { missing } = await rendered;
      setNotice({
        stepId: step.id,
        text: missing.length
          ? `Copied. Still missing: ${missing.join(', ')}`
          : `Copied for ${run.site?.name || 'team values'}`
      });
    } catch (err) {
      setNotice({ stepId: step.id, text: apiError(err, 'Could not copy.') });
    }
  };

  const cancel = async () => {
    if (!window.confirm('Cancel this run? Finished steps stay in history.')) {
      return;
    }

    const res = await axios.post<Response<RunbookRunDetail>>(`/api/runbooks/runs/${run.id}/cancel`);
    setRun(res.data.data);
  };

  return (
    <Layout>
      <div className='col-12'>
        <Link to={run.runbookId ? `/runbooks/${run.runbookId}` : '/runbooks'} className='back-link'>
          {run.runbookId ? 'Back to runbook' : 'All runbooks'}
        </Link>
      </div>

      <div className='col-12'>
        <Card classes='variables-card'>
          <div className='variables-card-header'>
            <div>
              <p className='eyebrow'>Runbook run</p>
              <h2 className='runbook-title'>
                {run.runbookTitle}
                {run.site && (
                  <>
                    {' · '}
                    <Link to={`/sites/${run.site.id}`}>{run.site.name}</Link>
                  </>
                )}
              </h2>
              <p className='form-text mb-0'>
                Started by {run.user?.displayName || 'unknown'}{' '}
                {dateParser(run.createdAt).relative}
                {run.completedAt && ` · ${run.status === 'cancelled' ? 'cancelled' : 'finished'} ${dateParser(run.completedAt).relative}`}
                {!run.site && ' · using team values'}
                {run.device && ` · steps run on ${run.device.name}`}
                {run.scheduled && ' · started by a schedule'}
              </p>
            </div>
            <div className='variable-row-actions'>
              <span className={`run-status is-${run.status}`}>
                {statusLabel[run.status] || run.status}
              </span>
              {canEdit && (run.status === 'in_progress' || run.status === 'attention') && (
                <button type='button' className='btn btn-sm btn-outline-danger' onClick={cancel}>
                  Cancel run
                </button>
              )}
            </div>
          </div>
          <div className='runbook-progress' role='progressbar' aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${percent}%` }} />
          </div>
        </Card>
      </div>

      {error ? (
        <div className='col-12'>
          <div className='alert alert-danger mb-0'>{error}</div>
        </div>
      ) : (
        <></>
      )}

      <div className='col-12'>
        <ol className='runbook-steps is-run'>
          {run.steps.map((step, index) => {
            const snippet = snippets.find(item => item.id === step.snippetId);
            const resolved = snippet
              ? resolveVariables(snippet.code, {
                  personal: variables.personal,
                  site: siteVariables,
                  team: variables.team
                })
              : [];
            const missing = resolved.filter(variable => variable.source === 'missing');
            // On a device run the agent decides what it can run
            const canRunStep =
              canEdit &&
              active &&
              Boolean(step.snippet) &&
              step.status !== 'running' &&
              (Boolean(run.device) ||
                (snippetRun.enabled &&
                  snippetRun.languages.includes((step.snippet?.language || '').toLowerCase())));

            return (
              <li key={step.id} className={`runbook-run-step is-${step.status}`}>
                <Card classes='variables-card'>
                  <div className='variables-card-header'>
                    <div>
                      <p className='eyebrow mb-1'>
                        Step {index + 1} · <span className={`run-status is-step-${step.status}`}>{stepStatusLabel[step.status]}</span>
                      </p>
                      <h5 className='card-title mb-1'>
                        {step.title || step.snippet?.title || 'Missing snippet'}
                      </h5>
                      {step.snippet && (
                        <span className='runbook-step-kind'>
                          <Link to={`/snippet/${step.snippet.id}`}>{step.snippet.title}</Link> · {step.snippet.language}
                        </span>
                      )}
                      {step.note && <p className='runbook-step-note'>{step.note}</p>}
                      {step.completedAt && (
                        <p className='form-text mb-0'>
                          {stepStatusLabel[step.status]} by {step.completedBy || 'unknown'}{' '}
                          {dateParser(step.completedAt).relative}
                        </p>
                      )}
                    </div>
                    {canEdit && active && (
                      <div className='runbook-step-actions'>
                        {canRunStep && (
                          <button
                            type='button'
                            className='btn btn-sm btn-primary'
                            disabled={busyStep === step.id}
                            onClick={() => act(step, 'run')}
                          >
                            {busyStep === step.id
                              ? 'Starting…'
                              : step.lastRun
                              ? 'Run again'
                              : run.device
                              ? `Run on ${run.device.name}`
                              : 'Run on server'}
                          </button>
                        )}
                        {step.snippetId && (
                          <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => copyStep(step)}>
                            Copy
                          </button>
                        )}
                        {step.status !== 'done' && step.status !== 'running' && (
                          <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => act(step, 'done')}>
                            Mark done
                          </button>
                        )}
                        {step.status === 'pending' && (
                          <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => act(step, 'skip')}>
                            Skip
                          </button>
                        )}
                        {step.status !== 'pending' && (
                          <button type='button' className='btn btn-sm btn-link' onClick={() => act(step, 'reset')}>
                            Reset
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {notice?.stepId === step.id && <p className='form-text'>{notice.text}</p>}
                  {missing.length > 0 && (
                    <p className='raw-token-notice'>
                      No value for {missing.map(variable => variable.name).join(', ')}
                      {run.site ? ` on ${run.site.name}` : ''}.{' '}
                      {run.site && <Link to={`/sites/${run.site.id}`}>Set site values</Link>}
                    </p>
                  )}
                  {snippet && step.status === 'pending' && (
                    <SnippetCode code={renderForDisplay(snippet.code, resolved)} language={snippet.language} />
                  )}
                  {step.lastRun && (
                    <>
                      <p className='form-text mb-1'>
                        {step.lastRun.ok ? 'Exit 0' : step.lastRun.timedOut ? 'Timed out' : `Exit ${step.lastRun.exitCode}`} ·{' '}
                        {(step.lastRun.durationMs / 1000).toFixed(1)}s · {dateParser(step.lastRun.createdAt).relative}
                      </p>
                      <RunOutput run={step.lastRun} />
                    </>
                  )}
                </Card>
              </li>
            );
          })}
        </ol>
      </div>
    </Layout>
  );
};
