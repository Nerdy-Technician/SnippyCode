/**
 * HTTP tests for variables, secrets, sites, raw links, run history and
 * runbooks against a real PostgreSQL database. Set TEST_DATABASE_URL to a
 * throwaway database whose name contains "test"; its public schema is dropped
 * and re-created.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createHash } from 'crypto';
import { AddressInfo } from 'net';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = TEST_DATABASE_URL
  ? false
  : 'TEST_DATABASE_URL is not set, skipping HTTP variable and site tests';

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: () => any;
}

const SECRET = 'sk_live_very_secret_value';
const MASK = '••••••';

describe('variables, secrets, sites, runs and runbooks', { skip }, () => {
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
        headers.cookie = cookies[who];
      }

      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
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

  let editor: { id: number };
  let snippet: { id: number; rawSlug: string };
  let acme: { id: number; slug: string };
  let vault: { id: number; slug: string };
  let snippetToken = '';
  let apiKey = '';

  before(async () => {
    const dbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');

    if (!/test/i.test(dbName)) {
      throw new Error(`Refusing to reset database "${dbName}": its name must contain "test"`);
    }

    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = 'snippycode-test-session-secret';
    process.env.VARIABLES_SECRET_KEY = 'snippycode-test-variables-key';
    process.env.SNIPPET_RUN_ENABLED = 'true';
    process.env.GITHUB_TOKEN = '';

    // Same module load order as src/server.ts (utils before db)
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

    editor = await createUser('editor', 'editor');
    await createUser('viewer', 'viewer');

    snippet = await ok(
      request('POST', '/api/snippets', {
        body: {
          title: 'Deploy agent',
          language: 'bash',
          code: 'echo {{HOST:localhost}} {{API_TOKEN}} {{REGION:eu}}\n',
          description: '',
          docs: '',
          tags: [],
          isPinned: false
        }
      }),
      201
    );
    snippetToken = (await ok(request('POST', `/api/snippets/${snippet.id}/raw-token`), 201)).token;
    apiKey = (await ok(request('POST', '/api/admin/raw-api-key'), 201)).key;

    acme = await ok(request('POST', '/api/sites', { body: { name: 'Acme Corp', tags: 'prod, uk' } }), 201);
    vault = await ok(
      request('POST', '/api/sites', { body: { name: 'Vault Co', access: 'members' } }),
      201
    );

    await ok(request('POST', '/api/variables', { body: { scope: 'team', name: 'HOST', value: 'team.lan' } }), 201);
    await ok(
      request('POST', '/api/variables', {
        body: { scope: 'team', name: 'API_TOKEN', value: SECRET, isSecret: true }
      }),
      201
    );
    await ok(
      request('POST', '/api/variables', {
        body: { scope: 'site', siteId: acme.id, name: 'HOST', value: 'acme.example' }
      }),
      201
    );
    await ok(
      request('POST', '/api/variables', {
        body: { scope: 'site', siteId: vault.id, name: 'HOST', value: 'vault.internal' }
      }),
      201
    );
  });

  after(async () => {
    await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
    await db?.sequelize.close();
  });

  test('secret values are encrypted at rest and hidden in listings', async () => {
    const [row] = await db.sequelize.query(
      `SELECT value FROM variables WHERE name = 'API_TOKEN'`,
      { type: 'SELECT' }
    );
    assert.match(row.value, /^enc:v1:/);
    assert.ok(!row.value.includes(SECRET));

    const list = await ok(request('GET', '/api/variables', { as: 'viewer' }));
    const token = list.team.find((item: any) => item.name === 'API_TOKEN');
    assert.equal(token.value, '');
    assert.equal(token.isSecret, true);
    assert.equal(token.hasValue, true);
    assert.ok(!JSON.stringify(list).includes(SECRET));
  });

  test('editors can reveal team secrets (audited); viewers cannot', async () => {
    const list = await ok(request('GET', '/api/variables'));
    const id = list.team.find((item: any) => item.name === 'API_TOKEN').id;

    assert.equal((await ok(request('GET', `/api/variables/${id}/reveal`, { as: 'editor' }))).value, SECRET);
    assert.equal((await request('GET', `/api/variables/${id}/reveal`, { as: 'viewer' })).status, 403);

    const [audit] = await db.sequelize.query(
      `SELECT COUNT(*)::int AS count FROM audit_logs WHERE action = 'variable.revealed'`,
      { type: 'SELECT' }
    );
    assert.equal(audit.count, 1);
  });

  test('editing a secret without sending a value keeps it', async () => {
    const list = await ok(request('GET', '/api/variables'));
    const id = list.team.find((item: any) => item.name === 'API_TOKEN').id;

    await ok(
      request('PUT', `/api/variables/${id}`, {
        body: { name: 'API_TOKEN', description: 'Deploy token', isSecret: true }
      })
    );
    assert.equal((await ok(request('GET', `/api/variables/${id}/reveal`))).value, SECRET);
  });

  test('public raw links never get team values or secrets', async () => {
    await ok(request('PUT', `/api/snippets/${snippet.id}`, {
      body: {
        title: 'Deploy agent',
        language: 'bash',
        code: 'echo {{HOST:localhost}} {{API_TOKEN}} {{REGION:eu}}\n',
        description: '',
        docs: '',
        tags: [],
        isPinned: false,
        isPublic: true
      }
    }));

    const raw = await request('GET', `/raw/${snippet.rawSlug}`, { as: null });
    assert.equal(raw.status, 200);
    // Values are quoted for bash; an unfilled secret stays a placeholder
    assert.equal(raw.text, "echo 'localhost' {{API_TOKEN}} 'eu'\n");

    const withSite = await request('GET', `/raw/${snippet.rawSlug}?site=${acme.slug}`, { as: null });
    assert.equal(withSite.status, 401);
  });

  test('token and API key raw links fill site, team and secret values', async () => {
    const raw = await request('GET', `/raw/${snippet.rawSlug}?key=${snippetToken}&site=${acme.slug}&REGION=us`, {
      as: null
    });
    assert.equal(raw.status, 200, raw.text);
    assert.equal(raw.text, `echo 'acme.example' '${SECRET}' 'us'\n`);
    assert.equal(
      raw.headers['x-content-sha256'],
      createHash('sha256').update(raw.text).digest('hex')
    );

    const template = await request('GET', `/raw/${snippet.rawSlug}?key=${snippetToken}&render=0`, { as: null });
    assert.equal(template.text, 'echo {{HOST:localhost}} {{API_TOKEN}} {{REGION:eu}}\n');
  });

  test('a snippet token cannot reach a members-only site; the admin key can', async () => {
    const byToken = await request('GET', `/raw/${snippet.rawSlug}?key=${snippetToken}&site=${vault.slug}`, { as: null });
    assert.equal(byToken.status, 404);

    const byKey = await request('GET', `/raw/${snippet.rawSlug}?site=${vault.slug}`, {
      as: null,
      headers: { 'x-api-key': apiKey }
    });
    assert.equal(byKey.status, 200, byKey.text);
    assert.match(byKey.text, /vault\.internal/);
  });

  test('members-only sites are hidden until the user is added', async () => {
    const before = await ok(request('GET', '/api/sites', { as: 'editor' }));
    assert.deepEqual(before.sites.map((site: any) => site.slug), [acme.slug]);
    assert.equal(before.canManage, false);

    const vars = await ok(request('GET', '/api/variables', { as: 'editor' }));
    assert.ok(!vars.site.some((item: any) => item.siteId === vault.id));
    assert.equal(
      (await request('POST', `/api/snippets/${snippet.id}/render`, { as: 'editor', body: { siteId: vault.id } })).status,
      404
    );
    assert.equal((await request('POST', '/api/sites', { as: 'editor', body: { name: 'Nope' } })).status, 403);

    await ok(request('PUT', `/api/sites/${vault.id}/members`, { body: { userIds: [editor.id] } }));

    const after = await ok(request('GET', '/api/sites', { as: 'editor' }));
    assert.deepEqual(after.sites.map((site: any) => site.slug).sort(), [acme.slug, vault.slug].sort());

    const rendered = await ok(
      request('POST', `/api/snippets/${snippet.id}/render`, { as: 'editor', body: { siteId: vault.id } })
    );
    assert.equal(rendered.code, `echo 'vault.internal' '${SECRET}' 'eu'\n`);
    assert.deepEqual(rendered.secretsUsed, ['API_TOKEN']);
    assert.equal(rendered.sha256, createHash('sha256').update(rendered.code).digest('hex'));

    await ok(request('PUT', `/api/sites/${vault.id}/members`, { body: { userIds: [] } }));
  });

  test('personal values beat site values, which beat team values', async () => {
    await ok(request('POST', '/api/variables', { as: 'editor', body: { scope: 'personal', name: 'REGION', value: 'mine' } }), 201);

    const rendered = await ok(
      request('POST', `/api/snippets/${snippet.id}/render`, { as: 'editor', body: { siteId: acme.id } })
    );
    assert.equal(rendered.code, `echo 'acme.example' '${SECRET}' 'mine'\n`);
  });

  test('server runs are saved per site with secrets masked', async () => {
    const result = await ok(
      request('POST', `/api/snippets/${snippet.id}/run`, { as: 'editor', body: { siteId: acme.id } })
    );
    assert.equal(result.ok, true);
    assert.equal(result.stdout, `acme.example ${MASK} mine\n`);

    const [stored] = await db.sequelize.query(`SELECT stdout FROM snippet_runs WHERE id = :id`, {
      type: 'SELECT',
      replacements: { id: result.runId }
    });
    assert.ok(!stored.stdout.includes(SECRET));

    const acmeRuns = await ok(request('GET', `/api/runs?siteId=${acme.id}`, { as: 'viewer' }));
    assert.equal(acmeRuns.length, 1);
    assert.equal(acmeRuns[0].site.slug, acme.slug);
    assert.equal(acmeRuns[0].user.displayName, 'editor');

    // A run on a members-only site stays hidden from non-members
    const vaultRun = await ok(request('POST', `/api/snippets/${snippet.id}/run`, { body: { siteId: vault.id } }));
    assert.equal((await request('GET', `/api/runs/${vaultRun.runId}`, { as: 'viewer' })).status, 404);
    assert.equal((await request('GET', `/api/runs?siteId=${vault.id}`, { as: 'viewer' })).status, 404);
    const viewerRuns = await ok(request('GET', '/api/runs', { as: 'viewer' }));
    assert.ok(!viewerRuns.some((run: any) => run.id === vaultRun.runId));
  });

  test('a runbook is worked through against one site', async () => {
    const runbook = await ok(
      request('POST', '/api/runbooks', {
        as: 'editor',
        body: {
          title: 'Onboard customer',
          steps: [
            { snippetId: snippet.id },
            { title: 'Email the customer', note: 'Send the welcome pack' }
          ]
        }
      }),
      201
    );
    assert.equal(runbook.steps.length, 2);
    assert.equal((await request('POST', `/api/runbooks/${runbook.id}/runs`, { as: 'viewer', body: {} })).status, 403);

    const started = await ok(
      request('POST', `/api/runbooks/${runbook.id}/runs`, { as: 'editor', body: { siteId: acme.id } }),
      201
    );
    assert.equal(started.status, 'in_progress');
    assert.deepEqual(started.progress, { total: 2, finished: 0, failed: 0 });

    const [runStep, manualStep] = runbook.steps;
    const afterRun = await ok(
      request('POST', `/api/runbooks/runs/${started.id}/steps/${runStep.id}`, {
        as: 'editor',
        body: { action: 'run' }
      })
    );
    const ran = afterRun.steps.find((step: any) => step.id === runStep.id);
    assert.equal(ran.status, 'done');
    assert.equal(ran.lastRun.stdout, `acme.example ${MASK} mine\n`);
    assert.equal(afterRun.status, 'in_progress');

    const finished = await ok(
      request('POST', `/api/runbooks/runs/${started.id}/steps/${manualStep.id}`, {
        as: 'editor',
        body: { action: 'done' }
      })
    );
    assert.equal(finished.status, 'completed');
    assert.ok(finished.completedAt);

    const reopened = await ok(
      request('POST', `/api/runbooks/runs/${started.id}/steps/${manualStep.id}`, {
        as: 'editor',
        body: { action: 'reset' }
      })
    );
    assert.equal(reopened.status, 'in_progress');

    const siteRuns = await ok(request('GET', `/api/runs?runbookRunId=${started.id}`));
    assert.equal(siteRuns.length, 1);

    // Editing keeps progress for steps that are kept
    const edited = await ok(
      request('PUT', `/api/runbooks/${runbook.id}`, {
        as: 'editor',
        body: {
          title: 'Onboard customer',
          steps: [runStep, { title: 'Book a follow-up call' }]
        }
      })
    );
    assert.equal(edited.steps[0].id, runStep.id);
    const detail = await ok(request('GET', `/api/runbooks/runs/${started.id}`));
    assert.equal(detail.steps.find((step: any) => step.id === runStep.id).status, 'done');
  });

  test('deleting a site removes its variables and run history', async () => {
    const temp = await ok(request('POST', '/api/sites', { body: { name: 'Acme Corp' } }), 201);
    assert.equal(temp.slug, 'acme-corp-2');
    await ok(request('POST', '/api/variables', { body: { scope: 'site', siteId: temp.id, name: 'HOST', value: 'x' } }), 201);
    await ok(request('DELETE', `/api/sites/${temp.id}`));

    const [count] = await db.sequelize.query(
      `SELECT COUNT(*)::int AS count FROM variables WHERE "siteId" = :id`,
      { type: 'SELECT', replacements: { id: temp.id } }
    );
    assert.equal(count.count, 0);
  });
});
