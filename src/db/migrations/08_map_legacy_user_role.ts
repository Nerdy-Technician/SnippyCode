import { DataTypes, QueryInterface } from 'sequelize';

const { STRING } = DataTypes;

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.sequelize.query(
    `UPDATE users SET role = 'editor' WHERE role = 'user' AND "isOwner" = false`
  );
  await queryInterface.changeColumn('users', 'role', {
    type: STRING,
    allowNull: false,
    defaultValue: 'editor'
  });
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.changeColumn('users', 'role', {
    type: STRING,
    allowNull: false,
    defaultValue: 'user'
  });
};
