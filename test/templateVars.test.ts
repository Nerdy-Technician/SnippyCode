import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { findTemplateVariables, renderTemplate } from '../src/utils/templateVars';

describe('findTemplateVariables', () => {
  test('finds names and inline defaults once each', () => {
    assert.deepEqual(
      findTemplateVariables('{{HOST}}:{{PORT:8080}} {{HOST}} {{VERSION:}}'),
      [
        { name: 'HOST', defaultValue: null },
        { name: 'PORT', defaultValue: '8080' },
        { name: 'VERSION', defaultValue: '' }
      ]
    );
  });

  test('a later default fills in an earlier bare use', () => {
    assert.deepEqual(findTemplateVariables('{{HOST}} {{HOST:example.com}}'), [
      { name: 'HOST', defaultValue: 'example.com' }
    ]);
  });

  test('ignores other template languages', () => {
    const code = [
      '${{ secrets.TOKEN }}',
      '${{HOST}}',
      '{{ .Values.image }}',
      '{{ name }}',
      '{{name}}',
      '{{ HOST }}',
      '{{1ABC}}'
    ].join('\n');

    assert.deepEqual(findTemplateVariables(code), []);
    assert.equal(renderTemplate(code, { HOST: 'x', name: 'y' }), code);
  });
});

describe('renderTemplate', () => {
  test('the first source that defines a name wins, then the default', () => {
    assert.equal(
      renderTemplate(
        '{{HOST}}:{{PORT:8080}}/{{PATH:api}}',
        { HOST: 'typed.example' },
        { HOST: 'team.example', PORT: '9000' }
      ),
      'typed.example:9000/api'
    );
  });

  test('an empty string is a real value, not a fallback', () => {
    assert.equal(renderTemplate('[{{X:default}}]', { X: '' }), '[]');
  });

  test('unknown names without a default stay as placeholders', () => {
    assert.equal(renderTemplate('ssh {{USER}}@{{HOST}}', { HOST: 'h' }), 'ssh {{USER}}@h');
  });

  test('values are inserted literally', () => {
    assert.equal(renderTemplate('{{A}}', { A: '$& $1 {{B}}' }, { B: 'no' }), '$& $1 {{B}}');
  });
});
