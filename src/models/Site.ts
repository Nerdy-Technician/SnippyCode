import { Model, DataTypes, Optional } from 'sequelize';
import { sequelize } from '../db';

const { INTEGER, STRING, DATE, TEXT } = DataTypes;

export type SiteAccess = 'everyone' | 'members';

export interface Site {
  id: number;
  name: string;
  slug: string;
  description: string;
  tags: string;
  access: SiteAccess;
  createdAt: Date;
  updatedAt: Date;
}

export interface SiteInstance
  extends Model<Site, Optional<Site, 'id' | 'createdAt' | 'updatedAt' | 'description' | 'tags' | 'access'>>,
    Site {}

export const SiteModel = sequelize.define<SiteInstance>(
  'Site',
  {
    id: { type: INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: STRING(120), allowNull: false },
    slug: { type: STRING(120), allowNull: false, unique: true },
    description: { type: TEXT, allowNull: false, defaultValue: '' },
    tags: { type: TEXT, allowNull: false, defaultValue: '' },
    access: { type: STRING(20), allowNull: false, defaultValue: 'everyone' },
    createdAt: { type: DATE },
    updatedAt: { type: DATE }
  },
  { tableName: 'sites' }
);

export interface SiteMember {
  siteId: number;
  userId: number;
}

export interface SiteMemberInstance extends Model<SiteMember>, SiteMember {}

export const SiteMemberModel = sequelize.define<SiteMemberInstance>(
  'SiteMember',
  {
    siteId: { type: INTEGER, primaryKey: true },
    userId: { type: INTEGER, primaryKey: true }
  },
  { tableName: 'site_members', timestamps: false }
);
