import { QueryInterface, QueryTypes } from 'sequelize';
import { wrapLegacyHash } from '../../utils/tokenHash';

/**
 * Wrap every stored SHA-256 token hash in scrypt (see utils/tokenHash.ts):
 * the raw API key setting, snippet raw tokens, device tokens and enrolment
 * tokens. Tokens keep working; each is upgraded to plain scrypt(token) the next time it is used.
 *
 * Only plain 64-character hex hashes are touched, so it is safe to re-run,
 * and revoked device hashes ("revoked:...") stay as they are.
 */

const LEGACY = /^[0-9a-f]{64}$/;

const wrapColumn = async (
  queryInterface: QueryInterface,
  table: string,
  column: string
): Promise<void> => {
  const rows = await queryInterface.sequelize.query<{ id: number; hash: string }>(
    `SELECT id, "${column}" AS hash FROM "${table}" WHERE "${column}" IS NOT NULL`,
    { type: QueryTypes.SELECT }
  );

  for (const row of rows) {
    if (!LEGACY.test(row.hash)) continue;

    await queryInterface.sequelize.query(`UPDATE "${table}" SET "${column}" = :hash WHERE id = :id`, {
      replacements: { hash: await wrapLegacyHash(row.hash), id: row.id }
    });
  }
};

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await wrapColumn(queryInterface, 'snippets', 'rawTokenHash');
  await wrapColumn(queryInterface, 'devices', 'tokenHash');
  await wrapColumn(queryInterface, 'device_enrollments', 'tokenHash');

  const [setting] = await queryInterface.sequelize.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'rawApiKey'`,
    { type: QueryTypes.SELECT }
  );

  if (setting) {
    try {
      const parsed = JSON.parse(setting.value) as { hash?: string };

      if (parsed.hash && LEGACY.test(parsed.hash)) {
        parsed.hash = await wrapLegacyHash(parsed.hash);
        await queryInterface.sequelize.query(`UPDATE settings SET value = :value WHERE key = 'rawApiKey'`, {
          replacements: { value: JSON.stringify(parsed) }
        });
      }
    } catch {
      // Unreadable setting: leave it; the key simply will not verify
    }
  }
};

/**
 * scrypt cannot be undone, so this does not restore the SHA-256 hashes.
 * Rolling back the code after this migration means re-issuing tokens, or
 * restoring the pre-upgrade database backup.
 */
export const down = async (): Promise<void> => undefined;
