import { useContext, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { SnippetsContext } from '../store';
import { Card, Layout } from '../components/UI';
import { Variable, VariableScope } from '../typescript/interfaces';
import { findTemplateVariables } from '../utils';
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

export const Variables = (): JSX.Element => {
  const { snippets, getSnippets, variables, getVariables, sites } = useContext(SnippetsContext);
  const [draft, setDraft] = useState<VariableDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getSnippets();
    getVariables();
  }, []);

  // Every placeholder referenced across the library
  const usage = useMemo(() => {
    const byName = new Map<string, { count: number; hasDefault: boolean }>();

    snippets.forEach(snippet => {
      findTemplateVariables(snippet.code).forEach(variable => {
        const entry = byName.get(variable.name) || { count: 0, hasDefault: false };
        entry.count += 1;
        entry.hasDefault = entry.hasDefault || variable.defaultValue !== null;
        byName.set(variable.name, entry);
      });
    });

    return byName;
  }, [snippets]);

  const teamNames = new Set(variables.team.map(variable => variable.name));
  const personalNames = new Set(variables.personal.map(variable => variable.name));
  const siteCounts = new Map<string, number>();
  variables.site.forEach(variable =>
    siteCounts.set(variable.name, (siteCounts.get(variable.name) || 0) + 1)
  );
  const referenced = Array.from(usage.entries()).sort(([a], [b]) => a.localeCompare(b));

  const start = (next: VariableDraft) => {
    setError('');
    setDraft(next);
  };

  const save = async () => {
    if (!draft) {
      return;
    }

    setSaving(true);
    setError('');

    try {
      await saveVariable(draft);
      setDraft(null);
      getVariables();
    } catch (err) {
      setError(apiError(err, 'Could not save the variable.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (variable: Variable) => {
    if (!window.confirm(`Delete ${variable.scope} variable ${variable.name}?`)) {
      return;
    }

    try {
      await axios.delete(`/api/variables/${variable.id}`);
      getVariables();
    } catch (err) {
      setError(apiError(err, 'Could not delete the variable.'));
    }
  };

  const renderSection = (
    scope: VariableScope,
    title: string,
    help: string,
    items: Variable[],
    canEdit: boolean
  ) => {
    const addingHere = draft && draft.scope === scope && !draft.id;

    return (
      <Card classes='variables-card'>
        <div className='variables-card-header'>
          <div>
            <p className='eyebrow'>{title}</p>
            <p className='form-text mb-0'>{help}</p>
          </div>
          {canEdit && !addingHere && (
            <button
              type='button'
              className='btn btn-sm btn-outline-secondary'
              onClick={() => start(newDraft(scope))}
            >
              Add variable
            </button>
          )}
        </div>

        {addingHere && (
          <VariableEditor
            draft={draft!}
            onChange={setDraft}
            onSave={save}
            onCancel={() => setDraft(null)}
            saving={saving}
          />
        )}

        {items.length === 0 && !addingHere ? (
          <p className='text-muted mb-0'>No {scope} variables yet.</p>
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
                    {variable.description && (
                      <span className='variable-description'>{variable.description}</span>
                    )}
                  </div>
                  <span className='variable-usage'>
                    {plural(usage.get(variable.name)?.count || 0, 'snippet')}
                  </span>
                  {canEdit && (
                    <div className='variable-row-actions'>
                      <button
                        type='button'
                        className='btn btn-sm btn-outline-secondary'
                        onClick={() => start(draftFrom(variable))}
                      >
                        Edit
                      </button>
                      <button
                        type='button'
                        className='btn btn-sm btn-outline-danger'
                        onClick={() => remove(variable)}
                      >
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
    );
  };

  return (
    <Layout>
      <div className='col-12'>
        <section className='variables-intro'>
          <p className='eyebrow'>Variables</p>
          <h1>Fill in snippets once, reuse everywhere</h1>
          <p>
            Write <code>{'{{HOST}}'}</code> or <code>{'{{VERSION:1.2.0}}'}</code> in any
            snippet. Values come from what you type on the snippet page, then{' '}
            <strong>my values</strong>, then the chosen <Link to='/sites'>site</Link>, then{' '}
            <strong>team values</strong>, then the inline default.
          </p>
          <p className='form-text mb-0'>
            Mark passwords and tokens as <strong>secret</strong>: they are encrypted, hidden until
            revealed, left out of public links, and masked in run history. Other values are
            visible to everyone who can sign in.
          </p>
        </section>
      </div>

      {error ? (
        <div className='col-12'>
          <div className='alert alert-danger mb-0'>{error}</div>
        </div>
      ) : (
        <></>
      )}

      <div className='col-12 col-lg-8 d-grid gap-4 align-content-start'>
        {renderSection(
          'team',
          'Team values',
          variables.canEditTeam
            ? 'Defaults for everyone. Editors and admins can change them. Sites override them.'
            : 'Defaults for everyone. Ask an editor to change them.',
          variables.team,
          variables.canEditTeam
        )}
        {renderSection(
          'personal',
          'My values',
          'Only you see these. They override site and team values for you.',
          variables.personal,
          true
        )}
      </div>

      <div className='col-12 col-lg-4'>
        <Card classes='variables-card'>
          <p className='eyebrow'>Used in the library</p>
          {referenced.length === 0 ? (
            <p className='text-muted mb-0'>
              No snippets use placeholders yet. Add <code>{'{{NAME}}'}</code> to one in the{' '}
              <Link to='/editor'>editor</Link>.
            </p>
          ) : (
            <ul className='variable-usage-list'>
              {referenced.map(([name, info]) => {
                const status = personalNames.has(name)
                  ? 'Mine'
                  : teamNames.has(name)
                  ? 'Team'
                  : siteCounts.has(name)
                  ? 'Sites'
                  : info.hasDefault
                  ? 'Default'
                  : 'Missing';

                return (
                  <li key={name}>
                    <code>{name}</code>
                    <span className='variable-usage'>
                      {plural(info.count, 'snippet')}
                      {siteCounts.has(name) && sites.length > 0
                        ? ` · ${siteCounts.get(name)}/${sites.length} sites`
                        : ''}
                    </span>
                    <span className={`snippet-variable-source is-${status.toLowerCase()}`}>
                      {status}
                    </span>
                    {!teamNames.has(name) && !personalNames.has(name) && (
                      <button
                        type='button'
                        className='btn btn-link btn-sm p-0'
                        onClick={() =>
                          start(newDraft(variables.canEditTeam ? 'team' : 'personal', name))
                        }
                      >
                        Set
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </Layout>
  );
};
