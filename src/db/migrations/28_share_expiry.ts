import { DataTypes, QueryInterface } from 'sequelize';

const { BOOLEAN, DATE } = DataTypes;

/**
 * Share link expiry (v1.4.0).
 *
 * - shareExpiresAt: a public share stops resolving (/s/ and tokenless /raw)
 *   after this time. NULL means the share never expires.
 * - shareOneShot: the share is burned (made private) by the first successful
 *   anonymous view of /s/ or tokenless /raw.
 *
 * Existing public snippets keep today's behaviour: no expiry, not one-shot.
 */
export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.addColumn('snippets', 'shareExpiresAt', { type: DATE, allowNull: true });
  await queryInterface.addColumn('snippets', 'shareOneShot', { type: BOOLEAN, allowNull: false, defaultValue: false });
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.removeColumn('snippets', 'shareOneShot');
  await queryInterface.removeColumn('snippets', 'shareExpiresAt');
};
