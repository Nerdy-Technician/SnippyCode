// Snippet placeholders: {{NAME}} or {{NAME:default}}.
// Names are UPPER_SNAKE so Mustache/Jinja/Helm templates ({{ name }}, {{ .Values }})
// and GitHub Actions expressions (${{ ... }}) are left alone.
// Keep in sync with src/utils/templateVars.ts on the server.
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
