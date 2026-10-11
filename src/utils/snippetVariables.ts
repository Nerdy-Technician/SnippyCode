import { findTemplateVariables, VARIABLE_NAME_PATTERN } from './templateVars';

/**
 * Variable definitions stored on a snippet. Placeholders ({{NAME}} or
 * {{NAME:default}}) still work without a definition; a definition adds a
 * type, a default, whether a value is required, and a description.
 * Keep in sync with client/src/utils/snippetVariables.ts.
 */
export const VARIABLE_TYPES = ['string', 'number', 'boolean', 'choice', 'secret-ref'] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export interface VariableDefinition {
  name: string;
  type: VariableType;
  default: string;
  required: boolean;
  description: string;
  /** choice only */
  choices?: string[];
  /** secret-ref only: the name of a saved (encrypted) variable. Never a value. */
  ref?: string;
  /** Insert the value as written instead of quoted. Only admins can set it. */
  raw?: boolean;
}

export const MAX_VARIABLE_DEFS = 50;

export class VariableDefinitionError extends Error {}

const text = (value: unknown, max: number) => (typeof value === 'string' ? value : value == null ? '' : String(value)).slice(0, max);

/** Validate and normalise definitions; throws VariableDefinitionError */
export const cleanVariableDefinitions = (input: unknown): VariableDefinition[] => {
  if (input === undefined || input === null || input === '') return [];
  let list = input;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      throw new VariableDefinitionError('Variables must be a JSON list');
    }
  }
  if (!Array.isArray(list)) throw new VariableDefinitionError('Variables must be a list');
  if (list.length > MAX_VARIABLE_DEFS) throw new VariableDefinitionError(`At most ${MAX_VARIABLE_DEFS} variables`);

  const seen = new Set<string>();
  return list.map((raw: any) => {
    const name = text(raw?.name, 64).trim().toUpperCase();
    if (!VARIABLE_NAME_PATTERN.test(name)) throw new VariableDefinitionError(`"${name}" is not a valid variable name (UPPER_SNAKE)`);
    if (seen.has(name)) throw new VariableDefinitionError(`${name} is defined twice`);
    seen.add(name);
    const type = (VARIABLE_TYPES as readonly string[]).includes(raw?.type) ? (raw.type as VariableType) : 'string';
    const def: VariableDefinition = {
      name,
      type,
      default: type === 'secret-ref' ? '' : text(raw?.default, 2000),
      required: Boolean(raw?.required),
      description: text(raw?.description, 500).trim(),
      ...(raw?.raw === true && type !== 'secret-ref' ? { raw: true } : {})
    };
    if (type === 'choice') {
      const choices = (Array.isArray(raw?.choices) ? raw.choices : String(raw?.choices || '').split(','))
        .map((c: unknown) => text(c, 200).trim())
        .filter(Boolean)
        .slice(0, 50);
      if (!choices.length) throw new VariableDefinitionError(`${name} needs at least one choice`);
      def.choices = Array.from(new Set(choices));
    }
    if (type === 'secret-ref') {
      const ref = text(raw?.ref || name, 64).trim().toUpperCase();
      if (!VARIABLE_NAME_PATTERN.test(ref)) throw new VariableDefinitionError(`${name} must reference a saved variable name`);
      def.ref = ref;
    }
    if (def.default && typeError(def, def.default)) {
      throw new VariableDefinitionError(`${name}: default ${typeError(def, def.default)}`);
    }
    return def;
  });
};

/** Why a value does not fit its type, or null */
export const typeError = (def: VariableDefinition, value: string): string | null => {
  switch (def.type) {
    case 'number':
      return /^-?\d+(\.\d+)?$/.test(value.trim()) ? null : 'must be a number';
    case 'boolean':
      return /^(true|false|yes|no|1|0)$/i.test(value.trim()) ? null : 'must be true or false';
    case 'choice':
      return def.choices?.includes(value) ? null : `must be one of ${def.choices?.join(', ')}`;
    default:
      return null;
  }
};

export const normaliseValue = (def: VariableDefinition, value: string): string =>
  def.type === 'boolean' ? String(/^(true|yes|1)$/i.test(value.trim())) : def.type === 'number' ? value.trim() : value;

/** Placeholders in the code without a definition, and definitions never used */
export const compareWithCode = (code: string, defs: VariableDefinition[]) => {
  const found = findTemplateVariables(code);
  const defined = new Set(defs.map(def => def.name));
  const used = new Set(found.map(item => item.name));
  return {
    missing: found.filter(item => !defined.has(item.name)),
    unused: defs.filter(def => !used.has(def.name)).map(def => def.name)
  };
};

/**
 * Check explicit values against definitions. Explicit values for secret-ref
 * variables are ignored (they always come from the store). Returns the
 * cleaned explicit values, defaults from definitions, and secret-ref aliases.
 */
export const applyDefinitions = (
  defs: VariableDefinition[],
  explicit: Record<string, string>
): { explicit: Record<string, string>; defaults: Record<string, string>; aliases: Record<string, string>; errors: string[] } => {
  const errors: string[] = [];
  const out: Record<string, string> = { ...explicit };
  const defaults: Record<string, string> = {};
  const aliases: Record<string, string> = {};

  for (const def of defs) {
    if (def.type === 'secret-ref') {
      delete out[def.name];
      aliases[def.name] = def.ref || def.name;
      continue;
    }
    if (def.default !== '') defaults[def.name] = def.default;
    const value = out[def.name];
    if (value === undefined || value === '') {
      if (value === '') delete out[def.name];
      continue;
    }
    const problem = typeError(def, value);
    if (problem) errors.push(`${def.name} ${problem}`);
    else out[def.name] = normaliseValue(def, value);
  }

  return { explicit: out, defaults, aliases, errors };
};

/** Required variables still without a value after rendering */
export const missingRequired = (defs: VariableDefinition[], unresolved: string[]): string[] =>
  defs.filter(def => def.required && unresolved.includes(def.name)).map(def => def.name);

/**
 * Hook for references: today they point at saved variables (encrypted when
 * secret). When a dedicated secrets store exists, add it here.
 */
export type ReferenceSource = 'variables';
export const REFERENCE_SOURCES: ReferenceSource[] = ['variables'];

/** Per-step values: NAME -> text (may pass another value through, e.g. {{SITE_SHARE}}) */
export const cleanStepValues = (input: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [name, value] of Object.entries(input as Record<string, unknown>).slice(0, 50)) {
    if (VARIABLE_NAME_PATTERN.test(name) && value !== undefined && value !== null && String(value) !== '') {
      out[name] = String(value).slice(0, 2000);
    }
  }
  return out;
};


/** Names of definitions an admin marked raw (inserted unquoted) */
export const rawNames = (input: unknown): string[] => {
  let list: unknown = input;
  try {
    if (typeof input === 'string') list = JSON.parse(input);
  } catch {
    list = [];
  }
  return Array.isArray(list) ? list.filter((def: any) => def && def.raw === true && typeof def.name === 'string').map((def: any) => def.name) : [];
};
