/**
 * M3: placeholders inside quotes or substitutions are refused (values are
 * quoted automatically, so the author's own quotes would let them break out).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotedPlaceholders, renderTemplateSafe, TemplateValueError } from '../src/utils';

const flagged = (code: string, language: string, raw: string[] = []) =>
  quotedPlaceholders(code, language, raw).map(p => p.context);

test("bash: '{{X}}', \"{{X}}\", backticks, $( ), ${ } and heredocs are refused", () => {
  assert.deepEqual(flagged("echo '{{X}}'", 'bash'), ['single quotes']);
  assert.deepEqual(flagged('echo "{{X}}"', 'bash'), ['double quotes']);
  assert.deepEqual(flagged('echo `{{X}}`', 'sh'), ['backticks']);
  assert.deepEqual(flagged('echo $(ls {{X}})', 'bash'), ['a $( ) substitution']);
  assert.deepEqual(flagged('echo "${HOME}/{{X}}"', 'bash'), ['double quotes']);
  assert.deepEqual(flagged('echo ${X:-{{X}}}', 'bash'), ['a ${ } expansion']);
  assert.deepEqual(flagged('cat <<EOF\nhello {{X}}\nEOF\necho {{Y}}', 'bash'), ['a heredoc']);
  assert.deepEqual(flagged("cat <<-'END'\n\t{{X}}\n\tEND\n", 'bash'), ['a heredoc']);
});

test('bash: bare placeholders, comments and ${{ }} expressions are fine', () => {
  assert.deepEqual(flagged('echo {{X}} && rm -- {{PATH_TO:/tmp/x}}', 'bash'), []);
  assert.deepEqual(flagged("# don't quote {{X}}\necho {{X}}", 'bash'), []);
  assert.deepEqual(flagged('echo "${{ github.ref }}" {{X}}', 'bash'), []);
  assert.deepEqual(flagged("echo 'done' {{X}} \"ok\"", 'bash'), []);
});

test("Linda's payloads cannot break out: rendering refuses the quoted forms", () => {
  const cases: Array<[string, string, string]> = [
    ["echo '{{X}}'", 'bash', "'; id #"],
    ['echo "{{X}}"', 'bash', '$(id)'],
    ['Write-Output "{{X}}"', 'powershell', '$(Get-Process)'],
    ["Write-Output '{{X}}'", 'powershell', "'; Get-Process; '"],
    ['console.log(`{{X}}`)', 'javascript', '${process.exit(1)}'],
    ["print('{{X}}')", 'python', "'); import os; os.system('id'); ('"],
    ['echo "{{X}}"', 'cmd', 'a'],
    ['cat <<EOF\n{{X}}\nEOF', 'bash', '$(id)']
  ];
  for (const [code, language, value] of cases) {
    assert.throws(
      () => renderTemplateSafe(code, { language }, { X: value }),
      (err: unknown) => err instanceof TemplateValueError && /remove the surrounding quotes/.test(String((err as Error).message)),
      `${language}: ${code}`
    );
  }
  // Bare placeholders get one safe literal
  assert.equal(renderTemplateSafe('echo {{X}}', { language: 'bash' }, { X: "'; id #" }), "echo ''\\''; id #'");
  assert.equal(renderTemplateSafe('console.log({{X}})', { language: 'js' }, { X: '${process.exit(1)}' }), 'console.log("${process.exit(1)}")');
});

test('PowerShell, JS and Python contexts', () => {
  assert.deepEqual(flagged('Write-Output "a $({{X}})"', 'powershell'), ['a $( ) substitution']);
  assert.deepEqual(flagged("$s = @'\n{{X}}\n'@\nWrite-Output {{Y}}", 'powershell'), ['a here-string']);
  assert.deepEqual(flagged('<# "{{X}}" #>\nWrite-Output {{X}}', 'powershell'), []);
  assert.deepEqual(flagged('const a = `x ${ {{X}} }`', 'javascript'), ['a ${ } expansion']);
  assert.deepEqual(flagged("function f() { return {{X}}; } // '{{Y}}'", 'javascript'), []);
  assert.deepEqual(flagged('x = """\n{{X}}\n"""', 'python'), ['a triple-quoted string']);
  assert.deepEqual(flagged("x = f'{ {{X}} }'", 'python'), ['single quotes']);
  assert.deepEqual(flagged('x = {{X}}  # "{{Y}}"', 'python'), []);
});

test('an admin-marked raw variable opts out; unknown languages are not checked', () => {
  assert.deepEqual(flagged("echo '{{X}}'", 'bash', ['X']), []);
  assert.equal(renderTemplateSafe("echo '{{X}}'", { language: 'bash', raw: ['X'] }, { X: 'ok' }), "echo 'ok'");
  assert.deepEqual(flagged('"{{X}}"', 'markdown'), []);
});

test('the error names the placeholder, the line and what to do', () => {
  assert.throws(
    () => renderTemplateSafe('ls\necho "{{TARGET}}"', { language: 'bash' }, { TARGET: 'x' }),
    /\{\{TARGET\}\} on line 2 is inside double quotes\. Values are quoted automatically, so remove the surrounding quotes/
  );
});
