import { DataTypes, QueryInterface } from 'sequelize';

const { INTEGER, STRING, DATE, TEXT } = DataTypes;

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.addColumn('users', 'role', {
    type: STRING,
    allowNull: false,
    defaultValue: 'user'
  });
  await queryInterface.sequelize.query(
    `UPDATE users SET role = CASE WHEN "isOwner" = true THEN 'owner' ELSE 'user' END`
  );

  await queryInterface.addColumn('snippets', 'rawTokenHash', {
    type: STRING,
    allowNull: true
  });
  await queryInterface.addColumn('snippets', 'rawTokenPrefix', {
    type: STRING,
    allowNull: true
  });
  await queryInterface.addColumn('snippets', 'rawTokenCreatedAt', {
    type: DATE,
    allowNull: true
  });
  await queryInterface.addColumn('snippets', 'rawSlug', {
    type: STRING,
    allowNull: true
  });
  await queryInterface.addColumn('snippets', 'collection', {
    type: STRING,
    allowNull: false,
    defaultValue: 'General'
  });
  await queryInterface.addColumn('snippets', 'fileName', {
    type: STRING,
    allowNull: true
  });
  await queryInterface.sequelize.query(
    `UPDATE snippets SET "rawSlug" = LOWER(REGEXP_REPLACE(title, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || id WHERE "rawSlug" IS NULL`
  );

  await queryInterface.createTable('audit_logs', {
    id: {
      type: INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true
    },
    userId: {
      type: INTEGER,
      allowNull: true
    },
    action: {
      type: STRING,
      allowNull: false
    },
    target: {
      type: STRING,
      allowNull: true
    },
    metadata: {
      type: TEXT,
      allowNull: false,
      defaultValue: '{}'
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

  await queryInterface.createTable('snippet_versions', {
    id: {
      type: INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true
    },
    snippetId: {
      type: INTEGER,
      allowNull: false
    },
    title: {
      type: STRING,
      allowNull: false
    },
    description: {
      type: TEXT,
      allowNull: true,
      defaultValue: ''
    },
    language: {
      type: STRING,
      allowNull: false
    },
    code: {
      type: TEXT,
      allowNull: false
    },
    docs: {
      type: TEXT,
      allowNull: true,
      defaultValue: ''
    },
    tags: {
      type: TEXT,
      allowNull: false,
      defaultValue: ''
    },
    createdBy: {
      type: INTEGER,
      allowNull: true
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
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.dropTable('snippet_versions');
  await queryInterface.dropTable('audit_logs');
  await queryInterface.removeColumn('snippets', 'fileName');
  await queryInterface.removeColumn('snippets', 'collection');
  await queryInterface.removeColumn('snippets', 'rawSlug');
  await queryInterface.removeColumn('snippets', 'rawTokenCreatedAt');
  await queryInterface.removeColumn('snippets', 'rawTokenPrefix');
  await queryInterface.removeColumn('snippets', 'rawTokenHash');
  await queryInterface.removeColumn('users', 'role');
};
