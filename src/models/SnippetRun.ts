import { Model, DataTypes, Optional } from 'sequelize';
import { sequelize } from '../db';

const { INTEGER, STRING, DATE, TEXT, BOOLEAN } = DataTypes;

export interface SnippetRun {
  id: number;
  snippetId: number | null;
  snippetTitle: string;
  siteId: number | null;
  userId: number | null;
  runbookRunId: number | null;
  deviceId: number | null;
  deviceName: string | null;
  scheduleRunId: number | null;
  /** How a server run was isolated: 'bwrap', 'docker', or 'none' */
  sandbox: string | null;
  /** 'snippet' or 'tool' (built-in device tools) */
  kind: string;
  language: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SnippetRunInstance
  extends Model<SnippetRun, Optional<SnippetRun, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'deviceName' | 'scheduleRunId' | 'sandbox' | 'kind'>>,
    SnippetRun {}

export const SnippetRunModel = sequelize.define<SnippetRunInstance>(
  'SnippetRun',
  {
    id: { type: INTEGER, primaryKey: true, autoIncrement: true },
    snippetId: { type: INTEGER, allowNull: true },
    snippetTitle: { type: STRING(255), allowNull: false },
    siteId: { type: INTEGER, allowNull: true },
    userId: { type: INTEGER, allowNull: true },
    runbookRunId: { type: INTEGER, allowNull: true },
    deviceId: { type: INTEGER, allowNull: true },
    deviceName: { type: STRING(120), allowNull: true },
    scheduleRunId: { type: INTEGER, allowNull: true },
    sandbox: { type: STRING(20), allowNull: true },
    kind: { type: STRING(20), allowNull: false, defaultValue: 'snippet' },
    language: { type: STRING, allowNull: false },
    ok: { type: BOOLEAN, allowNull: false },
    exitCode: { type: INTEGER, allowNull: true },
    timedOut: { type: BOOLEAN, allowNull: false, defaultValue: false },
    stdout: { type: TEXT, allowNull: false, defaultValue: '' },
    stderr: { type: TEXT, allowNull: false, defaultValue: '' },
    durationMs: { type: INTEGER, allowNull: false, defaultValue: 0 },
    createdAt: { type: DATE },
    updatedAt: { type: DATE }
  },
  { tableName: 'snippet_runs' }
);
