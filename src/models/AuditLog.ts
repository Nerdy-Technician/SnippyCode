import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';
import { AuditLog, AuditLogCreationAttributes } from '../typescript/interfaces';

const { INTEGER, STRING, TEXT, DATE } = DataTypes;

export interface AuditLogInstance
  extends Model<AuditLog, AuditLogCreationAttributes>,
    AuditLog {}

export const AuditLogModel = sequelize.define<AuditLogInstance>(
  'AuditLog',
  {
    id: {
      type: INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    userId: {
      type: INTEGER,
      allowNull: true
    },
    action: {
      type: STRING,
      allowNull: false
    },
    target: {
      type: STRING,
      allowNull: true
    },
    ipAddress: {
      type: STRING,
      allowNull: true
    },
    metadata: {
      type: TEXT,
      allowNull: false,
      defaultValue: '{}'
    },
    createdAt: {
      type: DATE
    },
    updatedAt: {
      type: DATE
    }
  },
  {
    tableName: 'audit_logs'
  }
);
