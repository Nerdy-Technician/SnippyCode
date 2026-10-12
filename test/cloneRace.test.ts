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
const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set, skipping clone rate limit race tests';

interface TestResponse {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
  json: () => any;
}

describe('clone rate limit race', { skip }, () => {
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
      if (who && cookies[who]) { headers.cookie = `${cookies[who]}; XSRF-TOKEN=test-xsrf`; headers['x-xsrf-token'] = 'test-xsrf'; }
      if (options.ip) headers['x-forwarded-for'] = options.ip;
      if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
      Object.assign(headers, options.headers || {});

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
    process.env.CLONE_ENROLL_PER_HOUR = '5';
    process.env.CLONE_MAX_PER_SOURCE = '20';
    process.env.CLONE_GLOBAL_PER_HOUR = '50';


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

  test('R5: parallel clone enrolments never exceed the hourly limit, and R7: refusals are not counted', async () => {
    const src = await source('race-src');
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => cloneEnroll(src.token, hex(i + 1), `10.61.0.${i + 1}`)));
    const statuses = results.map(res => res.status).sort();
    assert.equal(statuses.filter(code => code === 201).length, 5, JSON.stringify(statuses));
    assert.equal(statuses.filter(code => code === 429).length, 7);
    assert.equal(await models.DeviceModel.count({ where: { clonedFrom: src.deviceId } }), 5);
    const [rows] = await db.sequelize.query(`SELECT count FROM clone_enroll_counters WHERE scope = :s`, {
      replacements: { s: `device:${src.deviceId}` }
    });
    assert.equal((rows as any[])[0].count, 5, 'the 7 refusals rolled back their increments');

    // Refusals for other reasons (repeat, matching hardware) don't use up anything either
    const other = await source('race-src-2');
    assert.equal((await cloneEnroll(other.token, FP_A)).status, 400);
    assert.equal((await cloneEnroll(other.token, hex(99))).status, 201);
    for (let i = 0; i < 6; i += 1) assert.equal((await cloneEnroll(other.token, hex(99))).status, 409);
    assert.equal((await cloneEnroll(other.token, hex(100))).status, 201, 'six repeats did not eat the limit');
    const [audit] = await db.sequelize.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE target = :t AND action = 'device.clone_enroll_refused'`,
      { replacements: { t: `device:${other.deviceId}` } }
    );
    assert.equal((audit as any[])[0].n, 7, 'but every refusal is audited');
  });
});
