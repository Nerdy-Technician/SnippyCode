import { DataTypes, QueryInterface } from 'sequelize';

const { BOOLEAN, STRING, TEXT } = DataTypes;

/**
 * Stable device identity: agents send a random agent ID (UUID) generated on
 * first run. Re-enrolment matches on it. A shared hostname/OS/arch or
 * machine ID is only a hint and sets possibleDuplicate on the devices.
 */
export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.addColumn('devices', 'agentId', { type: STRING(36), allowNull: true });
  await queryInterface.addColumn('devices', 'possibleDuplicate', { type: BOOLEAN, allowNull: false, defaultValue: false });
  // Comma-separated IDs of the devices this one looks like
  await queryInterface.addColumn('devices', 'duplicateOf', { type: TEXT, allowNull: false, defaultValue: '' });
  await queryInterface.sequelize.query(
    `CREATE UNIQUE INDEX devices_agent_id_unique ON devices ("agentId") WHERE "agentId" IS NOT NULL`
  );
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.sequelize.query(`DROP INDEX IF EXISTS devices_agent_id_unique`);
  await queryInterface.removeColumn('devices', 'duplicateOf');
  await queryInterface.removeColumn('devices', 'possibleDuplicate');
  await queryInterface.removeColumn('devices', 'agentId');
};
