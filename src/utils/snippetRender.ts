import { SnippetRunModel, SnippetRunInstance } from '../models';
import { findTemplateVariables, renderTemplate } from './templateVars';
import { loadVariableLayers } from './variableValues';
import { maskSecrets } from './secretBox';
import { runSnippetCode } from './runSnippet';
import { applyDefinitions, missingRequired, VariableDefinition } from './snippetVariables';

export interface RenderedSnippet {
  code: string;
  /** Plain-text secret values used, for masking output */
  secretValues: string[];
  /** Secret names used in the result */
  secretsUsed: string[];
  /** Placeholders left without a value */
  missing: string[];
  /** Values that do not fit their variable's type */
  errors: string[];
  /** Required variables still without a value */
  missingRequired: string[];
}

/**
 * Fill a snippet for a signed-in user: explicit values, then personal, site,
 * and team values (secrets included), then inline defaults.
 */
export const renderSnippetFor = async (options: {
  code: string;
  userId?: number | null;
  siteId?: number | null;
  explicit?: Record<string, string>;
  /** DEVICE_* values when running on a device; after personal, before site */
  deviceValues?: Record<string, string>;
  includeTeam?: boolean;
  includeSecrets: boolean;
  /** The snippet's variable definitions: types, defaults, required, references */
  definitions?: VariableDefinition[];
}): Promise<RenderedSnippet> => {
  const layers = await loadVariableLayers({
    userId: options.userId,
    siteId: options.siteId,
    includeTeam: options.includeTeam,
    includeSecrets: options.includeSecrets
  });
  // Raw queries hand back the stored JSON text; anything unreadable means no definitions
  let definitions: VariableDefinition[] = [];
  const given: unknown = options.definitions;
  try {
    const list = typeof given === 'string' ? JSON.parse(given) : given;
    definitions = Array.isArray(list) ? list : [];
  } catch {
    definitions = [];
  }
  const applied = applyDefinitions(definitions, options.explicit || {});
  const explicit = applied.explicit;
  const device = options.deviceValues || {};
  const [saved] = layers.sources;
  // Personal values win over device ones; device values over site and team
  const merged: Record<string, string> = { ...saved };
  Object.entries(device).forEach(([name, value]) => {
    if (!(name in merged) || !layers.personalNames.includes(name)) {
      merged[name] = value;
    }
  });
  // secret-ref variables read the saved variable they point at
  const referenced: Record<string, string> = {};
  Object.entries(applied.aliases).forEach(([name, ref]) => {
    if (merged[ref] !== undefined) referenced[name] = merged[ref];
  });
  const code = renderTemplate(options.code, referenced, explicit, merged, applied.defaults);
  const used = findTemplateVariables(options.code).map(variable => variable.name);
  const usedRefs = used.map(name => applied.aliases[name] || name);
  const secretsUsed = layers.secretNames.filter(
    name => usedRefs.includes(name) && explicit[name] === undefined
  );
  const unresolved = findTemplateVariables(code).map(variable => variable.name);

  return {
    code,
    secretValues: layers.secretValues,
    secretsUsed,
    missing: unresolved,
    errors: applied.errors,
    missingRequired: missingRequired(definitions, unresolved)
  };
};

/**
 * Run code on the server and keep the result, with secret values masked.
 */
export const runAndRecord = async (options: {
  snippet: { id: number; title: string; language: string };
  code: string;
  secretValues: string[];
  siteId?: number | null;
  userId?: number | null;
  runbookRunId?: number | null;
}): Promise<SnippetRunInstance> => {
  const started = Date.now();
  const result = await runSnippetCode(options.snippet.language, options.code);

  return SnippetRunModel.create({
    snippetId: options.snippet.id,
    snippetTitle: options.snippet.title,
    siteId: options.siteId || null,
    userId: options.userId || null,
    runbookRunId: options.runbookRunId || null,
    language: result.language,
    ok: result.ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: maskSecrets(result.stdout, options.secretValues),
    stderr: maskSecrets(result.stderr, options.secretValues),
    durationMs: Date.now() - started,
    sandbox: result.sandbox
  });
};
