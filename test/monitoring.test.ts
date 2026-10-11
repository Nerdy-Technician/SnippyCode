/**
 * Monitoring: policy scopes, file listings, and (with TEST_DATABASE_URL) the
 * alert lifecycle, policy schedules, patch compliance and site reports.
 */
import './testDbEnv';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { policyMatches } from '../src/utils/monitoring';
import { buildToolScript, parseFileList } from '../src/utils/deviceTools';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set, skipping monitoring tests';

describe('policy scope', () => {
  const device = (props: { id: number; siteId: number; os: string }) => props as any;
  const site = (id: number, tags: string) => ({ id, tags }) as any;

  test('sites, tags, devices and OS narrow who a policy covers', () => {
    const linux = device({ id: 1, siteId: 10, os: 'linux' });
    const windows = device({ id: 2, siteId: 20, os: 'windows' });

    assert.equal(policyMatches({ all: true }, linux, site(10, '')), true);
    assert.equal(policyMatches({ all: true, os: 'windows' }, linux, site(10, '')), false);
    assert.equal(policyMatches({ siteIds: [20] }, windows, site(20, '')), true);
    assert.equal(policyMatches({ tags: ['prod'] }, linux, site(10, 'prod,linux')), true);
    assert.equal(policyMatches({ tags: ['prod'] }, windows, site(20, 'staging')), false);
    assert.equal(policyMatches({ deviceIds: [2], os: 'windows' }, windows, site(20, '')), true);
    assert.equal(policyMatches({}, linux, site(10, 'prod')), false, 'an empty scope covers nothing');
  });
});

describe('file tools', () => {
  test('Linux listings keep odd names and put folders first', () => {
    const out = ['f\t120\t1700000000.5\t644\troot\tb file.txt', 'd\t4096\t1700000000\t755\troot\tzeta', 'l\t7\t1700000000\t777\troot\tlink\twith tab'].join('\n');
    const entries = parseFileList('linux', out);

    assert.deepEqual(entries.map(entry => [entry.type, entry.name]), [
      ['dir', 'zeta'],
      ['file', 'b file.txt'],
      ['link', 'link\twith tab']
    ]);
    assert.equal(entries[1].size, 120);
    assert.equal(entries[1].modified, new Date(1700000000500).toISOString());
  });

  test('a Windows folder with one item is still a list', () => {
    const entries = parseFileList('windows', '{"name":"C:\\\\","type":"d","size":0,"modified":"","mode":"drive"}');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, 'dir');
  });

  test('paths are quoted and uploads are size-limited', () => {
    const code = buildToolScript('files', 'linux', { path: "/tmp/it's here" }).code;
    assert.ok(code.includes(`'/tmp/it'\\''s here'`));
    assert.throws(() => buildToolScript('files', 'linux', { path: 'relative/path' }), Error);
    assert.throws(() => buildToolScript('fileput', 'linux', { path: '/tmp/x', content: 'not base64!' }), Error);
    assert.throws(() => buildToolScript('fileput', 'linux', { path: '/tmp/x', content: 'A'.repeat(2_000_000) }), Error);
  });

  test('patching validates package names', () => {
    assert.throws(() => buildToolScript('patch', 'linux', { mode: 'selected', packages: ['vim; reboot'] }), Error);
    assert.match(buildToolScript('patch', 'linux', { mode: 'selected', packages: ['openssl', 'libssl3'] }).code, /openssl/);
  });
});

describe('alerts, policies and reports', { skip }, () => {
  let server: http.Server;
  let port = 0;
  let db: any;
  let utils: any;
  let models: any;
  let cookie = '';

  const request = (method: string, path: string, options: { body?: unknown; auth?: boolean; token?: string } = {}) =>
    new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders; json: () => any }>((resolve, reject) => {
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
      const headers: http.OutgoingHttpHeaders = {};
      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(payload);
      }
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      else if (options.auth !== false && cookie) { headers.cookie = `${cookie}; XSRF-TOKEN=test-xsrf`; headers['x-xsrf-token'] = 'test-xsrf'; }

      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
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

  const ok = async (res: ReturnType<typeof request>, status = 200) => {
    const response = await res;
    assert.equal(response.status, status, response.text);
    return response.json().data;
  };

  let site: { id: number };
  let deviceId = 0;
  let token = '';

  const facts = (diskUsedGb: number) =>
    ok(
      request('POST', '/api/agent/facts', {
        token,
        body: { cpus: 4, load1: 0.4, memTotalMb: 8000, memAvailableMb: 6000, diskTotalGb: 100, diskUsedGb }
      })
    );

  before(async () => {
    const dbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
    if (!/test/i.test(dbName)) throw new Error(`Refusing to reset database "${dbName}"`);

    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = 'snippycode-test-session-secret';
    process.env.VARIABLES_SECRET_KEY = 'snippycode-test-variables-key';

    utils = await import('../src/utils');
    models = await import('../src/models');
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
      auth: false
    });
    cookie = String(setup.headers['set-cookie']?.[0] || '').split(';')[0];

    site = await ok(request('POST', '/api/sites', { body: { name: 'Acme', tags: 'prod' } }), 201);
    const enrollment = await ok(request('POST', '/api/devices/enrollments', { body: { siteId: site.id } }), 201);
    const enrolled = await new Promise<string>((resolve, reject) => {
      const form = `token=${encodeURIComponent(enrollment.token)}&hostname=web-01&os=linux&arch=x86_64&version=1.3.0`;
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/agent/enroll?format=env',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) }
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }
      );
      req.on('error', reject);
      req.end(form);
    });
    token = /DEVICE_TOKEN=(\S+)/.exec(enrolled)![1];
    deviceId = Number(/DEVICE_ID=(\d+)/.exec(enrolled)![1]);
  });

  after(async () => {
    await utils?.flushNotifications();
    await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
    await db?.sequelize.close();
  });

  test('a disk monitor opens an alert, and it resolves on its own', async () => {
    const policy = await ok(
      request('POST', '/api/policies', {
        body: {
          name: 'Prod Linux servers',
          scope: { tags: ['prod'], os: 'linux' },
          monitors: [{ type: 'disk', params: { percent: 90 }, severity: 'critical' }]
        }
      }),
      201
    );
    assert.equal(policy.deviceCount, 1);
    assert.deepEqual(policy.monitors[0].params, { percent: 90 });

    await facts(95);
    await utils.monitoringTick(new Date());

    let alerts = await ok(request('GET', '/api/alerts'));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].severity, 'critical');
    assert.match(alerts[0].title, /Disk over 90% on web-01/);
    assert.match(alerts[0].detail, /\/ 95%/);

    // Still failing: the same alert, not a second one
    await utils.monitoringTick(new Date());
    assert.equal((await ok(request('GET', '/api/alerts'))).length, 1);

    await facts(40);
    await utils.monitoringTick(new Date());
    alerts = await ok(request('GET', '/api/alerts?status=resolved'));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].resolvedBy, 'auto');
    assert.equal((await ok(request('GET', '/api/alerts'))).length, 0);

    const metrics = await ok(request('GET', `/api/devices/${deviceId}/metrics?range=24h`));
    assert.ok(metrics.points.some((point: any) => point.disk === 40 || point.disk === 67.5));
    assert.equal(metrics.availability, 100);
  });

  test('alerts can be acknowledged, snoozed and resolved by hand', async () => {
    await facts(97);
    await utils.monitoringTick(new Date());
    const [alert] = await ok(request('GET', '/api/alerts'));

    const [acked] = await ok(request('POST', '/api/alerts/action', { body: { ids: [alert.id], action: 'acknowledge' } }));
    assert.equal(acked.status, 'acknowledged');
    assert.equal(acked.acknowledgedBy, 'Owner');

    const [snoozed] = await ok(request('POST', '/api/alerts/action', { body: { ids: [alert.id], action: 'snooze', minutes: 60 } }));
    assert.equal(snoozed.snoozed, true);

    const [resolved] = await ok(request('POST', '/api/alerts/action', { body: { ids: [alert.id], action: 'resolve' } }));
    assert.equal(resolved.status, 'resolved');

    // The disk is still full, so the next check opens a fresh alert
    await utils.monitoringTick(new Date());
    const open = await ok(request('GET', '/api/alerts'));
    assert.equal(open.length, 1);
    assert.notEqual(open[0].id, alert.id);
    await facts(40);
    await utils.monitoringTick(new Date());
  });

  test('a service monitor restarts the service, then escalates when it keeps stopping', async () => {
    const device = await models.DeviceModel.findByPk(deviceId);
    const inventory = (state: string) =>
      device.update({
        inventory: JSON.stringify({
          services: {
            at: new Date().toISOString(),
            data: [{ name: 'nginx.service', status: state === 'running' ? 'running' : 'stopped', state, startup: 'enabled' }]
          }
        })
      });

    await ok(
      request('POST', '/api/policies', {
        body: {
          name: 'Keep nginx running',
          scope: { deviceIds: [deviceId] },
          monitors: [{ type: 'service', params: { name: 'nginx', autoRestart: true, maxRestarts: 2 } }]
        }
      }),
      201
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await inventory('inactive');
      await utils.monitoringTick(new Date());
      const job = await models.AgentJobModel.findOne({
        where: { deviceId, tool: 'service', status: 'queued' }
      });
      assert.ok(job, `restart ${attempt + 1} is queued`);
      assert.match(job.snippetTitle, /nginx\.service: start/);
      await job.update({ status: 'done', finishedAt: new Date() });
    }

    await inventory('inactive');
    await utils.monitoringTick(new Date());
    const alerts = await ok(request('GET', '/api/alerts'));
    const alert = alerts.find((item: any) => item.type === 'service');
    assert.ok(alert, 'an alert opens after the restarts run out');
    assert.equal(alert.severity, 'critical');
    assert.match(alert.title, /keeps stopping/);

    await inventory('running');
    await utils.monitoringTick(new Date(Date.now() + 1000));
    assert.ok(!(await ok(request('GET', '/api/alerts'))).some((item: any) => item.type === 'service'));
  });

  test('schedules can target a policy, and it must exist', async () => {
    const policies = await ok(request('GET', '/api/policies'));
    const snippet = await ok(
      request('POST', '/api/snippets', {
        body: { title: 'Hello', language: 'bash', code: 'echo {{DEVICE_ASSET_TAG}}\n', description: '', docs: '', tags: [], isPinned: false }
      }),
      201
    );
    await ok(request('PUT', `/api/devices/${deviceId}/fields`, { body: { assetTag: 'AT-0042', custom: { rack: 'B2' } } }));

    const bad = await request('POST', '/api/schedules', {
      body: { name: 'x', targetType: 'snippet', snippetId: snippet.id, cron: '0 * * * *', siteMode: 'policy', policyId: 9999 }
    });
    assert.equal(bad.status, 400);

    const schedule = await ok(
      request('POST', '/api/schedules', {
        body: { name: 'Tag check', targetType: 'snippet', snippetId: snippet.id, cron: '0 * * * *', siteMode: 'policy', policyId: policies[0].id }
      }),
      201
    );
    assert.equal(schedule.runOn, 'devices');
    assert.equal(schedule.policyName, policies[0].name);

    await ok(request('POST', `/api/schedules/${schedule.id}/run`), 202);
    const job = await models.AgentJobModel.findOne({ where: { deviceId, snippetId: snippet.id } });
    assert.ok(job, 'the policy device got the job');
    assert.equal(utils.decryptSecret(job.payload), "echo 'AT-0042'\n", 'device fields fill {{DEVICE_*}} placeholders');
  });

  test('site health, patch compliance and the monthly report', async () => {
    const device = await models.DeviceModel.findByPk(deviceId);
    await device.update({
      inventory: JSON.stringify({
        updates: { at: new Date().toISOString(), data: { reboot: false, updates: [{ name: 'openssl', security: true }] } }
      })
    });

    const health = await ok(request('GET', '/api/sites/health'));
    assert.equal(health[site.id].devices, 1);
    assert.equal(health[site.id].online, 1);
    assert.equal(health[site.id].compliance, 0);

    const patching = await ok(request('GET', `/api/sites/${site.id}/patching`));
    assert.equal(patching.devices[0].security, 1);
    assert.equal(patching.devices[0].compliant, false);

    const month = new Date().toISOString().slice(0, 7);
    const html = await request('GET', `/api/sites/${site.id}/report?month=${month}`);
    assert.equal(html.status, 200);
    assert.match(String(html.headers['content-type']), /text\/html/);
    assert.match(html.text, /<h1>Acme<\/h1>/);
    assert.match(html.text, /web-01/);
    assert.match(html.text, /Disk over 90%/);

    const json = await ok(request('GET', `/api/sites/${site.id}/report?month=${month}&format=json`));
    assert.ok(json.alertsOpened >= 2);
    assert.equal(json.devices[0].availability, 100);
  });
});
