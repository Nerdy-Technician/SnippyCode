import { QueryInterface, Transaction } from 'sequelize';
import { assertSecretKeyConfigured, decryptSecret, encryptSecret, isBoundSecret, isEncryptedSecret } from '../../utils/secretBox';

/**
 * Variables redesign (v1.3.0): Global, Site and User scopes.
 *
 * The scopes map onto the existing columns, so no data moves:
 *   global = userId NULL and siteId NULL (was "team")
 *   site   = siteId set
 *   user   = userId set (was "personal")
 *
 * - A row with both userId and siteId set was ambiguous; it was always
 *   treated as the user's value, so siteId is cleared to match.
 * - A CHECK constraint keeps every row in exactly one scope.
 * - Secret values are re-encrypted bound to their row with AAD
 *   ("variables:<id>:value"); a ciphertext copied to another row fails.
 *   Already-bound values are skipped, so this can run again safely.
 *
 * Everything runs in one transaction: a missing key or an unreadable
 * secret leaves the table untouched.
 */
export const bindVariableSecrets = async (queryInterface: QueryInterface, transaction?: Transaction): Promise<number> => {
  const q = queryInterface.sequelize;
  const [rows] = (await q.query(`SELECT id, value FROM variables WHERE "isSecret" = true AND value <> '' ORDER BY id`, {
    transaction
  })) as [Array<{ id: number; value: string }>, unknown];
  let changed = 0;

  for (const row of rows) {
    if (isBoundSecret(row.value)) continue;
    const plain = isEncryptedSecret(row.value) ? decryptSecret(row.value) : row.value;
    await q.query(`UPDATE variables SET value = :value WHERE id = :id`, {
      replacements: { id: row.id, value: encryptSecret(plain, `variables:${row.id}:value`) },
      transaction
    });
    changed += 1;
  }

  return changed;
};

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  const q = queryInterface.sequelize;

  await q.transaction(async transaction => {
    const [[{ secrets }]] = (await q.query(
      `SELECT COUNT(*)::int AS secrets FROM variables WHERE "isSecret" = true AND value <> '' AND value NOT LIKE 'enc:v2:%'`,
      { transaction }
    )) as [Array<{ secrets: number }>, unknown];
    if (secrets > 0) assertSecretKeyConfigured();

    await q.query(`UPDATE variables SET "siteId" = NULL WHERE "userId" IS NOT NULL AND "siteId" IS NOT NULL`, { transaction });
    await q.query(`ALTER TABLE variables DROP CONSTRAINT IF EXISTS variables_single_scope`, { transaction });
    await q.query(`ALTER TABLE variables ADD CONSTRAINT variables_single_scope CHECK ("userId" IS NULL OR "siteId" IS NULL)`, {
      transaction
    });
    await bindVariableSecrets(queryInterface, transaction);
  });
};

/** Bound secrets stay bound: the app reads both formats */
export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.sequelize.query(`ALTER TABLE variables DROP CONSTRAINT IF EXISTS variables_single_scope`);
};
