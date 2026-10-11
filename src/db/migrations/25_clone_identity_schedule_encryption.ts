import { DataTypes, QueryInterface, Transaction } from 'sequelize';
import { assertSecretKeyConfigured, decryptSecret, encryptSecret, isBoundSecret, isEncryptedSecret } from '../../utils/secretBox';

const { BOOLEAN, DATE, INTEGER, STRING } = DataTypes;

const aad = (id: number, name: string) => `schedules:${id}:variables:${name}`;

/**
 * Clone handling and schedule encryption. Runs in one transaction, so a
 * missing key or a failing row leaves nothing half-migrated.
 *
 * - devices.fingerprint: sha256 hardware fingerprint (never the raw values).
 *   It catches accidental clones and golden images; it is NOT
 *   authentication (a token thief can replay the header).
 * - devices.clonedFrom / clonePendingApproval: clones start inactive until
 *   an admin approves them (or a fresh enrolment token activates them).
 * - devices.fingerprintPendingReview: a first fingerprint bound in
 *   suspicious circumstances (see checkFingerprint).
 * - clone_enroll_counters: race-safe clone rate-limit windows.
 * - settings.fingerprintBindingSince: start of the 7-day window in which
 *   legacy devices may bind their first fingerprint from any address.
 * - Schedule variable values are encrypted bound to their schedule (AAD).
 *   Already-bound values are skipped, so the backfill can run again.
 */
export const encryptScheduleRows = async (queryInterface: QueryInterface, transaction?: Transaction): Promise<number> => {
  const q = queryInterface.sequelize;
  const [rows] = (await q.query(`SELECT id, variables FROM schedules ORDER BY id`, { transaction })) as [
    Array<{ id: number; variables: string }>,
    unknown
  ];
  let changed = 0;
  for (const row of rows) {
    let values: Record<string, unknown>;
    try {
      values = JSON.parse(row.variables || '{}');
    } catch {
      continue;
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    let dirty = false;
    const next: Record<string, string> = {};
    for (const [key, raw] of Object.entries(values)) {
      const value = String(raw ?? '');
      if (value === '' || isBoundSecret(value)) {
        next[key] = value;
      } else {
        next[key] = encryptSecret(isEncryptedSecret(value) ? decryptSecret(value) : value, aad(row.id, key));
        dirty = true;
      }
    }
    if (dirty) {
      await q.query(`UPDATE schedules SET variables = :variables WHERE id = :id`, {
        replacements: { id: row.id, variables: JSON.stringify(next) },
        transaction
      });
      changed += 1;
    }
  }
  return changed;
};

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  // Fail before touching anything if production has no key
  assertSecretKeyConfigured();
  await queryInterface.sequelize.transaction(async transaction => {
    const q = queryInterface.sequelize;
    await queryInterface.addColumn('devices', 'fingerprint', { type: STRING(64), allowNull: true }, { transaction });
    await queryInterface.addColumn(
      'devices',
      'clonedFrom',
      { type: INTEGER, allowNull: true, references: { model: 'devices', key: 'id' }, onDelete: 'SET NULL' },
      { transaction }
    );
    await queryInterface.addColumn(
      'devices',
      'clonePendingApproval',
      { type: BOOLEAN, allowNull: false, defaultValue: false },
      { transaction }
    );
    await queryInterface.addColumn(
      'devices',
      'fingerprintPendingReview',
      { type: BOOLEAN, allowNull: false, defaultValue: false },
      { transaction }
    );
    // At most one clone device per (source device, fingerprint)
    await q.query(
      `CREATE UNIQUE INDEX devices_clone_unique ON devices ("clonedFrom", fingerprint) WHERE "clonedFrom" IS NOT NULL`,
      { transaction }
    );
    await queryInterface.createTable(
      'clone_enroll_counters',
      {
        // "device:<id>" or "global"
        scope: { type: STRING(40), allowNull: false, primaryKey: true },
        windowStart: { type: DATE, allowNull: false, primaryKey: true },
        count: { type: INTEGER, allowNull: false, defaultValue: 0 }
      },
      { transaction }
    );
    await q.query(
      `INSERT INTO settings (key, value) VALUES ('fingerprintBindingSince', :now) ON CONFLICT (key) DO NOTHING`,
      { replacements: { now: new Date().toISOString() }, transaction }
    );
    await encryptScheduleRows(queryInterface, transaction);
  });
};

/**
 * WARNING: down decrypts schedule values back to plain text in the
 * database. Only run it when that exposure is acceptable.
 */
export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.sequelize.transaction(async transaction => {
    const q = queryInterface.sequelize;
    const [rows] = (await q.query(`SELECT id, variables FROM schedules`, { transaction })) as [
      Array<{ id: number; variables: string }>,
      unknown
    ];
    for (const row of rows) {
      let values: Record<string, string>;
      try {
        values = JSON.parse(row.variables || '{}');
      } catch {
        continue;
      }
      const plain = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          isBoundSecret(String(value)) ? decryptSecret(String(value), aad(row.id, key)) : decryptSecret(String(value))
        ])
      );
      await q.query(`UPDATE schedules SET variables = :variables WHERE id = :id`, {
        replacements: { id: row.id, variables: JSON.stringify(plain) },
        transaction
      });
    }
    await q.query(`DELETE FROM settings WHERE key = 'fingerprintBindingSince'`, { transaction });
    await queryInterface.dropTable('clone_enroll_counters', { transaction });
    await q.query(`DROP INDEX IF EXISTS devices_clone_unique`, { transaction });
    await queryInterface.removeColumn('devices', 'fingerprintPendingReview', { transaction });
    await queryInterface.removeColumn('devices', 'clonePendingApproval', { transaction });
    await queryInterface.removeColumn('devices', 'clonedFrom', { transaction });
    await queryInterface.removeColumn('devices', 'fingerprint', { transaction });
  });
};
