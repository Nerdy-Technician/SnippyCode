import { DataTypes, QueryInterface } from 'sequelize';

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.addColumn('audit_logs', 'ipAddress', {
    type: DataTypes.STRING,
    allowNull: true
  });
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.removeColumn('audit_logs', 'ipAddress');
};
