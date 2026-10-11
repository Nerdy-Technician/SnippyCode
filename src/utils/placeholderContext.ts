/**
 * Finds placeholders that sit inside a quoted or substituted context.
 *
 * Values are already inserted as one quoted literal for the language (see
 * renderTemplateSafe), so a placeholder written inside quotes, backticks,
 * $( ), ${ }, a heredoc, a here-string or a template literal would let the
 * value close the author's quote and run as code: bash '{{X}}' with
 * `'; id #`, "{{X}}" with `$(id)`, a JS template literal with `${...}`.
 * Those placeholders are refused at save and at run time unless an admin
 * marked the variable raw.
 *
 * This is a small lexer, not a full parser. It errs on the side of reporting.
 */

export interface QuotedPlaceholder {
  name: string;
  line: number;
  context: string;
}

const POSIX = ['bash', 'sh', 'shell', 'zsh', 'ksh', 'dash'];
const POWERSHELL = ['powershell', 'pwsh', 'ps1', 'ps'];
const JS = ['javascript', 'js', 'node', 'typescript', 'ts'];
const PYTHON = ['python', 'py'];
const JSON_LANG = ['json'];
const CMD = ['batch', 'bat', 'cmd'];

type Family = 'posix' | 'powershell' | 'js' | 'python' | 'json' | 'cmd';

const familyOf = (language?: string | null): Family | null => {
  const lang = String(language || '').toLowerCase();
  if (POSIX.includes(lang)) return 'posix';
  if (POWERSHELL.includes(lang)) return 'powershell';
  if (JS.includes(lang)) return 'js';
  if (PYTHON.includes(lang)) return 'python';
  if (JSON_LANG.includes(lang)) return 'json';
  if (CMD.includes(lang)) return 'cmd';
  return null;
};

// Context kinds. `brace` is a plain code block (JS), never reported.
type Kind =
  | 'sq' | 'dq' | 'bt' | 'subst' | 'param' | 'heredoc' | 'herestring'
  | 'template' | 'tsq' | 'tdq' | 'brace';

const LABEL: Record<Kind, string> = {
  sq: 'single quotes',
  dq: 'double quotes',
  bt: 'backticks',
  subst: 'a $( ) substitution',
  param: 'a ${ } expansion',
  heredoc: 'a heredoc',
  herestring: 'a here-string',
  template: 'a template literal',
  tsq: 'a triple-quoted string',
  tdq: 'a triple-quoted string',
  brace: ''
};

const PLACEHOLDER = /(\$?)\{\{([A-Z][A-Z0-9_]{0,63})(?::([^}\n]*))?\}\}/g;

interface Frame {
  kind: Kind;
  end?: string; // heredoc / here-string terminator
  dash?: boolean; // <<- strips leading tabs
}

export const quotedPlaceholders = (
  code: string,
  language?: string | null,
  raw: string[] = []
): QuotedPlaceholder[] => {
  const family = familyOf(language);
  const text = code || '';
  if (!family) return [];
  const rawSet = new Set(raw);

  const starts = new Map<number, { name: string; length: number }>();
  let m: RegExpExecArray | null;
  const pattern = new RegExp(PLACEHOLDER.source, 'g');
  while ((m = pattern.exec(text)) !== null) {
    if (m[1]) continue; // ${{ ... }} expressions are not placeholders
    starts.set(m.index, { name: m[2], length: m[0].length });
  }
  if (!starts.size) return [];

  const found: QuotedPlaceholder[] = [];
  const stack: Frame[] = [];
  const pendingHeredocs: Frame[] = [];
  let line = 1;
  let i = 0;
  const top = (): Frame | undefined => stack[stack.length - 1];
  const at = (s: string): boolean => text.startsWith(s, i);
  const inString = (): Frame | undefined => [...stack].reverse().find(f => f.kind !== 'brace');
  const codeLike = (): boolean => {
    const t = top();
    return !t || t.kind === 'subst' || t.kind === 'param' || t.kind === 'brace';
  };
  const skipToEol = (): void => {
    while (i < text.length && text[i] !== '\n') i += 1;
  };

  while (i < text.length) {
    const hit = starts.get(i);
    if (hit) {
      const ctx = inString();
      if (ctx && !rawSet.has(hit.name)) found.push({ name: hit.name, line, context: LABEL[ctx.kind] });
      i += hit.length;
      continue;
    }
    const c = text[i];
    const t = top();

    if (c === '\n') {
      line += 1;
      i += 1;
      // A heredoc body starts on the line after its <<WORD
      if (pendingHeredocs.length && codeLike()) stack.push(pendingHeredocs.shift() as Frame);
      // Heredoc / here-string ends on a line holding only the terminator
      const now = top();
      if (now && (now.kind === 'heredoc' || now.kind === 'herestring') && now.end) {
        const eol = text.indexOf('\n', i);
        const nextLine = text.slice(i, eol === -1 ? text.length : eol);
        const candidate = now.kind === 'heredoc' ? (now.dash ? nextLine.replace(/^\t+/, '') : nextLine) : nextLine.trimStart();
        if (now.kind === 'heredoc' ? candidate === now.end : candidate.startsWith(now.end)) {
          stack.pop();
          i += nextLine.indexOf(now.end) + now.end.length;
        }
      }
      continue;
    }

    if (family === 'posix') {
      if (t?.kind === 'sq') {
        if (c === "'") stack.pop();
        i += 1;
        continue;
      }
      if (t?.kind === 'heredoc') {
        // Unquoted heredocs expand $( ) and `` too; the whole body counts
        i += 1;
        continue;
      }
      if (c === '\\') { i += 2; continue; }
      if (t?.kind === 'bt') {
        if (c === '`') stack.pop();
        i += 1;
        continue;
      }
      if (t?.kind === 'dq') {
        if (c === '"') { stack.pop(); i += 1; continue; }
        if (at('$(')) { stack.push({ kind: 'subst' }); i += 2; continue; }
        if (at('${')) { stack.push({ kind: 'param' }); i += 2; continue; }
        if (c === '`') { stack.push({ kind: 'bt' }); i += 1; continue; }
        i += 1;
        continue;
      }
      // code-like (top level, $( ) or ${ })
      if (c === '#' && (i === 0 || /\s|;/.test(text[i - 1]))) { skipToEol(); continue; }
      if (c === "'") { stack.push({ kind: 'sq' }); i += 1; continue; }
      if (c === '"') { stack.push({ kind: 'dq' }); i += 1; continue; }
      if (c === '`') { stack.push({ kind: 'bt' }); i += 1; continue; }
      if (at('$(')) { stack.push({ kind: 'subst' }); i += 2; continue; }
      if (at('${')) { stack.push({ kind: 'param' }); i += 2; continue; }
      if (c === ')' && t?.kind === 'subst') { stack.pop(); i += 1; continue; }
      if (c === '}' && t?.kind === 'param') { stack.pop(); i += 1; continue; }
      const here = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(text.slice(i, i + 80));
      if (here && !at('<<<')) {
        pendingHeredocs.push({ kind: 'heredoc', end: here[3], dash: here[1] === '-' });
        i += here[0].length;
        continue;
      }
      i += 1;
      continue;
    }

    if (family === 'powershell') {
      if (t?.kind === 'herestring') { i += 1; continue; }
      if (t?.kind === 'sq') {
        if (c === "'" || /[\u2018\u2019\u201A\u201B]/.test(c)) {
          if (text[i + 1] === c) { i += 2; continue; }
          stack.pop();
        }
        i += 1;
        continue;
      }
      if (t?.kind === 'dq') {
        if (c === '`') { i += 2; continue; }
        if (c === '"' || /[\u201C\u201D\u201E]/.test(c)) {
          if (text[i + 1] === c) { i += 2; continue; }
          stack.pop();
          i += 1;
          continue;
        }
        if (at('$(')) { stack.push({ kind: 'subst' }); i += 2; continue; }
        if (at('${')) { stack.push({ kind: 'param' }); i += 2; continue; }
        i += 1;
        continue;
      }
      if (at('<#')) {
        const end = text.indexOf('#>', i + 2);
        const stop = end === -1 ? text.length : end + 2;
        line += (text.slice(i, stop).match(/\n/g) || []).length;
        i = stop;
        continue;
      }
      if (c === '#') { skipToEol(); continue; }
      if (c === '`') { i += 2; continue; }
      if (at("@'\n") || at("@'\r\n")) { stack.push({ kind: 'herestring', end: "'@" }); i += 2; continue; }
      if (at('@"\n') || at('@"\r\n')) { stack.push({ kind: 'herestring', end: '"@' }); i += 2; continue; }
      if (c === "'" || /[\u2018\u2019\u201A\u201B]/.test(c)) { stack.push({ kind: 'sq' }); i += 1; continue; }
      if (c === '"' || /[\u201C\u201D\u201E]/.test(c)) { stack.push({ kind: 'dq' }); i += 1; continue; }
      if (at('$(')) { stack.push({ kind: 'subst' }); i += 2; continue; }
      if (at('${')) { stack.push({ kind: 'param' }); i += 2; continue; }
      if (c === ')' && t?.kind === 'subst') { stack.pop(); i += 1; continue; }
      if (c === '}' && t?.kind === 'param') { stack.pop(); i += 1; continue; }
      i += 1;
      continue;
    }

    if (family === 'js' || family === 'json') {
      if (t?.kind === 'sq' || t?.kind === 'dq') {
        if (c === '\\') { i += 2; continue; }
        if ((t.kind === 'sq' && c === "'") || (t.kind === 'dq' && c === '"')) stack.pop();
        i += 1;
        continue;
      }
      if (t?.kind === 'template') {
        if (c === '\\') { i += 2; continue; }
        if (c === '`') { stack.pop(); i += 1; continue; }
        if (at('${')) { stack.push({ kind: 'param' }); i += 2; continue; }
        i += 1;
        continue;
      }
      if (family === 'js') {
        if (at('//')) { skipToEol(); continue; }
        if (at('/*')) {
          const end = text.indexOf('*/', i + 2);
          const stop = end === -1 ? text.length : end + 2;
          line += (text.slice(i, stop).match(/\n/g) || []).length;
          i = stop;
          continue;
        }
        if (c === '`') { stack.push({ kind: 'template' }); i += 1; continue; }
        if (c === "'") { stack.push({ kind: 'sq' }); i += 1; continue; }
        if (c === '{') { stack.push({ kind: 'brace' }); i += 1; continue; }
        if (c === '}' && (t?.kind === 'brace' || t?.kind === 'param')) { stack.pop(); i += 1; continue; }
      }
      if (c === '"') { stack.push({ kind: 'dq' }); i += 1; continue; }
      i += 1;
      continue;
    }

    if (family === 'python') {
      if (t?.kind === 'tsq' || t?.kind === 'tdq') {
        if (c === '\\') { i += 2; continue; }
        if (at(t.kind === 'tsq' ? "'''" : '"""')) { stack.pop(); i += 3; continue; }
        i += 1;
        continue;
      }
      if (t?.kind === 'sq' || t?.kind === 'dq') {
        if (c === '\\') { i += 2; continue; }
        if ((t.kind === 'sq' && c === "'") || (t.kind === 'dq' && c === '"')) stack.pop();
        i += 1;
        continue;
      }
      if (c === '#') { skipToEol(); continue; }
      if (at("'''")) { stack.push({ kind: 'tsq' }); i += 3; continue; }
      if (at('"""')) { stack.push({ kind: 'tdq' }); i += 3; continue; }
      if (c === "'") { stack.push({ kind: 'sq' }); i += 1; continue; }
      if (c === '"') { stack.push({ kind: 'dq' }); i += 1; continue; }
      i += 1;
      continue;
    }

    // cmd / batch
    if (t?.kind === 'dq') {
      if (c === '"') stack.pop();
      i += 1;
      continue;
    }
    if (/^\s*(rem\s|::)/i.test(text.slice(i, i + 6)) && (i === 0 || text[i - 1] === '\n')) { skipToEol(); continue; }
    if (c === '"') { stack.push({ kind: 'dq' }); i += 1; continue; }
    i += 1;
  }

  return found;
};

export const quotedPlaceholderMessage = (problems: QuotedPlaceholder[]): string =>
  problems
    .map(
      p =>
        `{{${p.name}}} on line ${p.line} is inside ${p.context}. Values are quoted automatically, ` +
        `so remove the surrounding quotes and write {{${p.name}}} bare (or ask an admin to mark ${p.name} as raw).`
    )
    .join(' ');

export interface QuotedPlaceholderReport {
  id: number;
  title: string;
  language: string;
  problems: QuotedPlaceholder[];
}

/** Snippets whose placeholders the save/run rule would refuse */
export const scanQuotedPlaceholders = (
  rows: Array<{ id: number; title: string; language: string; code: string; variables?: unknown }>,
  rawNamesOf: (variables: unknown) => string[]
): QuotedPlaceholderReport[] =>
  rows
    .map(row => ({
      id: row.id,
      title: row.title,
      language: row.language,
      problems: quotedPlaceholders(row.code, row.language, rawNamesOf(row.variables))
    }))
    .filter(row => row.problems.length > 0);
