import { Model, DataTypes, Optional } from 'sequelize';
import { sequelize } from '../db';

const { INTEGER, STRING, DATE, TEXT } = DataTypes;

export type RunApprovalKind = 'snippet' | 'runbook' | 'schedule';
export type RunApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'failed' | 'stale';

export interface RunApproval {
  id: number;
  kind: RunApprovalKind;
  snippetId: number | null;
  runbookId: number | null;
  scheduleId: number | null;
  scheduleRunId: number | null;
  title: string;
  requestedBy: number | null;
  trigger: 'manual' | 'schedule';
  reason: string;
  why: string;
  siteId: number | null;
  targets: string;
  targetCount: number;
  payload: string;
  status: RunApprovalStatus;
  decidedBy: number | null;
  decisionComment: string;
  decidedAt: Date | null;
  expiresAt: Date;
  result: string;
  contentHash: string;
  contentPreview: string;
  siteIds: string;
  excludedApprovers: string;
  createdAt: Date;
  updatedAt: Date;
}

type Defaults =
  | 'id' | 'createdAt' | 'updatedAt' | 'snippetId' | 'runbookId' | 'scheduleId' | 'scheduleRunId'
  | 'title' | 'requestedBy' | 'trigger' | 'reason' | 'why' | 'siteId' | 'targets' | 'targetCount'
  | 'payload' | 'status' | 'decidedBy' | 'decisionComment' | 'decidedAt' | 'result'
  | 'contentHash' | 'contentPreview' | 'siteIds' | 'excludedApprovers';

export interface RunApprovalInstance extends Model<RunApproval, Optional<RunApproval, Defaults>>, RunApproval {}

export const RunApprovalModel = sequelize.define<RunApprovalInstance>(
  'RunApproval',
  {
    id: { type: INTEGER, primaryKey: true, autoIncrement: true },
    kind: { type: STRING(10), allowNull: false },
    snippetId: { type: INTEGER, allowNull: true },
    runbookId: { type: INTEGER, allowNull: true },
    scheduleId: { type: INTEGER, allowNull: true },
    scheduleRunId: { type: INTEGER, allowNull: true },
    title: { type: STRING(200), allowNull: false, defaultValue: '' },
    requestedBy: { type: INTEGER, allowNull: true },
    trigger: { type: STRING(10), allowNull: false, defaultValue: 'manual' },
    reason: { type: TEXT, allowNull: false, defaultValue: '' },
    why: { type: STRING(60), allowNull: false, defaultValue: '' },
    siteId: { type: INTEGER, allowNull: true },
    targets: { type: TEXT, allowNull: false, defaultValue: '[]' },
    targetCount: { type: INTEGER, allowNull: false, defaultValue: 0 },
    payload: { type: TEXT, allowNull: false, defaultValue: '' },
    status: { type: STRING(10), allowNull: false, defaultValue: 'pending' },
    decidedBy: { type: INTEGER, allowNull: true },
    decisionComment: { type: TEXT, allowNull: false, defaultValue: '' },
    decidedAt: { type: DATE, allowNull: true },
    expiresAt: { type: DATE, allowNull: false },
    result: { type: TEXT, allowNull: false, defaultValue: '' },
    contentHash: { type: STRING(64), allowNull: false, defaultValue: '' },
    contentPreview: { type: TEXT, allowNull: false, defaultValue: '' },
    siteIds: { type: TEXT, allowNull: false, defaultValue: '' },
    excludedApprovers: { type: TEXT, allowNull: false, defaultValue: '' },
    createdAt: { type: DATE },
    updatedAt: { type: DATE }
  },
  { tableName: 'run_approvals' }
);
