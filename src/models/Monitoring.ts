import { Model, DataTypes, Optional } from 'sequelize';
import { sequelize } from '../db';

const { INTEGER, STRING, DATE, TEXT, BOOLEAN, FLOAT } = DataTypes;

const id = { type: INTEGER, primaryKey: true, autoIncrement: true };
const stamps = { createdAt: { type: DATE }, updatedAt: { type: DATE } };

type Stamps = { createdAt: Date; updatedAt: Date };

export interface Policy extends Stamps {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  scope: string;
  settings: string;
  lastPatchAt: Date | null;
  nextPatchAt: Date | null;
  createdBy: number | null;
}

export interface PolicyInstance
  extends Model<Policy, Optional<Policy, 'id' | 'createdAt' | 'updatedAt' | 'description' | 'lastPatchAt' | 'nextPatchAt' | 'createdBy'>>,
    Policy {}

export const PolicyModel = sequelize.define<PolicyInstance>(
  'Policy',
  {
    id,
    name: { type: STRING(120), allowNull: false },
    description: { type: TEXT, allowNull: false, defaultValue: '' },
    enabled: { type: BOOLEAN, allowNull: false, defaultValue: true },
    scope: { type: TEXT, allowNull: false, defaultValue: '{}' },
    settings: { type: TEXT, allowNull: false, defaultValue: '{}' },
    lastPatchAt: { type: DATE, allowNull: true },
    nextPatchAt: { type: DATE, allowNull: true },
    createdBy: { type: INTEGER, allowNull: true },
    ...stamps
  },
  { tableName: 'policies' }
);

export type MonitorType =
  | 'offline'
  | 'disk'
  | 'memory'
  | 'cpu'
  | 'service'
  | 'process'
  | 'failed_units'
  | 'reboot'
  | 'updates';

export interface PolicyMonitor extends Stamps {
  id: number;
  policyId: number;
  type: MonitorType;
  params: string;
  severity: 'warning' | 'critical';
  enabled: boolean;
}

export interface PolicyMonitorInstance
  extends Model<PolicyMonitor, Optional<PolicyMonitor, 'id' | 'createdAt' | 'updatedAt'>>,
    PolicyMonitor {}

export const PolicyMonitorModel = sequelize.define<PolicyMonitorInstance>(
  'PolicyMonitor',
  {
    id,
    policyId: { type: INTEGER, allowNull: false },
    type: { type: STRING(30), allowNull: false },
    params: { type: TEXT, allowNull: false, defaultValue: '{}' },
    severity: { type: STRING(10), allowNull: false, defaultValue: 'warning' },
    enabled: { type: BOOLEAN, allowNull: false, defaultValue: true },
    ...stamps
  },
  { tableName: 'policy_monitors' }
);

export type AlertStatus = 'open' | 'acknowledged' | 'resolved';

export interface Alert extends Stamps {
  id: number;
  deviceId: number;
  siteId: number | null;
  policyId: number | null;
  monitorId: number | null;
  type: string;
  severity: 'warning' | 'critical';
  title: string;
  detail: string;
  status: AlertStatus;
  occurrences: number;
  lastSeenAt: Date;
  snoozedUntil: Date | null;
  acknowledgedBy: number | null;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  resolvedBy: number | null;
  autoResolved: boolean;
}

export interface AlertInstance
  extends Model<
      Alert,
      Optional<
        Alert,
        | 'id'
        | 'createdAt'
        | 'updatedAt'
        | 'detail'
        | 'status'
        | 'occurrences'
        | 'snoozedUntil'
        | 'acknowledgedBy'
        | 'acknowledgedAt'
        | 'resolvedAt'
        | 'resolvedBy'
        | 'autoResolved'
      >
    >,
    Alert {}

export const AlertModel = sequelize.define<AlertInstance>(
  'Alert',
  {
    id,
    deviceId: { type: INTEGER, allowNull: false },
    siteId: { type: INTEGER, allowNull: true },
    policyId: { type: INTEGER, allowNull: true },
    monitorId: { type: INTEGER, allowNull: true },
    type: { type: STRING(30), allowNull: false },
    severity: { type: STRING(10), allowNull: false },
    title: { type: STRING(255), allowNull: false },
    detail: { type: TEXT, allowNull: false, defaultValue: '' },
    status: { type: STRING(20), allowNull: false, defaultValue: 'open' },
    occurrences: { type: INTEGER, allowNull: false, defaultValue: 1 },
    lastSeenAt: { type: DATE, allowNull: false },
    snoozedUntil: { type: DATE, allowNull: true },
    acknowledgedBy: { type: INTEGER, allowNull: true },
    acknowledgedAt: { type: DATE, allowNull: true },
    resolvedAt: { type: DATE, allowNull: true },
    resolvedBy: { type: INTEGER, allowNull: true },
    autoResolved: { type: BOOLEAN, allowNull: false, defaultValue: false },
    ...stamps
  },
  { tableName: 'alerts' }
);

export interface DeviceMetric {
  id: number;
  deviceId: number;
  at: Date;
  online: boolean;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
}

export interface DeviceMetricInstance
  extends Model<DeviceMetric, Optional<DeviceMetric, 'id' | 'cpu' | 'memory' | 'disk'>>,
    DeviceMetric {}

export const DeviceMetricModel = sequelize.define<DeviceMetricInstance>(
  'DeviceMetric',
  {
    id,
    deviceId: { type: INTEGER, allowNull: false },
    at: { type: DATE, allowNull: false },
    online: { type: BOOLEAN, allowNull: false, defaultValue: true },
    cpu: { type: FLOAT, allowNull: true },
    memory: { type: FLOAT, allowNull: true },
    disk: { type: FLOAT, allowNull: true }
  },
  { tableName: 'device_metrics', timestamps: false }
);
