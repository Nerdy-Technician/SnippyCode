import { Fragment, useContext, useEffect, useMemo, useState } from 'react';
import { Link, useHistory, useLocation, useParams } from 'react-router-dom';
import axios from 'axios';
import { AuthContext, SnippetsContext } from '../store';
import { Card, Layout } from '../components/UI';
import {
  Device,
  Response,
  RunbookListItem,
  RunbookRunSummary,
  Site,
  SiteAccess,
  Variable
} from '../typescript/interfaces';
import { canEditSnippets, dateParser, findTemplateVariables, SECRET_MASK } from '../utils';
import {
  VariableDraft,
  VariableEditor,
  VariableValue,
  apiError,
  draftFrom,
  newDraft,
  saveVariable
} from '../components/Variables/VariableFields';
import { RunHistory } from '../components/Runs/RunHistory';
import { RunbookRunList } from './Runbooks';
import { SiteDevices } from '../components/Sites/SiteDevices';
import { DeviceCard } from '../components/Sites/DeviceCard';
import { SiteHealthGrid, SitePatching, SiteReport, useSitesHealth } from '../components/Sites/SiteHealth';
import { AlertList } from '../components/Alerts/AlertList';
import { hasMinimumRole } from '../utils/roles';

const SITE_TABS = ['overview', 'devices', 'alerts', 'patching', 'values', 'activity', 'report', 'access'] as const;
type SiteTab = typeof SITE_TABS[number];

interface SiteForm {
  name: string;
  slug: string;
  description: string;
  tags: string;
  access: SiteAccess;
}

const emptyForm: SiteForm = { name: '', slug: '', description: '', tags: '', access: 'everyone' };

const SiteFormFields = (props: {
  form: SiteForm;
  onChange: (form: SiteForm) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  saving: boolean;
}): JSX.Element => {
  const { form, onChange, onSubmit, onCancel, submitLabel, saving } = props;

  return (
    <form
      className='site-form'
      onSubmit={e => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label>
        <span>Name</span>
        <input
          className='form-control form-control-sm'
          value={form.name}
          onChange={e => onChange({ ...form, name: e.target.value })}
          placeholder='Acme Corp'
          autoFocus
        />
      </label>
      <label>
        <span>Slug (for ?site=)</span>
        <input
          className='form-control form-control-sm'
          value={form.slug}
          onChange={e => onChange({ ...form, slug: e.target.value })}
          placeholder='Made from the name'
        />
      </label>
      <label>
        <span>Tags</span>
        <input
          className='form-control form-control-sm'
          value={form.tags}
          onChange={e => onChange({ ...form, tags: e.target.value })}
          placeholder='prod, uk'
        />
      </label>
      <label>
        <span>Who can see it</span>
        <select
          className='form-control form-control-sm'
          value={form.access}
          onChange={e => onChange({ ...form, access: e.target.value as SiteAccess })}
        >
          <option value='everyone'>Everyone who can sign in</option>
          <option value='members'>Only members (and admins)</option>
        </select>
      </label>
      <label className='site-form-wide'>
        <span>Notes</span>
        <textarea
          className='form-control form-control-sm'
          rows={2}
          value={form.description}
          onChange={e => onChange({ ...form, description: e.target.value })}
        />
      </label>
      <div className='variable-editor-actions site-form-wide'>
        <button type='submit' className='btn btn-sm btn-primary' disabled={!form.name.trim() || saving}>
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button type='button' className='btn btn-sm btn-outline-secondary' onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
};

const siteToForm = (site: Site): SiteForm => ({
  name: site.name,
  slug: site.slug,
  description: site.description,
  tags: site.tags.join(', '),
  access: site.access
});

export const Sites = (): JSX.Element => {
  const { id } = useParams<{ id?: string }>();
  const history = useHistory();
  const { user } = useContext(AuthContext);
  const {
    sites,
    getSites,
    canManageSites,
    variables,
    getVariables,
    snippets,
    getSnippets,
    selectedSiteId,
    setSelectedSiteId
  } = useContext(SnippetsContext);
  const canEdit = canEditSnippets(user?.role);
  const site = sites.find(item => item.id === Number(id)) || null;

  const [creating, setCreating] = useState(false);
  const [editingSite, setEditingSite] = useState(false);
  const [form, setForm] = useState<SiteForm>(emptyForm);
  const [draft, setDraft] = useState<VariableDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [users, setUsers] = useState<{ id: number; displayName: string; email: string; role: string }[]>([]);
  const [memberIds, setMemberIds] = useState<number[]>([]);
  const [membersNotice, setMembersNotice] = useState('');
  const [runbooks, setRunbooks] = useState<RunbookListItem[]>([]);
  const [runbookToStart, setRunbookToStart] = useState('');
  const [runs, setRuns] = useState<RunbookRunSummary[] | null>(null);
  const [filter, setFilter] = useState('');
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [valueFilter, setValueFilter] = useState<'all' | 'overridden' | 'missing'>('all');
  const [indexView, setIndexView] = useState<'health' | 'values'>('health');
  const health = useSitesHealth();
  const location = useLocation();
  const tab: SiteTab = (SITE_TABS as readonly string[]).includes(new URLSearchParams(location.search).get('tab') || '')
    ? (new URLSearchParams(location.search).get('tab') as SiteTab)
    : 'overview';
  const setTab = (next: SiteTab) =>
    history.replace({ pathname: location.pathname, search: next === 'overview' ? '' : `?tab=${next}` });

  const loadDevices = () => {
    if (!site) {
      return;
    }

    axios
      .get<Response<Device[]>>('/api/devices', { params: { siteId: site.id } })
      .then(res => setDevices(res.data.data))
      .catch(() => setDevices([]));
  };

  // Keep device status fresh while the site is open
  useEffect(() => {
    setDevices(null);
    setValueFilter('all');

    if (!site) {
      return;
    }

    loadDevices();
    const timer = window.setInterval(loadDevices, 20_000);
    return () => window.clearInterval(timer);
  }, [site?.id]);

  useEffect(() => {
    getSites();
    getVariables();
    getSnippets();
    axios
      .get<Response<RunbookListItem[]>>('/api/runbooks')
      .then(res => setRunbooks(res.data.data))
      .catch(() => setRunbooks([]));
  }, []);

  useEffect(() => {
    setDraft(null);
    setEditingSite(false);
    setError('');
    setMembersNotice('');
    setMemberIds(site?.memberIds || []);

    if (site) {
      setRuns(null);
      axios
        .get<Response<RunbookRunSummary[]>>('/api/runbooks/runs', { params: { siteId: site.id } })
        .then(res => setRuns(res.data.data))
        .catch(() => setRuns([]));
    }
  }, [site?.id]);

  useEffect(() => {
    if (canManageSites && site && !users.length) {
      axios
        .get<Response<typeof users>>('/api/sites/users')
        .then(res => setUsers(res.data.data))
        .catch(() => setUsers([]));
    }
  }, [canManageSites, site?.id]);

  // Names worth showing: used by snippets, set for the team, or set on any site
  const names = useMemo(() => {
    const all = new Set<string>();
    snippets.forEach(snippet =>
      findTemplateVariables(snippet.code).forEach(variable => all.add(variable.name))
    );
    variables.team.forEach(variable => all.add(variable.name));
    variables.site.forEach(variable => all.add(variable.name));
    return Array.from(all).sort();
  }, [snippets, variables]);

  const usedNames = useMemo(() => {
    const used = new Set<string>();
    snippets.forEach(snippet => findTemplateVariables(snippet.code).forEach(variable => used.add(variable.name)));
    return used;
  }, [snippets]);

  const defaults = useMemo(() => {
    const map = new Map<string, string>();
    snippets.forEach(snippet =>
      findTemplateVariables(snippet.code).forEach(variable => {
        if (variable.defaultValue !== null && !map.has(variable.name)) {
          map.set(variable.name, variable.defaultValue);
        }
      })
    );
    return map;
  }, [snippets]);

  const teamValue = (name: string) => variables.team.find(item => item.name === name);
  const siteValue = (siteId: number, name: string) =>
    variables.site.find(item => item.siteId === siteId && item.name === name);

  const visibleSites = sites.filter(item => {
    const term = filter.trim().toLowerCase();
    return (
      !term ||
      item.name.toLowerCase().includes(term) ||
      item.tags.some(tag => tag.includes(term))
    );
  });

  const submitSite = async () => {
    setSaving(true);
    setError('');

    try {
      const body = { ...form, tags: form.tags };

      if (editingSite && site) {
        await axios.put(`/api/sites/${site.id}`, body);
        setEditingSite(false);
      } else {
        const res = await axios.post<Response<Site>>('/api/sites', body);
        setCreating(false);
        history.push(`/sites/${res.data.data.id}`);
      }

      setForm(emptyForm);
      getSites();
    } catch (err) {
      setError(apiError(err, 'Could not save the site.'));
    } finally {
      setSaving(false);
    }
  };

  const deleteSite = async () => {
    if (
      !site ||
      !window.confirm(
        `Delete ${site.name}? Its variables, secrets, and run history are deleted too.`
      )
    ) {
      return;
    }

    try {
      await axios.delete(`/api/sites/${site.id}`);
      if (selectedSiteId === site.id) {
        setSelectedSiteId(null);
      }
      getSites();
      getVariables();
      history.push('/sites');
    } catch (err) {
      setError(apiError(err, 'Could not delete the site.'));
    }
  };

  const saveDraft = async () => {
    if (!draft) {
      return;
    }

    setSaving(true);
    setError('');

    try {
      await saveVariable(draft);
      setDraft(null);
      getVariables();
      getSites();
    } catch (err) {
      setError(apiError(err, 'Could not save the value.'));
    } finally {
      setSaving(false);
    }
  };

  const clearValue = async (variable: Variable) => {
    if (!window.confirm(`Remove ${variable.name} from ${site?.name}? The team value applies instead.`)) {
      return;
    }

    try {
      await axios.delete(`/api/variables/${variable.id}`);
      getVariables();
      getSites();
    } catch (err) {
      setError(apiError(err, 'Could not remove the value.'));
    }
  };

  const saveMembers = async () => {
    if (!site) {
      return;
    }

    try {
      await axios.put(`/api/sites/${site.id}/members`, { userIds: memberIds });
      setMembersNotice('Members saved.');
      getSites();
    } catch (err) {
      setMembersNotice(apiError(err, 'Could not save members.'));
    }
  };

  const startRunbook = async () => {
    if (!site || !runbookToStart) {
      return;
    }

    try {
      const res = await axios.post<Response<RunbookRunSummary>>(
        `/api/runbooks/${runbookToStart}/runs`,
        { siteId: site.id }
      );
      history.push(`/runbooks/runs/${res.data.data.id}`);
    } catch (err) {
      setError(apiError(err, 'Could not start the runbook.'));
    }
  };

  const renderMatrix = () => (
    <Card classes='variables-card'>
      <p className='eyebrow'>All sites</p>
      <p className='form-text'>
        Each cell shows the value a snippet gets for that site. Faded values come from the team
        default or the snippet itself. <strong>Missing</strong> means a snippet uses it with
        nothing to fill in.
      </p>
      {sites.length === 0 || names.length === 0 ? (
        <p className='text-muted mb-0'>
          {sites.length === 0
            ? 'No sites yet.'
            : 'No variables yet. Add {{NAME}} placeholders to snippets first.'}
        </p>
      ) : (
        <div className='site-matrix-wrap'>
          <table className='site-matrix'>
            <thead>
              <tr>
                <th>Variable</th>
                <th>Team</th>
                {visibleSites.map(item => (
                  <th key={item.id}>
                    <Link to={`/sites/${item.id}`}>{item.name}</Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {names.map(name => {
                const team = teamValue(name);
                const fallback = team
                  ? team.isSecret
                    ? SECRET_MASK
                    : team.value
                  : defaults.get(name);

                return (
                  <tr key={name}>
                    <th>
                      <code>{name}</code>
                    </th>
                    <td className={team ? '' : 'is-inherited'}>
                      {team ? (team.isSecret ? `🔒 ${SECRET_MASK}` : team.value || '(empty)') : defaults.has(name) ? defaults.get(name) : '—'}
                    </td>
                    {visibleSites.map(item => {
                      const own = siteValue(item.id, name);

                      if (own) {
                        return (
                          <td key={item.id}>
                            {own.isSecret ? `🔒 ${SECRET_MASK}` : own.value || '(empty)'}
                          </td>
                        );
                      }

                      return fallback !== undefined ? (
                        <td key={item.id} className='is-inherited'>
                          {fallback || '(empty)'}
                        </td>
                      ) : (
                        <td key={item.id} className='is-missing'>
                          Missing
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );

  const siteNames = (current: Site) => {
    const overridden = names.filter(name => siteValue(current.id, name));
    const missing = names.filter(
      name => usedNames.has(name) && !siteValue(current.id, name) && !teamValue(name) && !defaults.has(name)
    );
    return { overridden, missing };
  };

  const renderValueRow = (current: Site, name: string) => {
    const own = siteValue(current.id, name);
    const team = teamValue(name);
    const editingThis = draft && ((own && draft.id === own.id) || (!draft.id && draft.name === name));

    if (editingThis) {
      return (
        <tr key={name} className='is-editing'>
          <td colSpan={4}>
            <VariableEditor
              draft={draft!}
              onChange={setDraft}
              onSave={saveDraft}
              onCancel={() => setDraft(null)}
              saving={saving}
              lockName={!draft!.id}
            />
          </td>
        </tr>
      );
    }

    const source = own ? 'site' : team ? 'team' : defaults.has(name) ? 'default' : 'missing';

    return (
      <tr key={name} className={`is-${source}`}>
        <th scope='row'>
          <code>{name}</code>
        </th>
        <td className='values-value'>
          {own ? (
            <VariableValue variable={own} canReveal={canEdit} showName={false} />
          ) : team ? (
            <code>{team.isSecret ? `🔒 ${SECRET_MASK}` : team.value || '(empty)'}</code>
          ) : defaults.has(name) ? (
            <code>{defaults.get(name) || '(empty)'}</code>
          ) : (
            <span className='text-muted'>—</span>
          )}
        </td>
        <td>
          <span className={`snippet-variable-source is-${source === 'site' ? 'site' : source}`}>
            {{ site: 'This site', team: 'Team', default: 'Snippet default', missing: 'Missing' }[source]}
          </span>
        </td>
        <td className='values-actions'>
          {canEdit &&
            (own ? (
              <>
                <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => setDraft(draftFrom(own))}>
                  Edit
                </button>
                <button type='button' className='btn btn-sm btn-outline-danger' onClick={() => clearValue(own)} title='Use the team value again'>
                  Clear
                </button>
              </>
            ) : (
              <button
                type='button'
                className='btn btn-sm btn-outline-secondary'
                onClick={() => setDraft({ ...newDraft('site', name, current.id), isSecret: Boolean(team?.isSecret) })}
              >
                {source === 'missing' ? 'Set value' : 'Override'}
              </button>
            ))}
        </td>
      </tr>
    );
  };

  const renderSite = (current: Site) => {
    const { overridden, missing } = siteNames(current);
    const online = (devices || []).filter(device => device.online);
    const offline = (devices || []).filter(device => !device.online);
    const outdated = (devices || []).filter(device => device.updateAvailable);
    const shownNames =
      valueFilter === 'overridden'
        ? names.filter(name => siteValue(current.id, name))
        : valueFilter === 'missing'
        ? missing
        : names;
    const eligibleMembers = users.filter(item => item.role !== 'admin' && item.role !== 'owner');
    const attention = [
      ...missing.map(name => ({ key: `m-${name}`, text: `${name} has no value here`, tab: 'values' as SiteTab })),
      ...offline.map(device => ({
        key: `o-${device.id}`,
        text: `${device.name} is offline${device.lastSeenAt ? ` (seen ${dateParser(device.lastSeenAt).relative})` : ''}`,
        tab: 'devices' as SiteTab
      })),
      ...outdated.map(device => ({
        key: `u-${device.id}`,
        text: `${device.name} runs agent ${device.agentVersion}; ${device.latestAgentVersion} is available`,
        tab: 'devices' as SiteTab
      }))
    ];
    const siteHealth = health?.[current.id];
    const tabs: { id: SiteTab; label: string; count?: number; tone?: string }[] = [
      { id: 'overview', label: 'Overview' },
      { id: 'devices', label: 'Devices', count: devices?.length },
      { id: 'alerts', label: 'Alerts', count: siteHealth?.alerts, tone: siteHealth?.critical ? 'bad' : 'warn' },
      { id: 'patching', label: 'Patching' },
      { id: 'values', label: 'Values', count: overridden.length },
      { id: 'activity', label: 'Activity' },
      { id: 'report', label: 'Report' },
      { id: 'access', label: 'Access' }
    ];

    return (
      <Fragment>
        <Card classes='variables-card site-hero'>
          {editingSite ? (
            <SiteFormFields
              form={form}
              onChange={setForm}
              onSubmit={submitSite}
              onCancel={() => setEditingSite(false)}
              submitLabel='Save site'
              saving={saving}
            />
          ) : (
            <>
              <div className='site-header'>
                <div>
                  <h2>{current.name}</h2>
                  <p className='site-meta'>
                    <span className={`site-access ${current.access === 'members' ? 'is-private' : ''}`}>
                      {current.access === 'members' ? '🔒 Members only' : 'Everyone'}
                    </span>
                    <code title='Use in raw links'>?site={current.slug}</code>
                    {current.tags.map(tag => (
                      <span key={tag} className='site-tag'>
                        {tag}
                      </span>
                    ))}
                  </p>
                  {current.description && <p className='site-description'>{current.description}</p>}
                </div>
                <div className='site-header-actions'>
                  {selectedSiteId === current.id ? (
                    <span className='site-selected'>✓ Snippets use this site</span>
                  ) : (
                    <button type='button' className='btn btn-sm btn-primary' onClick={() => setSelectedSiteId(current.id)}>
                      Use in snippets
                    </button>
                  )}
                  {canManageSites && (
                    <details className='device-menu'>
                      <summary className='btn btn-sm btn-outline-secondary' aria-label='Site actions'>
                        ⋯
                      </summary>
                      <div className='device-menu-list'>
                        <button
                          type='button'
                          onClick={() => {
                            setForm(siteToForm(current));
                            setEditingSite(true);
                          }}
                        >
                          Edit site
                        </button>
                        <button type='button' className='is-danger' onClick={deleteSite}>
                          Delete site
                        </button>
                      </div>
                    </details>
                  )}
                </div>
              </div>

              <div className='site-stats'>
                <button type='button' onClick={() => setTab('devices')}>
                  <strong>
                    {devices ? online.length : '…'}
                    <small>/{devices?.length ?? 0}</small>
                  </strong>
                  <span>devices online</span>
                </button>
                <button type='button' className={siteHealth?.alerts ? (siteHealth.critical ? 'is-bad' : 'is-warn') : ''} onClick={() => setTab('alerts')}>
                  <strong>{siteHealth ? siteHealth.alerts : '…'}</strong>
                  <span>open alerts</span>
                </button>
                <button type='button' className={siteHealth?.compliance !== null && siteHealth?.compliance !== undefined && siteHealth.compliance < 100 ? 'is-warn' : ''} onClick={() => setTab('patching')}>
                  <strong>{siteHealth?.compliance === null || siteHealth?.compliance === undefined ? '—' : `${siteHealth.compliance}%`}</strong>
                  <span>patched</span>
                </button>
                <button type='button' className={missing.length ? 'is-warn' : ''} onClick={() => { setValueFilter('missing'); setTab('values'); }}>
                  <strong>{missing.length}</strong>
                  <span>missing values</span>
                </button>
                <button type='button' onClick={() => setTab('activity')}>
                  <strong className='is-text'>{current.lastRunAt ? dateParser(current.lastRunAt).relative : 'Never'}</strong>
                  <span>last run</span>
                </button>
              </div>
            </>
          )}
        </Card>

        <div className='site-tabs' role='tablist' aria-label={`${current.name} sections`}>
          {tabs.map(item => (
            <button
              key={item.id}
              type='button'
              role='tab'
              aria-selected={tab === item.id}
              className={tab === item.id ? 'is-active' : ''}
              onClick={() => setTab(item.id)}
            >
              {item.label}
              {item.count !== undefined && item.count > 0 && <span className={`site-tab-count ${item.tone ? `is-${item.tone}` : ''}`}>{item.count}</span>}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <div className='site-overview'>
            <Card classes='variables-card'>
              <div className='site-section-head'>
                <h3>Needs attention</h3>
              </div>
              {attention.length === 0 ? (
                <p className='site-all-good'>✓ Nothing needs attention at {current.name}.</p>
              ) : (
                <ul className='attention-list'>
                  {attention.map(item => (
                    <li key={item.key}>
                      <button
                        type='button'
                        onClick={() => {
                          if (item.tab === 'values') {
                            setValueFilter('missing');
                          }
                          setTab(item.tab);
                        }}
                      >
                        <span className='attention-dot' aria-hidden='true' />
                        {item.text}
                        <span className='attention-go'>→</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card classes='variables-card'>
              <div className='site-section-head'>
                <h3>Devices</h3>
                <button type='button' className='btn btn-link btn-sm p-0' onClick={() => setTab('devices')}>
                  {devices && devices.length ? 'Manage' : 'Add a device'} →
                </button>
              </div>
              {devices === null ? (
                <p className='text-muted mb-0'>Loading…</p>
              ) : devices.length === 0 ? (
                <p className='text-muted mb-0'>No devices yet.</p>
              ) : (
                <div className='device-grid is-compact'>
                  {devices.slice(0, 4).map(device => (
                    <DeviceCard
                      key={device.id}
                      device={device}
                      compact
                      canManage={false}
                      canRun={false}
                      onRun={() => setTab('devices')}
                      onHistory={() => setTab('devices')}
                      onRename={() => undefined}
                      onRevoke={() => undefined}
                    />
                  ))}
                </div>
              )}
            </Card>

            <Card classes='variables-card site-overview-wide'>
              <div className='site-section-head'>
                <h3>Recent activity</h3>
                <button type='button' className='btn btn-link btn-sm p-0' onClick={() => setTab('activity')}>
                  All activity →
                </button>
              </div>
              <RunHistory query={{ siteId: current.id }} showSite={false} limit={5} empty={`Nothing has run for ${current.name} yet.`} />
            </Card>
          </div>
        )}

        {tab === 'devices' && (
          <Card classes='variables-card'>
            <SiteDevices
              siteId={current.id}
              siteName={current.name}
              devices={devices}
              canManage={canManageSites}
              canRun={canEdit}
              reload={loadDevices}
            />
          </Card>
        )}

        {tab === 'values' && (
          <Card classes='variables-card'>
            <div className='site-section-head'>
              <div>
                <h3>Values</h3>
                <p>What snippets get at {current.name}. Site values override team values; personal values still win for each user.</p>
              </div>
              {canEdit && !(draft && !draft.id && !names.includes(draft.name)) && (
                <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => setDraft(newDraft('site', '', current.id))}>
                  + New variable
                </button>
              )}
            </div>

            <div className='segmented mb-3'>
              {([
                ['all', `All (${names.length})`],
                ['overridden', `Set here (${overridden.length})`],
                ['missing', `Missing (${missing.length})`]
              ] as ['all' | 'overridden' | 'missing', string][]).map(([value, label]) => (
                <button key={value} type='button' className={valueFilter === value ? 'is-active' : ''} onClick={() => setValueFilter(value)}>
                  {label}
                </button>
              ))}
            </div>

            {draft && !draft.id && !names.includes(draft.name) && (
              <VariableEditor draft={draft} onChange={setDraft} onSave={saveDraft} onCancel={() => setDraft(null)} saving={saving} />
            )}

            {shownNames.length === 0 ? (
              <p className='text-muted mb-0'>
                {valueFilter === 'missing'
                  ? 'Every variable has a value here.'
                  : valueFilter === 'overridden'
                  ? `Nothing is set specifically for ${current.name} yet; it uses team values and snippet defaults.`
                  : 'No variables yet. Add {{NAME}} placeholders to snippets first.'}
              </p>
            ) : (
              <div className='values-table-wrap'>
                <table className='values-table'>
                  <thead>
                    <tr>
                      <th scope='col'>Variable</th>
                      <th scope='col'>Value at {current.name}</th>
                      <th scope='col'>From</th>
                      <th scope='col' aria-label='Actions' />
                    </tr>
                  </thead>
                  <tbody>{shownNames.map(name => renderValueRow(current, name))}</tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {tab === 'activity' && (
          <>
            <Card classes='variables-card'>
              <div className='site-section-head'>
                <div>
                  <h3>Runbooks</h3>
                  <p>Checklists worked through for {current.name}.</p>
                </div>
                {canEdit && runbooks.length > 0 && (
                  <div className='site-runbook-start'>
                    <select className='form-control form-control-sm' value={runbookToStart} onChange={e => setRunbookToStart(e.target.value)}>
                      <option value=''>Choose a runbook…</option>
                      {runbooks.map(item => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                    <button type='button' className='btn btn-sm btn-primary' disabled={!runbookToStart} onClick={startRunbook}>
                      Start
                    </button>
                  </div>
                )}
              </div>
              <RunbookRunList runs={runs} showSite={false} empty={`No runbooks run for ${current.name} yet.`} />
            </Card>

            <Card classes='variables-card'>
              <div className='site-section-head'>
                <h3>Runs</h3>
              </div>
              <RunHistory query={{ siteId: current.id }} showSite={false} empty={`Nothing has run for ${current.name} yet.`} />
            </Card>
          </>
        )}

        {tab === 'alerts' && (
          <Card classes='variables-card'>
            <AlertList
              query={{ siteId: current.id }}
              showSite={false}
              canAct={hasMinimumRole(user?.role, 'user')}
              empty={`No alerts at ${current.name}.`}
            />
          </Card>
        )}

        {tab === 'patching' && (
          <Card classes='variables-card'>
            <SitePatching siteId={current.id} />
          </Card>
        )}

        {tab === 'report' && (
          <Card classes='variables-card'>
            <SiteReport siteId={current.id} siteName={current.name} />
          </Card>
        )}

        {tab === 'access' && (
          <Card classes='variables-card'>
            <div className='site-section-head'>
              <div>
                <h3>Access</h3>
                <p>
                  {current.access === 'members'
                    ? `Only the people below, and admins, can see ${current.name}, use its values and secrets, run on its devices, or read its history.`
                    : `Everyone who can sign in can see ${current.name} and use its values.`}
                </p>
              </div>
              {canManageSites && (
                <button
                  type='button'
                  className='btn btn-sm btn-outline-secondary'
                  onClick={() => {
                    setForm({ ...siteToForm(current), access: current.access === 'members' ? 'everyone' : 'members' });
                    setEditingSite(true);
                  }}
                >
                  {current.access === 'members' ? 'Open to everyone…' : 'Make members only…'}
                </button>
              )}
            </div>

            {current.access === 'members' && canManageSites && (
              eligibleMembers.length === 0 ? (
                <div className='site-empty'>
                  <p>
                    Everyone with an account is an admin, and admins always have access. Add editor or
                    viewer accounts in <Link to='/admin'>Admin → Users</Link>, then choose here who can
                    see {current.name}.
                  </p>
                </div>
              ) : (
                <>
                  <div className='member-list'>
                    {eligibleMembers.map(item => (
                      <label key={item.id} className={`member-row ${memberIds.includes(item.id) ? 'is-member' : ''}`}>
                        <input
                          type='checkbox'
                          className='form-check-input'
                          checked={memberIds.includes(item.id)}
                          onChange={e =>
                            setMemberIds(currentIds =>
                              e.target.checked ? [...currentIds, item.id] : currentIds.filter(memberId => memberId !== item.id)
                            )
                          }
                        />
                        <span className='member-name'>{item.displayName}</span>
                        <span className='member-email'>{item.email}</span>
                        <span className='site-tag'>{item.role}</span>
                      </label>
                    ))}
                  </div>
                  <div className='variable-editor-actions mt-3'>
                    <button type='button' className='btn btn-sm btn-primary' onClick={saveMembers}>
                      Save members
                    </button>
                    {membersNotice && <span className='form-text'>{membersNotice}</span>}
                  </div>
                </>
              )
            )}
          </Card>
        )}
      </Fragment>
    );
  };

  if (!id) {
    return (
      <Layout>
        <div className='col-12'>
          <section className='variables-intro sites-intro'>
            <div>
              <p className='eyebrow'>Sites</p>
              <h1>Every customer and location at a glance</h1>
              <p>Device health, open alerts and patching for each site. Pick one for its devices, values, reports and access.</p>
            </div>
            <div className='sites-intro-actions'>
              {sites.length > 4 && (
                <input
                  className='form-control form-control-sm'
                  placeholder='Filter by name or tag'
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  aria-label='Filter sites'
                />
              )}
              {canManageSites && !creating && (
                <button
                  type='button'
                  className='btn btn-primary'
                  onClick={() => {
                    setForm(emptyForm);
                    setCreating(true);
                  }}
                >
                  New site
                </button>
              )}
            </div>
          </section>
        </div>

        {creating ? (
          <div className='col-12'>
            <Card classes='variables-card'>
              <SiteFormFields
                form={form}
                onChange={setForm}
                onSubmit={submitSite}
                onCancel={() => setCreating(false)}
                submitLabel='Create site'
                saving={saving}
              />
            </Card>
          </div>
        ) : (
          <></>
        )}

        <div className='col-12'>
          {error && <div className='alert alert-danger'>{error}</div>}
          <div className='site-tabs sites-index-tabs' role='tablist' aria-label='Sites view'>
            <button type='button' role='tab' aria-selected={indexView === 'health'} className={indexView === 'health' ? 'is-active' : ''} onClick={() => setIndexView('health')}>
              Health
            </button>
            <button type='button' role='tab' aria-selected={indexView === 'values'} className={indexView === 'values' ? 'is-active' : ''} onClick={() => setIndexView('values')}>
              Compare values
            </button>
          </div>
        </div>

        <div className='col-12'>
          {sites.length === 0 ? (
            <Card classes='variables-card'>
              <p className='text-muted mb-0'>
                {canManageSites
                  ? 'Create a site for each customer or location. Its values override team values, and its devices are grouped here.'
                  : 'No sites yet. Ask an admin to add one.'}
              </p>
            </Card>
          ) : indexView === 'health' ? (
            <SiteHealthGrid sites={visibleSites} health={health} selectedSiteId={selectedSiteId} />
          ) : (
            renderMatrix()
          )}
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className='col-12 col-lg-4 col-xl-3'>
        <Card classes='variables-card'>
          <div className='variables-card-header'>
            <p className='eyebrow mb-0'>Sites</p>
            {canManageSites && !creating && (
              <button
                type='button'
                className='btn btn-sm btn-outline-secondary'
                onClick={() => {
                  setForm(emptyForm);
                  setCreating(true);
                }}
              >
                New site
              </button>
            )}
          </div>
          {creating && (
            <SiteFormFields
              form={form}
              onChange={setForm}
              onSubmit={submitSite}
              onCancel={() => setCreating(false)}
              submitLabel='Create site'
              saving={saving}
            />
          )}
          {sites.length > 4 && (
            <input
              className='form-control form-control-sm mb-2'
              placeholder='Filter by name or tag'
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
          )}
          <Link to='/sites' className='tag-filter'>
            <span>← All sites</span>
            <span>{sites.length}</span>
          </Link>
          {visibleSites.map(item => (
            <Link
              key={item.id}
              to={`/sites/${item.id}`}
              className={`tag-filter ${site?.id === item.id ? 'is-active' : ''}`}
            >
              <span>
                {item.access === 'members' && '🔒 '}
                {item.name}
                {selectedSiteId === item.id && ' ✓'}
              </span>
              <span
                className='site-list-devices'
                title={
                  item.deviceCount
                    ? `${item.devicesOnline} of ${item.deviceCount} devices online`
                    : 'No devices'
                }
              >
                {item.deviceCount ? (
                  <>
                    <span className={`device-dot ${item.devicesOnline ? 'is-online' : ''}`} />
                    {item.devicesOnline}/{item.deviceCount}
                  </>
                ) : (
                  '—'
                )}
              </span>
            </Link>
          ))}
          {sites.length === 0 && !creating && (
            <p className='text-muted mb-0 mt-2'>
              {canManageSites
                ? 'Create a site for each customer or location. Its values override team values.'
                : 'No sites yet. Ask an admin to add one.'}
            </p>
          )}
        </Card>
      </div>

      <div className='col-12 col-lg-8 col-xl-9 d-grid gap-4 align-content-start'>
        {error && <div className='alert alert-danger mb-0'>{error}</div>}
        {id && !site ? (
          <Card classes='variables-card'>
            <p className='text-muted mb-0'>
              {sites.length ? 'This site does not exist or you do not have access to it.' : 'Loading…'}
            </p>
          </Card>
        ) : site ? (
          renderSite(site)
        ) : (
          renderMatrix()
        )}
      </div>
    </Layout>
  );
};
