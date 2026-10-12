import { useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { SnippetsContext } from '../store';
import { Card, Layout } from '../components/UI';
import { SnippetDocs } from '../components/Snippets/SnippetDocs';
import { Response, Variable, VariableScope, VariableUsage } from '../typescript/interfaces';
import {
  VariableDraft,
  VariableEditor,
  VariableValue,
  apiError,
  draftFrom,
  newDraft,
  saveVariable
} from '../components/Variables/VariableFields';

const plural = (count: number, word: string): string =>
  `${count} ${count === 1 ? word : `${word}s`}`;

const TABS: Array<{ scope: VariableScope; label: string; help: string }> = [
  { scope: 'global', label: 'Global', help: 'Values for everyone. Only admins can change them. Sites and users override them.' },
  { scope: 'site', label: 'Site', help: 'Values for one site. Editors with access to the site can change them. They override global values.' },
  { scope: 'user', label: 'User', help: 'Only you see these. They override site and global values for you.' }
];

const emptyUsage: VariableUsage = { snippets: [], runbooks: [], schedules: [] };

export const UsedIn = ({ usage }: { usage: VariableUsage }): JSX.Element => {
  const total = usage.snippets.length + usage.runbooks.length + usage.schedules.length;

  if (!total) {
    return <span className='variable-usage'>Not used yet</span>;
  }

  return (
    <details className='variable-used-in'>
      <summary className='variable-usage'>
        Used in {[
          usage.snippets.length ? plural(usage.snippets.length, 'snippet') : '',
          usage.runbooks.length ? plural(usage.runbooks.length, 'runbook') : '',
          usage.schedules.length ? plural(usage.schedules.length, 'schedule') : ''
        ]
          .filter(Boolean)
          .join(', ')}
      </summary>
      <ul>
        {usage.snippets.map(item => (
          <li key={`s${item.id}`}>
            Snippet: <Link to={`/snippet/${item.id}`}>{item.title}</Link>
          </li>
        ))}
        {usage.runbooks.map(item => (
          <li key={`r${item.id}`}>
            Runbook: <Link to={`/runbooks/${item.id}`}>{item.title}</Link>
          </li>
        ))}
        {usage.schedules.map(item => (
          <li key={`c${item.id}`}>
            Schedule: <Link to={`/schedules/${item.id}`}>{item.name}</Link>
          </li>
        ))}
      </ul>
    </details>
  );
};

export const Variables = (): JSX.Element => {
  const { variables, getVariables, sites, getSites } = useContext(SnippetsContext);
  const [tab, setTab] = useState<VariableScope>('global');
  const [siteId, setSiteId] = useState<number | null>(null);
  const [draft, setDraft] = useState<VariableDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [usage, setUsage] = useState<Record<string, VariableUsage>>({});
  const [help, setHelp] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const loadUsage = () =>
    axios
      .get<Response<Record<string, VariableUsage>>>('/api/variables/usage')
      .then(res => setUsage(res.data.data))
      .catch(() => setUsage({}));

  useEffect(() => {
    getVariables();
    if (getSites) getSites();
    loadUsage();
  }, []);

  useEffect(() => {
    if (siteId === null && sites.length) setSiteId(sites[0].id);
  }, [sites]);

  useEffect(() => {
    if (showHelp && help === null) {
      axios
        .get<{ data: { markdown: string } }>('/api/help/variables')
        .then(res => setHelp(res.data.data.markdown))
        .catch(() => setHelp('The help page could not be loaded.'));
    }
  }, [showHelp]);

  const global = variables.global || variables.team || [];
  const user = variables.user || variables.personal || [];
  const canEditGlobal = Boolean(variables.canEditGlobal);
  const canEditSite = Boolean(variables.canEditSite);

  const items: Variable[] =
    tab === 'global' ? global : tab === 'user' ? user : variables.site.filter(item => item.siteId === siteId);
  const canEdit = tab === 'global' ? canEditGlobal : tab === 'site' ? canEditSite && siteId !== null : true;
  const current = TABS.find(item => item.scope === tab)!;
  const addingHere = draft && draft.scope === tab && !draft.id;

  const start = (next: VariableDraft) => {
    setError('');
    setDraft(next);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError('');
    try {
      await saveVariable(draft);
      setDraft(null);
      getVariables();
      loadUsage();
    } catch (err) {
      setError(apiError(err, 'Could not save the variable.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (variable: Variable) => {
    if (!window.confirm(`Delete ${variable.scope} variable ${variable.name}?`)) return;
    try {
      await axios.delete(`/api/variables/${variable.id}`);
      getVariables();
    } catch (err) {
      setError(apiError(err, 'Could not delete the variable.'));
    }
  };

  return (
    <Layout>
      <div className='col-12'>
        <section className='variables-intro'>
          <div className='d-flex justify-content-between align-items-start gap-3'>
            <div>
              <p className='eyebrow'>Variables</p>
              <h1>Fill in snippets once, reuse everywhere</h1>
            </div>
            <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => setShowHelp(!showHelp)}>
              {showHelp ? 'Hide help' : 'Help'}
            </button>
          </div>
          <p>
            Write <code>{'{{HOST}}'}</code> or <code>{'{{VERSION:1.2.0}}'}</code> in any snippet. The value
            comes from the first of: what you type when it runs, your <strong>user</strong> values, the
            device, the chosen <Link to='/sites'>site</Link>, <strong>global</strong> values, then the
            snippet default.
          </p>
          <p className='form-text mb-0'>
            Mark passwords and tokens as <strong>secret</strong>: they are encrypted, masked everywhere,
            left out of public links, and hidden in run history.
          </p>
        </section>
      </div>

      {showHelp ? (
        <div className='col-12'>
          <Card classes='variables-help'>
            {help === null ? <p className='text-muted mb-0'>Loading help…</p> : <SnippetDocs markdown={help} />}
          </Card>
        </div>
      ) : (
        <></>
      )}

      {error ? (
        <div className='col-12'>
          <div className='alert alert-danger mb-0'>{error}</div>
        </div>
      ) : (
        <></>
      )}

      <div className='col-12'>
        <ul className='nav nav-tabs variables-tabs' role='tablist'>
          {TABS.map(item => (
            <li className='nav-item' key={item.scope} role='presentation'>
              <button
                type='button'
                role='tab'
                aria-selected={tab === item.scope}
                className={`nav-link ${tab === item.scope ? 'active' : ''}`}
                onClick={() => {
                  setTab(item.scope);
                  setDraft(null);
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className='col-12 col-lg-9'>
        <Card classes='variables-card'>
          <div className='variables-card-header'>
            <div>
              <p className='eyebrow'>{current.label} values</p>
              <p className='form-text mb-0'>
                {current.help}
                {tab === 'global' && !canEditGlobal ? ' Ask an admin to change them.' : ''}
              </p>
            </div>
            {tab === 'site' && (
              <select
                className='form-select form-select-sm w-auto'
                aria-label='Site'
                value={siteId ?? ''}
                onChange={event => {
                  setSiteId(Number(event.target.value) || null);
                  setDraft(null);
                }}
              >
                {sites.length === 0 && <option value=''>No sites yet</option>}
                {sites.map(site => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
            )}
            {canEdit && !addingHere && (
              <button
                type='button'
                className='btn btn-sm btn-outline-secondary'
                onClick={() => start(newDraft(tab, '', tab === 'site' ? siteId : null))}
              >
                Add variable
              </button>
            )}
          </div>

          {addingHere && (
            <VariableEditor draft={draft!} onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} saving={saving} />
          )}

          {items.length === 0 && !addingHere ? (
            <p className='text-muted mb-0'>No {current.label.toLowerCase()} variables yet.</p>
          ) : (
            <div className='variable-list'>
              {items.map(variable =>
                draft?.id === variable.id ? (
                  <VariableEditor
                    key={variable.id}
                    draft={draft}
                    onChange={setDraft}
                    onSave={save}
                    onCancel={() => setDraft(null)}
                    saving={saving}
                  />
                ) : (
                  <div className='variable-row' key={variable.id}>
                    <div className='variable-row-main'>
                      <VariableValue variable={variable} canReveal={canEdit} />
                      {variable.description && <span className='variable-description'>{variable.description}</span>}
                    </div>
                    <UsedIn usage={usage[variable.name] || emptyUsage} />
                    {canEdit && (
                      <div className='variable-row-actions'>
                        <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => start(draftFrom(variable))}>
                          Edit
                        </button>
                        <button type='button' className='btn btn-sm btn-outline-danger' onClick={() => remove(variable)}>
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                )
              )}
            </div>
          )}
        </Card>
      </div>

      <div className='col-12 col-lg-3'>
        <Card classes='variables-card'>
          <p className='eyebrow'>Override order</p>
          <ol className='variables-order mb-0'>
            <li>Runtime prompt</li>
            <li>User</li>
            <li>Device</li>
            <li>Site</li>
            <li>Global</li>
            <li>Snippet default</li>
          </ol>
          <p className='form-text mt-2 mb-0'>The first one with a value wins.</p>
        </Card>
      </div>
    </Layout>
  );
};
