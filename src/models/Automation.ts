import { Model, DataTypes, Optional } from 'sequelize';
import { sequelize } from '../db';

const { INTEGER, STRING, DATE, TEXT, BOOLEAN } = DataTypes;

const id = { type: INTEGER, primaryKey: true, autoIncrement: true };
const stamps = { createdAt: { type: DATE }, updatedAt: { type: DATE } };

type Stamps = { createdAt: Date; updatedAt: Date };

// Devices ------------------------------------------------------------------

export interface Device extends Stamps {
  id: number;
  siteId: number;
  name: string;
  hostname: string;
  os: string;
  arch: string;
  agentVersion: string;
  capabilities: string;
  tokenHash: string;
  tokenPrefix: string;
  lastSeenAt: Date | null;
  lastIp: string | null;
  offlineNotifiedAt: Date | null;
  revokedAt: Date | null;
  /** JSON object of system facts reported by the agent */
  facts: string;
  factsAt: Date | null;
  /** JSON: { [tool]: { at, data } } from the latest read-only tool runs */
  inventory: string;
  /** JSON: asset tag, owner, warranty, notes and custom fields */
  fields: string;
  /** JSON: remote access details; the password is stored encrypted */
  remote: string;
}

export interface DeviceInstance
  extends Model<
      Device,
      Optional<
        Device,
        | 'id'
        | 'createdAt'
        | 'updatedAt'
        | 'hostname'
        | 'os'
        | 'arch'
        | 'agentVersion'
        | 'capabilities'
        | 'lastSeenAt'
        | 'lastIp'
        | 'offlineNotifiedAt'
        | 'revokedAt'
        | 'facts'
        | 'factsAt'
        | 'inventory'
        | 'fields'
        | 'remote'
      >
    >,
    Device {}

export const DeviceModel = sequelize.define<DeviceInstance>(
  'Device',
  {
    id,
    siteId: { type: INTEGER, allowNull: false },
    name: { type: STRING(120), allowNull: false },
    hostname: { type: STRING(255), allowNull: false, defaultValue: '' },
    os: { type: STRING(40), allowNull: false, defaultValue: '' },
    arch: { type: STRING(40), allowNull: false, defaultValue: '' },
    agentVersion: { type: STRING(40), allowNull: false, defaultValue: '' },
    capabilities: { type: TEXT, allowNull: false, defaultValue: '' },
    tokenHash: { type: STRING, allowNull: false },
    tokenPrefix: { type: STRING(20), allowNull: false },
    lastSeenAt: { type: DATE, allowNull: true },
    lastIp: { type: STRING(80), allowNull: true },
    offlineNotifiedAt: { type: DATE, allowNull: true },
    revokedAt: { type: DATE, allowNull: true },
    facts: { type: TEXT, allowNull: false, defaultValue: '{}' },
    factsAt: { type: DATE, allowNull: true },
    inventory: { type: TEXT, allowNull: false, defaultValue: '{}' },
    fields: { type: TEXT, allowNull: false, defaultValue: '{}' },
    remote: { type: TEXT, allowNull: false, defaultValue: '{}' },
    ...stamps
  },
  { tableName: 'devices' }
);

export interface DeviceEnrollment extends Stamps {
  id: number;
  siteId: number;
  tokenHash: string;
  tokenPrefix: string;
  expiresAt: Date;
  maxUses: number;
  uses: number;
  createdBy: number | null;
}

export interface DeviceEnrollmentInstance
  extends Model<DeviceEnrollment, Optional<DeviceEnrollment, 'id' | 'createdAt' | 'updatedAt' | 'uses'>>,
    DeviceEnrollment {}

export const DeviceEnrollmentModel = sequelize.define<DeviceEnrollmentInstance>(
  'DeviceEnrollment',
  {
    id,
    siteId: { type: INTEGER, allowNull: false },
    tokenHash: { type: STRING, allowNull: false },
    tokenPrefix: { type: STRING(20), allowNull: false },
    expiresAt: { type: DATE, allowNull: false },
    maxUses: { type: INTEGER, allowNull: false, defaultValue: 1 },
    uses: { type: INTEGER, allowNull: false, defaultValue: 0 },
    createdBy: { type: INTEGER, allowNull: true },
    ...stamps
  },
  { tableName: 'device_enrollments' }
);

// Agent jobs ---------------------------------------------------------------

export type AgentJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'expired';

export interface AgentJob extends Stamps {
  id: number;
  deviceId: number;
  snippetId: number | null;
  snippetTitle: string;
  siteId: number | null;
  userId: number | null;
  language: string;
  payload: string;
  secretValues: string;
  status: AgentJobStatus;
  timeoutMs: number;
  runbookRunId: number | null;
  runbookStepId: number | null;
  scheduleRunId: number | null;
  snippetRunId: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  kind: 'snippet' | 'tool';
  tool: string | null;
}

export interface AgentJobInstance
  extends Model<
      AgentJob,
      Optional<
        AgentJob,
        | 'id'
        | 'createdAt'
        | 'updatedAt'
        | 'secretValues'
        | 'status'
        | 'runbookRunId'
        | 'runbookStepId'
        | 'scheduleRunId'
        | 'snippetRunId'
        | 'startedAt'
        | 'finishedAt'
        | 'kind'
        | 'tool'
      >
    >,
    AgentJob {}

export const AgentJobModel = sequelize.define<AgentJobInstance>(
  'AgentJob',
  {
    id,
    deviceId: { type: INTEGER, allowNull: false },
    snippetId: { type: INTEGER, allowNull: true },
    snippetTitle: { type: STRING(255), allowNull: false },
    siteId: { type: INTEGER, allowNull: true },
    userId: { type: INTEGER, allowNull: true },
    language: { type: STRING(40), allowNull: false },
    payload: { type: TEXT, allowNull: false },
    secretValues: { type: TEXT, allowNull: false, defaultValue: '' },
    status: { type: STRING(20), allowNull: false, defaultValue: 'queued' },
    timeoutMs: { type: INTEGER, allowNull: false },
    runbookRunId: { type: INTEGER, allowNull: true },
    runbookStepId: { type: INTEGER, allowNull: true },
    scheduleRunId: { type: INTEGER, allowNull: true },
    snippetRunId: { type: INTEGER, allowNull: true },
    startedAt: { type: DATE, allowNull: true },
    finishedAt: { type: DATE, allowNull: true },
    kind: { type: STRING(20), allowNull: false, defaultValue: 'snippet' },
    tool: { type: STRING(40), allowNull: true },
    ...stamps
  },
  { tableName: 'agent_jobs' }
);

// Schedules ----------------------------------------------------------------

export type ScheduleSiteMode = 'none' | 'sites' | 'tag' | 'all' | 'policy';

export interface Schedule extends Stamps {
  id: number;
  name: string;
  targetType: 'snippet' | 'runbook';
  snippetId: number | null;
  runbookId: number | null;
  cron: string;
  timezone: string;
  siteMode: ScheduleSiteMode;
  siteIds: string;
  siteTag: string;
  runOn: 'server' | 'devices';
  notifyOn: 'failure' | 'always' | 'never';
  enabled: boolean;
  createdBy: number | null;
  lastRunAt: Date | null;
  lastStatus: string | null;
  nextRunAt: Date | null;
  policyId: number | null;
}

export interface ScheduleInstance
  extends Model<
      Schedule,
      Optional<
        Schedule,
        'id' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'lastStatus' | 'nextRunAt' | 'createdBy' | 'policyId'
      >
    >,
    Schedule {}

export const ScheduleModel = sequelize.define<ScheduleInstance>(
  'Schedule',
  {
    id,
    name: { type: STRING(200), allowNull: false },
    targetType: { type: STRING(20), allowNull: false },
    snippetId: { type: INTEGER, allowNull: true },
    runbookId: { type: INTEGER, allowNull: true },
    cron: { type: STRING(120), allowNull: false },
    timezone: { type: STRING(64), allowNull: false, defaultValue: 'UTC' },
    siteMode: { type: STRING(10), allowNull: false, defaultValue: 'none' },
    siteIds: { type: TEXT, allowNull: false, defaultValue: '' },
    siteTag: { type: STRING(60), allowNull: false, defaultValue: '' },
    runOn: { type: STRING(10), allowNull: false, defaultValue: 'server' },
    notifyOn: { type: STRING(10), allowNull: false, defaultValue: 'failure' },
    enabled: { type: BOOLEAN, allowNull: false, defaultValue: true },
    createdBy: { type: INTEGER, allowNull: true },
    lastRunAt: { type: DATE, allowNull: true },
    lastStatus: { type: STRING(20), allowNull: true },
    nextRunAt: { type: DATE, allowNull: true },
    policyId: { type: INTEGER, allowNull: true },
    ...stamps
  },
  { tableName: 'schedules' }
);

export type ScheduleRunStatus = 'running' | 'succeeded' | 'failed' | 'attention';

export interface ScheduleRun extends Stamps {
  id: number;
  scheduleId: number;
  scheduleName: string;
  status: ScheduleRunStatus;
  trigger: 'schedule' | 'manual';
  triggeredBy: number | null;
  finishedAt: Date | null;
}

export interface ScheduleRunInstance
  extends Model<
      ScheduleRun,
      Optional<ScheduleRun, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'triggeredBy' | 'finishedAt'>
    >,
    ScheduleRun {}

export const ScheduleRunModel = sequelize.define<ScheduleRunInstance>(
  'ScheduleRun',
  {
    id,
    scheduleId: { type: INTEGER, allowNull: false },
    scheduleName: { type: STRING(200), allowNull: false },
    status: { type: STRING(20), allowNull: false, defaultValue: 'running' },
    trigger: { type: STRING(20), allowNull: false, defaultValue: 'schedule' },
    triggeredBy: { type: INTEGER, allowNull: true },
    finishedAt: { type: DATE, allowNull: true },
    ...stamps
  },
  { tableName: 'schedule_runs' }
);

// Webhooks -----------------------------------------------------------------

export type WebhookType = 'slack' | 'teams' | 'discord' | 'webhook';

export interface Webhook extends Stamps {
  id: number;
  name: string;
  type: WebhookType;
  url: string;
  signingSecret: string;
  events: string;
  siteIds: string;
  enabled: boolean;
  lastStatus: string | null;
  lastError: string | null;
  lastDeliveredAt: Date | null;
}

export interface WebhookInstance
  extends Model<
      Webhook,
      Optional<
        Webhook,
        'id' | 'createdAt' | 'updatedAt' | 'signingSecret' | 'siteIds' | 'lastStatus' | 'lastError' | 'lastDeliveredAt'
      >
    >,
    Webhook {}

export const WebhookModel = sequelize.define<WebhookInstance>(
  'Webhook',
  {
    id,
    name: { type: STRING(120), allowNull: false },
    type: { type: STRING(20), allowNull: false },
    url: { type: TEXT, allowNull: false },
    signingSecret: { type: TEXT, allowNull: false, defaultValue: '' },
    events: { type: TEXT, allowNull: false, defaultValue: '' },
    siteIds: { type: TEXT, allowNull: false, defaultValue: '' },
    enabled: { type: BOOLEAN, allowNull: false, defaultValue: true },
    lastStatus: { type: STRING(20), allowNull: true },
    lastError: { type: TEXT, allowNull: true },
    lastDeliveredAt: { type: DATE, allowNull: true },
    ...stamps
  },
  { tableName: 'webhooks' }
);

export interface WebhookDelivery extends Stamps {
  id: number;
  webhookId: number;
  event: string;
  title: string;
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  attempts: number;
}

export interface WebhookDeliveryInstance
  extends Model<WebhookDelivery, Optional<WebhookDelivery, 'id' | 'createdAt' | 'updatedAt' | 'statusCode' | 'error'>>,
    WebhookDelivery {}

export const WebhookDeliveryModel = sequelize.define<WebhookDeliveryInstance>(
  'WebhookDelivery',
  {
    id,
    webhookId: { type: INTEGER, allowNull: false },
    event: { type: STRING(60), allowNull: false },
    title: { type: STRING(255), allowNull: false, defaultValue: '' },
    ok: { type: BOOLEAN, allowNull: false },
    statusCode: { type: INTEGER, allowNull: true },
    error: { type: TEXT, allowNull: true },
    attempts: { type: INTEGER, allowNull: false, defaultValue: 1 },
    ...stamps
  },
  { tableName: 'webhook_deliveries' }
);
