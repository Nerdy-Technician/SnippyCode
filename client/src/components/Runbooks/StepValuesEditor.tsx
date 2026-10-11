import { findTemplateVariables } from '../../utils/templateVars';
import { VariableDefinition } from '../../utils/snippetVariables';

interface Props {
  code: string;
  definitions: VariableDefinition[];
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}

/**
 * Per-step values for a runbook step's snippet. Empty means "use the site or
 * saved value"; {{OTHER_NAME}} passes another value through.
 */
export const StepValuesEditor = ({ code, definitions, value, onChange }: Props): JSX.Element => {
  const names = Array.from(
    new Set([
      ...definitions.filter(def => def.type !== 'secret-ref').map(def => def.name),
      ...findTemplateVariables(code)
        .map(item => item.name)
        .filter(name => !definitions.some(def => def.name === name && def.type === 'secret-ref'))
    ])
  );

  if (!names.length) return <></>;

  return (
    <details className='step-values'>
      <summary className='small'>
        Values for this step{Object.keys(value).length ? ` (${Object.keys(value).length} set)` : ''}
      </summary>
      <p className='form-text mb-1'>Leave empty to use the site or saved value. Use {'{{OTHER_NAME}}'} to pass a value through.</p>
      {names.map(name => {
        const def = definitions.find(item => item.name === name);
        return (
          <label key={name} className='d-flex gap-2 align-items-center mb-1'>
            <span className='font-monospace small step-value-name'>
              {name}
              {def?.required ? ' *' : ''}
            </span>
            <input
              className='form-control form-control-sm'
              aria-label={`Value for ${name}`}
              placeholder={def?.default ? `default: ${def.default}` : def?.description || ''}
              value={value[name] || ''}
              onChange={e => {
                const next = { ...value, [name]: e.target.value };
                if (!e.target.value) delete next[name];
                onChange(next);
              }}
            />
          </label>
        );
      })}
    </details>
  );
};
