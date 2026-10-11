import { Model, DataTypes, Optional } from 'sequelize';
import { sequelize } from '../db';

const { INTEGER, STRING, DATE, TEXT } = DataTypes;

export interface Runbook {
  id: number;
  title: string;
  description: string;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunbookInstance
  extends Model<Runbook, Optional<Runbook, 'id' | 'createdAt' | 'updatedAt' | 'description'>>,
    Runbook {}

export const RunbookModel = sequelize.define<RunbookInstance>(
  'Runbook',
  {
    id: { type: INTEGER, primaryKey: true, autoIncrement: true },
    title: { type: STRING(200), allowNull: false },
    description: { type: TEXT, allowNull: false, defaultValue: '' },
    createdBy: { type: INTEGER, allowNull: true },
    createdAt: { type: DATE },
    updatedAt: { type: DATE }
  },
  { tableName: 'runbooks' }
);

export interface RunbookStep {
  id: number;
  runbookId: number;
  position: number;
  snippetId: number | null;
  title: string;
  note: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunbookStepInstance
  extends Model<RunbookStep, Optional<RunbookStep, 'id' | 'createdAt' | 'updatedAt' | 'title' | 'note'>>,
    RunbookStep {}

export const RunbookStepModel = sequelize.define<RunbookStepInstance>(
  'RunbookStep',
  {
    id: { type: INTEGER, primaryKey: true, autoIncrement: true },
    runbookId: { type: INTEGER, allowNull: false },
    position: { type: INTEGER, allowNull: false },
    snippetId: { type: INTEGER, allowNull: true },
    title: { type: STRING(200), allowNull: false, defaultValue: '' },
    note: { type: TEXT, allowNull: false, defaultValue: '' },
    createdAt: { type: DATE },
    updatedAt: { type: DATE }
  },
  { tableName: 'runbook_steps' }
);

export type RunbookRunStatus = 'in_progress' | 'completed' | 'cancelled' | 'failed' | 'attention';

export interface RunbookRun {
  id: number;
  runbookId: number | null;
  runbookTitle: string;
  siteId: number | null;
  userId: number | null;
  deviceId: number | null;
  scheduleRunId: number | null;
  status: RunbookRunStatus;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunbookRunInstance
  extends Model<RunbookRun, Optional<RunbookRun, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'completedAt' | 'deviceId' | 'scheduleRunId'>>,
    RunbookRun {}

export const RunbookRunModel = sequelize.define<RunbookRunInstance>(
  'RunbookRun',
  {
    id: { type: INTEGER, primaryKey: true, autoIncrement: true },
    runbookId: { type: INTEGER, allowNull: true },
    runbookTitle: { type: STRING(200), allowNull: false },
    siteId: { type: INTEGER, allowNull: true },
    userId: { type: INTEGER, allowNull: true },
    deviceId: { type: INTEGER, allowNull: true },
    scheduleRunId: { type: INTEGER, allowNull: true },
    status: { type: STRING(20), allowNull: false, defaultValue: 'in_progress' },
    completedAt: { type: DATE, allowNull: true },
    createdAt: { type: DATE },
    updatedAt: { type: DATE }
  },
  { tableName: 'runbook_runs' }
);

export type RunbookStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface RunbookRunStep {
  runId: number;
  stepId: number;
  status: RunbookStepStatus;
  snippetRunId: number | null;
  completedBy: number | null;
  completedAt: Date | null;
}

export interface RunbookRunStepInstance
  extends Model<RunbookRunStep, Optional<RunbookRunStep, 'status' | 'snippetRunId' | 'completedBy' | 'completedAt'>>,
    RunbookRunStep {}

export const RunbookRunStepModel = sequelize.define<RunbookRunStepInstance>(
  'RunbookRunStep',
  {
    runId: { type: INTEGER, primaryKey: true },
    stepId: { type: INTEGER, primaryKey: true },
    status: { type: STRING(20), allowNull: false, defaultValue: 'pending' },
    snippetRunId: { type: INTEGER, allowNull: true },
    completedBy: { type: INTEGER, allowNull: true },
    completedAt: { type: DATE, allowNull: true }
  },
  { tableName: 'runbook_run_steps', timestamps: false }
);
