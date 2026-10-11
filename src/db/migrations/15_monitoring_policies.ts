import { DataTypes, QueryInterface } from 'sequelize';

const { INTEGER, STRING, DATE, TEXT, BOOLEAN, FLOAT } = DataTypes;

const timestamps = {
  createdAt: { type: DATE, allowNull: false },
  updatedAt: { type: DATE, allowNull: false }
};

const ref = (model: string, onDelete: 'CASCADE' | 'SET NULL', allowNull = true) => ({
  type: INTEGER,
  allowNull,
  references: { model, key: 'id' },
  onDelete
});

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  // Policies: monitors, patching and schedules applied to a set of devices
  await queryInterface.createTable('policies', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    name: { type: STRING(120), allowNull: false },
    description: { type: TEXT, allowNull: false, defaultValue: '' },
    enabled: { type: BOOLEAN, allowNull: false, defaultValue: true },
    // JSON: { siteIds: number[], tags: string[], deviceIds: number[], os: 'any'|'linux'|'windows' }
    scope: { type: TEXT, allowNull: false, defaultValue: '{}' },
    // JSON: { patch: { enabled, cron, timezone, mode: 'security'|'all', reboot: 'never'|'if-required'|'always' } }
    settings: { type: TEXT, allowNull: false, defaultValue: '{}' },
    lastPatchAt: { type: DATE, allowNull: true },
    nextPatchAt: { type: DATE, allowNull: true },
    createdBy: ref('users', 'SET NULL'),
    ...timestamps
  });

  await queryInterface.createTable('policy_monitors', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    policyId: ref('policies', 'CASCADE', false),
    type: { type: STRING(30), allowNull: false },
    // JSON parameters, e.g. { percent: 90, minutes: 15 } or { name: 'nginx', autoRestart: true }
    params: { type: TEXT, allowNull: false, defaultValue: '{}' },
    severity: { type: STRING(10), allowNull: false, defaultValue: 'warning' },
    enabled: { type: BOOLEAN, allowNull: false, defaultValue: true },
    ...timestamps
  });

  await queryInterface.createTable('alerts', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    deviceId: ref('devices', 'CASCADE', false),
    siteId: ref('sites', 'CASCADE'),
    policyId: ref('policies', 'SET NULL'),
    monitorId: ref('policy_monitors', 'SET NULL'),
    type: { type: STRING(30), allowNull: false },
    severity: { type: STRING(10), allowNull: false },
    title: { type: STRING(255), allowNull: false },
    detail: { type: TEXT, allowNull: false, defaultValue: '' },
    // 'open', 'acknowledged' or 'resolved'
    status: { type: STRING(20), allowNull: false, defaultValue: 'open' },
    occurrences: { type: INTEGER, allowNull: false, defaultValue: 1 },
    lastSeenAt: { type: DATE, allowNull: false },
    snoozedUntil: { type: DATE, allowNull: true },
    acknowledgedBy: ref('users', 'SET NULL'),
    acknowledgedAt: { type: DATE, allowNull: true },
    resolvedAt: { type: DATE, allowNull: true },
    resolvedBy: ref('users', 'SET NULL'),
    autoResolved: { type: BOOLEAN, allowNull: false, defaultValue: false },
    ...timestamps
  });
  await queryInterface.addIndex('alerts', ['status', 'deviceId']);
  await queryInterface.addIndex('alerts', ['siteId', 'createdAt']);

  // Trends: one row per check-in, plus availability samples for offline devices
  await queryInterface.createTable('device_metrics', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    deviceId: ref('devices', 'CASCADE', false),
    at: { type: DATE, allowNull: false },
    online: { type: BOOLEAN, allowNull: false, defaultValue: true },
    cpu: { type: FLOAT, allowNull: true },
    memory: { type: FLOAT, allowNull: true },
    disk: { type: FLOAT, allowNull: true }
  });
  await queryInterface.addIndex('device_metrics', ['deviceId', 'at']);

  // Custom fields and remote access details per device
  await queryInterface.addColumn('devices', 'fields', { type: TEXT, allowNull: false, defaultValue: '{}' });
  await queryInterface.addColumn('devices', 'remote', { type: TEXT, allowNull: false, defaultValue: '{}' });

  // Schedules can target a policy's devices
  await queryInterface.addColumn('schedules', 'policyId', ref('policies', 'CASCADE'));
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.removeColumn('schedules', 'policyId');
  await queryInterface.removeColumn('devices', 'remote');
  await queryInterface.removeColumn('devices', 'fields');
  await queryInterface.dropTable('device_metrics');
  await queryInterface.dropTable('alerts');
  await queryInterface.dropTable('policy_monitors');
  await queryInterface.dropTable('policies');
};
