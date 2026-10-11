import { DataTypes, QueryInterface } from 'sequelize';

const { INTEGER, STRING, DATE, TEXT, BOOLEAN } = DataTypes;

const timestamps = {
  createdAt: { type: DATE, allowNull: false },
  updatedAt: { type: DATE, allowNull: false }
};

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  // Sites: customers or locations with their own variable values
  await queryInterface.createTable('sites', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    name: { type: STRING(120), allowNull: false },
    slug: { type: STRING(120), allowNull: false, unique: true },
    description: { type: TEXT, allowNull: false, defaultValue: '' },
    tags: { type: TEXT, allowNull: false, defaultValue: '' },
    // 'everyone' or 'members'; admins and the owner always have access
    access: { type: STRING(20), allowNull: false, defaultValue: 'everyone' },
    ...timestamps
  });

  await queryInterface.createTable('site_members', {
    siteId: {
      type: INTEGER,
      allowNull: false,
      primaryKey: true,
      references: { model: 'sites', key: 'id' },
      onDelete: 'CASCADE'
    },
    userId: {
      type: INTEGER,
      allowNull: false,
      primaryKey: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE'
    }
  });

  // Variables gain a site scope and secrets
  await queryInterface.addColumn('variables', 'siteId', {
    type: INTEGER,
    allowNull: true,
    references: { model: 'sites', key: 'id' },
    onDelete: 'CASCADE'
  });
  await queryInterface.addColumn('variables', 'isSecret', {
    type: BOOLEAN,
    allowNull: false,
    defaultValue: false
  });
  await queryInterface.sequelize.query(`DROP INDEX IF EXISTS variables_team_name`);
  await queryInterface.sequelize.query(
    `CREATE UNIQUE INDEX variables_team_name ON variables (name) WHERE "userId" IS NULL AND "siteId" IS NULL`
  );
  await queryInterface.sequelize.query(
    `CREATE UNIQUE INDEX variables_site_name ON variables ("siteId", name) WHERE "siteId" IS NOT NULL`
  );

  // Runbooks: ordered snippets worked through against one site
  await queryInterface.createTable('runbooks', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    title: { type: STRING(200), allowNull: false },
    description: { type: TEXT, allowNull: false, defaultValue: '' },
    createdBy: {
      type: INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL'
    },
    ...timestamps
  });

  await queryInterface.createTable('runbook_steps', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    runbookId: {
      type: INTEGER,
      allowNull: false,
      references: { model: 'runbooks', key: 'id' },
      onDelete: 'CASCADE'
    },
    position: { type: INTEGER, allowNull: false },
    snippetId: {
      type: INTEGER,
      allowNull: true,
      references: { model: 'snippets', key: 'id' },
      onDelete: 'SET NULL'
    },
    title: { type: STRING(200), allowNull: false, defaultValue: '' },
    note: { type: TEXT, allowNull: false, defaultValue: '' },
    ...timestamps
  });

  await queryInterface.createTable('runbook_runs', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    runbookId: {
      type: INTEGER,
      allowNull: true,
      references: { model: 'runbooks', key: 'id' },
      onDelete: 'SET NULL'
    },
    // Kept so history reads well after a runbook is renamed or deleted
    runbookTitle: { type: STRING(200), allowNull: false },
    siteId: {
      type: INTEGER,
      allowNull: true,
      references: { model: 'sites', key: 'id' },
      onDelete: 'CASCADE'
    },
    userId: {
      type: INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL'
    },
    // 'in_progress', 'completed', or 'cancelled'
    status: { type: STRING(20), allowNull: false, defaultValue: 'in_progress' },
    completedAt: { type: DATE, allowNull: true },
    ...timestamps
  });

  // Every server run, with its output (secret values masked)
  await queryInterface.createTable('snippet_runs', {
    id: { type: INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
    snippetId: {
      type: INTEGER,
      allowNull: true,
      references: { model: 'snippets', key: 'id' },
      onDelete: 'SET NULL'
    },
    snippetTitle: { type: STRING(255), allowNull: false },
    siteId: {
      type: INTEGER,
      allowNull: true,
      references: { model: 'sites', key: 'id' },
      onDelete: 'CASCADE'
    },
    userId: {
      type: INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL'
    },
    runbookRunId: {
      type: INTEGER,
      allowNull: true,
      references: { model: 'runbook_runs', key: 'id' },
      onDelete: 'SET NULL'
    },
    language: { type: STRING, allowNull: false },
    ok: { type: BOOLEAN, allowNull: false },
    exitCode: { type: INTEGER, allowNull: true },
    timedOut: { type: BOOLEAN, allowNull: false, defaultValue: false },
    stdout: { type: TEXT, allowNull: false, defaultValue: '' },
    stderr: { type: TEXT, allowNull: false, defaultValue: '' },
    durationMs: { type: INTEGER, allowNull: false, defaultValue: 0 },
    ...timestamps
  });
  await queryInterface.addIndex('snippet_runs', ['siteId', 'createdAt']);
  await queryInterface.addIndex('snippet_runs', ['snippetId', 'createdAt']);

  await queryInterface.createTable('runbook_run_steps', {
    runId: {
      type: INTEGER,
      allowNull: false,
      primaryKey: true,
      references: { model: 'runbook_runs', key: 'id' },
      onDelete: 'CASCADE'
    },
    stepId: {
      type: INTEGER,
      allowNull: false,
      primaryKey: true,
      references: { model: 'runbook_steps', key: 'id' },
      onDelete: 'CASCADE'
    },
    // 'pending', 'done', 'skipped', or 'failed'
    status: { type: STRING(20), allowNull: false, defaultValue: 'pending' },
    snippetRunId: {
      type: INTEGER,
      allowNull: true,
      references: { model: 'snippet_runs', key: 'id' },
      onDelete: 'SET NULL'
    },
    completedBy: {
      type: INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL'
    },
    completedAt: { type: DATE, allowNull: true }
  });
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.dropTable('runbook_run_steps');
  await queryInterface.dropTable('snippet_runs');
  await queryInterface.dropTable('runbook_runs');
  await queryInterface.dropTable('runbook_steps');
  await queryInterface.dropTable('runbooks');
  await queryInterface.sequelize.query(`DROP INDEX IF EXISTS variables_site_name`);
  await queryInterface.sequelize.query(`DROP INDEX IF EXISTS variables_team_name`);
  await queryInterface.removeColumn('variables', 'isSecret');
  await queryInterface.removeColumn('variables', 'siteId');
  await queryInterface.sequelize.query(
    `CREATE UNIQUE INDEX variables_team_name ON variables (name) WHERE "userId" IS NULL`
  );
  await queryInterface.dropTable('site_members');
  await queryInterface.dropTable('sites');
};
