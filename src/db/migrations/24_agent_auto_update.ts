import { DataTypes, QueryInterface } from 'sequelize';

const { INTEGER, STRING } = DataTypes;

/**
 * Staged agent updates: a rollout ring and an optional version pin per
 * device, and the last update result (with the version it came from, so a
 * rollback is visible). Existing devices go in the "stable" ring, unpinned.
 */
export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.addColumn('devices', 'updateRing', { type: STRING(20), allowNull: false, defaultValue: 'stable' });
  await queryInterface.addColumn('devices', 'updatePin', { type: STRING(40), allowNull: false, defaultValue: '' });
  await queryInterface.addColumn('devices', 'previousAgentVersion', { type: STRING(40), allowNull: false, defaultValue: '' });
  await queryInterface.addColumn('devices', 'lastUpdateResult', { type: STRING(300), allowNull: false, defaultValue: '' });
  // Polls since the device reached the current release: staged rollout health
  await queryInterface.addColumn('devices', 'healthyCheckins', { type: INTEGER, allowNull: false, defaultValue: 0 });
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  for (const column of ['healthyCheckins', 'lastUpdateResult', 'previousAgentVersion', 'updatePin', 'updateRing']) {
    await queryInterface.removeColumn('devices', column);
  }
};
