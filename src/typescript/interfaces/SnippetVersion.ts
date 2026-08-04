import { Optional } from 'sequelize';
import { Model } from '.';

export interface SnippetVersion extends Model {
  snippetId: number;
  title: string;
  description: string;
  language: string;
  code: string;
  docs: string;
  tags: string;
  createdBy?: number | null;
}

export interface SnippetVersionCreationAttributes
  extends Optional<SnippetVersion, 'id' | 'createdAt' | 'updatedAt' | 'description' | 'docs' | 'tags' | 'createdBy'> {}
