// Snippet variable definitions. Keep in sync with src/utils/snippetVariables.ts.
import { findTemplateVariables, TemplateVariable, VARIABLE_NAME_PATTERN } from './templateVars';

export const VARIABLE_TYPES = ['string', 'number', 'boolean', 'choice', 'secret-ref'] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export interface VariableDefinition {
  name: string;
  type: VariableType;
  default: string;
  required: boolean;
  description: string;
  choices?: string[];
  ref?: string;
  /** Inserted as written instead of quoted (admins only) */
  raw?: boolean;
}

export const newDefinition = (name = '', defaultValue = ''): VariableDefinition => ({
  name,
  type: 'string',
  default: defaultValue,
  required: false,
  description: ''
});

export const typeError = (def: VariableDefinition, value: string): string | null => {
  switch (def.type) {
    case 'number':
      return /^-?\d+(\.\d+)?$/.test(value.trim()) ? null : 'must be a number';
    case 'boolean':
      return /^(true|false|yes|no|1|0)$/i.test(value.trim()) ? null : 'must be true or false';
    case 'choice':
      return (def.choices || []).includes(value) ? null : `must be one of ${(def.choices || []).join(', ')}`;
    default:
      return null;
  }
};

/** Problems with the definitions themselves (shown in the editor) */
export const definitionProblems = (defs: VariableDefinition[]): string[] => {
  const problems: string[] = [];
  const seen = new Set<string>();
  defs.forEach(def => {
    if (!VARIABLE_NAME_PATTERN.test(def.name)) problems.push(`"${def.name || '(empty)'}" is not a valid name (UPPER_SNAKE)`);
    if (seen.has(def.name)) problems.push(`${def.name} is defined twice`);
    seen.add(def.name);
    if (def.type === 'choice' && !(def.choices || []).length) problems.push(`${def.name} needs at least one choice`);
    if (def.type === 'secret-ref' && def.ref && !VARIABLE_NAME_PATTERN.test(def.ref)) problems.push(`${def.name} must reference a saved variable name`);
    if (def.type !== 'secret-ref' && def.default && typeError(def, def.default)) problems.push(`${def.name}: default ${typeError(def, def.default)}`);
  });
  return problems;
};

export const compareWithCode = (
  code: string,
  defs: VariableDefinition[]
): { missing: TemplateVariable[]; unused: string[] } => {
  const found = findTemplateVariables(code);
  const defined = new Set(defs.map(def => def.name));
  const used = new Set(found.map(item => item.name));
  return { missing: found.filter(item => !defined.has(item.name)), unused: defs.filter(def => !used.has(def.name)).map(def => def.name) };
};

/** Accepts a list of definitions, or { variables: [...] } (a snippet or export) */
export const parseDefinitionsJson = (text: string): VariableDefinition[] => {
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.variables) ? parsed.variables : null;
  if (!list) throw new Error('Paste a JSON list of variables, or an object with a "variables" list');
  return list.map((raw: any) => ({
    name: String(raw?.name || '').trim().toUpperCase(),
    type: (VARIABLE_TYPES as readonly string[]).includes(raw?.type) ? raw.type : 'string',
    default: raw?.type === 'secret-ref' ? '' : String(raw?.default ?? ''),
    required: Boolean(raw?.required),
    description: String(raw?.description || ''),
    ...(Array.isArray(raw?.choices) ? { choices: raw.choices.map(String) } : {}),
    ...(raw?.ref ? { ref: String(raw.ref).toUpperCase() } : {})
  }));
};

/** Add definitions whose names are not taken yet */
export const mergeDefinitions = (current: VariableDefinition[], incoming: VariableDefinition[]): VariableDefinition[] => {
  const taken = new Set(current.map(def => def.name));
  return [...current, ...incoming.filter(def => def.name && !taken.has(def.name))];
};

/** Problems with values for a run: required values missing, wrong types */
export const runValueProblems = (defs: VariableDefinition[], values: Record<string, string | undefined>): string[] =>
  defs.flatMap(def => {
    if (def.type === 'secret-ref') return [];
    const value = values[def.name] ?? '';
    const effective = value !== '' ? value : def.default;
    if (!effective) return def.required ? [`${def.name} needs a value`] : [];
    const problem = value !== '' ? typeError(def, value) : null;
    return problem ? [`${def.name} ${problem}`] : [];
  });
