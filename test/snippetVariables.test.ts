/**
 * Snippet variable definitions: validation, detection, manual runs
 * (required + types), secret references, runbook step values, schedules,
 * sync format, import sources (names only), and old snippets unchanged.
 * Needs TEST_DATABASE_URL (a throwaway database whose name contains "test").
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import * as vars from '../src/utils/snippetVariables';
import * as templates from '../src/utils/templateVars';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join as joinPath } from 'path';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set, skipping snippet variable tests';

interface TestResponse {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
  json: () => any;
}

describe('snippet variables', { skip }, () => {
  let server: http.Server;
  let port = 0;
  let db: any;
  let models: typeof import('../src/models');
  const cookies: { [who: string]: string } = {};

  const request = (
    method: string,
    path: string,
    options: { body?: unknown; form?: Record<string, string>; as?: string | null; ip?: string } = {}
  ): Promise<TestResponse> =>
    new Promise((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = {};
      let payload: string | undefined;

      if (options.form) {
        payload = new URLSearchParams(options.form).toString();
        headers['content-type'] = 'application/x-www-form-urlencoded';
      } else if (options.body !== undefined) {
        payload = JSON.stringify(options.body);
        headers['content-type'] = 'application/json';
      }
      if (payload !== undefined) headers['content-length'] = Buffer.byteLength(payload);

      const who = options.as === undefined ? 'owner' : options.as;
      if (who && cookies[who]) { headers.cookie = `${cookies[who]}; XSRF-TOKEN=test-xsrf`; headers['x-xsrf-token'] = 'test-xsrf'; }
      if (options.ip) headers['x-forwarded-for'] = options.ip;

      const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 0, text, headers: res.headers, json: () => JSON.parse(text) });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });

  const ok = async (res: Promise<TestResponse>, status = 200) => {
    const response = await res;
    assert.equal(response.status, status, response.text);
    return response.json().data;
  };

  let site: { id: number };
  let device: any;
  let crypto: typeof import('../src/utils/secretBox');

  const defs = [
    { name: 'PATH_TO_CLEAN', type: 'string', required: true, description: 'Folder' },
    { name: 'DAYS', type: 'number', default: '7', required: true },
    { name: 'DRY_RUN', type: 'boolean', default: 'true' },
    { name: 'MODE', type: 'choice', choices: ['fast', 'safe'], default: 'safe' },
    { name: 'API_TOKEN', type: 'secret-ref', ref: 'VAULT_TOKEN', required: true }
  ];
  const code = 'find {{PATH_TO_CLEAN}} -mtime +{{DAYS}} # {{DRY_RUN}} {{MODE}} {{API_TOKEN}}\n';
  const lastJobCode = async () => {
    const job = await models.AgentJobModel.findOne({ order: [['id', 'DESC']] });
    return crypto.decryptSecret(job!.payload);
  };
  const runOn = (snippetId: number, variables: Record<string, string>) =>
    request('POST', `/api/snippets/${snippetId}/run`, { body: { siteId: site.id, deviceIds: [device.id], variables } });

  const PAYLOADS = [
    "a'; touch /tmp/snippycode-pwned; echo '",
    '$(touch /tmp/snippycode-pwned)',
    '`touch /tmp/snippycode-pwned`',
    'x"; Remove-Item -Recurse C:\\; "',
    "x'; Remove-Item C:\\ ; '",
    'it\u2019s; whoami',
    '$env:PATH; ${HOME}',
    'line1\nrm -rf /',
    'back\\slash \\" end',
    '\u2028 and \u2029'
  ];

  test('MED3: every payload is inserted as one literal (bash, PowerShell, Python, Node)', () => {
    const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' });
    const pwsh = ['pwsh', joinPath(homedir(), '.local/pwsh/pwsh')].find(bin => bin === 'pwsh' ? run('pwsh', ['-v']).status === 0 : existsSync(bin));
    for (const payload of PAYLOADS) {
      const bash = run('bash', ['-c', `printf %s ${templates.quoteForLanguage(payload, 'bash')}`]);
      assert.equal(bash.stdout, payload, `bash: ${payload}`);
      const py = run('python3', ['-c', `import sys; sys.stdout.write(${templates.quoteForLanguage(payload, 'python')})`]);
      if (py.status !== null && !py.error) assert.equal(py.stdout, payload, `python: ${payload}`);
      const node = run(process.execPath, ['-e', `process.stdout.write(${templates.quoteForLanguage(payload, 'javascript')})`]);
      assert.equal(node.stdout, payload, `node: ${payload}`);
      if (pwsh) {
        const ps = run(pwsh, ['-NoProfile', '-NonInteractive', '-Command', `[Console]::Out.Write(${templates.quoteForLanguage(payload, 'powershell')})`]);
        assert.equal(ps.stdout, payload, `powershell: ${payload}`);
      }
    }
    assert.equal(existsSync('/tmp/snippycode-pwned'), false);
    // Batch has no safe quoting: metacharacters are refused
    assert.throws(() => templates.quoteForLanguage('a & del *', 'batch'), templates.TemplateValueError);
    assert.equal(templates.quoteForLanguage('plain value', 'batch'), '"plain value"');
    // Languages SnippyCode does not run get the value as written
    assert.equal(templates.quoteForLanguage("it's", 'markdown'), "it's");
  });

  test('MED3: typed values are checked before quoting; raw is an explicit opt-out', () => {
    const check = (name: string, value: string) => (name === 'N' && !/^\d+$/.test(value) ? 'must be a number' : null);
    assert.equal(templates.renderTemplateSafe('x {{N}}', { language: 'bash', check }, { N: '5' }), "x '5'");
    assert.throws(() => templates.renderTemplateSafe('x {{N}}', { language: 'bash', check }, { N: '5; reboot' }), /N must be a number/);
    assert.equal(templates.renderTemplateSafe('ls {{FLAGS}}', { language: 'bash', raw: ['FLAGS'] }, { FLAGS: '-la -h' }), 'ls -la -h');
  });

  test('definitions are validated and normalised', () => {
    const cleaned = vars.cleanVariableDefinitions(defs);
    assert.equal(cleaned.length, 5);
    assert.equal(cleaned[4].default, '', 'secret-refs never hold a value');
    assert.equal(cleaned[4].ref, 'VAULT_TOKEN');
    assert.throws(() => vars.cleanVariableDefinitions([{ name: 'bad name' }]), /valid variable name/);
    assert.throws(() => vars.cleanVariableDefinitions([{ name: 'A' }, { name: 'A' }]), /twice/);
    assert.throws(() => vars.cleanVariableDefinitions([{ name: 'N', type: 'number', default: 'x' }]), /number/);
    assert.throws(() => vars.cleanVariableDefinitions([{ name: 'C', type: 'choice' }]), /choice/);
    assert.throws(() => vars.cleanVariableDefinitions('{nope'), /JSON/);
  });

  test('detects missing and unused definitions', () => {
    const result = vars.compareWithCode('echo {{A}} {{B:2}} ${{ C }}', vars.cleanVariableDefinitions([{ name: 'A' }, { name: 'ZED' }]));
    assert.deepEqual(result.missing.map(item => item.name), ['B']);
    assert.equal(result.missing[0].defaultValue, '2');
    assert.deepEqual(result.unused, ['ZED']);
  });

  before(async () => {
    const dbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
    if (!/test/i.test(dbName)) throw new Error(`Refusing to reset database "${dbName}"`);

    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = 'snippycode-test-session-secret';
    process.env.VARIABLES_SECRET_KEY = 'snippycode-test-variables-key';

    await import('../src/utils');
    db = await import('../src/db');
    await db.sequelize.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await db.connectDB();
    const { associateModels } = await import('../src/db/associateModels');
    await associateModels();
    models = await import('../src/models');
    crypto = await import('../src/utils/secretBox');

    const { createApp } = await import('../src/app');
    server = createApp({ clientDirs: [] }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;

    const setup = await request('POST', '/api/auth/setup', {
      body: { email: 'owner@example.test', displayName: 'Owner', password: 'correct-horse-battery' },
      as: null
    });
    assert.equal(setup.status, 201, setup.text);
    cookies.owner = String(setup.headers['set-cookie']?.[0] || '').split(';')[0];

    site = await ok(request('POST', '/api/sites', { body: { name: 'Alpha' } }), 201);
    device = await models.DeviceModel.create({
      siteId: site.id, name: 'pc1', hostname: 'pc1', os: 'linux', arch: 'x86_64', capabilities: 'bash',
      tokenHash: 'unused', tokenPrefix: 'dev_vars_1', lastSeenAt: new Date()
    } as any);
    await ok(request('POST', '/api/variables', { body: { scope: 'site', siteId: site.id, name: 'VAULT_TOKEN', value: 's3cr3t-value', isSecret: true } }), 201);
  });

  after(async () => {
    await new Promise(resolve => server?.close(resolve));
    await db?.sequelize.close();
  });

  let snippet: any;

  test('definitions are stored on the snippet; bad ones are refused', async () => {
    const bad = await request('POST', '/api/snippets', {
      body: { title: 'Bad', language: 'bash', code, variables: [{ name: '9 bad' }] }
    });
    assert.equal(bad.status, 400);
    snippet = await ok(request('POST', '/api/snippets', { body: { title: 'Clean', language: 'bash', code, variables: defs } }), 201);
    assert.equal(snippet.variables.length, 5);
    const fetched = await ok(request('GET', `/api/snippets/${snippet.id}`));
    assert.equal(fetched.variables[1].type, 'number');

    // Updates without "variables" keep them
    await ok(request('PUT', `/api/snippets/${snippet.id}`, { body: { title: 'Clean', language: 'bash', code } }));
    assert.equal((await models.SnippetModel.findByPk(snippet.id))!.variables.length, 5);
  });

  test('manual runs need required values and the right types', async () => {
    let res = await runOn(snippet.id, {});
    assert.equal(res.status, 400);
    assert.match(res.text, /PATH_TO_CLEAN needs a value/);

    res = await runOn(snippet.id, { PATH_TO_CLEAN: '/tmp', DAYS: 'soon' });
    assert.equal(res.status, 400);
    assert.match(res.text, /DAYS must be a number/);

    res = await runOn(snippet.id, { PATH_TO_CLEAN: '/tmp', MODE: 'reckless' });
    assert.match(res.text, /MODE must be one of fast, safe/);

    const before = await models.AgentJobModel.count();
    res = await runOn(snippet.id, { PATH_TO_CLEAN: '/tmp', DRY_RUN: 'no', API_TOKEN: 'typed-in' });
    assert.equal(res.status, 202, res.text);
    assert.equal(await models.AgentJobModel.count(), before + 1);
    assert.equal(await lastJobCode(), "find '/tmp' -mtime +'7' # 'false' 'safe' 's3cr3t-value'\n", 'defaults, booleans and the secret reference');
  });

  test('a missing secret reference blocks the run', async () => {
    const other = await ok(request('POST', '/api/snippets', {
      body: { title: 'Ref', language: 'bash', code: 'echo {{KEY}}\n', variables: [{ name: 'KEY', type: 'secret-ref', ref: 'NOPE', required: true }] }
    }), 201);
    const res = await runOn(other.id, { KEY: 'typed' });
    assert.equal(res.status, 400);
    assert.match(res.text, /KEY needs a value/);
  });

  test('snippets without definitions still run exactly as before', async () => {
    const old = await ok(request('POST', '/api/snippets', { body: { title: 'Old', language: 'bash', code: 'echo {{WHO:world}} {{UNSET}}\n' } }), 201);
    assert.deepEqual(old.variables, []);
    await ok(runOn(old.id, {}), 202);
    assert.equal(await lastJobCode(), "echo 'world' {{UNSET}}\n");
  });

  test('schedules store values and refuse to save without required ones', async () => {
    const body = { name: 'Nightly', cron: '0 3 * * *', timezone: 'UTC', targetType: 'snippet', snippetId: snippet.id, siteMode: 'devices', deviceIds: [device.id], enabled: true };
    let res = await request('POST', '/api/schedules', { body });
    assert.equal(res.status, 400);
    assert.match(res.text, /PATH_TO_CLEAN needs a value/);
    res = await request('POST', '/api/schedules', { body: { ...body, variables: { PATH_TO_CLEAN: '/var/tmp', DAYS: 'x' } } });
    assert.match(res.text, /DAYS must be a number/);
    const saved = await ok(request('POST', '/api/schedules', { body: { ...body, variables: { PATH_TO_CLEAN: '/var/tmp', DRY_RUN: 'yes', JUNK: '1' } } }), 201);
    // Values are encrypted at rest: masked in responses, plain only in the edit fetch
    assert.deepEqual(saved.variables, { PATH_TO_CLEAN: '••••••', DRY_RUN: '••••••' });
    const edit = await ok(request('GET', `/api/schedules/${saved.id}/edit`));
    assert.deepEqual(edit.variables, { PATH_TO_CLEAN: '/var/tmp', DRY_RUN: 'true' });

    const scheduler = await import('../src/utils/scheduler');
    await scheduler.startScheduleRun((await models.ScheduleModel.findByPk(saved.id))!, 'manual');
    assert.equal(await lastJobCode(), "find '/var/tmp' -mtime +'7' # 'true' 'safe' 's3cr3t-value'\n");
  });

  test('runbook steps set or pass through values', async () => {
    await ok(request('POST', '/api/variables', { body: { scope: 'site', siteId: site.id, name: 'SITE_SHARE', value: '/srv/share' } }), 201);
    const runbook = await ok(request('POST', '/api/runbooks', {
      body: { title: 'Clean share', steps: [{ snippetId: snippet.id, title: 'clean', values: { PATH_TO_CLEAN: '{{SITE_SHARE}}', DAYS: '30', lower: 'x' } }] }
    }), 201);
    const fetched = await ok(request('GET', `/api/runbooks/${runbook.id}`));
    assert.deepEqual(fetched.steps[0].values, { PATH_TO_CLEAN: '{{SITE_SHARE}}', DAYS: '30' });
    assert.equal(fetched.steps[0].snippet.variables.length, 5);

    const run = await ok(request('POST', `/api/runbooks/${runbook.id}/runs`, { body: { siteId: site.id, deviceId: device.id } }), 201);
    const automation = await import('../src/utils/automation');
    const row = await models.RunbookRunModel.findByPk(run.id);
    await automation.executeRunbookStep(row!, fetched.steps[0].id, {});
    assert.equal(await lastJobCode(), "find '/srv/share' -mtime +'30' # 'true' 'safe' 's3cr3t-value'\n");
  });

  test('import sources list saved variables by name only', async () => {
    const sources = await ok(request('GET', '/api/snippets/variable-sources'));
    assert.ok(sources.snippets.some((item: any) => item.id === snippet.id));
    const vault = sources.saved.find((item: any) => item.name === 'VAULT_TOKEN');
    assert.equal(vault.isSecret, true);
    assert.equal(vault.scope, 'site');
    assert.ok(!JSON.stringify(sources).includes('s3cr3t-value'), 'never a value');
  });

  test('sync format carries definitions and step values', async () => {
    const sync = await import('../src/utils/githubSync');
    const canonical = sync.canonicalSnippet({ title: 'x', code: 'y', variables: defs });
    assert.equal((canonical.variables as any[]).length, 5);
    assert.deepEqual(sync.canonicalSnippet({ title: 'x', variables: 'garbage' }).variables, [], 'bad remote data is dropped');
    const runbook = sync.canonicalRunbook({ title: 'r', steps: [{ title: 's', values: { A: '1', bad: '2' } }] });
    assert.deepEqual((runbook.steps as any[])[0].values, { A: '1' });
  });

  test('MED3: run values, site values and step values are quoted; raw needs an admin', async () => {
    // A run value carrying an injection stays one argument
    const echo = await ok(request('POST', '/api/snippets', {
      body: { title: 'Echo', language: 'bash', code: 'echo {{MSG}}\n', variables: [{ name: 'MSG', type: 'string', required: true }] }
    }), 201);
    await ok(runOn(echo.id, { MSG: "hi'; rm -rf / #" }), 202);
    assert.equal(await lastJobCode(), "echo 'hi'\\''; rm -rf / #'\n");

    // A saved site value that does not fit a number definition is refused
    await ok(request('POST', '/api/variables', { body: { name: 'BAD_DAYS', value: '7; reboot', siteId: site.id } }), 201);
    const typed = await ok(request('POST', '/api/snippets', {
      body: { title: 'Typed', language: 'bash', code: 'sleep {{BAD_DAYS}}\n', variables: [{ name: 'BAD_DAYS', type: 'number' }] }
    }), 201);
    const refused = await runOn(typed.id, {});
    assert.equal(refused.status, 400);
    assert.match(refused.text, /BAD_DAYS must be a number/);

    // Raw: editors cannot set it; owners can, and the value goes in as written
    const editor = await ok(request('POST', '/api/admin/users', { body: { email: 'med3-ed@example.test', displayName: 'Ed', password: 'editor-password-123', role: 'editor' } }), 201);
    assert.ok(editor);
    const login = await request('POST', '/api/auth/login', { body: { email: 'med3-ed@example.test', password: 'editor-password-123' }, as: null });
    cookies.editor = String(login.headers['set-cookie']?.[0] || '').split(';')[0];
    const rawDefs = [{ name: 'FLAGS', type: 'string', raw: true, default: '-la' }];
    assert.equal((await request('POST', '/api/snippets', { body: { title: 'Raw', language: 'bash', code: 'ls {{FLAGS}}\n', variables: rawDefs }, as: 'editor' })).status, 403);
    const raw = await ok(request('POST', '/api/snippets', { body: { title: 'Raw', language: 'bash', code: 'ls {{FLAGS}}\n', variables: rawDefs } }), 201);
    assert.equal(raw.variables[0].raw, true);
    await ok(runOn(raw.id, { FLAGS: '-la -h' }), 202);
    assert.equal(await lastJobCode(), 'ls -la -h\n');
    // An editor changing the code drops the raw flag
    const edited = await ok(request('PUT', `/api/snippets/${raw.id}`, {
      body: { title: 'Raw', language: 'bash', code: 'ls {{FLAGS}} /tmp\n', description: '', variables: rawDefs }, as: 'editor'
    }));
    assert.equal(edited.variables[0].raw, undefined);
  });
  test('M3: quoted placeholders are refused at save, flagged on legacy snippets and in the admin report', async () => {
    const refused = await request('POST', '/api/snippets', {
      body: { title: 'Quoted', language: 'bash', code: "echo '{{TARGET}}'\n", description: '' }
    });
    assert.equal(refused.status, 400);
    assert.match(refused.text, /remove the surrounding quotes/);
    const fine = await ok(request('POST', '/api/snippets', { body: { title: 'Bare', language: 'bash', code: 'echo {{TARGET}}\n', description: '' } }), 201);
    const put = await request('PUT', `/api/snippets/${fine.id}`, {
      body: { title: 'Bare', language: 'bash', code: 'echo "$({{TARGET}})"\n', description: '' }
    });
    assert.equal(put.status, 400);
    // A legacy snippet saved before the rule is shown with a warning, not hidden
    const legacy = await models.SnippetModel.create({ title: 'Legacy', language: 'bash', code: 'echo "{{TARGET}}"\n', description: '', docs: '' } as any);
    const shown = await ok(request('GET', `/api/snippets/${legacy.id}`));
    assert.equal(shown.quotedPlaceholders.length, 1);
    assert.equal(shown.quotedPlaceholders[0].context, 'double quotes');
    const report = await ok(request('GET', '/api/snippets/quoted-placeholders'));
    assert.ok(report.flagged.some((item: any) => item.id === legacy.id));
    assert.ok(!report.flagged.some((item: any) => item.id === fine.id));
    assert.equal((await request('GET', '/api/snippets/quoted-placeholders', { as: 'editor' })).status, 403);
  });
});
