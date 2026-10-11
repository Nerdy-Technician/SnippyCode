import { useEffect, useState } from 'react';
import axios from 'axios';
import {
  VARIABLE_TYPES,
  VariableDefinition,
  VariableType,
  compareWithCode,
  definitionProblems,
  mergeDefinitions,
  newDefinition,
  parseDefinitionsJson
} from '../../utils/snippetVariables';

interface Props {
  code: string;
  value: VariableDefinition[];
  onChange: (value: VariableDefinition[]) => void;
  /** The snippet being edited, left out of "import from another snippet" */
  snippetId?: number;
}

interface Sources {
  snippets: Array<{ id: number; title: string; variables: VariableDefinition[] }>;
  saved: Array<{ name: string; scope: 'personal' | 'team' | 'site'; siteName: string | null; isSecret: boolean; description: string }>;
}

const TYPE_LABELS: { [type in VariableType]: string } = {
  string: 'Text',
  number: 'Number',
  boolean: 'True/false',
  choice: 'Choice',
  'secret-ref': 'Reference (saved/secret)'
};

export const SnippetVariablesEditor = ({ code, value, onChange, snippetId }: Props): JSX.Element => {
  const [importMode, setImportMode] = useState<'' | 'json' | 'snippet' | 'saved'>('');
  const [json, setJson] = useState('');
  const [importError, setImportError] = useState('');
  const [sources, setSources] = useState<Sources | null>(null);

  const { missing, unused } = compareWithCode(code, value);
  const problems = definitionProblems(value);

  useEffect(() => {
    if ((importMode === 'snippet' || importMode === 'saved') && !sources) {
      axios
        .get<{ data: Sources }>('/api/snippets/variable-sources')
        .then(res => setSources(res.data.data))
        .catch(() => setSources({ snippets: [], saved: [] }));
    }
  }, [importMode, sources]);

  const update = (index: number, patch: Partial<VariableDefinition>) =>
    onChange(value.map((def, i) => (i === index ? { ...def, ...patch } : def)));

  const add = (defs: VariableDefinition[]) => onChange(mergeDefinitions(value, defs));

  const importJson = () => {
    try {
      add(parseDefinitionsJson(json));
      setJson('');
      setImportMode('');
      setImportError('');
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Could not read that JSON');
    }
  };

  return (
    <div className='snippet-variables-editor'>
      <div className='d-flex justify-content-between align-items-center flex-wrap gap-2 mb-2'>
        <h5 className='card-title mb-0'>Variables</h5>
        <div className='d-flex gap-1 flex-wrap'>
          <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => add([newDefinition(`VAR_${value.length + 1}`)])}>
            Add variable
          </button>
          <select
            className='form-select form-select-sm w-auto'
            aria-label='Import variables'
            value={importMode}
            onChange={e => setImportMode(e.target.value as typeof importMode)}
          >
            <option value=''>Import…</option>
            <option value='json'>From pasted JSON</option>
            <option value='snippet'>From another snippet</option>
            <option value='saved'>From saved variables and secrets</option>
          </select>
        </div>
      </div>
      <p className='form-text mt-0'>
        Use <code>{'{{NAME}}'}</code> or <code>{'{{NAME:default}}'}</code> in the script. A definition adds a type, a
        default, whether it is required and a description, which runs, runbooks and schedules check.
      </p>

      {missing.length > 0 && (
        <div className='alert alert-info py-2 variables-missing'>
          Found in the script but not defined:{' '}
          {missing.map(item => (
            <button
              type='button'
              key={item.name}
              className='btn btn-sm btn-link p-0 me-2'
              onClick={() => add([newDefinition(item.name, item.defaultValue || '')])}
            >
              + {item.name}
            </button>
          ))}
          <button
            type='button'
            className='btn btn-sm btn-outline-primary ms-1'
            onClick={() => add(missing.map(item => newDefinition(item.name, item.defaultValue || '')))}
          >
            Add all
          </button>
        </div>
      )}

      {importMode === 'json' && (
        <div className='mb-2'>
          <textarea
            className='form-control font-monospace'
            rows={4}
            aria-label='Variables JSON'
            placeholder='[{"name": "TARGET_DIR", "type": "string", "required": true}]'
            value={json}
            onChange={e => setJson(e.target.value)}
          />
          <button type='button' className='btn btn-sm btn-primary mt-1' disabled={!json.trim()} onClick={importJson}>
            Import JSON
          </button>
          {importError && <div className='text-danger small'>{importError}</div>}
        </div>
      )}

      {importMode === 'snippet' && (
        <div className='mb-2'>
          {!sources && <span className='text-muted small'>Loading…</span>}
          {sources?.snippets.filter(item => item.id !== snippetId).length === 0 && (
            <span className='text-muted small'>No other snippet has variables yet.</span>
          )}
          <ul className='list-unstyled mb-0'>
            {sources?.snippets
              .filter(item => item.id !== snippetId)
              .map(item => (
                <li key={item.id}>
                  <button type='button' className='btn btn-sm btn-link p-0' onClick={() => add(item.variables)}>
                    {item.title}
                  </button>{' '}
                  <span className='text-muted small'>{item.variables.map(def => def.name).join(', ')}</span>
                </li>
              ))}
          </ul>
        </div>
      )}

      {importMode === 'saved' && (
        <div className='mb-2'>
          <p className='form-text mt-0'>Adds references by name only; values stay in the store and are read at run time.</p>
          {sources?.saved.length === 0 && <span className='text-muted small'>No saved variables yet.</span>}
          <ul className='list-unstyled mb-0'>
            {sources?.saved.map(item => (
              <li key={`${item.scope}-${item.siteName}-${item.name}`}>
                <button
                  type='button'
                  className='btn btn-sm btn-link p-0'
                  onClick={() =>
                    add([{ ...newDefinition(item.name), type: 'secret-ref', ref: item.name, description: item.description || '' }])
                  }
                >
                  {item.name}
                </button>{' '}
                <span className='text-muted small'>
                  {item.scope}
                  {item.siteName ? ` · ${item.siteName}` : ''}
                  {item.isSecret ? ' · secret' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {value.length > 0 && (
        <div className='table-responsive'>
          <table className='table table-sm align-middle variables-table'>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Default / options</th>
                <th>Required</th>
                <th>Description</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {value.map((def, index) => (
                <tr key={index} className={unused.includes(def.name) ? 'variable-unused' : ''}>
                  <td>
                    <input
                      className='form-control form-control-sm font-monospace'
                      aria-label='Variable name'
                      value={def.name}
                      onChange={e => update(index, { name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}
                    />
                    {unused.includes(def.name) && <span className='badge bg-secondary'>not used in the script</span>}
                  </td>
                  <td>
                    <select
                      className='form-select form-select-sm'
                      aria-label='Variable type'
                      value={def.type}
                      onChange={e => {
                        const type = e.target.value as VariableType;
                        update(index, {
                          type,
                          ...(type === 'secret-ref' ? { default: '', ref: def.ref || def.name } : {}),
                          ...(type === 'choice' && !def.choices ? { choices: def.default ? [def.default] : [] } : {})
                        });
                      }}
                    >
                      {VARIABLE_TYPES.map(type => (
                        <option key={type} value={type}>
                          {TYPE_LABELS[type]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {def.type === 'secret-ref' ? (
                      <input
                        className='form-control form-control-sm font-monospace'
                        aria-label='Saved variable name'
                        placeholder='Saved variable name'
                        value={def.ref || ''}
                        onChange={e => update(index, { ref: e.target.value.toUpperCase() })}
                      />
                    ) : def.type === 'boolean' ? (
                      <select
                        className='form-select form-select-sm'
                        aria-label='Default'
                        value={def.default}
                        onChange={e => update(index, { default: e.target.value })}
                      >
                        <option value=''>(none)</option>
                        <option value='true'>true</option>
                        <option value='false'>false</option>
                      </select>
                    ) : (
                      <>
                        <input
                          className='form-control form-control-sm'
                          aria-label='Default'
                          placeholder='Default'
                          value={def.default}
                          onChange={e => update(index, { default: e.target.value })}
                        />
                        {def.type === 'choice' && (
                          <input
                            className='form-control form-control-sm mt-1'
                            aria-label='Choices'
                            placeholder='Choices, comma separated'
                            value={(def.choices || []).join(',')}
                            onChange={e => update(index, { choices: e.target.value.split(',').map(item => item.trim()) })}
                          />
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    <input
                      type='checkbox'
                      className='form-check-input'
                      aria-label='Required'
                      checked={def.required}
                      onChange={e => update(index, { required: e.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      className='form-control form-control-sm'
                      aria-label='Description'
                      value={def.description}
                      onChange={e => update(index, { description: e.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      type='button'
                      className='btn btn-sm btn-outline-danger'
                      aria-label={`Remove ${def.name}`}
                      onClick={() => onChange(value.filter((_, i) => i !== index))}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {problems.length > 0 && (
        <div className='alert alert-warning py-2'>
          {problems.map(problem => (
            <div key={problem}>{problem}</div>
          ))}
        </div>
      )}
    </div>
  );
};
