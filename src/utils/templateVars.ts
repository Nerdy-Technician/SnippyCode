// Snippet placeholders: {{NAME}} or {{NAME:default}}.
// Names are UPPER_SNAKE so Mustache/Jinja/Helm templates ({{ name }}, {{ .Values }})
// and GitHub Actions expressions (${{ ... }}) are left alone.
// Keep in sync with client/src/utils/templateVars.ts.
export const VARIABLE_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

const placeholderPattern = () => /(\$?)\{\{([A-Z][A-Z0-9_]{0,63})(?::([^}\n]*))?\}\}/g;

export interface TemplateVariable {
  name: string;
  defaultValue: string | null;
}

export const findTemplateVariables = (code: string): TemplateVariable[] => {
  const found = new Map<string, TemplateVariable>();
  const pattern = placeholderPattern();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code || '')) !== null) {
    if (match[1]) {
      continue;
    }

    const name = match[2];
    const defaultValue = match[3] === undefined ? null : match[3];
    const existing = found.get(name);

    if (!existing) {
      found.set(name, { name, defaultValue });
    } else if (existing.defaultValue === null && defaultValue !== null) {
      existing.defaultValue = defaultValue;
    }
  }

  return Array.from(found.values());
};

/**
 * Replace placeholders using the first source that defines each name, then the
 * inline default. Placeholders with no value and no default are left untouched.
 */
export const renderTemplate = (
  code: string,
  ...sources: Array<Record<string, string | undefined>>
): string =>
  (code || '').replace(placeholderPattern(), (whole, dollar, name, fallback) => {
    if (dollar) {
      return whole;
    }

    for (const source of sources) {
      const value = source[name];

      if (typeof value === 'string') {
        return value;
      }
    }

    return fallback === undefined ? whole : fallback;
  });

/**
 * Placeholder values are code, so by default each is inserted as ONE quoted
 * literal for the snippet's language and can never break out into commands:
 * - bash/sh/zsh: POSIX single quotes ('it'\''s')
 * - PowerShell: single quotes, every quote character doubled (incl. the
 *   typographic quotes PowerShell also accepts)
 * - Python, JavaScript, JSON: a JSON string literal
 * - cmd/batch: no safe quoting exists, so metacharacters are refused
 * Other languages (Markdown, YAML, plain text...) are not run by SnippyCode
 * and get the value as written. Write placeholders bare: `echo {{NAME}}`,
 * not `echo "{{NAME}}"`. A definition marked raw (admins only) opts out.
 */
export class TemplateValueError extends Error {}

const POSIX = ['bash', 'sh', 'shell', 'zsh', 'ksh', 'dash'];
const POWERSHELL = ['powershell', 'pwsh', 'ps1', 'ps'];
const JSON_LIKE = ['python', 'py', 'javascript', 'js', 'node', 'typescript', 'ts', 'json'];
const CMD = ['batch', 'bat', 'cmd'];

export const quotesValues = (language?: string | null): boolean => {
  const lang = String(language || '').toLowerCase();
  return [...POSIX, ...POWERSHELL, ...JSON_LIKE, ...CMD].includes(lang);
};

export const quoteForLanguage = (value: string, language?: string | null): string => {
  const lang = String(language || '').toLowerCase();
  if (POSIX.includes(lang)) {
    if (value.includes('\0')) throw new TemplateValueError('Values cannot contain NUL characters');
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }
  if (POWERSHELL.includes(lang)) return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, quote => quote + quote)}'`;
  if (JSON_LIKE.includes(lang)) return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  if (CMD.includes(lang)) {
    if (/[\r\n"%!^&|<>()]/.test(value)) {
      throw new TemplateValueError('Batch values cannot contain quotes, newlines or any of % ! ^ & | < > ( )');
    }
    return `"${value}"`;
  }
  return value;
};

export interface RenderOptions {
  language?: string | null;
  /** Names inserted as written (definitions marked raw by an admin) */
  raw?: string[];
  /** Type check before quoting; returns why a value does not fit, or null */
  check?: (name: string, value: string) => string | null;
}

/**
 * renderTemplate, with every value checked and quoted for the language.
 * Throws TemplateValueError when a value does not fit its type.
 */
export const renderTemplateSafe = (
  code: string,
  options: RenderOptions,
  ...sources: Array<Record<string, string | undefined>>
): string => {
  const raw = new Set(options.raw || []);
  const errors: string[] = [];
  const out = (code || '').replace(placeholderPattern(), (whole, dollar, name, fallback) => {
    if (dollar) return whole;
    let value: string | undefined;
    for (const source of sources) {
      if (typeof source[name] === 'string') {
        value = source[name];
        break;
      }
    }
    if (value === undefined) value = fallback;
    if (value === undefined) return whole;
    const problem = options.check?.(name, value);
    if (problem) {
      errors.push(`${name} ${problem}`);
      return whole;
    }
    return raw.has(name) ? value : quoteForLanguage(value, options.language);
  });
  if (errors.length) throw new TemplateValueError(errors.join('; '));
  return out;
};
