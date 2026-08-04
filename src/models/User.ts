import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';
import { User, UserCreationAttributes } from '../typescript/interfaces';

const { INTEGER, STRING, BOOLEAN, DATE } = DataTypes;

export interface UserInstance extends Model<User, UserCreationAttributes>, User {}

export const UserModel = sequelize.define<UserInstance>(
  'User',
  {
    id: {
      type: INTEGER,
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
    role: {
      type: STRING,
      allowNull: false,
      defaultValue: 'user'
    },
    mfaSecret: {
      type: STRING,
      allowNull: true
    },
    mfaEnabled: {
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
    tableName: 'users'
  }
);
