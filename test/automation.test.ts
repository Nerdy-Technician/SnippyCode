/**
 * HTTP tests for device agents, schedules, notifications, backups, lint and
 * AI routes against a real PostgreSQL database. Set TEST_DATABASE_URL to a
 * throwaway database whose name contains "test"; its public schema is dropped
 * and re-created.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createHmac } from 'crypto';
import { AddressInfo } from 'net';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set, skipping automation tests';

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: () => any;
}

const SECRET = 'tok_live_very_secret_4242';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('agents, schedules, notifications and backups', { skip }, () => {
  let server: http.Server;
  let port = 0;
  let db: any;
  let utils: any;
  let cookie = '';
  const password = 'correct-horse-battery';

  // Webhook receiver
  let hookServer: http.Server;
  let hookPort = 0;
  const received: { headers: http.IncomingHttpHeaders; body: string; json: any }[] = [];

  const request = (
    method: string,
    path: string,
    options: {
      body?: unknown;
      raw?: string | Buffer;
      contentType?: string;
      headers?: http.OutgoingHttpHeaders;
      auth?: boolean;
    } = {}
  ): Promise<TestResponse> =>
    new Promise((resolve, reject) => {
      const payload =
        options.raw !== undefined ? options.raw : options.body === undefined ? undefined : JSON.stringify(options.body);
      const headers: http.OutgoingHttpHeaders = { ...(options.headers || {}) };

      if (payload !== undefined) {
        headers['content-type'] = options.contentType || 'application/json';
        headers['content-length'] = Buffer.byteLength(payload);
      }

      if (options.auth !== false && cookie) {
        headers.cookie = cookie;
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

  const multipart = (fields: { [name: string]: string | { filename: string; content: string } }) => {
    const boundary = `----snippy${Date.now()}`;
    const parts = Object.entries(fields).map(([name, value]) =>
      typeof value === 'string'
        ? `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        : `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${value.content}\r\n`
    );

    return {
      raw: Buffer.from(`${parts.join('')}--${boundary}--\r\n`),
      contentType: `multipart/form-data; boundary=${boundary}`
    };
  };

  const agent = (token: string) => ({
    next: () => request('GET', '/api/agent/next?wait=0&caps=bash', { auth: false, headers: { authorization: `Bearer ${token}` } }),
    result: (jobId: string | number, fields: { [name: string]: string | { filename: string; content: string } }) => {
      const form = multipart(fields);
      return request('POST', `/api/agent/jobs/${jobId}/result`, {
        auth: false,
        raw: form.raw,
        contentType: form.contentType,
        headers: { authorization: `Bearer ${token}` }
      });
    }
  });

  const waitFor = async <T>(check: () => Promise<T | null | undefined | false>, what: string, ms = 8000): Promise<T> => {
    const until = Date.now() + ms;

    while (Date.now() < until) {
      const value = await check();
      if (value) {
        return value;
      }
      await sleep(100);
    }

    throw new Error(`Timed out waiting for ${what}`);
  };

  const events = (name: string) => received.filter(item => item.json.event === name);

  let site: { id: number; slug: string };
  let passing: { id: number };
  let failing: { id: number };
  let deviceToken = '';
  let deviceId = 0;

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
    process.env.PUBLIC_BASE_URL = 'https://snippy.test';
    process.env.BACKUP_DIR = mkdtempSync(join(tmpdir(), 'snippycode-backups-'));

    hookServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        received.push({ headers: req.headers, body, json: JSON.parse(body) });
        res.writeHead(req.url === '/broken' ? 500 : 204).end();
      });
    });
    hookServer.listen(0, '127.0.0.1');
    await new Promise(resolve => hookServer.once('listening', resolve));
    hookPort = (hookServer.address() as AddressInfo).port;

    utils = await import('../src/utils');
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
      body: { email: 'owner@example.test', displayName: 'Owner', password },
      auth: false
    });
    assert.equal(setup.status, 201, setup.text);
    cookie = String(setup.headers['set-cookie']?.[0] || '').split(';')[0];

    site = await ok(request('POST', '/api/sites', { body: { name: 'Acme', tags: 'prod' } }), 201);
    await ok(
      request('POST', '/api/variables', {
        body: { scope: 'site', siteId: site.id, name: 'TOKEN', value: SECRET, isSecret: true }
      }),
      201
    );

    const snippet = (title: string, code: string) =>
      ok(
        request('POST', '/api/snippets', {
          body: { title, language: 'bash', code, description: '', docs: '', tags: [], isPinned: false }
        }),
        201
      );
    passing = await snippet('Disk check', 'echo "disk ok for {{TOKEN}}"\n');
    failing = await snippet('Broken check', 'echo "about to fail" >&2\nexit 3\n');

    await ok(
      request('POST', '/api/notifications', {
        body: {
          name: 'Receiver',
          type: 'webhook',
          url: `http://127.0.0.1:${hookPort}/hook`,
          signingSecret: 'hook-secret',
          events: ['*']
        }
      }),
      201
    );
  });

  after(async () => {
    await utils?.flushNotifications();
    await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
    await new Promise(resolve => (hookServer ? hookServer.close(resolve) : resolve(undefined)));
    await db?.sequelize.close();
  });

  test('a failed run sends a signed webhook with the output masked', async () => {
    const run = await ok(request('POST', `/api/snippets/${failing.id}/run`, { body: { siteId: site.id } }));
    assert.equal(run.ok, false);
    assert.equal(run.exitCode, 3);
    await utils.flushNotifications();

    const [hook] = events('run.failed');
    assert.ok(hook, 'run.failed should be delivered');
    assert.equal(hook.json.title, 'Broken check failed on Acme');
    assert.match(hook.json.text, /about to fail/);
    assert.equal(hook.json.url, `https://snippy.test/snippet/${failing.id}`);

    const timestamp = String(hook.headers['x-snippycode-timestamp']);
    const expected = createHmac('sha256', 'hook-secret').update(`${timestamp}.${hook.body}`).digest('hex');
    assert.equal(hook.headers['x-snippycode-signature'], `sha256=${expected}`);
    assert.equal(hook.headers['x-snippycode-event'], 'run.failed');

    const list = await ok(request('GET', '/api/notifications'));
    assert.equal(list.webhooks[0].host, `127.0.0.1:${hookPort}`);
    assert.equal(list.webhooks[0].lastStatus, 'ok');
    assert.ok(!JSON.stringify(list).includes('/hook'), 'the full URL is never sent back');
  });

  test('a device enrolls once with its token and then polls for work', async () => {
    const enrollment = await ok(request('POST', '/api/devices/enrollments', { body: { siteId: site.id } }), 201);
    assert.match(enrollment.linux, /install\.sh \| sudo bash -s -- --url .* --token sc_enroll_/);
    assert.match(enrollment.windows, /install\.ps1/);

    const form = `token=${encodeURIComponent(enrollment.token)}&hostname=web-01&os=linux&arch=x86_64&version=1.0.0`;
    const enrolled = await request('POST', '/api/agent/enroll?format=env', {
      auth: false,
      raw: form,
      contentType: 'application/x-www-form-urlencoded'
    });
    assert.equal(enrolled.status, 201, enrolled.text);
    deviceToken = /DEVICE_TOKEN=(\S+)/.exec(enrolled.text)![1];
    deviceId = Number(/DEVICE_ID=(\d+)/.exec(enrolled.text)![1]);
    assert.match(enrolled.text, /SITE=acme/);

    const again = await request('POST', '/api/agent/enroll', {
      auth: false,
      raw: form,
      contentType: 'application/x-www-form-urlencoded'
    });
    assert.equal(again.status, 401, 'enrollment tokens are single use by default');

    const idle = await agent(deviceToken).next();
    assert.equal(idle.status, 204);
    assert.equal((await request('GET', '/api/agent/next?wait=0', { auth: false, headers: { authorization: 'Bearer sc_dev_nope' } })).status, 401);

    const devices = await ok(request('GET', `/api/devices?siteId=${site.id}`));
    assert.equal(devices[0].name, 'web-01');
    assert.equal(devices[0].online, true);
    assert.deepEqual(devices[0].capabilities, ['bash']);

    await utils.flushNotifications();
    assert.equal(events('device.enrolled').length, 1);
  });

  test('a snippet run is queued for the device, fetched with secrets, and reported back', async () => {
    const queued = await ok(
      request('POST', `/api/snippets/${passing.id}/run`, { body: { siteId: site.id, deviceIds: 'all' } }),
      202
    );
    assert.equal(queued.jobs.length, 1);

    const job = await agent(deviceToken).next();
    assert.equal(job.status, 200);
    assert.equal(job.headers['x-job-language'], 'bash');
    assert.equal(job.text, `echo "disk ok for ${SECRET}"\n`);

    const [stored] = await db.sequelize.query(`SELECT payload FROM agent_jobs WHERE id = :id`, {
      type: 'SELECT',
      replacements: { id: queued.jobs[0].id }
    });
    assert.ok(!stored.payload.includes(SECRET), 'queued code is encrypted at rest');

    const posted = await ok(
      agent(deviceToken).result(job.headers['x-job-id'] as string, {
        exitCode: '0',
        durationMs: '120',
        timedOut: 'false',
        stdout: { filename: 'out', content: `disk ok for ${SECRET}\n` },
        stderr: { filename: 'err', content: '' }
      })
    );
    assert.equal(posted.accepted, true);

    const duplicate = await ok(agent(deviceToken).result(job.headers['x-job-id'] as string, { exitCode: '1' }));
    assert.equal(duplicate.accepted, false, 'a job only takes one result');

    const [status] = await ok(request('GET', `/api/devices/jobs?ids=${queued.jobs[0].id}`));
    assert.equal(status.status, 'done');
    assert.equal(status.run.stdout, 'disk ok for ••••••\n');
    assert.equal(status.run.deviceName, 'web-01');
    assert.equal(status.run.sandbox, 'device');

    const [payloadGone] = await db.sequelize.query(`SELECT payload FROM agent_jobs WHERE id = :id`, {
      type: 'SELECT',
      replacements: { id: queued.jobs[0].id }
    });
    assert.equal(payloadGone.payload, '', 'code is dropped once it has run');
  });

  test('a runbook run on a device waits for each step', async () => {
    const runbook = await ok(
      request('POST', '/api/runbooks', {
        body: { title: 'Patch', steps: [{ snippetId: passing.id }, { title: 'Tell the customer' }] }
      }),
      201
    );
    const run = await ok(
      request('POST', `/api/runbooks/${runbook.id}/runs`, { body: { siteId: site.id, deviceId } }),
      201
    );
    assert.equal(run.device.name, 'web-01');

    const afterRun = await ok(
      request('POST', `/api/runbooks/runs/${run.id}/steps/${runbook.steps[0].id}`, { body: { action: 'run' } })
    );
    assert.equal(afterRun.steps[0].status, 'running');
    assert.equal(
      (await request('POST', `/api/runbooks/runs/${run.id}/steps/${runbook.steps[0].id}`, { body: { action: 'done' } })).status,
      409
    );

    const job = await agent(deviceToken).next();
    await ok(agent(deviceToken).result(job.headers['x-job-id'] as string, { exitCode: '0', stdout: 'patched\n' }));

    const detail = await ok(request('GET', `/api/runbooks/runs/${run.id}`));
    assert.equal(detail.steps[0].status, 'done');
    assert.equal(detail.steps[0].lastRun.stdout, 'patched\n');

    const finished = await ok(
      request('POST', `/api/runbooks/runs/${run.id}/steps/${runbook.steps[1].id}`, { body: { action: 'done' } })
    );
    assert.equal(finished.status, 'completed');
    await utils.flushNotifications();
    assert.equal(events('runbook.completed').length, 1);
  });

  test('schedules validate cron and preview the next runs', async () => {
    const bad = await request('POST', '/api/schedules', {
      body: { name: 'Bad', targetType: 'snippet', snippetId: passing.id, cron: '99 * * * *', timezone: 'UTC' }
    });
    assert.equal(bad.status, 400);
    assert.match(bad.json().error, /Cron/);

    const preview = await ok(request('GET', '/api/schedules/preview?cron=0%209%20*%20*%20mon&timezone=Europe%2FLondon'));
    assert.equal(preview.valid, true);
    assert.equal(preview.next.length, 5);
    assert.equal(new Date(preview.next[0]).getUTCDay(), 1);
  });

  test('a scheduled server run on a tag of sites reports its result', async () => {
    const schedule = await ok(
      request('POST', '/api/schedules', {
        body: {
          name: 'Nightly broken check',
          targetType: 'snippet',
          snippetId: failing.id,
          cron: '0 2 * * *',
          timezone: 'Europe/London',
          siteMode: 'tag',
          siteTag: 'prod',
          notifyOn: 'failure'
        }
      }),
      201
    );
    assert.ok(new Date(schedule.nextRunAt) > new Date());

    // Pretend it is due, then let the scheduler pick it up
    await db.sequelize.query(`UPDATE schedules SET "nextRunAt" = NOW() - INTERVAL '1 minute' WHERE id = :id`, {
      replacements: { id: schedule.id }
    });
    assert.equal(await utils.tickScheduler(new Date()), 1);

    const detail = await waitFor(async () => {
      const data = await ok(request('GET', `/api/schedules/${schedule.id}`));
      return data.runs[0]?.status !== 'running' && data.runs[0] ? data : null;
    }, 'the schedule run to finish');

    assert.equal(detail.runs[0].status, 'failed');
    assert.equal(detail.runs[0].results[0].site.name, 'Acme');
    assert.equal(detail.lastStatus, 'failed');
    assert.ok(new Date(detail.nextRunAt) > new Date(), 'the next run moved forward');

    await utils.flushNotifications();
    const [hook] = events('schedule.failed');
    assert.equal(hook.json.title, 'Nightly broken check: 1 of 1 failed');
    assert.match(hook.json.text, /❌ Acme: exit 3/);
    assert.equal(events('run.failed').length, 1, 'scheduled runs are summarised, not sent one by one');
  });

  test('a scheduled device run closes when the agent reports back', async () => {
    const schedule = await ok(
      request('POST', '/api/schedules', {
        body: {
          name: 'Disk check on devices',
          targetType: 'snippet',
          snippetId: passing.id,
          cron: '*/5 * * * *',
          timezone: 'UTC',
          siteMode: 'sites',
          siteIds: [site.id],
          runOn: 'devices',
          notifyOn: 'always'
        }
      }),
      201
    );
    await ok(request('POST', `/api/schedules/${schedule.id}/run`), 202);

    let detail = await ok(request('GET', `/api/schedules/${schedule.id}`));
    assert.equal(detail.runs[0].status, 'running');
    assert.equal(detail.runs[0].pendingJobs, 1);

    const job = await agent(deviceToken).next();
    await ok(agent(deviceToken).result(job.headers['x-job-id'] as string, { exitCode: '0', stdout: 'fine\n' }));

    detail = await ok(request('GET', `/api/schedules/${schedule.id}`));
    assert.equal(detail.runs[0].status, 'succeeded');
    assert.equal(detail.runs[0].results[0].deviceName, 'web-01');

    await utils.flushNotifications();
    assert.equal(events('schedule.succeeded')[0].json.title, 'Disk check on devices: all 1 targets succeeded');
  });

  test('jobs nobody collects expire, and revoked devices are locked out', async () => {
    const queued = await ok(
      request('POST', `/api/snippets/${passing.id}/run`, { body: { siteId: site.id, deviceIds: [deviceId] } }),
      202
    );
    await db.sequelize.query(`UPDATE agent_jobs SET "createdAt" = NOW() - INTERVAL '1 hour' WHERE id = :id`, {
      replacements: { id: queued.jobs[0].id }
    });
    assert.equal(await utils.expireStaleJobs(), 1);

    const [expired] = await ok(request('GET', `/api/devices/jobs?ids=${queued.jobs[0].id}`));
    assert.equal(expired.status, 'expired');
    assert.match(expired.run.stderr, /did not collect/);

    await ok(request('DELETE', `/api/devices/${deviceId}`));
    assert.equal((await agent(deviceToken).next()).status, 401);
  });

  test('lint and AI routes need the right role and configuration', async () => {
    const lint = await ok(request('POST', '/api/snippets/lint', { body: { language: 'yaml', code: 'a: 1' } }));
    assert.equal(lint.available, false);

    const explain = await request('POST', `/api/snippets/${passing.id}/explain`, { body: {} });
    assert.equal(explain.status, 400);
    assert.match(explain.json().error, /No AI provider/);
  });

  test('an encrypted backup restores everything, even under a new secret key', async () => {
    const backup = await ok(
      request('POST', '/api/admin/backups', { body: { passphrase: 'long enough passphrase' } }),
      201
    );
    assert.match(backup.name, /\.enc\.json$/);

    // Change things after the backup
    await ok(request('DELETE', `/api/snippets/${passing.id}`));
    await ok(request('POST', '/api/sites', { body: { name: 'Added later' } }), 201);

    const wrong = await request('POST', '/api/admin/backups/restore', {
      body: { name: backup.name, passphrase: 'nope nope nope', confirm: 'RESTORE' }
    });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json().error, /passphrase/);

    const unconfirmed = await request('POST', '/api/admin/backups/restore', {
      body: { name: backup.name, passphrase: 'long enough passphrase' }
    });
    assert.equal(unconfirmed.status, 400);

    // A different server key: portable secrets are re-encrypted on restore
    process.env.VARIABLES_SECRET_KEY = 'a-brand-new-key';
    const restored = await ok(
      request('POST', '/api/admin/backups/restore', {
        body: { name: backup.name, passphrase: 'long enough passphrase', confirm: 'RESTORE' }
      })
    );
    assert.match(restored.safetyBackup, /before-restore/);
    assert.ok(restored.restored.snippets >= 2);

    const login = await request('POST', '/api/auth/login', {
      body: { email: 'owner@example.test', password },
      auth: false
    });
    cookie = String(login.headers['set-cookie']?.[0] || '').split(';')[0];

    const snippets = await ok(request('GET', '/api/snippets'));
    assert.ok(snippets.some((item: any) => item.id === passing.id), 'deleted snippet is back');
    const sites = await ok(request('GET', '/api/sites'));
    assert.deepEqual(sites.sites.map((item: any) => item.name), ['Acme']);

    const vars = await ok(request('GET', '/api/variables'));
    const token = vars.site.find((item: any) => item.name === 'TOKEN');
    assert.equal((await ok(request('GET', `/api/variables/${token.id}/reveal`))).value, SECRET);

    // New rows keep working after the id sequences were reset
    await ok(request('POST', '/api/sites', { body: { name: 'After restore' } }), 201);

    const list = await ok(request('GET', '/api/admin/backups'));
    assert.equal(list.backups.length, 2);
  });

  test('an uploaded plain backup restores on the same key', async () => {
    const created = await ok(request('POST', '/api/admin/backups', { body: {} }), 201);
    const download = await request('GET', `/api/admin/backups/${created.name}`);
    assert.equal(download.status, 200);

    const form = multipart({ confirm: 'RESTORE', file: { filename: created.name, content: download.text } });
    const restored = await request('POST', '/api/admin/backups/restore', {
      raw: form.raw,
      contentType: form.contentType
    });
    assert.equal(restored.status, 200, restored.text);
    assert.equal(restored.json().data.meta.secretsPortable, false);
  });
});
