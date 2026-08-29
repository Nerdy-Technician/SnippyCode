import { Model } from '.';
import { Optional } from 'sequelize';

export interface Snippet extends Model {
  title: string;
  description: string;
  language: string;
  code: string;
  docs: string;
  isPinned: number;
  rawTokenHash?: string | null;
  rawTokenPrefix?: string | null;
  rawTokenCreatedAt?: Date | null;
  rawSlug?: string | null;
  collection: string;
  fileName?: string | null;
  isPublic: boolean;
  tags?: { name: string }[];
}

export interface SnippetCreationAttributes
  extends Optional<Snippet, 'id' | 'createdAt' | 'updatedAt' | 'rawTokenHash' | 'rawTokenPrefix' | 'rawTokenCreatedAt' | 'rawSlug' | 'collection' | 'fileName' | 'isPublic'> {}
