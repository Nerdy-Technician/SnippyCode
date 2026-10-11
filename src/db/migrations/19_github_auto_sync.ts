import { DataTypes, QueryInterface } from 'sequelize';

const { BOOLEAN, DATE, INTEGER, STRING, TEXT } = DataTypes;

/**
 * Automatic two-way GitHub sync: per-item sync state (stable sync id, the
 * hash both sides last agreed on, conflicts) and a run log.
 */
export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.createTable('github_sync_items', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    itemType: { type: STRING(10), allowNull: false },
    // null once the local item is deleted (the remote file is kept)
    itemId: { type: INTEGER, allowNull: true },
    syncId: { type: STRING(40), allowNull: false },
    baseHash: { type: STRING(64), allowNull: true },
    remoteSha: { type: STRING(64), allowNull: true },
    // synced | conflict | deleted_local | remote_missing
    status: { type: STRING(20), allowNull: false, defaultValue: 'synced' },
    conflictItemId: { type: INTEGER, allowNull: true },
    conflictRemoteHash: { type: STRING(64), allowNull: true },
    conflictAt: { type: DATE, allowNull: true },
    createdAt: { type: DATE, allowNull: false },
    updatedAt: { type: DATE, allowNull: false }
  });
  await queryInterface.addIndex('github_sync_items', ['itemType', 'syncId'], { unique: true });
  await queryInterface.addIndex('github_sync_items', ['itemType', 'itemId']);

  await queryInterface.createTable('github_sync_runs', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    trigger: { type: STRING(10), allowNull: false, defaultValue: 'schedule' },
    // running | success | skipped | failed | abandoned
    status: { type: STRING(12), allowNull: false, defaultValue: 'running' },
    uploaded: { type: INTEGER, allowNull: false, defaultValue: 0 },
    downloaded: { type: INTEGER, allowNull: false, defaultValue: 0 },
    conflicts: { type: INTEGER, allowNull: false, defaultValue: 0 },
    unchanged: { type: INTEGER, allowNull: false, defaultValue: 0 },
    backup: { type: STRING(200), allowNull: true },
    error: { type: TEXT, allowNull: true },
    dryRun: { type: BOOLEAN, allowNull: false, defaultValue: false },
    startedAt: { type: DATE, allowNull: false },
    finishedAt: { type: DATE, allowNull: true }
  });
  await queryInterface.addIndex('github_sync_runs', ['startedAt']);
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.dropTable('github_sync_runs');
  await queryInterface.dropTable('github_sync_items');
};
