/**
 * Schedule variable values: encrypted at rest and bound to their schedule
 * (AAD), masked in lists, decrypted only at run time or for the edit form;
 * legacy values are rebound; the migration backfill; no dev key in
 * production. The database parts need TEST_DATABASE_URL.
 */
import './testDbEnv';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VARIABLES_SECRET_KEY = process.env.VARIABLES_SECRET_KEY || 'snippycode-test-variables-key';
const dbSkip = process.env.TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set';

describe('schedule variable encryption', () => {
  test('round trip with AAD, masking and keeping masked values on save', async () => {
    const { SECRET_MASK, isBoundSecret } = await import('../src/utils/secretBox');
    const sv = await import('../src/utils/scheduleVariables');
    const plain = { host: 'db01', password: 'hunter2-long', ref: 'API_KEY', empty: '' };
    const stored = sv.encryptScheduleVariables(plain, 7);
    assert.ok(isBoundSecret(stored.host) && isBoundSecret(stored.password) && isBoundSecret(stored.ref));
    assert.equal(stored.empty, '');
    assert.ok(!JSON.stringify(stored).includes('hunter2'));
    assert.deepEqual(sv.encryptScheduleVariables(stored, 7), stored, 'already-bound values are kept');
    assert.deepEqual(sv.decryptScheduleVariables(stored, 7), plain);
    const masked = sv.maskScheduleVariables(stored);
    assert.deepEqual(masked, { host: SECRET_MASK, password: SECRET_MASK, ref: SECRET_MASK, empty: '' });
    assert.deepEqual(sv.restoreMaskedValues({ ...masked, host: 'db02' }, stored, 7), { ...plain, host: 'db02' });
  });

  test('AAD: a value moved to another schedule or name does not decrypt; v2 needs its AAD', async () => {
    const { decryptSecret } = await import('../src/utils/secretBox');
    const sv = await import('../src/utils/scheduleVariables');
    const stored = sv.encryptScheduleVariables({ password: 'p4ssw0rd' }, 1);
    assert.throws(() => sv.decryptScheduleVariables(stored, 2));
    assert.throws(() => sv.decryptScheduleVariables({ other: stored.password }, 1));
    assert.throws(() => decryptSecret(stored.password), /AAD/);
  });

  test('legacy v1 values decrypt once and are rewritten bound', async () => {
    const { encryptSecret, isBoundSecret } = await import('../src/utils/secretBox');
    const sv = await import('../src/utils/scheduleVariables');
    const legacy = { token: encryptSecret('old-value'), plain: 'typed' };
    assert.equal(sv.needsRebinding(legacy), true);
    assert.deepEqual(sv.decryptScheduleVariables(legacy, 3), { token: 'old-value', plain: 'typed' });
    const rebound = sv.encryptScheduleVariables(legacy, 3);
    assert.ok(isBoundSecret(rebound.token) && isBoundSecret(rebound.plain));
    assert.equal(sv.needsRebinding(rebound), false);
    assert.deepEqual(sv.decryptScheduleVariables(rebound, 3), { token: 'old-value', plain: 'typed' });
  });

  test('production refuses to start without a real key', async () => {
    const { assertSecretKeyConfigured } = await import('../src/utils/secretBox');
    const saved = { env: process.env.NODE_ENV, v: process.env.VARIABLES_SECRET_KEY, s: process.env.SESSION_SECRET };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.VARIABLES_SECRET_KEY;
      delete process.env.SESSION_SECRET;
      assert.throws(() => assertSecretKeyConfigured(), /must be set/);
      process.env.VARIABLES_SECRET_KEY = 'k';
      assert.doesNotThrow(() => assertSecretKeyConfigured());
    } finally {
      process.env.NODE_ENV = saved.env;
      if (saved.v === undefined) delete process.env.VARIABLES_SECRET_KEY;
      else process.env.VARIABLES_SECRET_KEY = saved.v;
      if (saved.s !== undefined) process.env.SESSION_SECRET = saved.s;
    }
  });

  test('saved schedules hold bound ciphertext; runs rebind legacy rows; migration backfill is idempotent', { skip: dbSkip }, async () => {
    const url = process.env.TEST_DATABASE_URL || '';
    if (!/test/i.test(new URL(url).pathname)) throw new Error('Refusing to use a non-test database');
    process.env.NODE_ENV = 'test';
    await import('../src/utils');
    const db = await import('../src/db');
    await db.sequelize.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await db.connectDB();
    const { associateModels } = await import('../src/db/associateModels');
    await associateModels();
    const { ScheduleModel } = await import('../src/models');
    const { isBoundSecret, encryptSecret, decryptSecret } = await import('../src/utils/secretBox');
    const sv = await import('../src/utils/scheduleVariables');

    // The create path: id assigned before the AAD is computed
    const schedule = await ScheduleModel.create({ name: 's', targetType: 'snippet', cron: '0 3 * * *', nextRunAt: new Date(), variables: { token: 'abc123secret' } } as any);
    const [rows] = (await db.sequelize.query(`SELECT variables FROM schedules WHERE id = :id`, {
      replacements: { id: schedule.id }
    })) as [any[], unknown];
    assert.ok(!rows[0].variables.includes('abc123secret'));
    const raw = JSON.parse(rows[0].variables);
    assert.ok(isBoundSecret(raw.token));
    assert.equal(decryptSecret(raw.token, sv.scheduleAad(schedule.id, 'token')), 'abc123secret');

    // Migration backfill: plain and legacy v1 rows become bound, then nothing changes
    await db.sequelize.query(`UPDATE schedules SET variables = :v WHERE id = :id`, {
      replacements: { id: schedule.id, v: JSON.stringify({ a: 'one', b: encryptSecret('two'), c: '' }) }
    });
    const { encryptScheduleRows } = await import('../src/db/migrations/25_clone_identity_schedule_encryption');
    const qi = db.sequelize.getQueryInterface();
    assert.equal(await encryptScheduleRows(qi), 1);
    assert.equal(await encryptScheduleRows(qi), 0, 'idempotent');
    const reloaded = await ScheduleModel.findByPk(schedule.id);
    assert.deepEqual(sv.decryptScheduleVariables(reloaded!.variables, schedule.id), { a: 'one', b: 'two', c: '' });
    assert.equal(sv.needsRebinding(reloaded!.variables), false);

    // A legacy row is rewritten bound on its next run
    await db.sequelize.query(`UPDATE schedules SET variables = :v WHERE id = :id`, {
      replacements: { id: schedule.id, v: JSON.stringify({ a: encryptSecret('legacy') }) }
    });
    const legacy = await ScheduleModel.findByPk(schedule.id);
    const scheduler = await import('../src/utils/scheduler');
    await scheduler.startScheduleRun(legacy!, 'manual').catch(() => undefined);
    const after = await ScheduleModel.findByPk(schedule.id);
    assert.equal(sv.needsRebinding(after!.variables), false);
    assert.deepEqual(sv.decryptScheduleVariables(after!.variables, schedule.id), { a: 'legacy' });
    await db.sequelize.close();
  });
});
