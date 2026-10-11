import { useContext, useEffect, useMemo, useState } from 'react';
import { Link, useHistory, useParams } from 'react-router-dom';
import axios from 'axios';
import { AuthContext, SnippetsContext } from '../store';
import { Card, Layout } from '../components/UI';
import {
  Policy,
  Response,
  RunbookListItem,
  Schedule,
  ScheduleDetail,
  ScheduleSiteMode
} from '../typescript/interfaces';
import { canAdmin, canEditSnippets, dateParser } from '../utils';
import { apiError } from '../components/Variables/VariableFields';
import { RunOutput } from '../components/Runs/RunHistory';

const PRESETS: { label: string; cron: string }[] = [
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 02:00', cron: '0 2 * * *' },
  { label: 'Weekdays at 09:00', cron: '0 9 * * 1-5' },
  { label: 'Mondays at 09:00', cron: '0 9 * * mon' },
  { label: 'First of the month at 06:00', cron: '0 6 1 * *' }
];

const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const zones = (): string[] => {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const list = supported ? supported('timeZone') : [];
  return Array.from(new Set(['UTC', browserZone(), ...list]));
};

const formatIn = (iso: string, timezone: string): string => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(iso));
  } catch {
    return iso;
  }
};

const describeCron = (cron: string): string =>
  PRESETS.find(preset => preset.cron === cron)?.label || cron;

const describeWhere = (schedule: Schedule): string => {
  const where =
    schedule.siteMode === 'none'
      ? 'no site'
      : schedule.siteMode === 'all'
      ? 'all sites'
      : schedule.siteMode === 'tag'
      ? `sites tagged ${schedule.siteTag}`
      : schedule.siteMode === 'policy'
      ? `devices in policy ${schedule.policyName || '(deleted)'}`
      : schedule.siteNames.join(', ') || 'no sites';

  return `${where} · ${schedule.runOn === 'devices' ? 'on their devices' : 'on the server'}`;
};

const statusText: { [status: string]: string } = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  attention: 'Needs a person'
};

const statusClass = (status: string | null): string =>
  status === 'succeeded' ? 'is-ok' : status === 'failed' ? 'is-bad' : status ? 'is-in_progress' : '';

interface Form {
  name: string;
  targetType: 'snippet' | 'runbook';
  snippetId: string;
  runbookId: string;
  cron: string;
  timezone: string;
  siteMode: ScheduleSiteMode;
  siteIds: number[];
  siteTag: string;
  policyId: string;
  runOn: 'server' | 'devices';
  notifyOn: 'failure' | 'always' | 'never';
  enabled: boolean;
}

const emptyForm = (): Form => ({
  name: '',
  targetType: 'snippet',
  snippetId: '',
  runbookId: '',
  cron: '0 9 * * mon',
  timezone: browserZone(),
  siteMode: 'none',
  siteIds: [],
  siteTag: '',
  policyId: '',
  runOn: 'server',
  notifyOn: 'failure',
  enabled: true
});

const formFrom = (schedule: Schedule): Form => ({
  name: schedule.name,
  targetType: schedule.targetType,
  snippetId: String(schedule.snippetId || ''),
  runbookId: String(schedule.runbookId || ''),
  cron: schedule.cron,
  timezone: schedule.timezone,
  siteMode: schedule.siteMode,
  siteIds: schedule.siteIds,
  siteTag: schedule.siteTag,
  policyId: String(schedule.policyId || ''),
  runOn: schedule.runOn,
  notifyOn: schedule.notifyOn,
  enabled: schedule.enabled
});

const ScheduleForm = (props: {
  initial: Form;
  onSaved: (schedule: Schedule) => void;
  onCancel: () => void;
  id?: number;
}): JSX.Element => {
  const { user } = useContext(AuthContext);
  const { snippets, getSnippets, sites, getSites } = useContext(SnippetsContext);
  const [form, setForm] = useState<Form>(props.initial);
  const [runbooks, setRunbooks] = useState<RunbookListItem[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [preview, setPreview] = useState<{ valid: boolean; error?: string; next: string[] } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const admin = canAdmin(user?.role);
  const tags = useMemo(() => Array.from(new Set(sites.flatMap(site => site.tags))).sort(), [sites]);

  useEffect(() => {
    getSnippets();
    getSites();
    axios.get<Response<RunbookListItem[]>>('/api/runbooks').then(res => setRunbooks(res.data.data)).catch(() => undefined);
    axios.get<Response<Policy[]>>('/api/policies').then(res => setPolicies(res.data.data)).catch(() => undefined);
  }, []);

  // Live preview of the next run times
  useEffect(() => {
    const timer = window.setTimeout(() => {
      axios
        .get<Response<{ valid: boolean; error?: string; next: string[] }>>('/api/schedules/preview', {
          params: { cron: form.cron, timezone: form.timezone }
        })
        .then(res => setPreview(res.data.data))
        .catch(() => setPreview(null));
    }, 300);

    return () => window.clearTimeout(timer);
  }, [form.cron, form.timezone]);

  const set = (patch: Partial<Form>) => setForm(current => ({ ...current, ...patch }));

  const save = async () => {
    setSaving(true);
    setError('');

    const body = {
      ...form,
      snippetId: Number(form.snippetId) || undefined,
      runbookId: Number(form.runbookId) || undefined,
      policyId: Number(form.policyId) || undefined
    };

    try {
      const res = props.id
        ? await axios.put<Response<Schedule>>(`/api/schedules/${props.id}`, body)
        : await axios.post<Response<Schedule>>('/api/schedules', body);
      props.onSaved(res.data.data);
    } catch (err) {
      setError(apiError(err, 'Could not save the schedule.'));
    } finally {
      setSaving(false);
    }
  };

  const sortedSnippets = [...snippets].sort((a, b) => a.title.localeCompare(b.title));

  return (
    <form
      className='schedule-form'
      onSubmit={event => {
        event.preventDefault();
        save();
      }}
    >
      {error && <div className='alert alert-danger schedule-form-wide'>{error}</div>}

      <label className='schedule-form-wide'>
        <span>Name</span>
        <input
          className='form-control'
          value={form.name}
          onChange={e => set({ name: e.target.value })}
          placeholder='Weekly disk check'
          autoFocus
        />
      </label>

      <fieldset className='schedule-form-wide'>
        <legend>What</legend>
        <div className='segmented'>
          {(['snippet', 'runbook'] as const).map(type => (
            <button
              key={type}
              type='button'
              className={form.targetType === type ? 'is-active' : ''}
              onClick={() => set({ targetType: type })}
            >
              {type === 'snippet' ? 'A snippet' : 'A runbook'}
            </button>
          ))}
        </div>
        {form.targetType === 'snippet' ? (
          <select className='form-control' value={form.snippetId} onChange={e => set({ snippetId: e.target.value })}>
            <option value=''>Choose a snippet…</option>
            {sortedSnippets.map(snippet => (
              <option key={snippet.id} value={snippet.id}>
                {snippet.title} · {snippet.language}
              </option>
            ))}
          </select>
        ) : (
          <select className='form-control' value={form.runbookId} onChange={e => set({ runbookId: e.target.value })}>
            <option value=''>Choose a runbook…</option>
            {runbooks.map(runbook => (
              <option key={runbook.id} value={runbook.id}>
                {runbook.title} · {runbook.stepCount} steps
              </option>
            ))}
          </select>
        )}
      </fieldset>

      <fieldset className='schedule-form-wide'>
        <legend>When</legend>
        <div className='schedule-when'>
          <select
            className='form-control'
            value={PRESETS.some(preset => preset.cron === form.cron) ? form.cron : 'custom'}
            onChange={e => e.target.value !== 'custom' && set({ cron: e.target.value })}
            aria-label='Common timings'
          >
            {PRESETS.map(preset => (
              <option key={preset.cron} value={preset.cron}>
                {preset.label}
              </option>
            ))}
            <option value='custom'>Custom cron…</option>
          </select>
          <input
            className='form-control schedule-cron'
            value={form.cron}
            onChange={e => set({ cron: e.target.value })}
            spellCheck={false}
            aria-label='Cron expression'
          />
          <select className='form-control' value={form.timezone} onChange={e => set({ timezone: e.target.value })} aria-label='Timezone'>
            {zones().map(zone => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
        <p className='form-text mb-0'>
          minute hour day-of-month month day-of-week, e.g. <code>0 9 * * mon</code>.{' '}
          {preview?.valid === false ? (
            <span className='text-danger'>{preview.error}</span>
          ) : preview?.next.length ? (
            <>Next: {preview.next.slice(0, 3).map(next => formatIn(next, form.timezone)).join(' · ')}</>
          ) : null}
        </p>
      </fieldset>

      <fieldset className='schedule-form-wide'>
        <legend>Where</legend>
        <div className='segmented'>
          {([
            ['none', 'No site'],
            ['sites', 'Chosen sites'],
            ['tag', 'Sites with a tag'],
            ['all', 'All sites'],
            ['policy', 'A policy’s devices']
          ] as [ScheduleSiteMode, string][])
            .filter(([mode]) => admin || mode === 'none' || mode === 'sites')
            .map(([mode, label]) => (
              <button
                key={mode}
                type='button'
                className={form.siteMode === mode ? 'is-active' : ''}
                onClick={() => set({ siteMode: mode, runOn: mode === 'none' ? 'server' : mode === 'policy' ? 'devices' : form.runOn })}
              >
                {label}
              </button>
            ))}
        </div>
        {form.siteMode === 'sites' && (
          <div className='schedule-sites'>
            {sites.map(site => (
              <label key={site.id} className='site-member'>
                <input
                  type='checkbox'
                  className='form-check-input'
                  checked={form.siteIds.includes(site.id)}
                  onChange={e =>
                    set({
                      siteIds: e.target.checked
                        ? [...form.siteIds, site.id]
                        : form.siteIds.filter(id => id !== site.id)
                    })
                  }
                />
                <span>{site.name}</span>
              </label>
            ))}
          </div>
        )}
        {form.siteMode === 'tag' && (
          <select className='form-control' value={form.siteTag} onChange={e => set({ siteTag: e.target.value })}>
            <option value=''>Choose a tag…</option>
            {tags.map(tag => (
              <option key={tag} value={tag}>
                {tag} ({sites.filter(site => site.tags.includes(tag)).length} sites)
              </option>
            ))}
          </select>
        )}
        {form.siteMode === 'policy' && (
          <>
            <select className='form-control' value={form.policyId} onChange={e => set({ policyId: e.target.value })}>
              <option value=''>Choose a policy…</option>
              {policies.map(policy => (
                <option key={policy.id} value={policy.id}>
                  {policy.name} ({policy.deviceCount} devices)
                </option>
              ))}
            </select>
            <p className='form-text mb-0'>Runs on every device the policy covers, including devices that join it later.</p>
          </>
        )}
        {form.siteMode !== 'none' && form.siteMode !== 'policy' && (
          <div className='segmented mt-2'>
            {([
              ['server', 'Run on the SnippyCode server'],
              ['devices', 'Run on each site’s devices']
            ] as ['server' | 'devices', string][]).map(([value, label]) => (
              <button
                key={value}
                type='button'
                className={form.runOn === value ? 'is-active' : ''}
                onClick={() => set({ runOn: value })}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </fieldset>

      <label>
        <span>Notify</span>
        <select
          className='form-control'
          value={form.notifyOn}
          onChange={e => set({ notifyOn: e.target.value as Form['notifyOn'] })}
        >
          <option value='failure'>When something fails</option>
          <option value='always'>After every run</option>
          <option value='never'>Never</option>
        </select>
      </label>
      <label className='schedule-enabled'>
        <input
          type='checkbox'
          className='form-check-input'
          checked={form.enabled}
          onChange={e => set({ enabled: e.target.checked })}
        />
        <span>Enabled</span>
      </label>
      <p className='form-text schedule-form-wide mb-0'>
        Alerts go to the channels set up in Admin → Notifications.
      </p>

      <div className='variable-editor-actions schedule-form-wide'>
        <button type='submit' className='btn btn-primary' disabled={saving || !form.name.trim()}>
          {saving ? 'Saving…' : props.id ? 'Save schedule' : 'Create schedule'}
        </button>
        <button type='button' className='btn btn-outline-secondary' onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
};

const ScheduleList = (): JSX.Element => {
  const history = useHistory();
  const { user } = useContext(AuthContext);
  const canEdit = canEditSnippets(user?.role);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [creating, setCreating] = useState(new URLSearchParams(window.location.search).get('new') === '1');

  const load = () =>
    axios
      .get<Response<Schedule[]>>('/api/schedules')
      .then(res => setSchedules(res.data.data))
      .catch(() => setSchedules([]));

  useEffect(() => {
    load();
  }, []);

  return (
    <Layout>
      <div className='col-12'>
        <section className='variables-intro schedules-intro'>
          <div>
            <p className='eyebrow'>Schedules</p>
            <h1>Run snippets and runbooks on a timetable</h1>
            <p>
              Pick what to run, when, and where: the server or every device at a set of sites. Failures
              are sent to your notification channels.
            </p>
          </div>
          {canEdit && !creating && (
            <button type='button' className='btn btn-primary' onClick={() => setCreating(true)}>
              New schedule
            </button>
          )}
        </section>
      </div>

      {creating ? (
        <div className='col-12'>
          <Card classes='variables-card'>
            <ScheduleForm
              initial={emptyForm()}
              onSaved={schedule => history.push(`/schedules/${schedule.id}`)}
              onCancel={() => setCreating(false)}
            />
          </Card>
        </div>
      ) : (
        <></>
      )}

      <div className='col-12 d-grid gap-3'>
        {schedules === null ? (
          <p className='text-muted'>Loading…</p>
        ) : schedules.length === 0 ? (
          <Card classes='variables-card'>
            <p className='text-muted mb-0'>No schedules yet.</p>
          </Card>
        ) : (
          schedules.map(schedule => (
            <Link key={schedule.id} to={`/schedules/${schedule.id}`} className='schedule-row'>
              <span className={`run-status ${statusClass(schedule.lastStatus)}`}>
                {schedule.enabled ? statusText[schedule.lastStatus || ''] || 'Not run yet' : 'Paused'}
              </span>
              <span className='schedule-row-main'>
                <strong>{schedule.name}</strong>
                <span>
                  {schedule.target ? schedule.target.title : 'Missing target'} · {describeWhere(schedule)}
                </span>
              </span>
              <span className='schedule-row-when'>
                <span>{describeCron(schedule.cron)}</span>
                <span>
                  {schedule.enabled && schedule.nextRunAt
                    ? `Next ${formatIn(schedule.nextRunAt, schedule.timezone)}`
                    : 'Paused'}
                </span>
              </span>
            </Link>
          ))
        )}
      </div>
    </Layout>
  );
};

const ScheduleView = (props: { id: number }): JSX.Element => {
  const history = useHistory();
  const { user } = useContext(AuthContext);
  const canEdit = canEditSnippets(user?.role);
  const [schedule, setSchedule] = useState<ScheduleDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  const load = () =>
    axios
      .get<Response<ScheduleDetail>>(`/api/schedules/${props.id}`)
      .then(res => setSchedule(res.data.data))
      .catch(() => setError('Schedule was not found.'));

  useEffect(() => {
    load();
  }, [props.id]);

  const running = Boolean(schedule?.runs.some(run => run.status === 'running'));

  useEffect(() => {
    if (!running) {
      return;
    }

    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [running]);

  if (!schedule) {
    return (
      <Layout>
        <div className='col-12'>{error || 'Loading…'}</div>
      </Layout>
    );
  }

  const runNow = async () => {
    if (!window.confirm(`Run "${schedule.name}" now?`)) {
      return;
    }

    try {
      await axios.post(`/api/schedules/${schedule.id}/run`);
      load();
    } catch (err) {
      setError(apiError(err, 'Could not start the schedule.'));
    }
  };

  const toggle = async () => {
    await axios.put(`/api/schedules/${schedule.id}`, {
      ...formFrom(schedule),
      snippetId: schedule.snippetId,
      runbookId: schedule.runbookId,
      enabled: !schedule.enabled
    });
    load();
  };

  const remove = async () => {
    if (window.confirm(`Delete "${schedule.name}" and its history?`)) {
      await axios.delete(`/api/schedules/${schedule.id}`);
      history.push('/schedules');
    }
  };

  return (
    <Layout>
      <div className='col-12'>
        <Link to='/schedules' className='back-link'>
          All schedules
        </Link>
      </div>
      {error ? (
        <div className='col-12'>
          <div className='alert alert-danger mb-0'>{error}</div>
        </div>
      ) : (
        <></>
      )}
      <div className='col-12'>
        <Card classes='variables-card'>
          {editing ? (
            <ScheduleForm
              id={schedule.id}
              initial={formFrom(schedule)}
              onSaved={() => {
                setEditing(false);
                load();
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <div className='site-header'>
              <div>
                <p className='eyebrow'>Schedule</p>
                <h2>{schedule.name}</h2>
                <p className='site-meta'>
                  <span className={`run-status ${statusClass(schedule.lastStatus)}`}>
                    {schedule.enabled ? statusText[schedule.lastStatus || ''] || 'Not run yet' : 'Paused'}
                  </span>
                  <span>
                    {schedule.targetType === 'runbook' ? 'Runbook ' : 'Snippet '}
                    {schedule.target ? (
                      <Link
                        to={
                          schedule.targetType === 'runbook'
                            ? `/runbooks/${schedule.target.id}`
                            : `/snippet/${schedule.target.id}`
                        }
                      >
                        {schedule.target.title}
                      </Link>
                    ) : (
                      'deleted'
                    )}
                  </span>
                </p>
                <p className='text-muted mb-0'>
                  {describeCron(schedule.cron)} (<code>{schedule.cron}</code>, {schedule.timezone}) ·{' '}
                  {describeWhere(schedule)} · notify{' '}
                  {schedule.notifyOn === 'failure' ? 'on failure' : schedule.notifyOn}
                </p>
                <p className='form-text mb-0'>
                  {schedule.enabled && schedule.nextRunAt
                    ? `Next run ${formatIn(schedule.nextRunAt, schedule.timezone)}`
                    : 'Paused'}
                  {schedule.createdBy && ` · created by ${schedule.createdBy}`}
                </p>
              </div>
              {canEdit && (
                <div className='site-header-actions'>
                  <button type='button' className='btn btn-sm btn-primary' onClick={runNow}>
                    Run now
                  </button>
                  <button type='button' className='btn btn-sm btn-outline-secondary' onClick={toggle}>
                    {schedule.enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => setEditing(true)}>
                    Edit
                  </button>
                  <button type='button' className='btn btn-sm btn-outline-danger' onClick={remove}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className='col-12'>
        <Card classes='variables-card'>
          <p className='eyebrow'>Recent runs</p>
          {schedule.runs.length === 0 ? (
            <p className='text-muted mb-0'>Not run yet.</p>
          ) : (
            <ul className='run-list'>
              {schedule.runs.map(run => (
                <li key={run.id} className={open === run.id ? 'is-open' : ''}>
                  <button type='button' className='run-row' onClick={() => setOpen(open === run.id ? null : run.id)}>
                    <span className={`run-status ${statusClass(run.status)}`}>{statusText[run.status]}</span>
                    <span className='run-row-main'>
                      <strong>
                        {run.results.length + run.runbookRuns.length}{' '}
                        {run.results.length + run.runbookRuns.length === 1 ? 'target' : 'targets'}
                        {run.pendingJobs ? ` · ${run.pendingJobs} waiting for devices` : ''}
                      </strong>
                      <span>{run.trigger === 'manual' ? 'run by hand' : 'on schedule'}</span>
                    </span>
                    <span className='run-row-time' title={dateParser(run.createdAt).formatted}>
                      {dateParser(run.createdAt).relative}
                    </span>
                  </button>
                  {open === run.id && (
                    <div className='schedule-results'>
                      {run.results.map(result => (
                        <details key={result.id} className='schedule-result'>
                          <summary>
                            <span className={`run-status ${result.ok ? 'is-ok' : 'is-bad'}`}>
                              {result.ok ? 'OK' : result.timedOut ? 'Timed out' : `Exit ${result.exitCode}`}
                            </span>
                            {result.site?.name || 'No site'}
                            {result.deviceName ? ` / ${result.deviceName}` : ''}
                          </summary>
                          <RunOutput run={result} />
                        </details>
                      ))}
                      {run.runbookRuns.map(item => (
                        <Link key={item.id} to={`/runbooks/runs/${item.id}`} className='schedule-result-link'>
                          Runbook run for {item.site || 'no site'}: {item.status.replace('_', ' ')}
                        </Link>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Layout>
  );
};

export const Schedules = (): JSX.Element => {
  const { id } = useParams<{ id?: string }>();
  return id ? <ScheduleView id={Number(id)} /> : <ScheduleList />;
};
