import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';
import { Setting } from '../typescript/interfaces';

const { STRING, TEXT } = DataTypes;

export interface SettingInstance extends Model<Setting>, Setting {}

export const SettingModel = sequelize.define<SettingInstance>(
  'Setting',
  {
    key: {
      type: STRING,
      allowNull: false,
      primaryKey: true
    },
    value: {
      type: TEXT,
      allowNull: false
    }
  },
  {
    timestamps: false,
    tableName: 'settings'
  }
);
