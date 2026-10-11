/**
 * Stable device identity: agent IDs, clone flagging, agent ID takeover
 * protection and backfilling agents that were enrolled before agent IDs.
 * Needs TEST_DATABASE_URL (a throwaway database whose name contains "test").
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set, skipping agent identity tests';

interface TestResponse {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
  json: () => any;
}

describe('agent identity', { skip }, () => {
  let server: http.Server;
  let port = 0;
  let db: any;
  let models: typeof import('../src/models');
  const cookies: { [who: string]: string } = {};

  const request = (
    method: string,
    path: string,
    options: { body?: unknown; form?: Record<string, string>; as?: string | null; ip?: string; bearer?: string } = {}
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
    process.env.ENROLL_RATE_LIMIT_PER_IP = '100';

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

  const AGENT_A = '11111111-1111-4111-8111-111111111111';
  const AGENT_B = '22222222-2222-4222-8222-222222222222';
  const AGENT_C = '33333333-3333-4333-8333-333333333333';
  const AGENT_D = '44444444-4444-4444-8444-444444444444';

  const poll = (token: string, agentId?: string) =>
    request('GET', `/api/agent/next?wait=0&version=1.3.0${agentId ? `&agentId=${agentId}` : ''}`, {
      as: null,
      bearer: token
    });

  test('clones with the same hostname and machine ID but different agent IDs are both allowed and flagged', async () => {
    const created = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    const shared = { hostname: 'golden-image', machineId: 'cloned-machine-id-0001' };
    const a = await ok(enroll(created.token, { ...shared, agentId: AGENT_A }), 201);
    const b = await enroll(created.token, { ...shared, agentId: AGENT_B });
    assert.equal(b.status, 201, 'a look-alike is never refused');
    const bData = b.json().data;
    assert.notEqual(bData.deviceId, a.deviceId);
    assert.equal(bData.possibleDuplicate, true);

    const first = await models.DeviceModel.findByPk(a.deviceId);
    const second = await models.DeviceModel.findByPk(bData.deviceId);
    assert.equal(first?.possibleDuplicate, true);
    assert.equal(second?.possibleDuplicate, true);
    assert.equal(first?.agentId, AGENT_A);
    assert.equal(second?.agentId, AGENT_B);

    const list = await ok(request('GET', `/api/devices?siteId=${office.id}`));
    const rows = (Array.isArray(list) ? list : list.devices || []) as any[];
    const row = rows.find(item => item.id === bData.deviceId);
    assert.equal(row?.possibleDuplicate, true, 'exposed in the API');
    assert.deepEqual(row?.duplicateOf, [a.deviceId]);
  });

  test('a known agent ID cannot be taken over without a re-enrol token or a revoke', async () => {
    const plain = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    const first = await ok(enroll(plain.token, { hostname: 'takeover-1', agentId: AGENT_C }), 201);

    // Different hostname, same agent ID, ordinary token: refused
    const refused = await enroll(plain.token, { hostname: 'attacker', agentId: AGENT_C });
    assert.equal(refused.status, 409, refused.text);
    const device = await models.DeviceModel.findByPk(first.deviceId);
    assert.equal(device?.tokenPrefix, first.token.slice(0, 16), 'the device keeps its token');

    // Another site cannot claim it even with a re-enrol token
    const otherReenrol = await ok(createToken({ siteId: branch.id, allowReenrol: true }), 201);
    assert.equal((await enroll(otherReenrol.token, { hostname: 'takeover-1', agentId: AGENT_C })).status, 409);

    // An admin re-enrol token rotates the same device
    const reenrol = await ok(createToken({ siteId: office.id, allowReenrol: true }), 201);
    const again = await ok(enroll(reenrol.token, { hostname: 'takeover-1', agentId: AGENT_C }), 201);
    assert.equal(again.deviceId, first.deviceId);
    assert.equal(again.reused, true);

    // Revoked: the agent ID is free and enrols as a new device
    await ok(request('DELETE', `/api/devices/${first.deviceId}`));
    const fresh = await ok(enroll(plain.token, { hostname: 'takeover-1', agentId: AGENT_C }), 201);
    assert.notEqual(fresh.deviceId, first.deviceId);
    assert.equal((await models.DeviceModel.findByPk(first.deviceId))?.agentId, null);
  });

  test('an existing agent registers its agent ID on its existing device on first poll', async () => {
    const plain = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    // Enrolled by an older agent: no agent ID
    const legacy = await ok(enroll(plain.token, { hostname: 'legacy-host', machineId: 'legacy-machine-0001' }), 201);
    const before = await models.DeviceModel.findByPk(legacy.deviceId);
    assert.equal(before?.agentId, null);
    const count = await models.DeviceModel.count();

    assert.ok([200, 204].includes((await poll(legacy.token, AGENT_D)).status));
    const after = await models.DeviceModel.findByPk(legacy.deviceId);
    assert.equal(after?.agentId, AGENT_D, 'registered on the same device');
    assert.equal(after?.tokenPrefix, before?.tokenPrefix, 'no re-enrolment');
    assert.equal(after?.createdAt.getTime(), before?.createdAt.getTime());
    assert.equal(await models.DeviceModel.count(), count, 'no new device');

    // A later, different ID never replaces it
    await poll(legacy.token, AGENT_A);
    assert.equal((await models.DeviceModel.findByPk(legacy.deviceId))?.agentId, AGENT_D);

    // Another device cannot backfill an ID that is already held
    const other = await ok(enroll(plain.token, { hostname: 'legacy-2', machineId: 'legacy-machine-0002' }), 201);
    await poll(other.token, AGENT_D);
    assert.equal((await models.DeviceModel.findByPk(other.deviceId))?.agentId, null);

    // The agent can now re-enrol by agent ID with a re-enrol token
    const reenrol = await ok(createToken({ siteId: office.id, allowReenrol: true }), 201);
    const again = await ok(enroll(reenrol.token, { hostname: 'renamed', agentId: AGENT_D }), 201);
    assert.equal(again.deviceId, legacy.deviceId);
  });
});
