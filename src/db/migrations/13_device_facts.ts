import { DataTypes, QueryInterface } from 'sequelize';

const { DATE, TEXT } = DataTypes;

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  // System facts the agent reports: OS, memory, disk, uptime, address
  await queryInterface.addColumn('devices', 'facts', {
    type: TEXT,
    allowNull: false,
    defaultValue: '{}'
  });
  await queryInterface.addColumn('devices', 'factsAt', {
    type: DATE,
    allowNull: true
  });
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.removeColumn('devices', 'factsAt');
  await queryInterface.removeColumn('devices', 'facts');
};
