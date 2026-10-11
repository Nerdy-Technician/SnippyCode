import { Model, DataTypes, Optional } from 'sequelize';
import { sequelize } from '../db';

const { INTEGER, STRING, DATE, TEXT, BOOLEAN } = DataTypes;

export type GithubSyncItemType = 'snippet' | 'runbook';
export type GithubSyncItemStatus = 'synced' | 'conflict' | 'deleted_local' | 'remote_missing';

export interface GithubSyncItem {
  id: number;
  itemType: GithubSyncItemType;
  itemId: number | null;
  syncId: string;
  baseHash: string | null;
  remoteSha: string | null;
  status: GithubSyncItemStatus;
  conflictItemId: number | null;
  conflictRemoteHash: string | null;
  conflictAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GithubSyncItemInstance
  extends Model<
      GithubSyncItem,
      Optional<
        GithubSyncItem,
        'id' | 'createdAt' | 'updatedAt' | 'status' | 'remoteSha' | 'conflictItemId' | 'conflictRemoteHash' | 'conflictAt'
      >
    >,
    GithubSyncItem {}

export const GithubSyncItemModel = sequelize.define<GithubSyncItemInstance>(
  'GithubSyncItem',
  {
    id: { type: INTEGER, primaryKey: true, autoIncrement: true },
    itemType: { type: STRING(10), allowNull: false },
    itemId: { type: INTEGER, allowNull: true },
    syncId: { type: STRING(40), allowNull: false },
    baseHash: { type: STRING(64), allowNull: true },
    remoteSha: { type: STRING(64), allowNull: true },
    status: { type: STRING(20), allowNull: false, defaultValue: 'synced' },
    conflictItemId: { type: INTEGER, allowNull: true },
    conflictRemoteHash: { type: STRING(64), allowNull: true },
    conflictAt: { type: DATE, allowNull: true },
    createdAt: { type: DATE },
    updatedAt: { type: DATE }
  },
  { tableName: 'github_sync_items' }
);

export type GithubSyncRunStatus = 'running' | 'success' | 'skipped' | 'failed' | 'abandoned';

export interface GithubSyncRun {
  id: number;
  trigger: 'schedule' | 'manual';
  status: GithubSyncRunStatus;
  uploaded: number;
  downloaded: number;
  conflicts: number;
  unchanged: number;
  backup: string | null;
  error: string | null;
  dryRun: boolean;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface GithubSyncRunInstance
  extends Model<
      GithubSyncRun,
      Optional<
        GithubSyncRun,
        'id' | 'status' | 'uploaded' | 'downloaded' | 'conflicts' | 'unchanged' | 'backup' | 'error' | 'dryRun' | 'finishedAt'
      >
    >,
    GithubSyncRun {}

export const GithubSyncRunModel = sequelize.define<GithubSyncRunInstance>(
  'GithubSyncRun',
  {
    id: { type: INTEGER, primaryKey: true, autoIncrement: true },
    trigger: { type: STRING(10), allowNull: false, defaultValue: 'schedule' },
    status: { type: STRING(12), allowNull: false, defaultValue: 'running' },
    uploaded: { type: INTEGER, allowNull: false, defaultValue: 0 },
    downloaded: { type: INTEGER, allowNull: false, defaultValue: 0 },
    conflicts: { type: INTEGER, allowNull: false, defaultValue: 0 },
    unchanged: { type: INTEGER, allowNull: false, defaultValue: 0 },
    backup: { type: STRING(200), allowNull: true },
    error: { type: TEXT, allowNull: true },
    dryRun: { type: BOOLEAN, allowNull: false, defaultValue: false },
    startedAt: { type: DATE, allowNull: false },
    finishedAt: { type: DATE, allowNull: true }
  },
  { tableName: 'github_sync_runs', timestamps: false }
);
