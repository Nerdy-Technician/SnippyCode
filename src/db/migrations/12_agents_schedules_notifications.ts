import { DataTypes, QueryInterface } from 'sequelize';

const { INTEGER, STRING, DATE, TEXT, BOOLEAN } = DataTypes;

const timestamps = {
  createdAt: { type: DATE, allowNull: false },
  updatedAt: { type: DATE, allowNull: false }
};

const ref = (model: string, onDelete: 'CASCADE' | 'SET NULL', allowNull = true) => ({
  type: INTEGER,
  allowNull,
  references: { model, key: 'id' },
  onDelete
});

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  // Devices run the SnippyCode agent and belong to one site
  await queryInterface.createTable('devices', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    siteId: ref('sites', 'CASCADE', false),
    name: { type: STRING(120), allowNull: false },
    hostname: { type: STRING(255), allowNull: false, defaultValue: '' },
    os: { type: STRING(40), allowNull: false, defaultValue: '' },
    arch: { type: STRING(40), allowNull: false, defaultValue: '' },
    agentVersion: { type: STRING(40), allowNull: false, defaultValue: '' },
    // Interpreters the agent found, comma separated
    capabilities: { type: TEXT, allowNull: false, defaultValue: '' },
    tokenHash: { type: STRING, allowNull: false },
    tokenPrefix: { type: STRING(20), allowNull: false },
    lastSeenAt: { type: DATE, allowNull: true },
    lastIp: { type: STRING(80), allowNull: true },
    offlineNotifiedAt: { type: DATE, allowNull: true },
    revokedAt: { type: DATE, allowNull: true },
    ...timestamps
  });

  await queryInterface.createTable('device_enrollments', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    siteId: ref('sites', 'CASCADE', false),
    tokenHash: { type: STRING, allowNull: false },
    tokenPrefix: { type: STRING(20), allowNull: false },
    expiresAt: { type: DATE, allowNull: false },
    maxUses: { type: INTEGER, allowNull: false, defaultValue: 1 },
    uses: { type: INTEGER, allowNull: false, defaultValue: 0 },
    createdBy: ref('users', 'SET NULL'),
    ...timestamps
  });

  // Schedules run a snippet or runbook on a cron timetable
  await queryInterface.createTable('schedules', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    name: { type: STRING(200), allowNull: false },
    targetType: { type: STRING(20), allowNull: false },
    snippetId: ref('snippets', 'CASCADE'),
    runbookId: ref('runbooks', 'CASCADE'),
    cron: { type: STRING(120), allowNull: false },
    timezone: { type: STRING(64), allowNull: false, defaultValue: 'UTC' },
    // 'none', 'sites', 'tag', or 'all'
    siteMode: { type: STRING(10), allowNull: false, defaultValue: 'none' },
    siteIds: { type: TEXT, allowNull: false, defaultValue: '' },
    siteTag: { type: STRING(60), allowNull: false, defaultValue: '' },
    // 'server' or 'devices'
    runOn: { type: STRING(10), allowNull: false, defaultValue: 'server' },
    // 'failure', 'always', or 'never'
    notifyOn: { type: STRING(10), allowNull: false, defaultValue: 'failure' },
    enabled: { type: BOOLEAN, allowNull: false, defaultValue: true },
    createdBy: ref('users', 'SET NULL'),
    lastRunAt: { type: DATE, allowNull: true },
    lastStatus: { type: STRING(20), allowNull: true },
    nextRunAt: { type: DATE, allowNull: true },
    ...timestamps
  });

  await queryInterface.createTable('schedule_runs', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    scheduleId: ref('schedules', 'CASCADE', false),
    scheduleName: { type: STRING(200), allowNull: false },
    // 'running', 'succeeded', 'failed', or 'attention'
    status: { type: STRING(20), allowNull: false, defaultValue: 'running' },
    trigger: { type: STRING(20), allowNull: false, defaultValue: 'schedule' },
    triggeredBy: ref('users', 'SET NULL'),
    finishedAt: { type: DATE, allowNull: true },
    ...timestamps
  });

  // Work queued for agents. Code and secret values are stored encrypted.
  await queryInterface.createTable('agent_jobs', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    deviceId: ref('devices', 'CASCADE', false),
    snippetId: ref('snippets', 'SET NULL'),
    snippetTitle: { type: STRING(255), allowNull: false },
    siteId: ref('sites', 'CASCADE'),
    userId: ref('users', 'SET NULL'),
    language: { type: STRING(40), allowNull: false },
    payload: { type: TEXT, allowNull: false },
    secretValues: { type: TEXT, allowNull: false, defaultValue: '' },
    // 'queued', 'running', 'done', 'failed', or 'expired'
    status: { type: STRING(20), allowNull: false, defaultValue: 'queued' },
    timeoutMs: { type: INTEGER, allowNull: false },
    runbookRunId: ref('runbook_runs', 'SET NULL'),
    runbookStepId: ref('runbook_steps', 'SET NULL'),
    scheduleRunId: ref('schedule_runs', 'SET NULL'),
    snippetRunId: ref('snippet_runs', 'SET NULL'),
    startedAt: { type: DATE, allowNull: true },
    finishedAt: { type: DATE, allowNull: true },
    ...timestamps
  });
  await queryInterface.addIndex('agent_jobs', ['deviceId', 'status']);

  await queryInterface.addColumn('snippet_runs', 'deviceId', ref('devices', 'SET NULL'));
  await queryInterface.addColumn('snippet_runs', 'deviceName', {
    type: STRING(120),
    allowNull: true
  });
  await queryInterface.addColumn('snippet_runs', 'scheduleRunId', ref('schedule_runs', 'SET NULL'));
  await queryInterface.addColumn('snippet_runs', 'sandbox', {
    type: STRING(20),
    allowNull: true
  });

  // A runbook run can target one device; each runnable step runs there
  await queryInterface.addColumn('runbook_runs', 'deviceId', ref('devices', 'SET NULL'));
  await queryInterface.addColumn('runbook_runs', 'scheduleRunId', ref('schedule_runs', 'SET NULL'));

  // Outgoing notifications
  await queryInterface.createTable('webhooks', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    name: { type: STRING(120), allowNull: false },
    // 'slack', 'teams', 'discord', or 'webhook'
    type: { type: STRING(20), allowNull: false },
    url: { type: TEXT, allowNull: false },
    signingSecret: { type: TEXT, allowNull: false, defaultValue: '' },
    events: { type: TEXT, allowNull: false, defaultValue: '' },
    siteIds: { type: TEXT, allowNull: false, defaultValue: '' },
    enabled: { type: BOOLEAN, allowNull: false, defaultValue: true },
    lastStatus: { type: STRING(20), allowNull: true },
    lastError: { type: TEXT, allowNull: true },
    lastDeliveredAt: { type: DATE, allowNull: true },
    ...timestamps
  });

  await queryInterface.createTable('webhook_deliveries', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    webhookId: ref('webhooks', 'CASCADE', false),
    event: { type: STRING(60), allowNull: false },
    title: { type: STRING(255), allowNull: false, defaultValue: '' },
    ok: { type: BOOLEAN, allowNull: false },
    statusCode: { type: INTEGER, allowNull: true },
    error: { type: TEXT, allowNull: true },
    attempts: { type: INTEGER, allowNull: false, defaultValue: 1 },
    ...timestamps
  });
  await queryInterface.addIndex('webhook_deliveries', ['webhookId', 'createdAt']);
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.dropTable('webhook_deliveries');
  await queryInterface.dropTable('webhooks');
  await queryInterface.removeColumn('runbook_runs', 'scheduleRunId');
  await queryInterface.removeColumn('runbook_runs', 'deviceId');
  await queryInterface.removeColumn('snippet_runs', 'sandbox');
  await queryInterface.removeColumn('snippet_runs', 'scheduleRunId');
  await queryInterface.removeColumn('snippet_runs', 'deviceName');
  await queryInterface.removeColumn('snippet_runs', 'deviceId');
  await queryInterface.dropTable('agent_jobs');
  await queryInterface.dropTable('schedule_runs');
  await queryInterface.dropTable('schedules');
  await queryInterface.dropTable('device_enrollments');
  await queryInterface.dropTable('devices');
};
