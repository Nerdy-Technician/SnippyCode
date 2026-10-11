import { useState } from 'react';
import axios from 'axios';
import { Response, Variable, VariableScope } from '../../typescript/interfaces';
import { SECRET_MASK } from '../../utils';

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface VariableDraft {
  id?: number;
  scope: VariableScope;
  siteId?: number | null;
  name: string;
  value: string;
  description: string;
  isSecret: boolean;
  /** Existing secret whose value was not retyped: keep the stored one */
  keepSecret?: boolean;
}

export const newDraft = (
  scope: VariableScope,
  name = '',
  siteId: number | null = null
): VariableDraft => ({ scope, siteId, name, value: '', description: '', isSecret: false });

export const draftFrom = (variable: Variable): VariableDraft => ({
  id: variable.id,
  scope: variable.scope,
  siteId: variable.siteId,
  name: variable.name,
  value: variable.value,
  description: variable.description,
  isSecret: variable.isSecret,
  keepSecret: variable.isSecret
});

export const apiError = (err: unknown, fallback: string): string =>
  (axios.isAxiosError(err) && (err.response?.data as { error?: string })?.error) || fallback;

export const saveVariable = async (draft: VariableDraft): Promise<void> => {
  const body: Record<string, unknown> = {
    scope: draft.scope,
    siteId: draft.siteId || undefined,
    name: draft.name,
    description: draft.description,
    isSecret: draft.isSecret
  };

  // Leaving a secret's value untouched keeps the stored one
  if (!draft.keepSecret) {
    body.value = draft.value;
  }

  if (draft.id) {
    await axios.put(`/api/variables/${draft.id}`, body);
  } else {
    await axios.post('/api/variables', body);
  }
};

export const VariableEditor = (props: {
  draft: VariableDraft;
  onChange: (draft: VariableDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  lockName?: boolean;
}): JSX.Element => {
  const { draft, onChange, onSave, onCancel, saving, lockName } = props;
  const nameValid = NAME_PATTERN.test(draft.name);

  return (
    <form
      className='variable-editor'
      onSubmit={e => {
        e.preventDefault();
        if (nameValid) {
          onSave();
        }
      }}
    >
      <label>
        <span>Name</span>
        <input
          className='form-control form-control-sm'
          value={draft.name}
          onChange={e =>
            onChange({ ...draft, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })
          }
          placeholder='HOST'
          autoFocus={!draft.id && !lockName}
          readOnly={lockName}
          spellCheck={false}
        />
      </label>
      <label>
        <span>Value</span>
        <input
          className='form-control form-control-sm'
          type={draft.isSecret ? 'password' : 'text'}
          value={draft.keepSecret ? '' : draft.value}
          placeholder={draft.keepSecret ? 'Unchanged. Type to replace the secret' : ''}
          onChange={e => onChange({ ...draft, value: e.target.value, keepSecret: false })}
          autoFocus={Boolean(draft.id) || lockName}
          autoComplete='new-password'
          spellCheck={false}
        />
      </label>
      <label className='variable-editor-wide'>
        <span>Description</span>
        <input
          className='form-control form-control-sm'
          value={draft.description}
          onChange={e => onChange({ ...draft, description: e.target.value })}
          placeholder='Optional'
        />
      </label>
      <label className='variable-editor-secret'>
        <input
          type='checkbox'
          className='form-check-input'
          checked={draft.isSecret}
          onChange={e => onChange({ ...draft, isSecret: e.target.checked })}
        />
        <span>
          Secret: encrypted, hidden until revealed, never sent in public links, and masked in
          run history
        </span>
      </label>
      <div className='variable-editor-actions'>
        <button type='submit' className='btn btn-sm btn-primary' disabled={!nameValid || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type='button' className='btn btn-sm btn-outline-secondary' onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
};

/**
 * A saved value. Secrets show a mask until revealed.
 */
export const VariableValue = (props: {
  variable: Variable;
  canReveal: boolean;
  showName?: boolean;
}): JSX.Element => {
  const { variable, canReveal, showName = true } = props;
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState('');

  const toggle = async () => {
    if (revealed !== null) {
      setRevealed(null);
      return;
    }

    try {
      const res = await axios.get<Response<{ value: string }>>(
        `/api/variables/${variable.id}/reveal`
      );
      setRevealed(res.data.data.value);
      setError('');
    } catch (err) {
      setError(apiError(err, 'Could not reveal'));
    }
  };

  return (
    <span className='variable-value-wrap'>
      {showName && <code className='variable-name'>{variable.name}</code>}
      {variable.isSecret ? (
        <>
          <code className='variable-value'>
            {revealed !== null ? revealed || '(empty)' : variable.hasValue ? SECRET_MASK : '(empty)'}
          </code>
          <span className='variable-secret-badge'>🔒 Secret</span>
          {canReveal && variable.hasValue && (
            <button type='button' className='btn btn-link btn-sm p-0' onClick={toggle}>
              {revealed !== null ? 'Hide' : 'Reveal'}
            </button>
          )}
          {error && <span className='text-danger small'>{error}</span>}
        </>
      ) : (
        <code className='variable-value'>{variable.value || '(empty)'}</code>
      )}
    </span>
  );
};
