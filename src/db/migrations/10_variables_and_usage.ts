import { DataTypes, QueryInterface } from 'sequelize';

const { INTEGER, STRING, DATE, TEXT, BOOLEAN } = DataTypes;

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  // Team (userId NULL) and personal (userId set) values for {{NAME}} placeholders
  await queryInterface.createTable('variables', {
    id: {
      type: INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: STRING(64),
      allowNull: false
    },
    value: {
      type: TEXT,
      allowNull: false,
      defaultValue: ''
    },
    description: {
      type: TEXT,
      allowNull: false,
      defaultValue: ''
    },
    userId: {
      type: INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE'
    },
    createdAt: {
      type: DATE,
      allowNull: false
    },
    updatedAt: {
      type: DATE,
      allowNull: false
    }
  });
  await queryInterface.sequelize.query(
    `CREATE UNIQUE INDEX variables_team_name ON variables (name) WHERE "userId" IS NULL`
  );
  await queryInterface.sequelize.query(
    `CREATE UNIQUE INDEX variables_user_name ON variables ("userId", name) WHERE "userId" IS NOT NULL`
  );

  // Library-wide usage counters, kept apart from snippets so updatedAt stays meaningful
  await queryInterface.createTable('snippet_stats', {
    snippetId: {
      type: INTEGER,
      allowNull: false,
      primaryKey: true,
      references: { model: 'snippets', key: 'id' },
      onDelete: 'CASCADE'
    },
    viewCount: { type: INTEGER, allowNull: false, defaultValue: 0 },
    copyCount: { type: INTEGER, allowNull: false, defaultValue: 0 },
    rawFetchCount: { type: INTEGER, allowNull: false, defaultValue: 0 },
    runCount: { type: INTEGER, allowNull: false, defaultValue: 0 },
    lastUsedAt: { type: DATE, allowNull: true }
  });

  // Per-user favorites and history
  await queryInterface.createTable('user_snippets', {
    userId: {
      type: INTEGER,
      allowNull: false,
      primaryKey: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE'
    },
    snippetId: {
      type: INTEGER,
      allowNull: false,
      primaryKey: true,
      references: { model: 'snippets', key: 'id' },
      onDelete: 'CASCADE'
    },
    isFavorite: { type: BOOLEAN, allowNull: false, defaultValue: false },
    viewCount: { type: INTEGER, allowNull: false, defaultValue: 0 },
    copyCount: { type: INTEGER, allowNull: false, defaultValue: 0 },
    lastViewedAt: { type: DATE, allowNull: true },
    lastCopiedAt: { type: DATE, allowNull: true }
  });
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.dropTable('user_snippets');
  await queryInterface.dropTable('snippet_stats');
  await queryInterface.dropTable('variables');
};
