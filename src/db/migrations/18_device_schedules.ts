import { DataTypes, QueryInterface } from 'sequelize';

const { STRING, TEXT } = DataTypes;

/**
 * Device-targeted schedules: device tags, and schedules that pick devices
 * individually (deviceIds) and/or by device tag. Existing schedules keep
 * their behaviour: both new columns default to empty.
 */
export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.addColumn('devices', 'tags', { type: TEXT, allowNull: false, defaultValue: '' });
  await queryInterface.addColumn('schedules', 'deviceIds', { type: TEXT, allowNull: false, defaultValue: '' });
  await queryInterface.addColumn('schedules', 'deviceTag', { type: STRING(60), allowNull: false, defaultValue: '' });
  // siteMode gains 'devices' (8 characters, fits the existing column)
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.sequelize.query(`UPDATE schedules SET "siteMode" = 'none', "runOn" = 'server', enabled = false WHERE "siteMode" = 'devices'`);
  await queryInterface.removeColumn('schedules', 'deviceTag');
  await queryInterface.removeColumn('schedules', 'deviceIds');
  await queryInterface.removeColumn('devices', 'tags');
};
