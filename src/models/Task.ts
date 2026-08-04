import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';
import { Task, TaskCreationAttributes } from '../typescript/interfaces';

const { INTEGER, STRING, DATE, TEXT } = DataTypes;

export interface TaskInstance extends Model<Task, TaskCreationAttributes>, Task {}

export const TaskModel = sequelize.define<TaskInstance>(
  'Task',
  {
    id: {
      type: INTEGER,
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
      type: DATE
    },
    updatedAt: {
      type: DATE
    }
  },
  {
    tableName: 'tasks'
  }
);
