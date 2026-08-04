import { DataTypes, QueryInterface } from 'sequelize';
const { INTEGER, STRING, DATE, TEXT, BOOLEAN } = DataTypes;

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.createTable('users', {
    id: {
      type: INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true
    },
    email: {
      type: STRING,
      allowNull: false,
      unique: true
    },
    displayName: {
      type: STRING,
      allowNull: false
    },
    passwordHash: {
      type: STRING,
      allowNull: true
    },
    oidcSubject: {
      type: STRING,
      allowNull: true,
      unique: true
    },
    avatarPath: {
      type: STRING,
      allowNull: true
    },
    isOwner: {
      type: BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    createdAt: {
      type: DATE,
      allowNull: false
    },
    updatedAt: {
      type: DATE,
      allowNull: false
    }
  });

  await queryInterface.createTable('settings', {
    key: {
      type: STRING,
      allowNull: false,
      primaryKey: true
    },
    value: {
      type: TEXT,
      allowNull: false
    }
  });
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.dropTable('settings');
  await queryInterface.dropTable('users');
};
