import { DataTypes, QueryInterface } from 'sequelize';

const { BOOLEAN, DATE, INTEGER, STRING } = DataTypes;

/**
 * Bulk enrolment: reusable enrolment tokens (optional max uses, revoke, last
 * use), a machine ID on devices so re-running the installer reuses the
 * device, and a per-site admin role for site members.
 */
export const up = async (queryInterface: QueryInterface): Promise<void> => {
  // NULL max uses = unlimited until the token expires or is revoked
  await queryInterface.changeColumn('device_enrollments', 'maxUses', {
    type: INTEGER,
    allowNull: true,
    defaultValue: 1
  });
  await queryInterface.addColumn('device_enrollments', 'label', {
    type: STRING(120),
    allowNull: false,
    defaultValue: ''
  });
  await queryInterface.addColumn('device_enrollments', 'lastUsedAt', { type: DATE, allowNull: true });
  await queryInterface.addColumn('device_enrollments', 'revokedAt', { type: DATE, allowNull: true });
  await queryInterface.addColumn('device_enrollments', 'revokedBy', {
    type: INTEGER,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL'
  });
  await queryInterface.addColumn('device_enrollments', 'allowReenrol', {
    type: BOOLEAN,
    allowNull: false,
    defaultValue: false
  });
  await queryInterface.addIndex('device_enrollments', ['tokenPrefix']);

  await queryInterface.addColumn('devices', 'machineId', {
    type: STRING(128),
    allowNull: true
  });
  await queryInterface.addIndex('devices', ['siteId', 'machineId']);

  await queryInterface.addColumn('site_members', 'role', {
    type: STRING(20),
    allowNull: false,
    defaultValue: 'member'
  });
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.removeColumn('site_members', 'role');
  await queryInterface.removeIndex('devices', ['siteId', 'machineId']);
  await queryInterface.removeColumn('devices', 'machineId');
  await queryInterface.removeIndex('device_enrollments', ['tokenPrefix']);
  await queryInterface.removeColumn('device_enrollments', 'allowReenrol');
  await queryInterface.removeColumn('device_enrollments', 'revokedBy');
  await queryInterface.removeColumn('device_enrollments', 'revokedAt');
  await queryInterface.removeColumn('device_enrollments', 'lastUsedAt');
  await queryInterface.removeColumn('device_enrollments', 'label');
  // Unlimited tokens cannot be represented any more; cap them at their uses
  await queryInterface.sequelize.query(
    'UPDATE device_enrollments SET "maxUses" = GREATEST(uses, 1) WHERE "maxUses" IS NULL'
  );
  await queryInterface.changeColumn('device_enrollments', 'maxUses', {
    type: INTEGER,
    allowNull: false,
    defaultValue: 1
  });
};
