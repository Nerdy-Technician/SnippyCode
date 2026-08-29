import { DataTypes, QueryInterface } from 'sequelize';

const { BOOLEAN } = DataTypes;

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.addColumn('snippets', 'isPublic', {
    type: BOOLEAN,
    allowNull: false,
    defaultValue: false
  });
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.removeColumn('snippets', 'isPublic');
};
