import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import {
  lintCode,
  parsePsScriptAnalyzer,
  parseRuff,
  parseShellcheck,
  withoutPlaceholderNoise
} from '../src/utils/lint';

const hasShellcheck = spawnSync('shellcheck', ['--version']).status === 0;

describe('lint output parsers', () => {
  test('shellcheck json1', () => {
    const [item] = parseShellcheck(
      JSON.stringify({
        comments: [
          { line: 2, endLine: 2, column: 6, endColumn: 10, level: 'warning', code: 2086, message: 'Double quote to prevent globbing' }
        ]
      })
    );

    assert.deepEqual(item, {
      line: 2, column: 6, endLine: 2, endColumn: 10, severity: 'warning', code: 'SC2086', message: 'Double quote to prevent globbing'
    });
  });

  test('ruff json, with syntax errors as errors', () => {
    const items = parseRuff(
      JSON.stringify([
        { code: 'F401', message: '`os` imported but unused', location: { row: 1, column: 8 }, end_location: { row: 1, column: 10 } },
        { code: null, message: 'SyntaxError: Expected an expression', location: { row: 3, column: 1 }, end_location: { row: 3, column: 2 } }
      ])
    );

    assert.equal(items[0].severity, 'warning');
    assert.equal(items[0].code, 'F401');
    assert.equal(items[1].severity, 'error');
    assert.equal(items[1].code, 'syntax');
  });

  test('PSScriptAnalyzer json (single object or array, numeric severity)', () => {
    const single = parsePsScriptAnalyzer(
      JSON.stringify({ Line: 4, Column: 1, Severity: 1, RuleName: 'PSAvoidUsingWriteHost', Message: 'Avoid Write-Host', EndLine: 4, EndColumn: 11 })
    );
    const many = parsePsScriptAnalyzer(JSON.stringify([{ Line: 1, Column: 1, Severity: 3, RuleName: 'Parse', Message: 'x' }]));

    assert.equal(single[0].severity, 'warning');
    assert.equal(many[0].severity, 'error');
    assert.deepEqual(parsePsScriptAnalyzer(''), []);
  });

  test('findings on {{PLACEHOLDERS}} are dropped', () => {
    const code = 'echo {{HOST}}\necho $x';
    const kept = withoutPlaceholderNoise(code, [
      { line: 1, column: 6, endLine: 1, endColumn: 14, severity: 'info', code: 'SC1083', message: 'brace' },
      { line: 2, column: 6, endLine: 2, endColumn: 8, severity: 'warning', code: 'SC2086', message: 'quote' }
    ]);

    assert.deepEqual(kept.map(item => item.code), ['SC2086']);
  });
});

describe('lintCode', () => {
  test('languages without a linter report unavailable', async () => {
    const result = await lintCode('yaml', 'a: 1');
    assert.deepEqual(result, { tool: null, available: false, diagnostics: [] });
  });

  test('runs shellcheck when installed', { skip: hasShellcheck ? false : 'shellcheck is not installed' }, async () => {
    const result = await lintCode('bash', 'x=$1\nrm -rf $x/{{DIR}}\n');

    assert.equal(result.tool, 'shellcheck');
    assert.equal(result.available, true);
    assert.ok(result.diagnostics.some(item => item.code === 'SC2086'));
  });
});
