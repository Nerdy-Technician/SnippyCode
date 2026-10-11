/**
 * Device-targeted schedules: target resolution at run time, permissions and
 * site scoping, per-device results, and existing schedules still working.
 * Needs TEST_DATABASE_URL (a throwaway database whose name contains "test").
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';
import http from 'http';
import { AddressInfo } from 'net';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set, skipping device schedule tests';

interface TestResponse {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
  json: () => any;
}

describe('device-targeted schedules', { skip }, () => {
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

  let siteA: { id: number };
  let siteB: { id: number };
  let snippet: { id: number };
  let scheduler: typeof import('../src/utils/scheduler');
  let automation: typeof import('../src/utils/automation');
  const dev: { [name: string]: any } = {};

  const device = (name: string, siteId: number, tags = '') =>
    models.DeviceModel.create({
      siteId,
      name,
      hostname: name,
      os: 'linux',
      arch: 'x86_64',
      tags,
      capabilities: 'bash',
      tokenHash: `unused-${name}`,
      tokenPrefix: `dev_${name}`.slice(0, 16),
      lastSeenAt: new Date()
    });

  const ids = (list: Array<{ id: number }>) => list.map(item => item.id).sort((a, b) => a - b);
  const base = { cron: '0 3 * * *', timezone: 'UTC', targetType: 'snippet', enabled: true };

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
    scheduler = await import('../src/utils/scheduler');
    automation = await import('../src/utils/automation');

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

    for (const who of ['alice', 'bob']) {
      const user = await ok(
        request('POST', '/api/admin/users', {
          body: { email: `${who}@example.test`, displayName: who, password: `${who}-password-123`, role: 'editor' }
        }),
        201
      );
      await ok(request('PUT', `/api/sites/${who === 'alice' ? siteA.id : siteB.id}/members`, { body: { userIds: [user.id] } }));
      const login = await request('POST', '/api/auth/login', {
        body: { email: `${who}@example.test`, password: `${who}-password-123` },
        as: null
      });
      cookies[who] = String(login.headers['set-cookie']?.[0] || '').split(';')[0];
    }

    snippet = await ok(
      request('POST', '/api/snippets', {
        body: { title: 'Uptime', language: 'bash', code: 'uptime\n', description: '', docs: '', tags: [], isPinned: false }
      }),
      201
    );

    dev.a1 = await device('a1', siteA.id, 'web');
    dev.a2 = await device('a2', siteA.id, '');
    dev.b1 = await device('b1', siteB.id, 'web,db');
  });

  after(async () => {
    await new Promise(resolve => server?.close(resolve));
    await db?.sequelize.close();
  });

  test('device tags are cleaned and only admins or site admins can set them', async () => {
    const tagged = await ok(request('PUT', `/api/devices/${dev.a2.id}/tags`, { body: { tags: ['DB', ' prod box ', 'db'] } }));
    assert.deepEqual(tagged.tags, ['db', 'prod-box']);
    assert.equal((await request('PUT', `/api/devices/${dev.a2.id}/tags`, { body: { tags: ['x'] }, as: 'alice' })).status, 404);
    await ok(request('PUT', `/api/devices/${dev.a2.id}/tags`, { body: { tags: [] } }));
  });

  test('only admins can clear a possible-duplicate flag, and it is audit-logged', async () => {
    const dup = await device('dup1', siteA.id);
    await dup.update({ possibleDuplicate: true, duplicateOf: `${dev.a1.id}` });

    // Non-admin (an editor and site member) is refused and nothing changes
    const denied = await request('POST', `/api/devices/${dup.id}/clear-duplicate`, { as: 'alice' });
    assert.equal(denied.status, 403, denied.text);
    await dup.reload();
    assert.equal(dup.possibleDuplicate, true);

    const cleared = await ok(request('POST', `/api/devices/${dup.id}/clear-duplicate`));
    assert.equal(cleared.possibleDuplicate, false);
    assert.deepEqual(cleared.duplicateOf, []);
    await dup.reload();
    assert.equal(dup.possibleDuplicate, false);
    assert.equal(dup.duplicateOf, '');

    const entry = await models.AuditLogModel.findOne({
      where: { action: 'device.duplicate_cleared', target: `device:${dup.id}` }
    });
    assert.ok(entry, 'audit entry written');
    assert.deepEqual(JSON.parse(entry!.metadata as unknown as string).before, {
      possibleDuplicate: true,
      duplicateOf: `${dev.a1.id}`
    });
    assert.ok(entry!.userId, 'audit entry names the admin');

    assert.equal((await request('POST', '/api/devices/999999/clear-duplicate')).status, 404);
    await dup.update({ revokedAt: new Date() });
  });

  test('targets: picked devices, device tag, sites narrowed by tag, resolved at run time', async () => {
    const picked = await ok(
      request('POST', '/api/schedules', {
        body: { ...base, name: 'Picked', snippetId: snippet.id, siteMode: 'devices', deviceIds: [dev.a2.id, dev.b1.id] }
      }),
      201
    );
    assert.equal(picked.runOn, 'devices');
    let schedule = await models.ScheduleModel.findByPk(picked.id);
    assert.deepEqual(ids(await scheduler.scheduleDevices(schedule!)), ids([dev.a2, dev.b1]));

    const byTag = await ok(
      request('POST', '/api/schedules', {
        body: { ...base, name: 'Web', snippetId: snippet.id, siteMode: 'devices', deviceTag: 'WEB', deviceIds: [dev.a2.id] }
      }),
      201
    );
    schedule = await models.ScheduleModel.findByPk(byTag.id);
    assert.deepEqual(ids(await scheduler.scheduleDevices(schedule!)), ids([dev.a1, dev.a2, dev.b1]));

    const sitesTag = await ok(
      request('POST', '/api/schedules', {
        body: { ...base, name: 'Alpha web', snippetId: snippet.id, siteMode: 'sites', siteIds: [siteA.id], runOn: 'devices', deviceTag: 'web' }
      }),
      201
    );
    schedule = await models.ScheduleModel.findByPk(sitesTag.id);
    assert.deepEqual(ids(await scheduler.scheduleDevices(schedule!)), ids([dev.a1]));

    // A device that joins later is picked up on the next run
    dev.a3 = await device('a3', siteA.id, 'web');
    assert.deepEqual(ids(await scheduler.scheduleDevices(schedule!)), ids([dev.a1, dev.a3]));

    // Revoked devices drop out
    await dev.a3.update({ revokedAt: new Date() });
    assert.deepEqual(ids(await scheduler.scheduleDevices(schedule!)), ids([dev.a1]));

    assert.equal(
      (await request('POST', '/api/schedules', { body: { ...base, name: 'Empty', snippetId: snippet.id, siteMode: 'devices' } })).status,
      400
    );
  });

  test('users can only target devices in sites they can access', async () => {
    const denied = await request('POST', '/api/schedules', {
      body: { ...base, name: 'Sneaky', snippetId: snippet.id, siteMode: 'devices', deviceIds: [dev.b1.id] },
      as: 'alice'
    });
    assert.equal(denied.status, 400);
    assert.ok(!denied.text.includes('Bravo'), 'does not reveal the other site');

    // A shared device tag spans every site, so tag-only targeting is admin-only
    const tagOnly = await request('POST', '/api/schedules', {
      body: { ...base, name: 'Alice web', snippetId: snippet.id, siteMode: 'devices', deviceTag: 'web' },
      as: 'alice'
    });
    assert.equal(tagOnly.status, 403);

    // A tag schedule an admin made that Alice last edited only reaches her sites
    const mine = await ok(
      request('POST', '/api/schedules', {
        body: { ...base, name: 'Alice web', snippetId: snippet.id, siteMode: 'devices', deviceTag: 'web' }
      }),
      201
    );
    const alice = await models.UserModel.findOne({ where: { email: { [Op.iLike]: 'alice%' } } });
    const schedule = await models.ScheduleModel.findByPk(mine.id);
    await schedule!.update({ updatedBy: alice!.id });
    assert.deepEqual(ids(await scheduler.scheduleDevices(schedule!)), ids([dev.a1]));

    // Admin-only modes stay admin-only
    assert.equal(
      (await request('POST', '/api/schedules', { body: { ...base, name: 'All', snippetId: snippet.id, siteMode: 'all', runOn: 'devices' }, as: 'alice' })).status,
      403
    );

    const [audit] = await db.sequelize.query(
      `SELECT metadata FROM audit_logs WHERE action = 'schedule.created' AND target = 'schedule:${mine.id}'`
    );
    const metadata = (audit as any[])[0].metadata;
    assert.equal((typeof metadata === 'string' ? JSON.parse(metadata) : metadata).deviceTag, 'web');
  });

  test('a run records a result per device, scoped to what the viewer can see', async () => {
    const created = await ok(
      request('POST', '/api/schedules', {
        body: { ...base, name: 'Both', snippetId: snippet.id, siteMode: 'devices', deviceIds: [dev.a1.id, dev.b1.id] }
      }),
      201
    );
    const started = await ok(request('POST', `/api/schedules/${created.id}/run`), 202);
    const jobs = await models.AgentJobModel.findAll({ where: { scheduleRunId: started.id }, order: [['deviceId', 'ASC']] });
    assert.deepEqual(jobs.map(job => job.deviceId).sort(), [dev.a1.id, dev.b1.id].sort());

    for (const job of jobs) {
      await job.update({ status: 'running', startedAt: new Date() });
      const fresh = await models.AgentJobModel.findByPk(job.id);
      await automation.finishAgentJob(fresh!, {
        exitCode: job.deviceId === dev.a1.id ? 0 : 2,
        stdout: job.deviceId === dev.a1.id ? 'up 3 days' : '',
        stderr: job.deviceId === dev.a1.id ? '' : 'boom',
        durationMs: 120
      });
    }

    const all = await ok(request('GET', `/api/schedules/${created.id}/runs/${started.id}`));
    assert.equal(all.devices.length, 2);
    const a1 = all.devices.find((item: any) => item.deviceId === dev.a1.id);
    const b1 = all.devices.find((item: any) => item.deviceId === dev.b1.id);
    assert.equal(a1.exitCode, 0);
    assert.equal(a1.ok, true);
    assert.equal(a1.stdout, 'up 3 days');
    assert.ok(a1.startedAt && a1.finishedAt);
    assert.equal(b1.exitCode, 2);
    assert.equal(b1.stderr, 'boom');
    assert.equal(b1.site, 'Bravo');

    const alices = await ok(request('GET', `/api/schedules/${created.id}/runs/${started.id}`, { as: 'alice' }));
    assert.deepEqual(alices.devices.map((item: any) => item.deviceId), [dev.a1.id]);
    const detail = await ok(request('GET', `/api/schedules/${created.id}`, { as: 'alice' }));
    assert.ok(detail.runs[0].results.every((result: any) => result.site?.id !== siteB.id), 'no cross-site results');

    assert.equal((await request('GET', `/api/schedules/${created.id}/runs/999999`)).status, 404);
  });

  test('existing site schedules keep working', async () => {
    // As an older schedule would be stored: no device columns set
    const legacy = await models.ScheduleModel.create({
      name: 'Legacy',
      targetType: 'snippet',
      snippetId: snippet.id,
      runbookId: null,
      cron: '0 4 * * *',
      timezone: 'UTC',
      siteMode: 'sites',
      siteIds: String(siteA.id),
      siteTag: '',
      runOn: 'devices',
      notifyOn: 'never',
      enabled: true
    });
    assert.equal(legacy.deviceIds, '');
    // Nobody owns it: it reaches nothing until an admin saves it
    assert.deepEqual(ids(await scheduler.scheduleDevices(legacy)), []);
    const owner = await models.UserModel.findOne({ where: { role: 'owner' } });
    await legacy.update({ createdBy: owner!.id });
    assert.deepEqual(ids(await scheduler.scheduleDevices(legacy)), ids([dev.a1, dev.a2]));

    const listed = await ok(request('GET', '/api/schedules'));
    const row = listed.find((item: any) => item.id === legacy.id);
    assert.deepEqual(row.deviceIds, []);
    assert.equal(row.deviceTag, '');

    const server = await ok(
      request('POST', '/api/schedules', { body: { ...base, name: 'Server', snippetId: snippet.id, siteMode: 'sites', siteIds: [siteA.id], runOn: 'server', deviceTag: 'web', deviceIds: [dev.a1.id] } }),
      201
    );
    assert.equal(server.runOn, 'server');
    assert.deepEqual(server.deviceIds, [], 'device targeting is ignored for server runs');
  });

  test("Linda's exploit: another site's schedule cannot be read, retargeted, run or deleted", async () => {
    // A schedule on a Bravo device, made by an admin
    const theirs = await ok(
      request('POST', '/api/schedules', { body: { ...base, name: 'Bravo job', snippetId: snippet.id, siteMode: 'devices', deviceIds: [dev.b1.id] } }),
      201
    );
    // Alice (Alpha only) gets the same 404 as for a missing schedule, everywhere
    assert.equal((await request('GET', `/api/schedules/${theirs.id}/edit`, { as: 'alice' })).status, 404);
    assert.equal(
      (await request('PUT', `/api/schedules/${theirs.id}`, { body: { ...base, name: 'Mine now', snippetId: snippet.id, siteMode: 'devices', deviceIds: [dev.a1.id] }, as: 'alice' })).status,
      404
    );
    assert.equal((await request('POST', `/api/schedules/${theirs.id}/run`, { as: 'alice' })).status, 404);
    assert.equal((await request('DELETE', `/api/schedules/${theirs.id}`, { as: 'alice' })).status, 404);
    const still = await models.ScheduleModel.findByPk(theirs.id);
    assert.equal(still?.name, 'Bravo job');
    assert.equal(still?.deviceIds, String(dev.b1.id));
    const [refusals] = await db.sequelize.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'schedule.access_refused' AND target = 'schedule:${theirs.id}'`);
    assert.equal((refusals as any[])[0].n, 4);

    // Her own schedule cannot be retargeted to a Bravo device, then run
    const mine = await ok(
      request('POST', '/api/schedules', { body: { ...base, name: 'Alpha job', snippetId: snippet.id, siteMode: 'devices', deviceIds: [dev.a1.id] }, as: 'alice' }),
      201
    );
    const retarget = await request('PUT', `/api/schedules/${mine.id}`, {
      body: { ...base, name: 'Alpha job', snippetId: snippet.id, siteMode: 'devices', deviceIds: [dev.b1.id] },
      as: 'alice'
    });
    assert.equal(retarget.status, 400);
    assert.equal((await models.ScheduleModel.findByPk(mine.id))?.deviceIds, String(dev.a1.id));

    // Even if a Bravo device ends up in it, a run only reaches the NARROWER of
    // creator and last editor: Alice's sites
    const shared = await ok(
      request('POST', '/api/schedules', { body: { ...base, name: 'Shared', snippetId: snippet.id, siteMode: 'devices', deviceIds: [dev.a1.id] } }),
      201
    );
    await ok(request('PUT', `/api/schedules/${shared.id}`, { body: { ...base, name: 'Shared', snippetId: snippet.id, siteMode: 'devices', deviceIds: [dev.a1.id] }, as: 'alice' }));
    const row = await models.ScheduleModel.findByPk(shared.id);
    const alice = await models.UserModel.findOne({ where: { email: 'alice@example.test' } });
    assert.equal(row?.updatedBy, alice!.id, 'every edit records the editor');
    await row!.update({ deviceIds: `${dev.a1.id},${dev.b1.id}` });
    assert.deepEqual(ids(await scheduler.scheduleDevices(row!)), ids([dev.a1]));
    const run = await scheduler.startScheduleRun(row!, 'manual', null);
    const jobs = await models.AgentJobModel.findAll({ where: { scheduleRunId: run.id } });
    assert.deepEqual(jobs.map((job: any) => job.deviceId), [dev.a1.id]);

    // Nobody responsible any more: refused
    await row!.update({ createdBy: null, updatedBy: null });
    const orphan = await scheduler.startScheduleRun(row!, 'manual', null);
    assert.equal((await models.ScheduleRunModel.findByPk(orphan.id))?.status, 'failed');
  });
});
