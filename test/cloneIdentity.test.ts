/**
 * Clone handling: hardware fingerprints at enrol and poll, fresh agent IDs
 * for clones, re-installs on the same machine and fingerprint backfill.
 * Needs TEST_DATABASE_URL (a throwaway database whose name contains "test").
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set, skipping clone identity tests';

interface TestResponse {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
  json: () => any;
}

describe('clone identity', { skip }, () => {
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

  const ID = '55555555-5555-4555-8555-555555555555';
  const ID2 = '66666666-6666-4666-8666-666666666666';
  const FP_A = 'a'.repeat(64);
  const FP_B = 'b'.repeat(64);

  // The fingerprint goes in the X-Agent-Fingerprint header only
  const poll = (token: string, query: string, ip?: string) => {
    const fingerprint = /fingerprint=([0-9a-f]+)/.exec(query)?.[1];
    const rest = query.replace(/&?fingerprint=[0-9a-f]+/, '');
    return request('GET', `/api/agent/next?wait=0&version=1.3.0&${rest}`, {
      as: null,
      bearer: token,
      ip,
      headers: fingerprint ? { 'x-agent-fingerprint': fingerprint } : {}
    });
  };

  test('a clone (same agent ID, different fingerprint) gets a fresh agent ID and its own device', async () => {
    const plain = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    const original = await ok(enroll(plain.token, { hostname: 'gold', agentId: ID, fingerprint: FP_A }), 201);
    const before = await models.DeviceModel.findByPk(original.deviceId);

    const clone = await enroll(plain.token, { hostname: 'gold', agentId: ID, fingerprint: FP_B });
    assert.equal(clone.status, 201, 'a clone is never refused');
    const data = clone.json().data;
    assert.notEqual(data.deviceId, original.deviceId);
    assert.notEqual(data.agentId, ID);
    assert.match(data.agentId, /^[0-9a-f-]{36}$/);
    assert.equal(data.clonedFrom, original.deviceId);
    assert.equal(data.possibleDuplicate, true);

    const stored = await models.DeviceModel.findByPk(data.deviceId);
    assert.equal(stored?.clonedFrom, original.deviceId);
    assert.equal(stored?.fingerprint, FP_B);
    const after = await models.DeviceModel.findByPk(original.deviceId);
    assert.equal(after?.agentId, ID, 'the original keeps its agent ID');
    assert.equal(after?.tokenHash, before?.tokenHash, 'and its token');
    assert.equal(after?.fingerprint, FP_A);

    // env format carries the new agent ID for the shell installer
    const env = await enroll(plain.token, { hostname: 'gold2', agentId: ID, fingerprint: 'c'.repeat(64) }, undefined);
    assert.equal(env.status, 201);
    const text = await request('POST', '/api/agent/enroll?format=env', {
      as: null,
      ip: '10.9.9.9',
      form: { token: plain.token, hostname: 'gold3', os: 'linux', arch: 'x86_64', agentId: ID, fingerprint: 'd'.repeat(64) }
    });
    assert.match(text.text, /^AGENT_ID=[0-9a-f-]{36}$/m);
    assert.ok(!text.text.includes(`AGENT_ID=${ID}`));

    // A clone enrolling at another site is also its own device, not a refusal
    const other = await ok(createToken({ siteId: branch.id, maxUses: null }), 201);
    const away = await ok(enroll(other.token, { hostname: 'gold', agentId: ID, fingerprint: 'e'.repeat(64) }), 201);
    assert.equal(away.clonedFrom, original.deviceId);
    assert.notEqual(away.agentId, ID);
  });

  test('a re-install on the same machine is a re-enrol under the admin-only rule', async () => {
    const plain = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    const first = await ok(enroll(plain.token, { hostname: 'same', agentId: ID2, fingerprint: FP_A }), 201);
    assert.equal((await enroll(plain.token, { hostname: 'same', agentId: ID2, fingerprint: FP_A })).status, 409);
    const reenrol = await ok(createToken({ siteId: office.id, allowReenrol: true }), 201);
    const again = await ok(enroll(reenrol.token, { hostname: 'same', agentId: ID2, fingerprint: FP_A }), 201);
    assert.equal(again.deviceId, first.deviceId);
    assert.equal(again.agentId, ID2);
    assert.equal(again.reused, true);
  });

  test('polling with a copied device token from other hardware needs re-enrolment', async () => {
    const plain = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    const AID = '77777777-7777-4777-8777-777777777777';
    const device = await ok(enroll(plain.token, { hostname: 'poller', agentId: AID, fingerprint: FP_A }), 201);
    assert.ok([200, 204].includes((await poll(device.token, `agentId=${AID}&fingerprint=${FP_A}`)).status));
    const before = await models.DeviceModel.findByPk(device.deviceId);

    const copied = await poll(device.token, `agentId=${AID}&fingerprint=${FP_B}`);
    assert.equal(copied.status, 409);
    assert.equal(copied.json().error, 'reenrol_required');
    assert.equal(copied.headers['x-reenrol-required'], '1');

    const after = await models.DeviceModel.findByPk(device.deviceId);
    assert.equal(after?.fingerprint, FP_A, 'the original is untouched');
    assert.equal(after?.lastSeenAt?.getTime(), before?.lastSeenAt?.getTime());
    const [audit] = await db.sequelize.query(
      `SELECT target FROM audit_logs WHERE action = 'device.fingerprint_mismatch' ORDER BY id DESC LIMIT 1`
    );
    assert.equal((audit as any[])[0]?.target, `device:${device.deviceId}`);

    // The clone then re-enrols and becomes its own device
    const clone = await ok(enroll(plain.token, { hostname: 'poller', agentId: AID, fingerprint: FP_B }), 201);
    assert.notEqual(clone.deviceId, device.deviceId);
    assert.equal(clone.clonedFrom, device.deviceId);
  });

  test('a first-time fingerprint on an existing device is recorded, not a mismatch', async () => {
    const plain = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    const AID = '88888888-8888-4888-8888-888888888888';
    const legacy = await ok(enroll(plain.token, { hostname: 'old-agent', agentId: AID }), 201);
    assert.equal((await models.DeviceModel.findByPk(legacy.deviceId))?.fingerprint, null);
    assert.ok([200, 204].includes((await poll(legacy.token, `agentId=${AID}&fingerprint=${FP_B}`)).status));
    assert.equal((await models.DeviceModel.findByPk(legacy.deviceId))?.fingerprint, FP_B);

    // Same for enrol: a holder without a fingerprint is the same machine
    const legacy2 = await ok(enroll(plain.token, { hostname: 'old-2', agentId: ID.replace(/5/g, '9') }), 201);
    const reenrol = await ok(createToken({ siteId: office.id, allowReenrol: true }), 201);
    const again = await ok(enroll(reenrol.token, { hostname: 'old-2', agentId: ID.replace(/5/g, '9'), fingerprint: FP_A }), 201);
    assert.equal(again.deviceId, legacy2.deviceId);
    assert.equal((await models.DeviceModel.findByPk(legacy2.deviceId))?.fingerprint, FP_A);
  });

  const asDevice = (method: string, url: string, token: string, fingerprint: string, body: unknown = {}) =>
    request(method, url, { as: null, bearer: token, body, headers: { 'x-agent-fingerprint': fingerprint } });

  test('facts and job results with a copied token are refused and leave the original alone', async () => {
    const plain = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    const AID = '99999999-1111-4111-8111-999999999999';
    const device = await ok(enroll(plain.token, { hostname: 'facts-host', agentId: AID, fingerprint: FP_A }), 201);
    const before = await models.DeviceModel.findByPk(device.deviceId);

    const facts = await asDevice('POST', '/api/agent/facts', device.token, FP_B, { cpus: 2 });
    assert.equal(facts.status, 409, facts.text);
    assert.equal(facts.json().error, 'reenrol_required');
    const result = await asDevice('POST', '/api/agent/jobs/1/result', device.token, FP_B, { exitCode: 0 });
    assert.equal(result.status, 409, result.text);
    assert.equal(result.json().error, 'reenrol_required');

    const after = await models.DeviceModel.findByPk(device.deviceId);
    assert.equal(after?.facts, before?.facts);
    assert.equal(after?.factsAt?.getTime(), before?.factsAt?.getTime());
    assert.equal(after?.fingerprint, FP_A);
    const [rows] = await db.sequelize.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'device.fingerprint_mismatch' AND target = :t`,
      { replacements: { t: `device:${device.deviceId}` } }
    );
    assert.equal((rows as any[])[0].n, 2);

    // The right hardware still gets through
    assert.ok((await asDevice('POST', '/api/agent/facts', device.token, FP_A, { cpus: 2 })).status < 300);
  });

  const cloneEnroll = (token: string, fingerprint: string, agentId: string) =>
    request('POST', '/api/agent/clone-enroll', {
      as: null,
      bearer: token,
      ip: `10.50.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      headers: { 'x-agent-fingerprint': fingerprint },
      body: { agentId, hostname: 'clone-host' }
    });

  test('clone self-enrol: new device, fresh identity, original untouched; repeats refused', async () => {
    const plain = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    const AID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const source = await ok(enroll(plain.token, { hostname: 'golden', agentId: AID, fingerprint: FP_A }), 201);
    const before = await models.DeviceModel.findByPk(source.deviceId);

    const clone = await ok(cloneEnroll(source.token, FP_B, AID), 201);
    assert.notEqual(clone.deviceId, source.deviceId);
    assert.notEqual(clone.agentId, AID);
    assert.notEqual(clone.token, source.token);
    assert.equal(clone.clonedFrom, source.deviceId);
    const stored = await models.DeviceModel.findByPk(clone.deviceId);
    assert.equal(stored?.siteId, before?.siteId);
    assert.equal(stored?.possibleDuplicate, true);
    assert.equal(stored?.fingerprint, FP_B);

    const after = await models.DeviceModel.findByPk(source.deviceId);
    assert.equal(after?.tokenHash, before?.tokenHash);
    assert.equal(after?.agentId, AID);
    assert.equal(after?.fingerprint, FP_A);

    // The clone's own token works on its hardware
    const idle = await poll(clone.token, `fingerprint=${FP_B}`);
    assert.equal(idle.status, 204);
    assert.equal(idle.headers['x-device-status'], 'pending_approval');
    assert.equal(clone.status, 'pending_approval');
    // The original's token still works for the original fingerprint
    assert.ok([200, 204].includes((await poll(source.token, `fingerprint=${FP_A}`)).status));

    // Same source + same fingerprint again: refused, no second device
    assert.equal((await cloneEnroll(source.token, FP_B, AID)).status, 409);
    assert.equal(await models.DeviceModel.count({ where: { clonedFrom: source.deviceId, fingerprint: FP_B } }), 1);
    // Matching hardware is not a clone
    assert.equal((await cloneEnroll(source.token, FP_A, AID)).status, 400);
    // A bad token is refused
    assert.equal((await cloneEnroll('sc_dev_nope', FP_B, AID)).status, 401);

    const [audit] = await db.sequelize.query(
      `SELECT action FROM audit_logs WHERE target = :t AND action LIKE 'device.clone_enroll%' ORDER BY id`,
      { replacements: { t: `device:${source.deviceId}` } }
    );
    assert.deepEqual((audit as any[]).map(row => row.action), [
      'device.clone_enroll',
      'device.clone_enroll_refused',
      'device.clone_enroll_refused'
    ]);
  });

  test('clone self-enrol is refused for revoked sources and rate limited per source', async () => {
    const plain = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    const revoked = await ok(enroll(plain.token, { hostname: 'gone', agentId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', fingerprint: FP_A }), 201);
    await ok(request('DELETE', `/api/devices/${revoked.deviceId}`));
    assert.equal((await cloneEnroll(revoked.token, FP_B, 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb')).status, 403);
    assert.equal(await models.DeviceModel.count({ where: { clonedFrom: revoked.deviceId } }), 0);

    const busy = await ok(enroll(plain.token, { hostname: 'busy', agentId: 'cccccccc-1111-4111-8111-cccccccccccc', fingerprint: FP_A }), 201);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      statuses.push((await cloneEnroll(busy.token, String(i).repeat(64), 'cccccccc-1111-4111-8111-cccccccccccc')).status);
    }
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429, 429]);
  });

  test('R1: a device with a fingerprint must send it; omitting the header is a mismatch', async () => {
    const plain = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    const AID = 'dddddddd-1111-4111-8111-dddddddddddd';
    const device = await ok(enroll(plain.token, { hostname: 'r1', agentId: AID, fingerprint: FP_A }), 201);
    for (const res of [
      await poll(device.token, `agentId=${AID}`),
      await request('POST', '/api/agent/facts', { as: null, bearer: device.token, body: { cpus: 1 } }),
      await request('POST', '/api/agent/jobs/1/result', { as: null, bearer: device.token, body: { exitCode: 0 } }),
      // R2: the query string is ignored, so this is still "missing"
      await request('GET', `/api/agent/next?wait=0&fingerprint=${FP_A}`, { as: null, bearer: device.token })
    ]) {
      assert.equal(res.status, 409, res.text);
      assert.equal(res.json().error, 'reenrol_required');
    }
    const [rows] = await db.sequelize.query(
      `SELECT metadata FROM audit_logs WHERE action = 'device.fingerprint_mismatch' AND target = :t`,
      { replacements: { t: `device:${device.deviceId}` } }
    );
    assert.equal((rows as any[]).length, 4);
    assert.ok((rows as any[]).every(row => JSON.stringify(row.metadata).includes('missing')));
    // Devices without a recorded fingerprint may still omit it
    const legacy = await ok(enroll(plain.token, { hostname: 'r1-legacy', agentId: 'dddddddd-2222-4222-8222-dddddddddddd' }), 201);
    assert.ok([200, 204].includes((await poll(legacy.token, '')).status));
  });

  test('R3: a pending clone gets no jobs, cannot post results, and needs an admin to approve it', async () => {
    const plain = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    const AID = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
    const source = await ok(enroll(plain.token, { hostname: 'r3', agentId: AID, fingerprint: FP_A }), 201);
    const clone = await ok(cloneEnroll(source.token, FP_B, AID), 201);
    const stored = await models.DeviceModel.findByPk(clone.deviceId);
    assert.equal(stored?.clonePendingApproval, true);

    // Even a job queued straight into the table is never handed out
    await models.AgentJobModel.create({
      deviceId: clone.deviceId, siteId: office.id, snippetTitle: 'x', language: 'bash', payload: 'enc:v1:x', timeoutMs: 1000
    } as any);
    const idle = await poll(clone.token, `fingerprint=${FP_B}`);
    assert.equal(idle.status, 204);
    assert.equal(idle.headers['x-device-status'], 'pending_approval');
    const result = await request('POST', '/api/agent/jobs/1/result', {
      as: null, bearer: clone.token, headers: { 'x-agent-fingerprint': FP_B }, body: { exitCode: 0 }
    });
    assert.equal(result.status, 403);
    assert.equal(result.json().error, 'pending_approval');
    // Facts are allowed, so admins can see what the machine is
    assert.ok((await request('POST', '/api/agent/facts', {
      as: null, bearer: clone.token, headers: { 'x-agent-fingerprint': FP_B }, body: { cpus: 1 }
    })).status < 300);

    // Queueing work for it fails, and site runs skip it
    const automation = await import('../src/utils/automation');
    await assert.rejects(
      automation.queueAgentJob({ device: stored!, snippet: { id: 1, title: 't', language: 'bash' }, code: 'echo', secretValues: [] }),
      /waiting for clone approval/
    );

    // Listed with its status
    const listed = await ok(request('GET', `/api/devices/${clone.deviceId}`));
    assert.equal(listed.status ?? listed.device?.status, 'pending_approval');

    // Only admins decide
    assert.equal((await request('POST', `/api/devices/${clone.deviceId}/approve-clone`, { as: 'siteadmin' })).status, 403);
    const approved = await ok(request('POST', `/api/devices/${clone.deviceId}/approve-clone`));
    assert.equal(approved.status, 'active');
    assert.equal((await request('POST', `/api/devices/${clone.deviceId}/approve-clone`)).status, 409);
    await models.AgentJobModel.destroy({ where: { deviceId: clone.deviceId } });
    assert.ok([200, 204].includes((await poll(clone.token, `fingerprint=${FP_B}`)).status));
    const [audit] = await db.sequelize.query(`SELECT action FROM audit_logs WHERE target = :t AND action LIKE 'device.clone_%'`, {
      replacements: { t: `device:${clone.deviceId}` }
    });
    assert.ok((audit as any[]).some(row => row.action === 'device.clone_approved'));
  });

  test('R3: denying a clone revokes it and deletes its token; a fresh enrol token activates one', async () => {
    const plain = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    const AID = 'ffffffff-1111-4111-8111-ffffffffffff';
    const source = await ok(enroll(plain.token, { hostname: 'r3b', agentId: AID, fingerprint: FP_A }), 201);
    const denied = await ok(cloneEnroll(source.token, FP_B, AID), 201);
    const res = await ok(request('POST', `/api/devices/${denied.deviceId}/deny-clone`));
    assert.equal(res.status, 'revoked');
    const row = await models.DeviceModel.findByPk(denied.deviceId);
    assert.ok(row?.revokedAt);
    assert.equal(row?.tokenHash, 'denied');
    assert.equal((await poll(denied.token, `fingerprint=${FP_B}`)).status, 401);

    const other = await ok(cloneEnroll(source.token, 'f'.repeat(64), AID), 201);
    const activated = await ok(enroll(plain.token, { hostname: 'r3b', agentId: other.agentId, fingerprint: 'f'.repeat(64) }), 201);
    assert.equal(activated.deviceId, other.deviceId);
    assert.equal((await models.DeviceModel.findByPk(other.deviceId))?.clonePendingApproval, false);
    // The source was never touched
    const src = await models.DeviceModel.findByPk(source.deviceId);
    assert.equal(src?.fingerprint, FP_A);
    assert.equal(src?.revokedAt, null);
  });

  test('R6: a legacy device binds its first fingerprint; outside the window from a new address it is flagged', async () => {
    const plain = await ok(createToken({ siteId: office.id, maxUses: null }), 201);
    const a = await ok(enroll(plain.token, { hostname: 'r6a', agentId: '12121212-1111-4111-8111-121212121212' }, '10.66.0.1'), 201);
    const b = await ok(enroll(plain.token, { hostname: 'r6b', agentId: '13131313-1111-4111-8111-131313131313' }, '10.66.0.2'), 201);
    const c = await ok(enroll(plain.token, { hostname: 'r6c', agentId: '14141414-1111-4111-8111-141414141414' }, '10.66.0.3'), 201);

    // Inside the 7-day window (migration just ran): any address is fine
    assert.ok([200, 204].includes((await poll(a.token, `fingerprint=${FP_A}`, '10.99.0.1')).status));
    let row = await models.DeviceModel.findByPk(a.deviceId);
    assert.equal(row?.fingerprint, FP_A);
    assert.equal(row?.fingerprintPendingReview, false);

    // Window closed
    await db.sequelize.query(`UPDATE settings SET value = :v WHERE key = 'fingerprintBindingSince'`, {
      replacements: { v: new Date(Date.now() - 30 * 86400_000).toISOString() }
    });
    try {
      // From its last known address: trusted
      assert.ok([200, 204].includes((await poll(b.token, `fingerprint=${FP_A}`, '10.66.0.2')).status));
      row = await models.DeviceModel.findByPk(b.deviceId);
      assert.equal(row?.fingerprintPendingReview, false);

      // From somewhere else: still works, but flagged and audited
      const res = await poll(c.token, `fingerprint=${FP_B}`, '10.77.0.9');
      assert.ok([200, 204].includes(res.status));
      row = await models.DeviceModel.findByPk(c.deviceId);
      assert.equal(row?.fingerprint, FP_B);
      assert.equal(row?.fingerprintPendingReview, true);
      const listed = await ok(request('GET', `/api/devices/${c.deviceId}`));
      assert.equal(listed.fingerprintPendingReview ?? listed.device?.fingerprintPendingReview, true);
      const [audit] = await db.sequelize.query(`SELECT action FROM audit_logs WHERE target = :t ORDER BY id DESC LIMIT 1`, {
        replacements: { t: `device:${c.deviceId}` }
      });
      assert.equal((audit as any[])[0].action, 'device.fingerprint_pending_review');
      // Once bound, a different fingerprint is a mismatch as usual
      assert.equal((await poll(c.token, `fingerprint=${FP_A}`, '10.77.0.9')).status, 409);
    } finally {
      await db.sequelize.query(`UPDATE settings SET value = :v WHERE key = 'fingerprintBindingSince'`, {
        replacements: { v: new Date().toISOString() }
      });
    }
  });
});
