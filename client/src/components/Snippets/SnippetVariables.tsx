import { Link } from 'react-router-dom';
import { ResolvedVariable, VariableSource } from '../../utils';
import { Card } from '../UI';

export type { ResolvedVariable };

interface Props {
  variables: ResolvedVariable[];
  siteName: string | null;
  onChange: (name: string, value: string) => void;
  onReset: () => void;
}

const sourceLabel = (source: VariableSource, siteName: string | null): string =>
  ({
    input: 'Edited',
    personal: 'My value',
    site: siteName || 'Site value',
    team: 'Team value',
    default: 'Default',
    missing: 'Needs a value'
  }[source]);

export const SnippetVariables = (props: Props): JSX.Element => {
  const { variables, siteName, onChange, onReset } = props;
  const edited = variables.some(variable => variable.source === 'input');

  return (
    <Card classes='snippet-variables'>
      <div className='snippet-variables-header'>
        <div>
          <p className='eyebrow'>Variables{siteName ? ` · ${siteName}` : ''}</p>
          <p className='form-text mb-0'>
            Copy, run, raw links, and install lines use these values.{' '}
            <Link to='/variables'>Manage saved values</Link>
          </p>
        </div>
        {edited && (
          <button type='button' className='btn btn-sm btn-outline-secondary' onClick={onReset}>
            Reset
          </button>
        )}
      </div>
      <div className='snippet-variables-grid'>
        {variables.map(variable => (
          <label key={variable.name} className='snippet-variable'>
            <span className='snippet-variable-name'>
              <code>{variable.name}</code>
              <span className={`snippet-variable-source is-${variable.source}`}>
                {variable.isSecret && '🔒 '}
                {sourceLabel(variable.source, siteName)}
              </span>
            </span>
            <input
              className='form-control form-control-sm'
              value={variable.isSecret ? '' : variable.value}
              placeholder={
                variable.isSecret
                  ? 'Secret, filled in when you copy or run'
                  : variable.source === 'missing'
                  ? `{{${variable.name}}}`
                  : ''
              }
              onChange={e => onChange(variable.name, e.target.value)}
              spellCheck={false}
              autoComplete='off'
            />
          </label>
        ))}
      </div>
    </Card>
  );
};
