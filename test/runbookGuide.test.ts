/**
 * In-app runbook guide and the one-click example runbook import:
 * guide served offline, import idempotent, permissions and audit log.
 * Needs TEST_DATABASE_URL (a throwaway database whose name contains "test").
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set, skipping runbook guide tests';

interface TestResponse {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
  json: () => any;
}

describe('runbook guide and example import', { skip }, () => {
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

  let siteA: { id: number };
  let siteB: { id: number };

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

    siteA = await ok(request('POST', '/api/sites', { body: { name: 'Alpha', access: 'members' } }), 201);
    siteB = await ok(request('POST', '/api/sites', { body: { name: 'Bravo', access: 'members' } }), 201);

    const memberIds: number[] = [];
    for (const [who, role] of [['alice', 'editor'], ['vera', 'viewer']]) {
      const user = await ok(
        request('POST', '/api/admin/users', {
          body: { email: `${who}@example.test`, displayName: who, password: `${who}-password-123`, role }
        }),
        201
      );
      memberIds.push(user.id);
      await ok(request('PUT', `/api/sites/${siteA.id}/members`, { body: { userIds: memberIds } }));
      const login = await request('POST', '/api/auth/login', {
        body: { email: `${who}@example.test`, password: `${who}-password-123` },
        as: null
      });
      cookies[who] = String(login.headers['set-cookie']?.[0] || '').split(';')[0];
    }
  });

  after(async () => {
    await new Promise(resolve => server?.close(resolve));
    await db?.sequelize.close();
  });

  test('the guide is served from the bundled docs and needs a login', async () => {
    const guide = await ok(request('GET', '/api/help/playbooks'));
    assert.match(guide.markdown, /^# /m);
    assert.match(guide.markdown, /runbook/i);
    assert.equal((await request('GET', '/api/help/playbooks', { as: null })).status, 401);
    assert.equal((await request('GET', '/api/help/..%2Fpackage.json')).status, 404);
  });

  test('import creates the example once and is idempotent', async () => {
    const first = await ok(request('POST', '/api/runbooks/example', { body: { siteId: siteA.id }, as: 'alice' }), 201);
    assert.equal(first.created.runbook, true);
    assert.ok(first.created.snippets > 0);
    assert.ok(first.created.variables > 0);

    const steps = await models.RunbookStepModel.findAll({ where: { runbookId: first.runbookId } });
    assert.ok(steps.length > 0);
    assert.ok(steps.some(step => step.snippetId !== null));

    const counts = async () => ({
      snippets: await models.SnippetModel.count(),
      runbooks: await models.RunbookModel.count(),
      variables: await models.VariableModel.count()
    });
    const before = await counts();
    const again = await ok(request('POST', '/api/runbooks/example', { body: { siteId: siteA.id }, as: 'alice' }));
    assert.equal(again.runbookId, first.runbookId);
    assert.deepEqual(again.created, { snippets: 0, runbook: false, variables: 0 });
    assert.deepEqual(await counts(), before);

    // Concurrent clicks still create nothing new
    await Promise.all([1, 2, 3].map(() => request('POST', '/api/runbooks/example', { body: { siteId: siteA.id } })));
    assert.deepEqual(await counts(), before);

    // Another site only gets its own variables
    const other = await ok(request('POST', '/api/runbooks/example', { body: { siteId: siteB.id } }));
    assert.equal(other.created.snippets, 0);
    assert.equal(other.created.runbook, false);
    assert.equal(other.created.variables, first.created.variables);
  });

  test('permissions: editors need site access, viewers cannot import', async () => {
    assert.equal((await request('POST', '/api/runbooks/example', { body: { siteId: siteB.id }, as: 'alice' })).status, 404);
    assert.equal((await request('POST', '/api/runbooks/example', { body: { siteId: siteA.id }, as: 'vera' })).status, 403);
    assert.equal((await request('POST', '/api/runbooks/example', { body: {}, as: 'alice' })).status, 404);
  });

  test('imports are audit-logged', async () => {
    const entries = await models.AuditLogModel.findAll({ where: { action: 'runbook.example_imported' } });
    assert.ok(entries.length >= 3);
    const metadata = JSON.parse(String(entries[0].metadata));
    assert.equal(metadata.siteId, siteA.id);
  });
});
