/**
 * Clone handling: hardware fingerprints at enrol and poll, fresh agent IDs
 * for clones, re-installs on the same machine and fingerprint backfill.
 * Needs TEST_DATABASE_URL (a throwaway database whose name contains "test").
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import crypto from 'crypto';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set, skipping clone caps tests';

interface TestResponse {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
  json: () => any;
}

describe('clone caps', { skip }, () => {
  let server: http.Server;
  let port = 0;
  let db: any;
  let models: typeof import('../src/models');
  const cookies: { [who: string]: string } = {};

  const request = (
    method: string,
    path: string,
    options: { body?: unknown; form?: Record<string, string>; as?: string | null; ip?: string; bearer?: string; headers?: Record<string, string> } = {}
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
      if (who && cookies[who]) headers.cookie = cookies[who];
      if (options.ip) headers['x-forwarded-for'] = options.ip;
      if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
      Object.assign(headers, options.headers || {});

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

  const ok = async (res: Promise<TestResponse>, status = 200) => {
    const response = await res;
    assert.equal(response.status, status, response.text);
    return response.json().data;
  };

  let ipCounter = 0;
  // Each enrolment from its own address unless a test says otherwise, so the
  // per-address limit only matters in the rate limit test
  const enroll = (token: string, extra: Record<string, string> = {}, ip?: string) =>
    request('POST', '/api/agent/enroll', {
      as: null,
      ip: ip || `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`,
      form: { token, hostname: 'host', os: 'linux', arch: 'x86_64', version: '1.3.0', ...extra }
    });

  const createToken = (body: Record<string, unknown>, as = 'owner') =>
    request('POST', '/api/devices/enrollments', { body, as });

  let office: { id: number };
  let branch: { id: number };
  let siteAdmin: { id: number };

  before(async () => {
    const dbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
    if (!/test/i.test(dbName)) throw new Error(`Refusing to reset database "${dbName}"`);

    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = 'snippycode-test-session-secret';
    process.env.VARIABLES_SECRET_KEY = 'snippycode-test-variables-key';
    process.env.ENROLL_RATE_LIMIT_PER_TOKEN = '100';
    process.env.ENROLL_RATE_LIMIT_PER_IP = '1000';
    process.env.CLONE_ENROLL_PER_HOUR = '100';
    process.env.CLONE_MAX_PER_SOURCE = '3';
    process.env.CLONE_GLOBAL_PER_HOUR = '4';


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

    office = await ok(request('POST', '/api/sites', { body: { name: 'Office' } }), 201);
    branch = await ok(request('POST', '/api/sites', { body: { name: 'Branch' } }), 201);
    assert.ok(branch.id);

    for (const who of ['siteadmin', 'member']) {
      const user = await ok(
        request('POST', '/api/admin/users', {
          body: { email: `${who}@example.test`, displayName: who, password: `${who}-password-123`, role: 'editor' }
        }),
        201
      );
      if (who === 'siteadmin') siteAdmin = user;
      const login = await request('POST', '/api/auth/login', {
        body: { email: `${who}@example.test`, password: `${who}-password-123` },
        as: null
      });
      cookies[who] = String(login.headers['set-cookie']?.[0] || '').split(';')[0];
    }

    const members = await ok(
      request('PUT', `/api/sites/${office.id}/members`, { body: { userIds: [siteAdmin.id], adminIds: [siteAdmin.id] } })
    );
    assert.deepEqual(members.adminIds, [siteAdmin.id]);
  });

  after(async () => {
    await new Promise(resolve => server?.close(resolve));
    await db?.sequelize.close();
  });

  const FP_A = 'a'.repeat(64);
  const hex = (n: number) => n.toString(16).padStart(64, '0');
  const cloneEnroll = (token: string, fingerprint: string, ip = '10.60.0.1') =>
    request('POST', '/api/agent/clone-enroll', {
      as: null,
      bearer: token,
      ip,
      headers: { 'x-agent-fingerprint': fingerprint },
      body: { agentId: '00000000-1111-4111-8111-000000000000' }
    });
  const source = async (name: string) => {
    const plain = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    return ok(enroll(plain.token, { hostname: name, agentId: crypto.randomUUID(), fingerprint: FP_A }), 201);
  };

  test('R4: lifetime cap per source and an instance-wide hourly cap; each clone raises a notification', async () => {
    const notify = await import('../src/utils/notify');
    const { encryptSecret } = await import('../src/utils/secretBox');
    const events: any[] = [];
    const hook = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        events.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        res.end('ok');
      });
    });
    hook.listen(0, '127.0.0.1');
    await new Promise(resolve => hook.once('listening', resolve));
    await models.WebhookModel.create({
      name: 'clones',
      type: 'webhook',
      url: encryptSecret(`http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`),
      events: 'device.clone_pending'
    } as any);
    const a = await source('cap-a');
    for (let i = 1; i <= 3; i += 1) assert.equal((await cloneEnroll(a.token, hex(i))).status, 201);
    const capped = await cloneEnroll(a.token, hex(4));
    assert.equal(capped.status, 429);
    assert.match(capped.text, /clone limit/);

    // Global: 4 per hour across the instance; 3 used above
    const b = await source('cap-b');
    assert.equal((await cloneEnroll(b.token, hex(10))).status, 201);
    const global = await cloneEnroll(b.token, hex(11));
    assert.equal(global.status, 429);
    assert.match(global.text, /right now/);
    assert.equal(await models.DeviceModel.count({ where: { clonedFrom: b.deviceId } }), 1);

    const [audit] = await db.sequelize.query(
      `SELECT metadata FROM audit_logs WHERE action = 'device.clone_enroll_refused' ORDER BY id`
    );
    const reasons = (audit as any[]).map(row => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata).reason);
    assert.deepEqual(reasons, ['lifetime_cap', 'global_rate_limited']);
    await notify.flushNotifications();
    hook.close();
    assert.equal(events.filter(event => JSON.stringify(event).includes('device.clone_pending')).length, 4, 'one notification per clone');
  });
});
