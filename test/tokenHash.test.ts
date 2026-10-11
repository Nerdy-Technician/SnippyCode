/**
 * Token hashing: scrypt(sha256(token)) for new tokens, compatibility with
 * hashes stored before v1.2.2, and migration 16 (with TEST_DATABASE_URL).
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import { createHash, randomBytes } from 'crypto';
import {
  clearTokenHashCache,
  hashToken,
  isScryptHash,
  checkToken,
  isLegacyWrappedHash,
  verifyToken,
  wrapLegacyHash
} from '../src/utils/tokenHash';

// What versions before v1.2.2 stored
const legacyHash = (token: string) => createHash('sha256').update(token).digest('hex');
const newTokenValue = (prefix: string) => `${prefix}${randomBytes(24).toString('base64url')}`;

describe('token hashes', () => {
  test('new hashes are salted scrypt and verify only the right token', async () => {
    const token = newTokenValue('sc_dev_');
    const a = await hashToken(token);
    const b = await hashToken(token);

    assert.ok(isScryptHash(a));
    assert.match(a, /^scrypt\$16384:8:1\$[\w-]+\$[\w-]+$/);
    assert.notEqual(a, b, 'each hash has its own salt');
    assert.equal(await verifyToken(token, a), true);
    assert.equal(await verifyToken(token, b), true);
    assert.equal(await verifyToken(`${token}x`, a), false);
    assert.equal(await verifyToken('', a), false);
    assert.equal(await verifyToken(token, null), false);
  });

  test('a wrapped pre-v1.2.2 hash verifies with the original token and offers an upgrade', async () => {
    const token = newTokenValue('sb_snip_');
    const wrapped = await wrapLegacyHash(legacyHash(token));

    assert.ok(isLegacyWrappedHash(wrapped));
    const check = await checkToken(token, wrapped);
    assert.equal(check.ok, true);
    assert.ok(check.upgrade && !isLegacyWrappedHash(check.upgrade) && isScryptHash(check.upgrade));
    assert.equal(await verifyToken(token, String(check.upgrade)), true);
    assert.equal(await verifyToken(newTokenValue('sb_snip_'), wrapped), false);
  });

  test('unwrapped SHA-256 and revoked hashes are rejected', async () => {
    const token = newTokenValue('sc_dev_');

    assert.equal(await verifyToken(token, legacyHash(token)), false);
    assert.equal(await verifyToken(token, `revoked:${await hashToken(token)}`), false);
    assert.equal(await verifyToken(token, 'scrypt$bad'), false);
  });

  test('the verification cache follows the stored hash', async () => {
    clearTokenHashCache();
    const token = newTokenValue('sc_dev_');
    const first = await hashToken(token);
    const rotated = await hashToken(newTokenValue('sc_dev_'));

    assert.equal(await verifyToken(token, first), true);
    const started = process.hrtime.bigint();
    assert.equal(await verifyToken(token, first), true);
    const cachedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(cachedMs < 5, `cached check took ${cachedMs}ms`);
    assert.equal(await verifyToken(token, rotated), false, 'a rotated hash is not served from cache');
  });
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set, skipping migration 16 tests';

describe('migration 16: scrypt token hashes', { skip }, () => {
  let server: http.Server;
  let port = 0;
  let db: typeof import('../src/db');
  let models: typeof import('../src/models');
  let utils: typeof import('../src/utils');

  const get = (path: string, headers: http.OutgoingHttpHeaders = {}) =>
    new Promise<number>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path, headers }, res => {
          res.resume();
          resolve(res.statusCode || 0);
        })
        .on('error', reject);
    });

  before(async () => {
    const dbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
    if (!/test/i.test(dbName)) throw new Error(`Refusing to reset database "${dbName}"`);

    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = 'snippycode-test-session-secret';
    process.env.VARIABLES_SECRET_KEY = 'snippycode-test-variables-key';

    utils = await import('../src/utils');
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
  });

  after(async () => {
    await new Promise(resolve => server?.close(resolve));
    await db?.sequelize.close();
  });

  test('pre-v1.2.2 tokens keep working after the migration', async () => {
    const devToken = newTokenValue('sc_dev_');
    const enrollToken = newTokenValue('sc_enroll_');
    const snipToken = newTokenValue('sb_snip_');
    const rawKey = newTokenValue('sb_raw_');

    // Rows as an older version wrote them: plain SHA-256 hex
    const site = await models.SiteModel.create({ name: 'Legacy', slug: 'legacy' } as never);
    const device = await models.DeviceModel.create({
      siteId: site.id,
      name: 'old-agent',
      tokenHash: legacyHash(devToken),
      tokenPrefix: devToken.slice(0, 16)
    } as never);
    const enrollment = await models.DeviceEnrollmentModel.create({
      siteId: site.id,
      tokenHash: legacyHash(enrollToken),
      tokenPrefix: enrollToken.slice(0, 16),
      expiresAt: new Date(Date.now() + 3600_000),
      maxUses: 1
    } as never);
    const snippet = await models.SnippetModel.create({
      title: 'Legacy',
      language: 'bash',
      code: 'echo legacy',
      rawTokenHash: legacyHash(snipToken),
      rawTokenPrefix: snipToken.slice(0, 16)
    } as never);
    await models.SettingModel.upsert({
      key: 'rawApiKey',
      value: JSON.stringify({ hash: legacyHash(rawKey), prefix: rawKey.slice(0, 14), createdAt: new Date().toISOString() })
    } as never);

    const revokedHash = `revoked:${legacyHash(newTokenValue('sc_dev_'))}`;
    const revoked = await models.DeviceModel.create({
      siteId: site.id,
      name: 'revoked-agent',
      tokenHash: revokedHash,
      tokenPrefix: 'sc_dev_revoked00',
      revokedAt: new Date()
    } as never);

    // Before the migration, the new code does not accept bare SHA-256 hashes
    assert.equal(await get('/api/agent/next?wait=0', { authorization: `Bearer ${devToken}` }), 401);

    const migration = await import('../src/db/migrations/16_scrypt_token_hashes');
    await migration.up(db.sequelize.getQueryInterface());
    await migration.up(db.sequelize.getQueryInterface()); // re-running is harmless

    await device.reload();
    await enrollment.reload();
    await snippet.reload();
    await revoked.reload();
    assert.ok(isLegacyWrappedHash(device.tokenHash));
    assert.ok(isLegacyWrappedHash(enrollment.tokenHash));
    assert.ok(isLegacyWrappedHash(snippet.rawTokenHash));
    assert.equal(revoked.tokenHash, revokedHash, 'revoked hashes are left alone');
    const setting = await models.SettingModel.findByPk('rawApiKey');
    assert.ok(isLegacyWrappedHash(JSON.parse(String(setting?.value)).hash));

    // Old tokens work through the real endpoints
    assert.equal(await get('/api/agent/next?wait=0', { authorization: `Bearer ${devToken}` }), 204);
    assert.equal(await get('/api/agent/next?wait=0', { authorization: `Bearer ${devToken}x` }), 401);
    assert.equal(await get(`/raw/${snippet.id}?key=${encodeURIComponent(snipToken)}`), 200);
    assert.equal(await get(`/raw/${snippet.id}?key=${encodeURIComponent(rawKey)}`), 200);
    assert.equal(await get(`/raw/${snippet.id}?key=wrong`), 404);
    assert.equal(await utils.verifyRawApiKey(rawKey), true);
    assert.equal(await utils.verifyTokenHash(enrollToken, enrollment.tokenHash), true);

    // Used hashes were upgraded to plain scrypt and still work
    await device.reload();
    await snippet.reload();
    const upgraded = await models.SettingModel.findByPk('rawApiKey');
    assert.ok(isScryptHash(device.tokenHash) && !isLegacyWrappedHash(device.tokenHash));
    assert.ok(isScryptHash(snippet.rawTokenHash) && !isLegacyWrappedHash(snippet.rawTokenHash));
    assert.ok(!isLegacyWrappedHash(JSON.parse(String(upgraded?.value)).hash));
    assert.equal(await get('/api/agent/next?wait=0', { authorization: `Bearer ${devToken}` }), 204);
    assert.equal(await get(`/raw/${snippet.id}?key=${encodeURIComponent(snipToken)}`), 200);
    assert.equal(await utils.verifyRawApiKey(rawKey), true);
  });

  test('new tokens are stored as scrypt and found by prefix', async () => {
    const token = newTokenValue('sc_dev_');
    const site = await models.SiteModel.create({ name: 'New', slug: 'new' } as never);
    await models.DeviceModel.create({
      siteId: site.id,
      name: 'new-agent',
      tokenHash: await utils.hashApiKey(token),
      tokenPrefix: token.slice(0, 16)
    } as never);

    assert.equal(await get('/api/agent/next?wait=0', { authorization: `Bearer ${token}` }), 204);
  });
});
