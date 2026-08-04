import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';
import {
  SnippetVersion,
  SnippetVersionCreationAttributes
} from '../typescript/interfaces';

const { INTEGER, STRING, TEXT, DATE } = DataTypes;

export interface SnippetVersionInstance
  extends Model<SnippetVersion, SnippetVersionCreationAttributes>,
    SnippetVersion {}

export const SnippetVersionModel = sequelize.define<SnippetVersionInstance>(
  'SnippetVersion',
  {
    id: {
      type: INTEGER,
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
      type: DATE
    },
    updatedAt: {
      type: DATE
    }
  },
  {
    tableName: 'snippet_versions'
  }
);
