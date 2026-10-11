import { DataTypes, QueryInterface } from 'sequelize';

const { INTEGER } = DataTypes;

/**
 * Clone activation tokens: a single-use enrolment token an admin creates for
 * one pending clone. Only such a token (or an admin approval) activates a
 * clone; bulk and multi-use tokens never do.
 */
export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.addColumn('device_enrollments', 'forDeviceId', { type: INTEGER, allowNull: true });
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.removeColumn('device_enrollments', 'forDeviceId');
};
