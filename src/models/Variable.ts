import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';
import { Variable, VariableCreationAttributes } from '../typescript/interfaces';

const { INTEGER, STRING, DATE, TEXT, BOOLEAN } = DataTypes;

export interface VariableInstance
  extends Model<Variable, VariableCreationAttributes>,
    Variable {}

export const VariableModel = sequelize.define<VariableInstance>(
  'Variable',
  {
    id: {
      type: INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: STRING(64),
      allowNull: false
    },
    value: {
      type: TEXT,
      allowNull: false,
      defaultValue: ''
    },
    description: {
      type: TEXT,
      allowNull: false,
      defaultValue: ''
    },
    userId: {
      type: INTEGER,
      allowNull: true
    },
    siteId: {
      type: INTEGER,
      allowNull: true
    },
    // Secret values are stored encrypted (see utils/secretBox)
    isSecret: {
      type: BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    createdAt: {
      type: DATE
    },
    updatedAt: {
      type: DATE
    }
  },
  {
    tableName: 'variables'
  }
);
