import { DataTypes, QueryInterface } from 'sequelize';
const { INTEGER, STRING, DATE, TEXT } = DataTypes;

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.createTable('tasks', {
    id: {
      type: INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true
    },
    title: {
      type: STRING,
      allowNull: false
    },
    description: {
      type: TEXT,
      allowNull: false,
      defaultValue: ''
    },
    status: {
      type: STRING,
      allowNull: false,
      defaultValue: 'todo'
    },
    priority: {
      type: STRING,
      allowNull: false,
      defaultValue: 'medium'
    },
    dueDate: {
      type: DATE,
      allowNull: true
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
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.dropTable('tasks');
};
