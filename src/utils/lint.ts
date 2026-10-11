import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { delimiter, join } from 'path';

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintDiagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: LintSeverity;
  code: string;
  message: string;
}

export interface LintResult {
  tool: string | null;
  available: boolean;
  diagnostics: LintDiagnostic[];
  error?: string;
}

interface Linter {
  tool: string;
  bin: string;
  args: string[];
  parse: (output: string) => LintDiagnostic[];
}

const onPath = (bin: string): boolean =>
  bin.includes('/')
    ? existsSync(bin)
    : String(process.env.PATH || '')
        .split(delimiter)
        .some(dir => dir && existsSync(join(dir, bin)));

// Parsers (exported for tests) ----------------------------------------------

export const parseShellcheck = (output: string): LintDiagnostic[] => {
  const data = JSON.parse(output || '{"comments":[]}');
  const comments = Array.isArray(data) ? data : data.comments || [];

  return comments.map((item: any) => ({
    line: item.line,
    column: item.column,
    endLine: item.endLine || item.line,
    endColumn: item.endColumn || item.column + 1,
    severity: item.level === 'error' ? 'error' : item.level === 'warning' ? 'warning' : 'info',
    code: `SC${item.code}`,
    message: item.message
  }));
};

export const parseRuff = (output: string): LintDiagnostic[] =>
  (JSON.parse(output || '[]') as any[]).map(item => ({
    line: item.location?.row || 1,
    column: item.location?.column || 1,
    endLine: item.end_location?.row || item.location?.row || 1,
    endColumn: item.end_location?.column || (item.location?.column || 1) + 1,
    // Syntax errors have no rule code
    severity: !item.code || /^E9|^F(63|7|82)/.test(item.code) ? 'error' : 'warning',
    code: item.code || 'syntax',
    message: item.message
  }));

export const parsePsScriptAnalyzer = (output: string): LintDiagnostic[] => {
  if (!output.trim()) {
    return [];
  }

  const data = JSON.parse(output);
  const items: any[] = Array.isArray(data) ? data : [data];
  // Severity comes through as a number: Information 0, Warning 1, Error 2, ParseError 3
  const severity = (value: unknown): LintSeverity => {
    const text = String(value).toLowerCase();
    return text === '2' || text === '3' || text.includes('error')
      ? 'error'
      : text === '1' || text === 'warning'
      ? 'warning'
      : 'info';
  };

  return items.map(item => ({
    line: item.Line || 1,
    column: item.Column || 1,
    endLine: item.EndLine || item.Line || 1,
    endColumn: item.EndColumn || (item.Column || 1) + 1,
    severity: severity(item.Severity),
    code: item.RuleName || 'PSScriptAnalyzer',
    message: item.Message
  }));
};

const LINTERS: { [language: string]: () => Linter } = {
  shell: () => ({
    tool: 'shellcheck',
    bin: process.env.SHELLCHECK_PATH || 'shellcheck',
    args: ['-f', 'json1', '-s', 'bash', '-'],
    parse: parseShellcheck
  }),
  python: () => ({
    tool: 'ruff',
    bin: process.env.RUFF_PATH || 'ruff',
    args: ['check', '--output-format', 'json', '--no-cache', '--stdin-filename', 'snippet.py', '-'],
    parse: parseRuff
  }),
  powershell: () => ({
    tool: 'PSScriptAnalyzer',
    bin: process.env.PWSH_PATH || 'pwsh',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$s=[Console]::In.ReadToEnd(); Invoke-ScriptAnalyzer -ScriptDefinition $s | Select-Object Line,Column,Severity,RuleName,Message,@{n='EndLine';e={$_.Extent.EndLineNumber}},@{n='EndColumn';e={$_.Extent.EndColumnNumber}} | ConvertTo-Json -Depth 3"
    ],
    parse: parsePsScriptAnalyzer
  })
};

const linterKey = (language: string): string | null => {
  const value = language.toLowerCase();

  if (['bash', 'sh', 'shell', 'zsh'].includes(value)) {
    return 'shell';
  }

  return Object.prototype.hasOwnProperty.call(LINTERS, value) ? value : null;
};

export const lintAvailability = (): { [language: string]: { tool: string; available: boolean } } => {
  const result: { [language: string]: { tool: string; available: boolean } } = {};

  Object.entries(LINTERS).forEach(([language, make]) => {
    const linter = make();
    result[language] = { tool: linter.tool, available: onPath(linter.bin) };
  });

  return result;
};

/**
 * Drop findings that fall on {{NAME}} placeholders; they are filled in later.
 */
export const withoutPlaceholderNoise = (code: string, diagnostics: LintDiagnostic[]): LintDiagnostic[] => {
  const ranges: { line: number; start: number; end: number }[] = [];

  code.split(/\r?\n/).forEach((text, index) => {
    const pattern = /\{\{[A-Z][A-Z0-9_]{0,63}(?::[^}\n]*)?\}\}/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      ranges.push({ line: index + 1, start: match.index + 1, end: match.index + match[0].length + 1 });
    }
  });

  return diagnostics.filter(
    item =>
      !ranges.some(
        range =>
          range.line === item.line &&
          item.column < range.end &&
          (item.endLine > item.line || item.endColumn > range.start)
      )
  );
};

export const lintCode = (language: string, code: string): Promise<LintResult> => {
  const key = linterKey(language);

  if (!key) {
    return Promise.resolve({ tool: null, available: false, diagnostics: [] });
  }

  const make = Object.prototype.hasOwnProperty.call(LINTERS, key) ? LINTERS[key] : undefined;

  if (typeof make !== 'function') {
    return Promise.resolve({ tool: null, available: false, diagnostics: [] });
  }

  const linter = make();

  if (!onPath(linter.bin)) {
    return Promise.resolve({ tool: linter.tool, available: false, diagnostics: [] });
  }

  return new Promise(resolve => {
    const child = spawn(linter.bin, linter.args, {
      env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' } as unknown as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);

    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ tool: linter.tool, available: false, diagnostics: [], error: err.message });
    });
    child.on('close', () => {
      clearTimeout(timer);

      try {
        resolve({
          tool: linter.tool,
          available: true,
          diagnostics: withoutPlaceholderNoise(code, linter.parse(stdout)).slice(0, 200)
        });
      } catch {
        resolve({
          tool: linter.tool,
          available: true,
          diagnostics: [],
          error: (stderr || stdout).slice(0, 300) || `${linter.tool} failed`
        });
      }
    });

    child.stdin.end(code);
  });
};
