import { DataTypes, QueryInterface } from 'sequelize';

const { BOOLEAN, DATE, INTEGER, STRING, TEXT } = DataTypes;

/**
 * Approval for risky runs: a "dangerous" flag on snippets and runbooks, and
 * approval requests that hold a run until an admin signs it off.
 */
export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.addColumn('snippets', 'dangerous', { type: BOOLEAN, allowNull: false, defaultValue: false });
  await queryInterface.addColumn('runbooks', 'dangerous', { type: BOOLEAN, allowNull: false, defaultValue: false });

  await queryInterface.createTable('run_approvals', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    // snippet | runbook | schedule
    kind: { type: STRING(10), allowNull: false },
    snippetId: { type: INTEGER, allowNull: true },
    runbookId: { type: INTEGER, allowNull: true },
    scheduleId: { type: INTEGER, allowNull: true },
    scheduleRunId: { type: INTEGER, allowNull: true },
    title: { type: STRING(200), allowNull: false, defaultValue: '' },
    requestedBy: { type: INTEGER, allowNull: true },
    // manual | schedule
    trigger: { type: STRING(10), allowNull: false, defaultValue: 'manual' },
    reason: { type: TEXT, allowNull: false, defaultValue: '' },
    // dangerous,large
    why: { type: STRING(60), allowNull: false, defaultValue: '' },
    siteId: { type: INTEGER, allowNull: true },
    // JSON: [{ type, id, name }]
    targets: { type: TEXT, allowNull: false, defaultValue: '[]' },
    targetCount: { type: INTEGER, allowNull: false, defaultValue: 0 },
    // Encrypted request to replay once approved
    payload: { type: TEXT, allowNull: false, defaultValue: '' },
    // pending | approved | denied | expired | failed
    status: { type: STRING(10), allowNull: false, defaultValue: 'pending' },
    decidedBy: { type: INTEGER, allowNull: true },
    decisionComment: { type: TEXT, allowNull: false, defaultValue: '' },
    decidedAt: { type: DATE, allowNull: true },
    expiresAt: { type: DATE, allowNull: false },
    result: { type: TEXT, allowNull: false, defaultValue: '' },
    // sha256 of exactly what was asked for (code, values, resolved targets);
    // the run is refused at execution if it no longer matches
    contentHash: { type: STRING(64), allowNull: false, defaultValue: '' },
    // What the approver reads: code / steps (placeholders, never values)
    contentPreview: { type: TEXT, allowNull: false, defaultValue: '' },
    // Every site the run reaches, for approver scoping ("1,4")
    siteIds: { type: TEXT, allowNull: false, defaultValue: '' },
    // Users who may not decide it besides the requester (schedule owner/editor)
    excludedApprovers: { type: TEXT, allowNull: false, defaultValue: '' },
    createdAt: { type: DATE, allowNull: false },
    updatedAt: { type: DATE, allowNull: false }
  });
  await queryInterface.addIndex('run_approvals', ['status', 'expiresAt']);
  await queryInterface.addIndex('run_approvals', ['scheduleId', 'status']);
  // Last editor of a schedule: their scheduled runs count as their request
  await queryInterface.addColumn('schedules', 'updatedBy', { type: INTEGER, allowNull: true });
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.removeColumn('schedules', 'updatedBy');
  await queryInterface.dropTable('run_approvals');
  await queryInterface.removeColumn('runbooks', 'dangerous');
  await queryInterface.removeColumn('snippets', 'dangerous');
};
