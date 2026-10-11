/**
 * Bulk enrolment: reusable tokens, max uses under concurrency, expiry,
 * revoke, site scope, de-duplication, rate limiting and the audit log.
 * Needs TEST_DATABASE_URL (a throwaway database whose name contains "test").
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set, skipping bulk enrolment tests';

interface TestResponse {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
  json: () => any;
}

describe('bulk enrolment', { skip }, () => {
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
      if (who && cookies[who]) headers.cookie = cookies[who];
      if (options.ip) headers['x-forwarded-for'] = options.ip;

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
    process.env.ENROLL_RATE_LIMIT_PER_TOKEN = '12';
    process.env.ENROLL_RATE_LIMIT_PER_IP = '6';

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

  test('a reusable token enrols many machines, each with its own device token', async () => {
    const created = await ok(createToken({ siteId: office.id, maxUses: null, expiresHours: 168 }), 201);

    assert.equal(created.maxUses, null);
    assert.match(created.token, /^sc_enroll_/);
    assert.ok(created.linux.includes(`--token ${created.token}`));
    assert.ok(created.windows.includes(`-Token ${created.token}`));

    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await ok(enroll(created.token, { hostname: `pc-${i}`, machineId: `machine-id-${i}-0000` }), 201));
    }

    const tokens = new Set(results.map(result => result.token));
    assert.equal(tokens.size, 4, 'every machine gets its own device token');
    assert.ok(!tokens.has(created.token), 'never the shared token');
    assert.equal(new Set(results.map(result => result.deviceId)).size, 4);

    const listed = await ok(request('GET', '/api/devices/enrollments'));
    const row = listed.find((item: any) => item.id === created.id);
    assert.equal(row.uses, 4);
    assert.ok(row.lastUsedAt);
    assert.equal(row.status, 'active');
    assert.equal(row.token, undefined, 'the list never includes the token');

    // Stored hash is scrypt, looked up by prefix
    const stored = await models.DeviceEnrollmentModel.findByPk(created.id);
    assert.match(String(stored?.tokenHash), /^scrypt\$/);
    assert.equal(stored?.tokenPrefix, created.token.slice(0, 16));
  });

  test('max uses cannot be exceeded by concurrent enrolments', async () => {
    const created = await ok(createToken({ siteId: office.id, maxUses: 3 }), 201);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => enroll(created.token, { hostname: `race-${i}`, machineId: `race-machine-${i}-00` }))
    );

    assert.equal(results.filter(result => result.status === 201).length, 3);
    assert.equal(results.filter(result => result.status === 401).length, 7);
    const stored = await models.DeviceEnrollmentModel.findByPk(created.id);
    assert.equal(stored?.uses, 3);
    assert.equal(await models.DeviceModel.count({ where: { hostname: results.map((_, i) => `race-${i}`) } }), 3);
  });

  test('single-use tokens still work once', async () => {
    const created = await ok(createToken({ siteId: office.id }), 201);

    assert.equal(created.maxUses, 1, 'omitting maxUses keeps the old single-use behaviour');
    assert.equal((await enroll(created.token, { hostname: 'single-1', machineId: 'single-machine-1' })).status, 201);
    assert.equal((await enroll(created.token, { hostname: 'single-2', machineId: 'single-machine-2' })).status, 401);
  });

  test('expired and revoked tokens are refused', async () => {
    const expiring = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    await models.DeviceEnrollmentModel.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id: expiring.id } });
    assert.equal((await enroll(expiring.token, { machineId: 'expired-machine-1' })).status, 401);

    const revoking = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    assert.equal((await enroll(revoking.token, { hostname: 'before-revoke', machineId: 'revoke-machine-1' })).status, 201);
    const revoked = await ok(request('DELETE', `/api/devices/enrollments/${revoking.id}`));
    assert.equal(revoked.status, 'revoked');
    assert.equal((await enroll(revoking.token, { hostname: 'after-revoke', machineId: 'revoke-machine-2' })).status, 401);

    // The machine enrolled before the revoke keeps working
    const device = await models.DeviceModel.findOne({ where: { machineId: 'revoke-machine-1' } });
    assert.ok(device && !device.revokedAt);
  });

  test('re-enrolling a known machine is refused unless an admin allowed it', async () => {
    const plain = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    const first = await ok(enroll(plain.token, { hostname: 'web-01', machineId: 'ABCDEF0123456789' }), 201);

    // Same machine with an ordinary token: refused, audited, no use counted
    const refused = await enroll(plain.token, { hostname: 'web-01', machineId: 'abcdef0123456789' });
    assert.equal(refused.status, 409, refused.text);
    let stored = await models.DeviceEnrollmentModel.findByPk(plain.id);
    assert.equal(stored?.uses, 1);
    const device = await models.DeviceModel.findByPk(first.deviceId);
    assert.equal(device?.tokenPrefix, first.token.slice(0, 16), 'the device keeps its token');
    const [audit] = await db.sequelize.query(
      `SELECT target FROM audit_logs WHERE action = 'device.reenrol_refused' ORDER BY id DESC LIMIT 1`
    );
    assert.equal((audit as any[])[0]?.target, `device:${first.deviceId}`);

    // Only admins may create re-enrol tokens
    assert.equal((await createToken({ siteId: office.id, allowReenrol: true }, 'siteadmin')).status, 403);
    const reenrol = await ok(createToken({ siteId: office.id, maxUses: 1, allowReenrol: true }), 201);
    assert.equal(reenrol.allowReenrol, true);

    const again = await ok(enroll(reenrol.token, { hostname: 'web-01-renamed', machineId: 'abcdef0123456789' }), 201);
    assert.equal(again.deviceId, first.deviceId);
    assert.equal(again.reused, true);
    assert.notEqual(again.token, first.token, 'the device gets a fresh token');
    stored = await models.DeviceEnrollmentModel.findByPk(reenrol.id);
    assert.equal(stored?.uses, 0, 're-enrolment never counts as a use');
    assert.equal(await models.DeviceModel.count({ where: { machineId: 'abcdef0123456789' } }), 1);

    // Without a machine ID: same hostname, OS and architecture is the same machine
    const a = await ok(enroll(plain.token, { hostname: 'no-id-host' }), 201);
    assert.equal((await enroll(plain.token, { hostname: 'no-id-host' })).status, 409);
    const c = await ok(enroll(plain.token, { hostname: 'no-id-host', arch: 'aarch64' }), 201);
    assert.notEqual(c.deviceId, a.deviceId);

    // An admin revoking the device frees the machine to enrol again as new
    await ok(request('DELETE', `/api/devices/${first.deviceId}`));
    const fresh = await ok(enroll(plain.token, { hostname: 'web-01', machineId: 'abcdef0123456789' }), 201);
    assert.notEqual(fresh.deviceId, first.deviceId);

    // The same machine in another site is a separate device
    const other = await ok(createToken({ siteId: branch.id, maxUses: null }), 201);
    const elsewhere = await ok(enroll(other.token, { hostname: 'web-01', machineId: 'abcdef0123456789' }), 201);
    assert.notEqual(elsewhere.deviceId, fresh.deviceId);
  });

  test('every token expires: default 7 days, capped at 365, unlimited included', async () => {
    const day = 24 * 3600_000;
    const unlimited = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    const left = new Date(unlimited.expiresAt).getTime() - Date.now();
    assert.ok(Math.abs(left - 7 * day) < 60_000, 'default is 7 days');

    const capped = await ok(createToken({ siteId: office.id, maxUses: null, expiresHours: 24 * 1000 }), 201);
    const cappedLeft = new Date(capped.expiresAt).getTime() - Date.now();
    assert.ok(Math.abs(cappedLeft - 365 * day) < 60_000, 'capped at 365 days');

    const noExpiry = await ok(createToken({ siteId: office.id, maxUses: null, expiresHours: null }), 201);
    assert.ok(noExpiry.expiresAt, 'asking for no expiry still gets one');
  });

  test('only admins and site admins manage tokens, and only for their sites', async () => {
    const own = await ok(createToken({ siteId: office.id, maxUses: 5 }, 'siteadmin'), 201);
    assert.equal((await createToken({ siteId: branch.id }, 'siteadmin')).status, 404);
    assert.equal((await createToken({ siteId: office.id }, 'member')).status, 404);

    const ownerToken = await ok(createToken({ siteId: branch.id, maxUses: 5 }), 201);
    assert.equal((await request('DELETE', `/api/devices/enrollments/${ownerToken.id}`, { as: 'siteadmin' })).status, 404);
    assert.equal((await request('DELETE', `/api/devices/enrollments/${own.id}`, { as: 'member' })).status, 404);

    const seen = await ok(request('GET', '/api/devices/enrollments', { as: 'siteadmin' }));
    assert.ok(seen.length > 0 && seen.every((item: any) => item.siteId === office.id));
    assert.deepEqual(await ok(request('GET', '/api/devices/enrollments', { as: 'member' })), []);
    assert.deepEqual(await ok(request('GET', `/api/devices/enrollments?siteId=${branch.id}`, { as: 'siteadmin' })), []);

    await ok(request('DELETE', `/api/devices/enrollments/${own.id}`, { as: 'siteadmin' }));
  });

  test('enrolment is rate limited per token and per address', async () => {
    const created = await ok(createToken({ siteId: branch.id, maxUses: null }), 201);
    const statuses = [];
    for (let i = 0; i < 14; i++) {
      statuses.push((await enroll(created.token, { hostname: `rl-${i}`, machineId: `rate-machine-${i}-0` })).status);
    }
    assert.ok(statuses.slice(0, 12).every(status => status === 201), statuses.join(','));
    assert.equal(statuses[12], 429);

    const address = '10.9.9.9';
    const fresh = await ok(createToken({ siteId: branch.id, maxUses: null }), 201);
    const fromOne = [];
    for (let i = 0; i < 7; i++) {
      fromOne.push((await enroll(fresh.token, { hostname: `ip-${i}`, machineId: `ip-machine-${i}-00` }, address)).status);
    }
    assert.equal(fromOne[5], 201);
    assert.equal(fromOne[6], 429);
  });

  test('create, revoke and enrolments are audited without the token', async () => {
    const created = await ok(createToken({ siteId: office.id, maxUses: 2, label: 'Audit' }), 201);
    const enrolled = await ok(enroll(created.token, { hostname: 'audited', machineId: 'audit-machine-01' }, '10.7.7.7'), 201);
    await enroll('sc_enroll_wrongwrongwrongwrong', {}, '10.7.7.8');
    await ok(request('DELETE', `/api/devices/enrollments/${created.id}`));

    const [rows] = await db.sequelize.query(
      `SELECT action, target, metadata, "ipAddress" FROM audit_logs WHERE action LIKE 'device.%' ORDER BY id`
    );
    const all = JSON.stringify(rows);
    assert.ok(!all.includes(created.token), 'the token never reaches the audit log');
    assert.ok(!all.includes(enrolled.token), 'nor the device token');

    const mine = (rows as any[]).filter(row => JSON.stringify(row.metadata).includes(created.tokenPrefix));
    const actions = mine.map(row => row.action);
    assert.ok(actions.includes('device.enrollment_created'));
    assert.ok(actions.includes('device.enrolled'));
    assert.ok(actions.includes('device.enrollment_revoked'));
    const enrolledRow = mine.find(row => row.action === 'device.enrolled');
    assert.equal(enrolledRow.target, `device:${enrolled.deviceId}`);
    assert.equal(enrolledRow.ipAddress, '10.7.7.7');
    assert.ok((rows as any[]).some(row => row.action === 'device.enroll_failed' && row.ipAddress === '10.7.7.8'));
  });
});
