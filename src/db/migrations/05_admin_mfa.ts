import { DataTypes, QueryInterface } from 'sequelize';
const { STRING, BOOLEAN } = DataTypes;

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.addColumn('users', 'mfaSecret', {
    type: STRING,
    allowNull: true
  });
  await queryInterface.addColumn('users', 'mfaEnabled', {
    type: BOOLEAN,
    allowNull: false,
    defaultValue: false
  });
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.removeColumn('users', 'mfaEnabled');
  await queryInterface.removeColumn('users', 'mfaSecret');
};
