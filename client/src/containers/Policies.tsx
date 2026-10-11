import { useContext, useEffect, useState } from 'react';
import { Link, useHistory, useParams } from 'react-router-dom';
import axios from 'axios';
import { AuthContext, SnippetsContext } from '../store';
import { Card, Layout } from '../components/UI';
import { MonitorType, PatchSettings, Policy, PolicyMonitor, PolicyScope, Response } from '../typescript/interfaces';
import { canAdmin, dateParser } from '../utils';
import { apiError } from '../components/Variables/VariableFields';
import { describeCron } from '../components/Devices/CronEditor';

interface MonitorSpec {
  label: string;
  describe: (params: any) => string;
  defaults: { [key: string]: any };
  fields: { key: string; label: string; kind: 'number' | 'text' | 'bool'; suffix?: string }[];
  note?: string;
}

export const MONITORS: { [type in MonitorType]: MonitorSpec } = {
  offline: {
    label: 'Device offline',
    describe: p => `Offline for ${p.minutes} minutes`,
    defaults: { minutes: 10 },
    fields: [{ key: 'minutes', label: 'After', kind: 'number', suffix: 'minutes' }]
  },
  disk: {
    label: 'Disk space',
    describe: p => `Any disk above ${p.percent}% full`,
    defaults: { percent: 90 },
    fields: [{ key: 'percent', label: 'Above', kind: 'number', suffix: '% used' }]
  },
  cpu: {
    label: 'CPU load',
    describe: p => `CPU above ${p.percent}% for ${p.minutes} minutes`,
    defaults: { percent: 90, minutes: 15 },
    fields: [
      { key: 'percent', label: 'Above', kind: 'number', suffix: '%' },
      { key: 'minutes', label: 'For', kind: 'number', suffix: 'minutes' }
    ],
    note: 'Linux uses the 1-minute load average divided by the CPU count.'
  },
  memory: {
    label: 'Memory',
    describe: p => `Memory above ${p.percent}% for ${p.minutes} minutes`,
    defaults: { percent: 90, minutes: 10 },
    fields: [
      { key: 'percent', label: 'Above', kind: 'number', suffix: '%' },
      { key: 'minutes', label: 'For', kind: 'number', suffix: 'minutes' }
    ]
  },
  service: {
    label: 'Service watch',
    describe: p => `${p.name || '(service)'} running${p.autoRestart ? `; restart it up to ${p.maxRestarts} times an hour` : ''}`,
    defaults: { name: '', autoRestart: true, maxRestarts: 3 },
    fields: [
      { key: 'name', label: 'Service', kind: 'text' },
      { key: 'autoRestart', label: 'Restart it automatically', kind: 'bool' },
      { key: 'maxRestarts', label: 'At most', kind: 'number', suffix: 'restarts an hour' }
    ],
    note: 'With restarts on, the alert opens only when the service keeps stopping.'
  },
  process: {
    label: 'Process running',
    describe: p => `${p.name || '(process)'} is running`,
    defaults: { name: '' },
    fields: [{ key: 'name', label: 'Process name', kind: 'text' }]
  },
  failed_units: {
    label: 'Failed systemd units',
    describe: () => 'Any systemd unit has failed (Linux)',
    defaults: {},
    fields: []
  },
  reboot: {
    label: 'Restart pending',
    describe: () => 'The device needs a restart to finish updates',
    defaults: {},
    fields: []
  },
  updates: {
    label: 'Pending updates',
    describe: p => `${p.count}+ ${p.securityOnly ? 'security ' : ''}updates waiting`,
    defaults: { count: 1, securityOnly: true },
    fields: [
      { key: 'count', label: 'At least', kind: 'number', suffix: 'updates' },
      { key: 'securityOnly', label: 'Security updates only', kind: 'bool' }
    ]
  }
};

const STARTER: PolicyMonitor[] = [
  { type: 'offline', params: { minutes: 10 }, severity: 'critical', enabled: true },
  { type: 'disk', params: { percent: 90 }, severity: 'warning', enabled: true },
  { type: 'cpu', params: { percent: 90, minutes: 15 }, severity: 'warning', enabled: true },
  { type: 'memory', params: { percent: 95, minutes: 15 }, severity: 'warning', enabled: true },
  { type: 'failed_units', params: {}, severity: 'warning', enabled: true },
  { type: 'reboot', params: {}, severity: 'warning', enabled: true }
];

interface Form {
  name: string;
  description: string;
  enabled: boolean;
  scope: PolicyScope;
  patch: PatchSettings;
  monitors: PolicyMonitor[];
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const emptyForm = (): Form => ({
  name: '',
  description: '',
  enabled: true,
  scope: { all: false, siteIds: [], tags: [], deviceIds: [], os: 'any' },
  patch: { enabled: false, cron: '0 3 * * 0', timezone: browserZone(), mode: 'security', reboot: 'if-required' },
  monitors: STARTER.map(monitor => ({ ...monitor, params: { ...monitor.params } }))
});

const formFrom = (policy: Policy): Form => ({
  name: policy.name,
  description: policy.description,
  enabled: policy.enabled,
  scope: { all: false, siteIds: [], tags: [], deviceIds: [], os: 'any', ...policy.scope },
  patch: { ...emptyForm().patch, ...(policy.settings.patch || {}) },
  monitors: policy.monitors
});

export const scopeText = (scope: PolicyScope, siteNames: (ids: number[]) => string[]) => {
  const parts = scope.all
    ? ['every device']
    : [
        ...(scope.siteIds?.length ? [siteNames(scope.siteIds).join(', ')] : []),
        ...(scope.tags?.length ? [`sites tagged ${scope.tags.join(', ')}`] : []),
        ...(scope.deviceIds?.length ? [`${scope.deviceIds.length} chosen device${scope.deviceIds.length === 1 ? '' : 's'}`] : [])
      ];
  const os = scope.os && scope.os !== 'any' ? ` (${scope.os === 'linux' ? 'Linux' : 'Windows'} only)` : '';
  return parts.length ? `${parts.join(' + ')}${os}` : 'nothing yet';
};

const MonitorRow = (props: { monitor: PolicyMonitor; onChange: (monitor: PolicyMonitor) => void; onRemove: () => void }) => {
  const { monitor } = props;
  const spec = MONITORS[monitor.type];
  const set = (key: string, value: unknown) => props.onChange({ ...monitor, params: { ...monitor.params, [key]: value } });

  return (
    <div className={`monitor-row ${monitor.enabled ? '' : 'is-off'}`}>
      <div className='monitor-row-head'>
        <label className='form-check form-switch mb-0'>
          <input
            type='checkbox'
            className='form-check-input'
            checked={monitor.enabled}
            onChange={event => props.onChange({ ...monitor, enabled: event.target.checked })}
            aria-label={`${spec.label} on`}
          />
        </label>
        <strong>{spec.label}</strong>
        <select
          className='form-select form-select-sm monitor-severity'
          value={monitor.severity}
          onChange={event => props.onChange({ ...monitor, severity: event.target.value as PolicyMonitor['severity'] })}
          aria-label='Severity'
        >
          <option value='warning'>Warning</option>
          <option value='critical'>Critical</option>
        </select>
        <button type='button' className='btn btn-sm btn-link text-danger ms-auto' onClick={props.onRemove}>
          Remove
        </button>
      </div>
      {spec.fields.length > 0 && (
        <div className='monitor-fields'>
          {spec.fields.map(field =>
            field.kind === 'bool' ? (
              <label key={field.key} className='form-check'>
                <input type='checkbox' className='form-check-input' checked={Boolean(monitor.params[field.key])} onChange={event => set(field.key, event.target.checked)} />{' '}
                {field.label}
              </label>
            ) : (
              <label key={field.key} className='monitor-field'>
                <span>{field.label}</span>
                <input
                  className={`form-control form-control-sm ${field.kind === 'number' ? 'is-number' : ''}`}
                  value={monitor.params[field.key] ?? ''}
                  inputMode={field.kind === 'number' ? 'numeric' : undefined}
                  placeholder={field.kind === 'text' ? (monitor.type === 'service' ? 'nginx' : 'java') : undefined}
                  onChange={event => set(field.key, field.kind === 'number' ? Number(event.target.value.replace(/[^\d.]/g, '')) || '' : event.target.value)}
                />
                {field.suffix && <span className='text-muted'>{field.suffix}</span>}
              </label>
            )
          )}
        </div>
      )}
      {spec.note && <p className='form-text mb-0'>{spec.note}</p>}
    </div>
  );
};

const PolicyEditor = (props: { policy?: Policy; onSaved: (policy: Policy) => void; onCancel: () => void; onDeleted?: () => void }) => {
  const { sites, getSites } = useContext(SnippetsContext);
  const [form, setForm] = useState<Form>(props.policy ? formFrom(props.policy) : emptyForm());
  const [preview, setPreview] = useState<{ id: number; name: string; os: string; site: string | null; online: boolean }[] | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState<MonitorType | ''>('');
  const tags = Array.from(new Set(sites.flatMap(site => site.tags))).sort();

  useEffect(() => {
    getSites();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      axios
        .post<Response<NonNullable<typeof preview>>>('/api/policies/preview', { scope: form.scope })
        .then(res => setPreview(res.data.data))
        .catch(() => setPreview(null));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [JSON.stringify(form.scope)]);

  const set = (patch: Partial<Form>) => setForm(current => ({ ...current, ...patch }));
  const setScope = (patch: Partial<PolicyScope>) => setForm(current => ({ ...current, scope: { ...current.scope, ...patch } }));
  const setPatch = (patch: Partial<PatchSettings>) => setForm(current => ({ ...current, patch: { ...current.patch, ...patch } }));
  const toggleIn = (list: (string | number)[] = [], value: string | number) => (list.includes(value) ? list.filter(item => item !== value) : [...list, value]);

  const save = async () => {
    setSaving(true);
    setError('');
    const body = { name: form.name, description: form.description, enabled: form.enabled, scope: form.scope, settings: { patch: form.patch }, monitors: form.monitors };
    try {
      const res = props.policy
        ? await axios.put<Response<Policy>>(`/api/policies/${props.policy.id}`, body)
        : await axios.post<Response<Policy>>('/api/policies', body);
      props.onSaved(res.data.data);
    } catch (err) {
      setError(apiError(err, 'Could not save the policy.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!props.policy || !window.confirm(`Delete ${props.policy.name}? Its open alerts are resolved and its schedules are deleted.`)) return;
    try {
      await axios.delete(`/api/policies/${props.policy.id}`);
      props.onDeleted?.();
    } catch (err) {
      setError(apiError(err, 'Could not delete the policy.'));
    }
  };

  return (
    <form
      className='policy-editor'
      onSubmit={event => {
        event.preventDefault();
        save();
      }}
    >
      {error && <div className='alert alert-danger'>{error}</div>}

      <section className='policy-section'>
        <div className='policy-grid'>
          <label>
            <span>Name</span>
            <input className='form-control' value={form.name} onChange={event => set({ name: event.target.value })} placeholder='Prod Linux servers' required />
          </label>
          <label>
            <span>Description</span>
            <input className='form-control' value={form.description} onChange={event => set({ description: event.target.value })} placeholder='What this policy is for' />
          </label>
        </div>
        <label className='form-check form-switch mt-2'>
          <input type='checkbox' className='form-check-input' checked={form.enabled} onChange={event => set({ enabled: event.target.checked })} /> Policy is on
        </label>
      </section>

      <section className='policy-section'>
        <h3>Applies to</h3>
        <p className='form-text'>Devices are matched every check, so new devices at these sites or tags are covered automatically.</p>
        <label className='form-check'>
          <input type='checkbox' className='form-check-input' checked={Boolean(form.scope.all)} onChange={event => setScope({ all: event.target.checked })} /> Every device at every site
        </label>
        {!form.scope.all && (
          <>
            <div className='policy-chips-label'>Sites</div>
            <div className='policy-chips'>
              {sites.map(site => (
                <button key={site.id} type='button' className={`policy-chip ${form.scope.siteIds?.includes(site.id) ? 'is-on' : ''}`} aria-pressed={form.scope.siteIds?.includes(site.id)} onClick={() => setScope({ siteIds: toggleIn(form.scope.siteIds, site.id) as number[] })}>
                  {site.name}
                </button>
              ))}
            </div>
            {tags.length > 0 && (
              <>
                <div className='policy-chips-label'>Site tags</div>
                <div className='policy-chips'>
                  {tags.map(tag => (
                    <button key={tag} type='button' className={`policy-chip ${form.scope.tags?.includes(tag) ? 'is-on' : ''}`} aria-pressed={form.scope.tags?.includes(tag)} onClick={() => setScope({ tags: toggleIn(form.scope.tags, tag) as string[] })}>
                      #{tag}
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
        <div className='policy-chips-label'>Operating system</div>
        <div className='segmented'>
          {(['any', 'linux', 'windows'] as const).map(os => (
            <button key={os} type='button' className={(form.scope.os || 'any') === os ? 'is-active' : ''} onClick={() => setScope({ os })}>
              {os === 'any' ? 'Any' : os === 'linux' ? 'Linux' : 'Windows'}
            </button>
          ))}
        </div>
        <div className='policy-preview'>
          {preview === null ? (
            <span className='text-muted'>Checking…</span>
          ) : preview.length === 0 ? (
            <span className='text-muted'>No devices match yet.</span>
          ) : (
            <>
              <strong>
                {preview.length} device{preview.length === 1 ? '' : 's'} match:
              </strong>{' '}
              {preview.slice(0, 12).map((device, index) => (
                <span key={device.id}>
                  {index > 0 && ', '}
                  <Link to={`/devices/${device.id}`}>{device.name}</Link>
                  {device.site && <span className='text-muted'> ({device.site})</span>}
                </span>
              ))}
              {preview.length > 12 && <span className='text-muted'> and {preview.length - 12} more</span>}
            </>
          )}
        </div>
      </section>

      <section className='policy-section'>
        <h3>Monitors</h3>
        <p className='form-text'>Checked on every device check-in (about every two minutes). Alerts go to your notification channels and close on their own.</p>
        <div className='monitor-list'>
          {form.monitors.length === 0 && <p className='text-muted'>No monitors yet.</p>}
          {form.monitors.map((monitor, index) => (
            <MonitorRow
              key={monitor.id || `new-${index}`}
              monitor={monitor}
              onChange={next => set({ monitors: form.monitors.map((item, i) => (i === index ? next : item)) })}
              onRemove={() => set({ monitors: form.monitors.filter((_, i) => i !== index) })}
            />
          ))}
        </div>
        <div className='monitor-add'>
          <select className='form-select form-select-sm' value={adding} onChange={event => setAdding(event.target.value as MonitorType)} aria-label='Monitor type'>
            <option value=''>Add a monitor…</option>
            {(Object.keys(MONITORS) as MonitorType[]).map(type => (
              <option key={type} value={type}>
                {MONITORS[type].label}
              </option>
            ))}
          </select>
          <button
            type='button'
            className='btn btn-sm btn-outline-secondary'
            disabled={!adding}
            onClick={() => {
              if (!adding) return;
              set({ monitors: [...form.monitors, { type: adding, params: { ...MONITORS[adding].defaults }, severity: adding === 'offline' ? 'critical' : 'warning', enabled: true }] });
              setAdding('');
            }}
          >
            Add
          </button>
        </div>
      </section>

      <section className='policy-section'>
        <h3>Patch window</h3>
        <label className='form-check form-switch'>
          <input type='checkbox' className='form-check-input' checked={Boolean(form.patch.enabled)} onChange={event => setPatch({ enabled: event.target.checked })} /> Install updates on a schedule
        </label>
        {form.patch.enabled && (
          <div className='policy-grid mt-2'>
            <label>
              <span>When (cron)</span>
              <input className='form-control mono' value={form.patch.cron || ''} onChange={event => setPatch({ cron: event.target.value })} />
              <span className='form-text'>{form.patch.cron ? describeCron(form.patch.cron) : ''}</span>
            </label>
            <label>
              <span>Timezone</span>
              <input className='form-control' value={form.patch.timezone || ''} onChange={event => setPatch({ timezone: event.target.value })} />
            </label>
            <label>
              <span>Install</span>
              <select className='form-select' value={form.patch.mode} onChange={event => setPatch({ mode: event.target.value as PatchSettings['mode'] })}>
                <option value='security'>Security updates</option>
                <option value='all'>All updates</option>
              </select>
            </label>
            <label>
              <span>Then</span>
              <select className='form-select' value={form.patch.reboot} onChange={event => setPatch({ reboot: event.target.value as PatchSettings['reboot'] })}>
                <option value='never'>Don’t restart</option>
                <option value='if-required'>Restart if required</option>
                <option value='always'>Always restart</option>
              </select>
            </label>
          </div>
        )}
        <p className='form-text mb-0'>Uses apt or dnf on Linux and Windows Update on Windows. Offline devices are skipped until the next window.</p>
      </section>

      {props.policy && (
        <section className='policy-section'>
          <h3>Schedules</h3>
          {props.policy.schedules.length ? (
            <ul className='mb-2'>
              {props.policy.schedules.map(schedule => (
                <li key={schedule.id}>
                  <Link to={`/schedules/${schedule.id}`}>{schedule.name}</Link> <span className='text-muted'>· {describeCron(schedule.cron)}</span>
                  {!schedule.enabled && <span className='text-muted'> · paused</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className='text-muted mb-2'>No schedules run on this policy’s devices.</p>
          )}
          <Link to='/schedules?new=1' className='btn btn-sm btn-outline-secondary'>
            New schedule
          </Link>{' '}
          <span className='form-text'>Choose “A policy’s devices” under Where.</span>
        </section>
      )}

      <div className='variable-editor-actions'>
        <button type='submit' className='btn btn-primary' disabled={saving}>
          {saving ? 'Saving…' : props.policy ? 'Save policy' : 'Create policy'}
        </button>
        <button type='button' className='btn btn-outline-secondary' onClick={props.onCancel}>
          Cancel
        </button>
        {props.policy && (
          <button type='button' className='btn btn-outline-danger ms-auto' onClick={remove}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
};

export const Policies = (): JSX.Element => {
  const { user } = useContext(AuthContext);
  const { sites, getSites } = useContext(SnippetsContext);
  const { id } = useParams<{ id?: string }>();
  const history = useHistory();
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const admin = canAdmin(user?.role);

  const load = () =>
    axios
      .get<Response<Policy[]>>('/api/policies')
      .then(res => setPolicies(res.data.data))
      .catch(err => setError(apiError(err, 'Could not load policies.')));

  useEffect(() => {
    load();
    getSites();
  }, []);

  const siteNames = (ids: number[]) => sites.filter(site => ids.includes(site.id)).map(site => site.name);
  const editing = id === 'new' ? 'new' : policies?.find(policy => policy.id === Number(id));

  const patchNow = async (policy: Policy) => {
    if (!window.confirm(`Install ${policy.settings.patch?.mode === 'all' ? 'all' : 'security'} updates on ${policy.deviceCount} devices now?`)) return;
    try {
      const res = await axios.post<Response<{ devices: number }>>(`/api/policies/${policy.id}/patch`);
      setNotice(`Patching starts within a minute on ${res.data.data.devices} devices.`);
      load();
    } catch (err) {
      setError(apiError(err, 'Could not start patching.'));
    }
  };

  return (
    <Layout>
      <div className='col-12'>
        <section className='variables-intro'>
          <div>
            <p className='eyebrow'>Policies</p>
            <h1>Monitors and patching, applied by site or tag</h1>
            <p>
              A policy bundles monitors, a patch window and schedules, and applies them to sites, site tags or chosen devices. New devices
              are set up as soon as they enrol.
            </p>
          </div>
          {admin && !editing && (
            <button type='button' className='btn btn-primary' onClick={() => history.push('/policies/new')}>
              New policy
            </button>
          )}
        </section>
      </div>

      <div className='col-12'>
        {error && <div className='alert alert-danger'>{error}</div>}
        {notice && <div className='alert alert-success'>{notice}</div>}
      </div>

      {editing && admin ? (
        <div className='col-12'>
          <Card classes='variables-card'>
            <PolicyEditor
              key={editing === 'new' ? 'new' : editing.id}
              policy={editing === 'new' ? undefined : editing}
              onSaved={() => {
                load();
                history.push('/policies');
              }}
              onCancel={() => history.push('/policies')}
              onDeleted={() => {
                load();
                history.push('/policies');
              }}
            />
          </Card>
        </div>
      ) : (
        <div className='col-12 policy-list'>
          {policies === null ? (
            <p className='text-muted'>Loading…</p>
          ) : policies.length === 0 ? (
            <Card classes='variables-card'>
              <p className='mb-2'>No policies yet.</p>
              <p className='text-muted mb-0'>
                {admin ? 'Create one to start monitoring: it comes with sensible starter monitors (offline, disk, CPU, memory, failed services, pending restart).' : 'Ask an admin to create one.'}
              </p>
            </Card>
          ) : (
            policies.map(policy => (
              <Card key={policy.id} classes={`variables-card policy-card ${policy.enabled ? '' : 'is-off'}`}>
                <div className='policy-card-head'>
                  <div>
                    <h3>
                      {policy.name} {!policy.enabled && <span className='run-status'>off</span>}
                    </h3>
                    {policy.description && <p className='text-muted mb-1'>{policy.description}</p>}
                    <p className='policy-scope'>Applies to {scopeText(policy.scope, siteNames)}</p>
                  </div>
                  <div className='policy-card-stats'>
                    <span>
                      <strong>{policy.deviceCount}</strong> devices
                    </span>
                    <Link to='/alerts' className={policy.openAlerts ? 'has-alerts' : ''}>
                      <strong>{policy.openAlerts}</strong> open alerts
                    </Link>
                  </div>
                </div>
                <ul className='policy-monitors'>
                  {policy.monitors.map(monitor => (
                    <li key={monitor.id} className={monitor.enabled ? '' : 'is-off'}>
                      <span className={`alert-severity is-${monitor.severity}`} aria-label={monitor.severity}>
                        {monitor.severity === 'critical' ? '●' : '▲'}
                      </span>
                      {MONITORS[monitor.type]?.describe(monitor.params) || monitor.type}
                    </li>
                  ))}
                  {policy.monitors.length === 0 && <li className='text-muted'>No monitors</li>}
                </ul>
                <div className='policy-card-foot'>
                  <span className='text-muted'>
                    {policy.settings.patch?.enabled
                      ? `Patches ${policy.settings.patch.mode === 'all' ? 'everything' : 'security updates'}: ${describeCron(policy.settings.patch.cron || '')} (${policy.settings.patch.timezone})${policy.nextPatchAt ? `, next ${dateParser(policy.nextPatchAt).relative}` : ''}`
                      : 'No patch window'}
                    {policy.schedules.length > 0 && ` · ${policy.schedules.length} schedule${policy.schedules.length === 1 ? '' : 's'}`}
                  </span>
                  {admin && (
                    <span className='d-flex gap-2'>
                      {policy.settings.patch?.enabled && (
                        <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => patchNow(policy)}>
                          Patch now
                        </button>
                      )}
                      <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => history.push(`/policies/${policy.id}`)}>
                        Edit
                      </button>
                    </span>
                  )}
                </div>
              </Card>
            ))
          )}
        </div>
      )}
    </Layout>
  );
};
