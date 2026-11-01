/**
 * Signed agent auto-update: release signing (scripts/agent-release.js),
 * manifest checks, staged rollout by ring/percentage, per-device pins,
 * update results and rollback reporting, and the admin API.
 * Needs TEST_DATABASE_URL (a throwaway database whose name contains "test").
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'crypto';
import { spawnSync } from 'child_process';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as release from '../src/utils/agentRelease';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set, skipping agent auto-update tests';

interface TestResponse {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
  json: () => any;
}

describe('agent auto-update', { skip }, () => {
  let server: http.Server;
  let port = 0;
  let db: any;
  let models: typeof import('../src/models');
  const cookies: { [who: string]: string } = {};

  const request = (
    method: string,
    path: string,
    options: { body?: unknown; form?: Record<string, string>; as?: string | null; ip?: string; bearer?: string; fingerprint?: string } = {}
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
      if (options.fingerprint) headers['x-agent-fingerprint'] = options.fingerprint;

      const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 0, text, headers: res.headers, json: () => JSON.parse(text) });
        });
        // A dropped response must fail the test, not leave the promise pending
        res.on('error', reject);
        res.on('aborted', () => reject(new Error(`${method} ${path}: response aborted`)));
      });
      req.on('error', reject);
      // A ref'd timer keeps the event loop alive and turns a hang into an error
      // (a pending promise with nothing scheduled cancels the whole suite)
      req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${path}: no response after 30s`)));
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

  const repo = process.cwd();
  const keys = mkdtempSync(join(tmpdir(), 'sc-agent-keys-'));
  const out = mkdtempSync(join(tmpdir(), 'sc-agent-release-'));
  const script = join(repo, 'scripts', 'agent-release.js');
  const signRelease = (dir = out, extra: string[] = []) =>
    execFileSync('node', [script, 'sign', '--key', join(keys, 'agent-signing.key.pem'), '--out', dir, ...extra]);
  const manifest = (dir = out) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const privateKey = () => createPrivateKey(readFileSync(join(keys, 'agent-signing.key.pem')));

  /** Re-sign the release copies as another version (repo files untouched) */
  const releaseAs = (version: string, opts: { downgrade?: boolean } = {}) => {
    const m = manifest();
    for (const name of ['snippycode-agent.sh', 'snippycode-agent.ps1']) {
      const text = readFileSync(join(out, name), 'utf8')
        .replace(/^AGENT_VERSION="[^"]+"$/m, `AGENT_VERSION="${version}"`)
        .replace(/^\$AgentVersion = '[^']+'$/m, `$AgentVersion = '${version}'`);
      writeFileSync(join(out, name), text);
      const entry = { ...m.files[name], sha256: createHash('sha256').update(text).digest('hex'), downgrade: Boolean(opts.downgrade) };
      entry.signature = sign(null, Buffer.from(release.signedMessage({ file: name, version, ...entry })), privateKey()).toString('base64');
      m.files[name] = entry;
    }
    m.version = version;
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(m));
    release.clearReleaseCache();
  };

  let site: { id: number };
  const devices: Array<{ id: number; token: string }> = [];
  let agentUpdate: typeof import('../src/controllers/agentUpdate');
  const fp = (i: number) => createHash('sha256').update(`machine-${i}`).digest('hex');

  before(async () => {
    const dbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
    if (!/test/i.test(dbName)) throw new Error(`Refusing to reset database "${dbName}"`);
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = 'snippycode-test-session-secret';
    process.env.VARIABLES_SECRET_KEY = 'snippycode-test-variables-key';
    process.env.ENROLL_RATE_LIMIT_PER_TOKEN = '100';
    process.env.ENROLL_RATE_LIMIT_PER_IP = '100';
    process.env.AGENT_RELEASE_DIR = out;

    execFileSync('node', [script, 'keygen', '--out', keys]);
    signRelease();
    process.env.AGENT_UPDATE_PUBLIC_KEYS = readFileSync(join(keys, 'agent-signing.pub.pem'), 'utf8');

    await import('../src/utils');
    db = await import('../src/db');
    await db.sequelize.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await db.connectDB();
    const { associateModels } = await import('../src/db/associateModels');
    await associateModels();
    models = await import('../src/models');
    agentUpdate = await import('../src/controllers/agentUpdate');
    const { createApp } = await import('../src/app');
    server = createApp({ clientDirs: [] }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => (server.listening ? resolve() : server.once('listening', () => resolve())));
    port = (server.address() as AddressInfo).port;

    const setup = await request('POST', '/api/auth/setup', {
      body: { email: 'owner@example.test', displayName: 'Owner', password: 'correct-horse-battery' },
      as: null
    });
    cookies.owner = String(setup.headers['set-cookie']?.[0] || '').split(';')[0];
    await ok(request('POST', '/api/admin/users', { body: { email: 'ed@example.test', displayName: 'Ed', password: 'editor-password-123', role: 'editor' } }), 201);
    const login = await request('POST', '/api/auth/login', { body: { email: 'ed@example.test', password: 'editor-password-123' }, as: null });
    cookies.editor = String(login.headers['set-cookie']?.[0] || '').split(';')[0];

    site = await ok(request('POST', '/api/sites', { body: { name: 'Fleet' } }), 201);
    const created = await ok(createToken({ siteId: site.id, maxUses: null }), 201);
    for (let i = 0; i < 24; i += 1) {
      const enrolled = await ok(
        enroll(created.token, { hostname: `pc-${i}`, agentId: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, fingerprint: fp(i) }),
        201
      );
      devices.push({ id: enrolled.deviceId, token: enrolled.token });
    }
  });

  after(async () => {
    await new Promise(resolve => server?.close(resolve));
    await db?.sequelize.close();
  });

  const reset = async (patch: Record<string, unknown> = {}) => {
    await models.DeviceModel.update({ agentVersion: '1.4.0', updateRing: 'stable', updatePin: '', healthyCheckins: 0, ...patch } as any, { where: {} });
    agentUpdate.clearFleetCache();
  };
  const setDevice = async (i: number, patch: Record<string, unknown>) => {
    await models.DeviceModel.update(patch as any, { where: { id: devices[i].id } });
    agentUpdate.clearFleetCache();
  };
  const latest = async (i: number) =>
    (await request('GET', `/api/agent/next?wait=0`, { fingerprint: fp(i), as: null, bearer: devices[i].token })).headers['x-agent-latest'];
  const rollout = (body: Record<string, unknown>) => ok(request('PUT', '/api/devices/agent-rollout', { body }));

  /** Run the agent's own verification functions (bash) on a message */
  const agentVerify = (sh: string, msg: string, sig: string): boolean => {
    const work = mkdtempSync(join(tmpdir(), 'sc-agent-work-'));
    const fns = readFileSync(sh, 'utf8');
    const keysLine = (fns.match(/^AGENT_UPDATE_PUBKEYS="[^"]*"$/m) || [''])[0];
    const body = fns.slice(fns.indexOf('trusted_openssl() {'), fns.indexOf('self_update() {'));
    const res = spawnSync('bash', ['-c', `${keysLine}\nWORK="${work}"\n${body}\nverify_signature "$MSG" "$SIG"`], {
      env: { ...process.env, MSG: msg, SIG: sig } as unknown as NodeJS.ProcessEnv
    });
    return res.status === 0;
  };

  test('keys are never written inside the repository, and a loose key file is refused', () => {
    assert.throws(() => execFileSync('node', [script, 'keygen', '--out', join(repo, 'tmp-keys')], { stdio: 'pipe' }));
    assert.ok(!existsSync(join(repo, 'tmp-keys')));
    const loose = join(mkdtempSync(join(tmpdir(), 'sc-loose-')), 'k.pem');
    writeFileSync(loose, readFileSync(join(keys, 'agent-signing.key.pem')), { mode: 0o644 });
    assert.throws(() => execFileSync('node', [script, 'sign', '--key', loose, '--out', mkdtempSync(join(tmpdir(), 'sc-x-'))], { stdio: 'pipe' }));
  });

  test('U2: the signature covers file, platform, arch, version, sha256 and the downgrade flag', () => {
    const m = manifest();
    assert.equal(m.version, '1.5.0');
    const pub = createPublicKey(readFileSync(join(keys, 'agent-signing.pub.pem')));
    const entry = m.files['snippycode-agent.sh'];
    const msg = (patch: Record<string, unknown> = {}) =>
      Buffer.from(release.signedMessage({ file: 'snippycode-agent.sh', version: m.version, ...entry, ...patch }));
    assert.ok(verify(null, msg(), pub, Buffer.from(entry.signature, 'base64')));
    for (const lie of [{ version: '9.9.9' }, { platform: 'windows' }, { downgrade: true }, { sha256: 'f'.repeat(64) }, { file: 'snippycode-agent.ps1' }]) {
      assert.equal(verify(null, msg(lie), pub, Buffer.from(entry.signature, 'base64')), false, JSON.stringify(lie));
    }
    assert.equal(execFileSync('node', [script, 'verify', '--out', out]).toString().match(/ok /g)?.length, 2);
  });

  test('U1/U3: the agent verifies with a root-owned openssl and any embedded key; lies fail', () => {
    const m = manifest();
    const entry = m.files['snippycode-agent.sh'];
    const sh = join(out, 'snippycode-agent.sh');
    const good = release.signedMessage({ file: 'snippycode-agent.sh', version: m.version, ...entry });
    assert.equal(agentVerify(sh, good, entry.signature), true);
    assert.equal(agentVerify(sh, good.replace(`version=${m.version}`, 'version=0.9.0'), entry.signature), false, 'version lie');
    assert.equal(agentVerify(sh, good.replace('downgrade=0', 'downgrade=1'), entry.signature), false, 'downgrade lie');
    // An agent with a standby key accepts releases signed by either key
    const next = mkdtempSync(join(tmpdir(), 'sc-next-'));
    execFileSync('node', [script, 'keygen', '--out', next]);
    const withNext = mkdtempSync(join(tmpdir(), 'sc-rel-next-'));
    signRelease(withNext, ['--next-pub', join(next, 'agent-signing.pub.pem')]);
    assert.equal(manifest(withNext).publicKeys.length, 2);
    const nextKey = createPrivateKey(readFileSync(join(next, 'agent-signing.key.pem')));
    assert.equal(agentVerify(join(withNext, 'snippycode-agent.sh'), good, sign(null, Buffer.from(good), nextKey).toString('base64')), true, 'standby key');
    assert.equal(agentVerify(sh, good, sign(null, Buffer.from(good), nextKey).toString('base64')), false, 'unknown key');
  });

  test('U3: the server refuses tampered, wrongly signed, or (in production) unverifiable releases', () => {
    release.clearReleaseCache();
    assert.equal(release.loadRelease()?.version, '1.5.0');
    const original = readFileSync(join(out, 'snippycode-agent.sh'));
    writeFileSync(join(out, 'snippycode-agent.sh'), Buffer.concat([original, Buffer.from('\n# changed\n')]));
    release.clearReleaseCache();
    assert.equal(release.loadRelease(), null, 'checksum mismatch');
    writeFileSync(join(out, 'snippycode-agent.sh'), original);

    const saved = process.env.AGENT_UPDATE_PUBLIC_KEYS;
    process.env.AGENT_UPDATE_PUBLIC_KEYS = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    release.clearReleaseCache();
    assert.equal(release.loadRelease(), null, 'signed by a key the server does not trust');
    process.env.AGENT_UPDATE_PUBLIC_KEYS = '';
    process.env.NODE_ENV = 'production';
    release.clearReleaseCache();
    assert.equal(release.loadRelease(), null, 'production needs a configured key');
    process.env.NODE_ENV = 'test';
    process.env.AGENT_UPDATE_PUBLIC_KEYS = saved;
    release.clearReleaseCache();
    assert.equal(release.loadRelease()?.version, '1.5.0');
  });

  test('rollout rules: pins (with signed downgrade), stages, percentage, Windows never', () => {
    const rel = { version: '1.5.0', files: { 'snippycode-agent.sh': { sha256: '', signature: '', platform: 'linux' as const, arch: 'any', downgrade: false } } };
    const base = { id: 7, agentVersion: '1.4.0', updateRing: 'stable', updatePin: '', os: 'linux' };
    const manual = { mode: 'manual' as const, rings: [] as any[], percent: 0, paused: false };
    assert.equal(release.updateOffer(base, rel, manual), null);
    assert.equal(release.updateOffer({ ...base, updateRing: 'canary' }, rel, { ...manual, rings: ['canary'] }), '1.5.0');
    assert.equal(release.updateOffer(base, rel, { ...manual, percent: 100 }), '1.5.0');
    assert.equal(release.updateOffer({ ...base, os: 'Windows 11' }, rel, { ...manual, percent: 100 }), null, 'Windows does not self-update');
    assert.equal(release.updateOffer({ ...base, updatePin: '1.4.5' }, rel, { ...manual, percent: 100 }), null, 'pinned elsewhere');
    assert.equal(release.updateOffer({ ...base, updatePin: '1.5.0' }, rel, { ...manual, paused: true }), '1.5.0', 'pinned to it, even paused');
    assert.equal(release.updateOffer({ ...base, agentVersion: '1.6.0', updatePin: '1.5.0' }, rel, manual), null, 'no downgrade unless signed so');
    const downgradable = { ...rel, files: { 'snippycode-agent.sh': { ...rel.files['snippycode-agent.sh'], downgrade: true } } };
    assert.equal(release.updateOffer({ ...base, agentVersion: '1.6.0', updatePin: '1.5.0' }, downgradable, manual), '1.5.0');
    assert.equal(release.updateOffer({ ...base, agentVersion: '1.6.0' }, downgradable, { ...manual, percent: 100 }), null, 'unpinned never downgrades');

    const auto = release.DEFAULT_ROLLOUT;
    assert.equal(auto.mode, 'auto');
    const fleet = (canaryDone: number, earlyDone: number) => [
      ...[1, 2, 3].map(id => ({ id, agentVersion: id <= canaryDone ? '1.5.0' : '1.4.0', updateRing: 'canary', healthyCheckins: 9 })),
      ...[4, 5, 6].map(id => ({ id, agentVersion: id - 3 <= earlyDone ? '1.5.0' : '1.4.0', updateRing: 'early', healthyCheckins: 9 })),
      { id: 7, agentVersion: '1.4.0', updateRing: 'stable' }
    ];
    assert.equal(release.effectiveStage(auto, rel, fleet(0, 0)).stage, 'canary');
    assert.equal(release.effectiveStage(auto, rel, fleet(2, 0)).stage, 'canary', 'not enough healthy canaries');
    assert.equal(release.effectiveStage(auto, rel, fleet(3, 0)).stage, 'early');
    const stable = release.effectiveStage(auto, rel, fleet(3, 3));
    assert.equal(stable.stage, 'stable');
    assert.equal(stable.percent, 25);
    const share = Array.from({ length: 1000 }, (_, id) => release.rolloutBucket(id, '1.5.0') < 25).filter(Boolean).length;
    assert.ok(share > 180 && share < 320, `about a quarter, got ${share}`);
  });

  test('U4: by default only canaries are offered; health opens early, then a stable share', async () => {
    releaseAs('1.5.0');
    await reset();
    for (const i of [0, 1, 2]) await setDevice(i, { updateRing: 'canary' });
    for (const i of [3, 4, 5]) await setDevice(i, { updateRing: 'early' });
    assert.equal(await latest(0), '1.5.0', 'canary');
    assert.equal(await latest(3), undefined, 'early waits');
    assert.equal(await latest(10), undefined, 'stable waits');
    assert.equal((await request('GET', '/api/agent/update', { fingerprint: fp(10), as: null, bearer: devices[10].token })).status, 204);

    // Canaries update and keep checking in healthily
    for (const i of [0, 1, 2]) await setDevice(i, { agentVersion: '1.5.0' });
    for (let n = 0; n < release.HEALTH.checkins; n += 1) for (const i of [0, 1, 2]) await latest(i);
    agentUpdate.clearFleetCache();
    assert.equal(await latest(3), '1.5.0', 'early opens after healthy canaries');
    assert.equal(await latest(10), undefined);
    for (const i of [3, 4, 5]) await setDevice(i, { agentVersion: '1.5.0' });
    for (let n = 0; n < release.HEALTH.checkins; n += 1) for (const i of [3, 4, 5]) await latest(i);
    agentUpdate.clearFleetCache();
    const status = await ok(request('GET', '/api/devices/agent-rollout'));
    assert.equal(status.stage, 'stable');
    let told = 0;
    for (let i = 6; i < 24; i += 1) if (await latest(i)) told += 1;
    assert.ok(told < 18, `only a share of stable (${told}/18)`);
  });

  test('U4: a rollback pauses the rollout for everyone, audited and notified', async () => {
    await reset();
    await setDevice(0, { updateRing: 'canary' });
    await setDevice(1, { updateRing: 'canary' });
    assert.equal(await latest(1), '1.5.0');
    await ok(request('POST', `/api/agent/update-result`, { fingerprint: fp(0), as: null, bearer: devices[0].token, form: { from: '1.4.0', to: '1.5.0', ok: '0', detail: 'health check failed, rolled back' } }));
    const paused = await ok(request('GET', '/api/devices/agent-rollout'));
    assert.equal(paused.rollout.paused, true);
    assert.match(paused.rollout.pausedReason, /rolled back/);
    assert.equal(await latest(1), undefined, 'nobody else is offered it');
    assert.ok(await models.AuditLogModel.count({ where: { action: 'agent.rollout_auto_paused' } }));
    const row = await models.DeviceModel.findByPk(devices[0].id);
    assert.equal(row!.agentVersion, '1.4.0');
    await rollout({ paused: false });
    assert.equal(await latest(1), '1.5.0');
  });

  test('manual mode, admin-only changes, ring validation', async () => {
    assert.equal((await request('PUT', '/api/devices/agent-rollout', { body: { mode: 'manual', percent: 100 }, as: 'editor' })).status, 403);
    await rollout({ mode: 'manual', rings: [], percent: 0 });
    await reset();
    assert.equal(await latest(6), undefined);
    await ok(request('PUT', `/api/devices/${devices[6].id}/agent-update`, { body: { ring: 'canary' } }));
    await rollout({ rings: ['canary'] });
    assert.equal(await latest(6), '1.5.0');
    assert.equal((await request('PUT', `/api/devices/${devices[6].id}/agent-update`, { body: { ring: 'beta' } })).status, 400);
    assert.equal((await request('PUT', `/api/devices/${devices[6].id}/agent-update`, { body: { pin: 'bad pin!' } })).status, 400);
  });

  test('U2: the download carries the signed manifest fields; downgrades need pin + signed flag', async () => {
    await reset({ updateRing: 'canary' });
    const download = await request('GET', `/api/agent/update?file=snippycode-agent.sh`, { fingerprint: fp(7), as: null, bearer: devices[7].token });
    assert.equal(download.status, 200);
    const h = download.headers;
    assert.equal(h['x-agent-platform'], 'linux');
    assert.equal(h['x-agent-pinned'], '0');
    const msg = release.signedMessage({ file: 'snippycode-agent.sh', platform: 'linux', arch: String(h['x-agent-arch']), version: String(h['x-agent-version']), sha256: createHash('sha256').update(download.text).digest('hex'), downgrade: h['x-agent-downgrade'] === '1' });
    assert.ok(verify(null, Buffer.from(msg), createPublicKey(readFileSync(join(keys, 'agent-signing.pub.pem'))), Buffer.from(String(h['x-agent-signature']), 'base64')));
    assert.equal((await request('GET', `/api/agent/update?file=snippycode-agent.ps1`, { fingerprint: fp(7), as: null, bearer: devices[7].token })).status, 204, 'Windows file is never offered');

    await setDevice(8, { agentVersion: '1.6.0', updatePin: '1.5.0' });
    assert.equal(await latest(8), undefined, 'release not signed for downgrade');
    releaseAs('1.5.0', { downgrade: true });
    const pinned = await request('GET', `/api/agent/update`, { fingerprint: fp(8), as: null, bearer: devices[8].token });
    assert.equal(pinned.status, 200);
    assert.equal(pinned.headers['x-agent-pinned'], '1');
    assert.equal(pinned.headers['x-agent-downgrade'], '1');
    releaseAs('1.5.0');
  });

  test('first hop: legacy agents only inside a bootstrap window with a pinned SHA-256, canary first, audited', async () => {
    await reset({ agentVersion: '1.3.0' });
    await rollout({ mode: 'auto', paused: false, bootstrapUntil: null });
    await setDevice(9, { updateRing: 'canary' });
    assert.equal(await latest(9), undefined, 'no window, no hop');
    await rollout({ bootstrapUntil: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    assert.equal(await latest(9), undefined, 'no pinned hash, no hop');
    process.env.AGENT_BOOTSTRAP_SHA256 = 'f'.repeat(64);
    assert.equal(await latest(9), undefined, 'hash must match the release');
    process.env.AGENT_BOOTSTRAP_SHA256 = manifest().files['snippycode-agent.sh'].sha256;
    assert.equal(await latest(9), '1.5.0', 'canary legacy device is told');
    assert.equal(await latest(12), undefined, 'stable legacy devices wait');
    await latest(9);
    assert.equal(await models.AuditLogModel.count({ where: { action: 'agent.bootstrap_offered', target: `device:${devices[9].id}` } }), 1, 'audited once');
    assert.equal((await request('GET', `/api/agent/update`, { fingerprint: fp(9), as: null, bearer: devices[9].token })).status, 200);

    const capped = await rollout({ bootstrapUntil: new Date(Date.now() + 400 * 86_400_000).toISOString() });
    assert.ok(new Date(capped.bootstrapUntil).getTime() <= Date.now() + 30 * 86_400_000 + 5000, 'window capped at 30 days');
    await rollout({ bootstrapUntil: new Date(Date.now() - 1000).toISOString() });
    assert.equal(await latest(9), undefined, 'expired');

    // The window cannot be re-armed: 30 days count from the first arming
    const release = await import('../src/utils/agentRelease');
    const day = 86_400_000;
    const armed29 = release.cleanRollout(
      { bootstrapUntil: new Date(Date.now() + 7 * day).toISOString() },
      { ...release.DEFAULT_ROLLOUT, bootstrapFirstArmed: new Date(Date.now() - 29 * day).toISOString() }
    );
    assert.ok(new Date(armed29.bootstrapUntil!).getTime() <= Date.now() + day + 5000, 'only the rest of the first 30 days');
    const armed31 = release.cleanRollout(
      { bootstrapUntil: new Date(Date.now() + 7 * day).toISOString() },
      { ...release.DEFAULT_ROLLOUT, bootstrapFirstArmed: new Date(Date.now() - 31 * day).toISOString() }
    );
    assert.equal(armed31.bootstrapUntil, null, 'a spent window stays shut');
    delete process.env.AGENT_BOOTSTRAP_SHA256;
  });

  test('update calls go through requireAgent: a clone with a copied token is sent to re-enrol', async () => {
    await reset({ updateRing: 'canary' });
    await rollout({ mode: 'auto', paused: false });
    const clone = 'b'.repeat(64);
    for (const path of ['/api/agent/update', '/api/agent/ping']) {
      const res = await request('GET', `${path}`, { fingerprint: clone, as: null, bearer: devices[11].token });
      assert.equal(res.status, 409, path);
      assert.equal(res.headers['x-reenrol-required'], '1');
    }
    const result = await request('POST', `/api/agent/update-result`, { fingerprint: clone, as: null, bearer: devices[11].token, form: { from: '1.4.0', to: '1.5.0', ok: 'true' } });
    assert.equal(result.status, 409);
    assert.equal((await models.DeviceModel.findByPk(devices[11].id))!.agentVersion, '1.4.0');
    assert.equal((await request('GET', `/api/agent/ping`, { fingerprint: fp(11), as: null, bearer: devices[11].token })).status, 204);
  });

  test('a device with a pending clone approval gets no update offer or download', async () => {
    await reset({ updateRing: 'canary' });
    await rollout({ mode: 'auto', paused: false });
    assert.equal(await latest(14), '1.5.0');
    await setDevice(14, { clonePendingApproval: true });
    assert.equal(await latest(14), undefined, 'polls carry no X-Agent-Latest');
    const res = await request('GET', '/api/agent/update', { fingerprint: fp(14), as: null, bearer: devices[14].token });
    assert.notEqual(res.status, 200);
    await setDevice(14, { clonePendingApproval: false });
  });

  test('update results record success, audited with the offered version', async () => {
    await ok(request('POST', `/api/agent/update-result`, { fingerprint: fp(13), as: null, bearer: devices[13].token, form: { from: '1.4.0', to: '1.5.0', ok: 'true' } }));
    const device = await models.DeviceModel.findByPk(devices[13].id);
    assert.equal(device!.agentVersion, '1.5.0');
    assert.equal(device!.previousAgentVersion, '1.4.0');
    const audit = await models.AuditLogModel.findOne({ where: { action: 'agent.updated', target: `device:${devices[13].id}` } });
    assert.match(String((audit as any).metadata), /matchesOffer\\?":true/);
  });

  test('key rotation: signed by the old key, embedding the new one', () => {
    const next = mkdtempSync(join(tmpdir(), 'sc-agent-keys-new-'));
    const rotated = mkdtempSync(join(tmpdir(), 'sc-agent-release-rot-'));
    execFileSync('node', [script, 'keygen', '--out', next]);
    signRelease(rotated, ['--embed-pub', join(next, 'agent-signing.pub.pem')]);
    const m = manifest(rotated);
    const newLine = createPublicKey(readFileSync(join(next, 'agent-signing.pub.pem'))).export({ type: 'spki', format: 'der' }).toString('base64');
    assert.deepEqual(m.publicKeys, [newLine]);
    assert.ok(readFileSync(join(rotated, 'snippycode-agent.sh'), 'utf8').includes(`AGENT_UPDATE_PUBKEYS="${newLine}"`));
    assert.match(execFileSync('node', [script, 'verify', '--out', rotated, '--pub', join(keys, 'agent-signing.pub.pem')]).toString(), /ok +snippycode-agent\.sh/);
  });

  test('installs download the signed release copy; agent scripts pass bash -n and shellcheck', async () => {
    const res = await request('GET', '/agent/snippycode-agent.sh', { as: null });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes(manifest().publicKeys[0]));
    execFileSync('bash', ['-n', join(repo, 'agent', 'snippycode-agent.sh')]);
    execFileSync('bash', ['-n', join(out, 'snippycode-agent.sh')]);
    try {
      execFileSync('shellcheck', ['-S', 'warning', join(repo, 'agent', 'snippycode-agent.sh')], { stdio: 'pipe' });
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw new Error(String(err.stdout || err));
    }
  });
});
