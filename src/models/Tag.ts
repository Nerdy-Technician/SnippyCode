import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';
import { Tag, TagCreationAttributes } from '../typescript/interfaces';

const { INTEGER, STRING } = DataTypes;

export interface TagInstance extends Model<Tag, TagCreationAttributes>, Tag {}

export const TagModel = sequelize.define<TagInstance>(
  'Tag',
  {
    id: {
      type: INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: STRING,
      allowNull: false,
      unique: true
    },
    color: {
      type: STRING(7),
      allowNull: true
    }
  },
  {
    timestamps: false,
    tableName: 'tags'
  }
);

/** Devices <-> shared tags */
export interface DeviceTag {
  deviceId: number;
  tagId: number;
}

export interface DeviceTagInstance extends Model<DeviceTag, DeviceTag>, DeviceTag {}

export const DeviceTagModel = sequelize.define<DeviceTagInstance>(
  'DeviceTag',
  {
    deviceId: { type: INTEGER, primaryKey: true, allowNull: false },
    tagId: { type: INTEGER, primaryKey: true, allowNull: false }
  },
  { timestamps: false, tableName: 'device_tags' }
);
