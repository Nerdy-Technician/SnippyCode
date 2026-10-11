import { Variable } from '../typescript/interfaces';
import { findTemplateVariables, renderTemplate, TemplateVariable } from './templateVars';

export const SECRET_MASK = '••••••';

export type VariableSource = 'input' | 'personal' | 'site' | 'team' | 'default' | 'missing';

export interface ResolvedVariable extends TemplateVariable {
  /** Plain value; empty for secrets, whose values stay on the server */
  value: string;
  source: VariableSource;
  isSecret: boolean;
}

/**
 * Work out each placeholder the same way the server does: typed value, then
 * personal, site, and team values, then the inline default.
 */
export const resolveVariables = (
  code: string,
  layers: {
    inputs?: Record<string, string>;
    personal: Variable[];
    site: Variable[];
    team: Variable[];
  }
): ResolvedVariable[] => {
  const inputs = layers.inputs || {};
  const ordered: Array<[VariableSource, Variable[]]> = [
    ['personal', layers.personal],
    ['site', layers.site],
    ['team', layers.team]
  ];

  return findTemplateVariables(code).map(variable => {
    const { name, defaultValue } = variable;

    if (inputs[name] !== undefined) {
      return { ...variable, value: inputs[name], source: 'input', isSecret: false };
    }

    for (const [source, list] of ordered) {
      const saved = list.find(item => item.name === name);

      if (saved) {
        return { ...variable, value: saved.value, source, isSecret: saved.isSecret };
      }
    }

    if (defaultValue !== null) {
      return { ...variable, value: defaultValue, source: 'default', isSecret: false };
    }

    return { ...variable, value: '', source: 'missing', isSecret: false };
  });
};

/**
 * Code for display: secrets are masked and missing values stay as placeholders.
 */
export const renderForDisplay = (code: string, resolved: ResolvedVariable[]): string => {
  const values: Record<string, string> = {};

  resolved.forEach(variable => {
    if (variable.source !== 'missing') {
      values[variable.name] = variable.isSecret ? SECRET_MASK : variable.value;
    }
  });

  return renderTemplate(code, values);
};
