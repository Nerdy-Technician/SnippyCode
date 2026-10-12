/**
 * HTTP tests for the v1.3.0 variables redesign (scopes, resolution order,
 * permissions, masking, preview, Used-in and migration 27) against a real PostgreSQL database. Set TEST_DATABASE_URL to a
 * throwaway database whose name contains "test"; its public schema is dropped
 * and re-created.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = TEST_DATABASE_URL
  ? false
  : 'TEST_DATABASE_URL is not set, skipping variables redesign tests';

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: () => any;
}

const SECRET = 'sk_live_very_secret_value';
const MASK = '••••••';

describe('variables redesign', { skip }, () => {
  let server: http.Server;
  let port = 0;
  let db: any;
  const cookies: { [who: string]: string } = {};

  const request = (
    method: string,
    path: string,
    options: { body?: unknown; as?: string | null; headers?: http.OutgoingHttpHeaders } = {}
  ): Promise<TestResponse> =>
    new Promise((resolve, reject) => {
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
      const headers: http.OutgoingHttpHeaders = { ...(options.headers || {}) };
      const who = options.as === undefined ? 'owner' : options.as;

      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(payload);
      }

      if (who && cookies[who]) {
        { headers.cookie = `${cookies[who]}; XSRF-TOKEN=test-xsrf`; headers['x-xsrf-token'] = 'test-xsrf'; }
      }

      const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      });

      req.on('error', reject);
      if (payload !== undefined) {
        req.write(payload);
      }
      req.end();
    });

  const ok = async (res: Promise<TestResponse>, status = 200) => {
    const response = await res;
    assert.equal(response.status, status, response.text);
    return response.json().data;
  };

  const signIn = async (who: string, email: string, password: string) => {
    const res = await request('POST', '/api/auth/login', { body: { email, password }, as: null });
    assert.equal(res.status, 200, res.text);
    cookies[who] = String(res.headers['set-cookie']?.[0] || '').split(';')[0];
  };

  const createUser = async (who: string, role: string) => {
    const email = `${who}@example.test`;
    const password = `${who}-password-123`;
    const user = await ok(
      request('POST', '/api/admin/users', { body: { email, displayName: who, password, role } }),
      201
    );
    await signIn(who, email, password);
    return user;
  };


  let snippet: { id: number };
  let acme: { id: number };
  let other: { id: number };

  before(async () => {
    const dbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
    if (!/test/i.test(dbName)) {
      throw new Error(`Refusing to reset database "${dbName}": its name must contain "test"`);
    }
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = 'snippycode-test-session-secret';
    process.env.VARIABLES_SECRET_KEY = 'snippycode-test-variables-key';
    process.env.GITHUB_TOKEN = '';

    await import('../src/utils');
    db = await import('../src/db');
    await db.sequelize.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await db.connectDB();
    const { associateModels } = await import('../src/db/associateModels');
    await associateModels();

    const clientDir = mkdtempSync(join(tmpdir(), 'snippycode-client-'));
    writeFileSync(join(clientDir, 'index.html'), '<!doctype html><div id="root"></div>');
    const { createApp } = await import('../src/app');
    server = createApp({ clientDirs: [clientDir] }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;

    const setup = await request('POST', '/api/auth/setup', {
      body: { email: 'owner@example.test', displayName: 'Owner', password: 'correct-horse-battery' },
      as: null
    });
    assert.equal(setup.status, 201, setup.text);
    cookies.owner = String(setup.headers['set-cookie']?.[0] || '').split(';')[0];
    await createUser('admin', 'admin');
    await createUser('editor', 'editor');
    await createUser('viewer', 'viewer');

    snippet = await ok(
      request('POST', '/api/snippets', {
        body: {
          title: 'Connect',
          language: 'bash',
          code: 'echo {{HOST:localhost}} {{PORT:22}} {{REGION:eu}} {{API_TOKEN}} {{ONLY_DEFAULT:d}}\n',
          description: '',
          docs: '',
          tags: [],
          isPinned: false
        }
      }),
      201
    );
    acme = await ok(request('POST', '/api/sites', { body: { name: 'Acme' } }), 201);
    other = await ok(request('POST', '/api/sites', { body: { name: 'Hidden', access: 'members' } }), 201);
  });

  after(async () => {
    await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
    await db?.sequelize.close();
  });

  test('global variables are admin-only; site needs an editor; user is your own', async () => {
    assert.equal(
      (await request('POST', '/api/variables', { as: 'editor', body: { scope: 'global', name: 'HOST', value: 'x' } })).status,
      403
    );
    // The pre-1.3 name maps to global too
    assert.equal(
      (await request('POST', '/api/variables', { as: 'editor', body: { scope: 'team', name: 'HOST', value: 'x' } })).status,
      403
    );
    const host = await ok(request('POST', '/api/variables', { as: 'admin', body: { scope: 'global', name: 'HOST', value: 'global.lan' } }), 201);
    assert.equal(host.scope, 'global');
    assert.equal((await request('PUT', `/api/variables/${host.id}`, { as: 'editor', body: { name: 'HOST', value: 'y' } })).status, 403);
    assert.equal((await request('DELETE', `/api/variables/${host.id}`, { as: 'editor' })).status, 403);

    assert.equal(
      (await request('POST', '/api/variables', { as: 'viewer', body: { scope: 'site', siteId: acme.id, name: 'HOST', value: 'v' } })).status,
      403
    );
    assert.equal(
      (await request('POST', '/api/variables', { as: 'editor', body: { scope: 'site', siteId: other.id, name: 'HOST', value: 'v' } })).status,
      403
    );
    await ok(request('POST', '/api/variables', { as: 'editor', body: { scope: 'site', siteId: acme.id, name: 'HOST', value: 'acme.lan' } }), 201);
    await ok(request('POST', '/api/variables', { as: 'admin', body: { scope: 'global', name: 'PORT', value: '2222' } }), 201);
    await ok(request('POST', '/api/variables', { as: 'editor', body: { scope: 'site', siteId: acme.id, name: 'PORT', value: '2200' } }), 201);
    const mine = await ok(request('POST', '/api/variables', { as: 'editor', body: { scope: 'user', name: 'PORT', value: '9999' } }), 201);
    assert.equal(mine.scope, 'user');
    // Someone else's user variable is invisible to others
    assert.equal((await request('PUT', `/api/variables/${mine.id}`, { as: 'admin', body: { name: 'PORT', value: '1' } })).status, 404);

    const list = await ok(request('GET', '/api/variables', { as: 'editor' }));
    assert.equal(list.canEditGlobal, false);
    assert.equal(list.global.length, 2);
    assert.deepEqual(list.user.map((item: any) => item.name), ['PORT']);
    assert.deepEqual(list.team, list.global);
    assert.equal((await ok(request('GET', '/api/variables', { as: 'admin' }))).canEditGlobal, true);
  });

  test('secrets are bound to their row, masked in listings and preview, revealed only to editors of that scope', async () => {
    const token = await ok(
      request('POST', '/api/variables', { as: 'admin', body: { scope: 'global', name: 'API_TOKEN', value: SECRET, isSecret: true } }),
      201
    );
    const [row] = await db.sequelize.query(`SELECT value FROM variables WHERE id = :id`, {
      replacements: { id: token.id },
      type: 'SELECT'
    });
    assert.match(row.value, /^enc:v2:/);
    assert.ok(!row.value.includes(SECRET));

    // Copied to another row, the ciphertext no longer decrypts
    const { decryptVariableValue } = await import('../src/utils');
    assert.equal(decryptVariableValue({ id: token.id, value: row.value }), SECRET);
    assert.throws(() => decryptVariableValue({ id: token.id + 1000, value: row.value }));

    for (const who of ['viewer', 'editor', 'admin']) {
      const list = await request('GET', '/api/variables', { as: who });
      assert.ok(!list.text.includes(SECRET), who);
      const preview = await request('GET', `/api/variables/preview?snippetId=${snippet.id}&siteId=${acme.id}`, { as: who });
      assert.equal(preview.status, 200, preview.text);
      assert.ok(!preview.text.includes(SECRET), who);
      const item = preview.json().data.variables.find((variable: any) => variable.name === 'API_TOKEN');
      assert.deepEqual([item.value, item.source, item.isSecret], [MASK, 'global', true]);
    }

    assert.equal((await request('GET', `/api/variables/${token.id}/reveal`, { as: 'editor' })).status, 403);
    assert.equal((await ok(request('GET', `/api/variables/${token.id}/reveal`, { as: 'admin' }))).value, SECRET);

    // Updating without a value keeps the secret, still bound
    await ok(request('PUT', `/api/variables/${token.id}`, { as: 'admin', body: { name: 'API_TOKEN', isSecret: true, description: 'ci' } }));
    assert.equal((await ok(request('GET', `/api/variables/${token.id}/reveal`, { as: 'admin' }))).value, SECRET);
  });

  test('resolution order: default < global < site < user < runtime prompt', async () => {
    const { renderSnippetFor } = await import('../src/utils');
    const models = await import('../src/models');
    const editorUser = await models.UserModel.findOne({ where: { email: 'editor@example.test' } });
    const code = 'echo {{HOST:localhost}} {{PORT:22}} {{REGION:eu}}';
    const render = (options: Record<string, unknown>) =>
      renderSnippetFor({ code, language: 'text', includeSecrets: false, ...options });

    assert.equal((await render({})).code, 'echo global.lan 2222 eu');
    assert.equal((await render({ siteId: acme.id })).code, 'echo acme.lan 2200 eu');
    assert.equal((await render({ siteId: acme.id, userId: editorUser!.id })).code, 'echo acme.lan 9999 eu');
    assert.equal(
      (await render({ siteId: acme.id, userId: editorUser!.id, explicit: { PORT: '1', REGION: 'us' } })).code,
      'echo acme.lan 1 us'
    );

    const preview = await ok(request('GET', `/api/variables/preview?snippetId=${snippet.id}&siteId=${acme.id}`, { as: 'editor' }));
    const bySource = Object.fromEntries(preview.variables.map((item: any) => [item.name, [item.value, item.source]]));
    assert.deepEqual(bySource.HOST, ['acme.lan', 'site']);
    assert.deepEqual(bySource.PORT, ['9999', 'user']);
    assert.deepEqual(bySource.REGION, ['eu', 'default']);
    assert.deepEqual(bySource.ONLY_DEFAULT, ['d', 'default']);
    assert.deepEqual(preview.order, ['default', 'global', 'site', 'device', 'user', 'prompt']);

    const noSite = await ok(request('GET', `/api/variables/preview?snippetId=${snippet.id}`, { as: 'viewer' }));
    assert.deepEqual(
      noSite.variables.find((item: any) => item.name === 'HOST'),
      { name: 'HOST', value: 'global.lan', source: 'global', isSecret: false }
    );
    // A site the user cannot see looks missing
    assert.equal((await request('GET', `/api/variables/preview?snippetId=${snippet.id}&siteId=${other.id}`, { as: 'editor' })).status, 404);
    assert.equal((await request('GET', `/api/variables/preview?snippetId=999999`, { as: 'editor' })).status, 404);
  });

  test('Used in lists snippets, runbooks and schedules', async () => {
    const plain = await ok(
      request('POST', '/api/snippets', {
        body: { title: 'Plain', language: 'bash', code: 'echo hi\n', description: '', docs: '', tags: [], isPinned: false }
      }),
      201
    );
    const runbook = await ok(
      request('POST', '/api/runbooks', { body: { title: 'Rollout', steps: [{ snippetId: snippet.id, title: 'connect', note: '' }] } }),
      201
    );
    const schedule = await ok(
      request('POST', '/api/schedules', {
        body: { name: 'Nightly', cron: '0 3 * * *', timezone: 'UTC', targetType: 'snippet', snippetId: snippet.id, siteMode: 'none', variables: { REGION: 'us-secret-ish' } }
      }),
      201
    );
    const usage = await ok(request('GET', '/api/variables/usage', { as: 'viewer' }));
    assert.deepEqual(usage.HOST.snippets.map((item: any) => item.id), [snippet.id]);
    assert.deepEqual(usage.HOST.runbooks.map((item: any) => item.id), [runbook.id]);
    assert.deepEqual(usage.REGION.schedules.map((item: any) => item.id), [schedule.id]);
    assert.ok(!usage.HOST.snippets.some((item: any) => item.id === plain.id));
    // Schedule values never show up here
    assert.ok(!JSON.stringify(usage).includes('us-secret-ish'));
  });

  test('migration 27 binds legacy secrets, fixes ambiguous rows and is idempotent', async () => {
    const { encryptSecret, decryptVariableValue } = await import('../src/utils');
    const q = db.sequelize;
    await q.query(`ALTER TABLE variables DROP CONSTRAINT IF EXISTS variables_single_scope`);
    const owner = await q.query(`SELECT id FROM users WHERE email = 'owner@example.test'`, { type: 'SELECT' });
    await q.query(
      `INSERT INTO variables (name, value, description, "isSecret", "userId", "siteId", "createdAt", "updatedAt")
       VALUES ('LEGACY_V1', :v1, '', true, NULL, NULL, NOW(), NOW()),
              ('LEGACY_PLAIN', 'plain-secret', '', true, NULL, :site, NOW(), NOW()),
              ('AMBIGUOUS', 'x', '', false, :user, :site, NOW(), NOW())`,
      { replacements: { v1: encryptSecret('v1-secret'), site: acme.id, user: owner[0].id } }
    );

    const migration = await import('../src/db/migrations/27_variable_scopes');
    await migration.up(q.getQueryInterface());
    const rows = await q.query(`SELECT id, name, value, "siteId" FROM variables WHERE name IN ('LEGACY_V1','LEGACY_PLAIN','AMBIGUOUS') ORDER BY name`, { type: 'SELECT' });
    const byName = Object.fromEntries(rows.map((row: any) => [row.name, row]));
    assert.equal(byName.AMBIGUOUS.siteId, null);
    assert.match(byName.LEGACY_V1.value, /^enc:v2:/);
    assert.match(byName.LEGACY_PLAIN.value, /^enc:v2:/);
    assert.equal(decryptVariableValue(byName.LEGACY_V1), 'v1-secret');
    assert.equal(decryptVariableValue(byName.LEGACY_PLAIN), 'plain-secret');

    // Running again changes nothing
    await migration.up(q.getQueryInterface());
    assert.equal(await migration.bindVariableSecrets(q.getQueryInterface()), 0);
    const again = await q.query(`SELECT value FROM variables WHERE name = 'LEGACY_V1'`, { type: 'SELECT' });
    assert.equal(again[0].value, byName.LEGACY_V1.value);

    // The constraint now refuses rows in two scopes
    await assert.rejects(
      q.query(
        `INSERT INTO variables (name, value, description, "isSecret", "userId", "siteId", "createdAt", "updatedAt")
         VALUES ('BAD', '', '', false, :user, :site, NOW(), NOW())`,
        { replacements: { site: acme.id, user: owner[0].id } }
      )
    );
  });

  test('migration 27 rolls back as a whole when a secret cannot be read', async () => {
    const q = db.sequelize;
    await q.query(
      `INSERT INTO variables (name, value, description, "isSecret", "userId", "siteId", "createdAt", "updatedAt")
       VALUES ('BROKEN', 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '', true, NULL, :site, NOW(), NOW()),
              ('AFTER_BROKEN', 'later-plain', '', true, NULL, NULL, NOW(), NOW())`,
      { replacements: { site: other.id } }
    );
    const migration = await import('../src/db/migrations/27_variable_scopes');
    await assert.rejects(migration.up(q.getQueryInterface()));
    const [after] = await q.query(`SELECT value FROM variables WHERE name = 'AFTER_BROKEN'`, { type: 'SELECT' });
    assert.equal(after.value, 'later-plain');
    await q.query(`DELETE FROM variables WHERE name IN ('BROKEN', 'AFTER_BROKEN')`);
  });
});
