import { SnippetRunModel, SnippetRunInstance } from '../models';
import { findTemplateVariables, renderTemplate } from './templateVars';
import { loadVariableLayers } from './variableValues';
import { maskSecrets } from './secretBox';
import { runSnippetCode } from './runSnippet';

export interface RenderedSnippet {
  code: string;
  /** Plain-text secret values used, for masking output */
  secretValues: string[];
  /** Secret names used in the result */
  secretsUsed: string[];
  /** Placeholders left without a value */
  missing: string[];
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
}): Promise<RenderedSnippet> => {
  const layers = await loadVariableLayers({
    userId: options.userId,
    siteId: options.siteId,
    includeTeam: options.includeTeam,
    includeSecrets: options.includeSecrets
  });
  const explicit = options.explicit || {};
  const device = options.deviceValues || {};
  const [saved] = layers.sources;
  // Personal values win over device ones; device values over site and team
  const merged: Record<string, string> = { ...saved };
  Object.entries(device).forEach(([name, value]) => {
    if (!(name in merged) || !layers.personalNames.includes(name)) {
      merged[name] = value;
    }
  });
  const code = renderTemplate(options.code, explicit, merged);
  const used = findTemplateVariables(options.code).map(variable => variable.name);
  const secretsUsed = layers.secretNames.filter(
    name => used.includes(name) && explicit[name] === undefined
  );

  return {
    code,
    secretValues: layers.secretValues,
    secretsUsed,
    missing: findTemplateVariables(code).map(variable => variable.name)
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
