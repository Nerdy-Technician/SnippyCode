/**
 * The example runbook in docs/examples must stay importable and valid.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { VARIABLE_NAME_PATTERN, findTemplateVariables, renderTemplate } from '../src/utils/templateVars';

const file = path.join(__dirname, '..', '..', 'docs', 'examples', 'linux-disk-cleanup.runbook.json');
const example = JSON.parse(readFileSync(file, 'utf8'));
const RUNNABLE = ['bash', 'sh', 'shell', 'python', 'javascript', 'js', 'powershell'];

describe('example runbook', () => {
  test('snippets are in the library import format', () => {
    assert.ok(Array.isArray(example.snippets) && example.snippets.length > 0);
    for (const snippet of example.snippets) {
      assert.ok(String(snippet.title).trim(), 'title');
      assert.ok(String(snippet.code).trim(), `${snippet.title}: code`);
      assert.ok(RUNNABLE.includes(snippet.language), `${snippet.title}: ${snippet.language}`);
    }
  });

  test('every placeholder is a valid name with a default', () => {
    for (const snippet of example.snippets) {
      for (const variable of findTemplateVariables(snippet.code)) {
        assert.match(variable.name, VARIABLE_NAME_PATTERN);
        assert.notEqual(variable.defaultValue, null, `${snippet.title}: {{${variable.name}}} needs a default`);
        assert.ok(example.runbook.description.includes(variable.name), `${variable.name} is listed in the description`);
      }
    }
  });

  test('every placeholder has a valid variable definition', async () => {
    const { cleanVariableDefinitions, compareWithCode } = await import('../src/utils/snippetVariables');
    for (const snippet of example.snippets) {
      const defs = cleanVariableDefinitions(snippet.variables);
      const { missing, unused } = compareWithCode(snippet.code, defs);
      assert.deepEqual(missing, [], snippet.title);
      assert.deepEqual(unused, [], snippet.title);
    }
  });

  test('rendered bash parses', () => {
    for (const snippet of example.snippets.filter((item: any) => item.language === 'bash')) {
      execFileSync('bash', ['-n'], { input: renderTemplate(snippet.code) });
    }
  });

  test('the runbook passes the same rules as POST /api/runbooks', () => {
    const { runbook } = example;
    const titles = new Set(example.snippets.map((snippet: any) => snippet.title));

    assert.ok(runbook.title && runbook.title.length <= 200);
    assert.ok(runbook.steps.length > 0 && runbook.steps.length <= 100);
    for (const step of runbook.steps) {
      assert.ok(step.snippet || step.title, 'each step needs a snippet or a title');
      assert.ok(!step.snippet || titles.has(step.snippet), `unknown snippet ${step.snippet}`);
      assert.ok(String(step.title || '').length <= 200);
    }
  });
});
