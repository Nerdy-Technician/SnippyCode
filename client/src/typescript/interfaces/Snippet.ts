import type { VariableDefinition } from '../../utils/snippetVariables';
import { Model } from '.';

export interface NewSnippet {
  title: string;
  description?: string;
  language: string;
  code: string;
  docs?: string;
  isPinned: boolean;
  tags: string[];
  collection?: string;
  fileName?: string;
  isPublic?: boolean;
  variables?: VariableDefinition[];
  dangerous?: boolean;
}

export interface SnippetUsage {
  views: number;
  copies: number;
  rawFetches: number;
  runs: number;
  lastUsedAt: string | null;
}

export interface PersonalUsage {
  isFavorite: boolean;
  views: number;
  copies: number;
  lastViewedAt: string | null;
  lastCopiedAt: string | null;
}

export interface Snippet extends Model, NewSnippet {
  rawSlug?: string | null;
  rawTokenPrefix?: string | null;
  rawTokenConfigured?: boolean;
  usage?: SnippetUsage;
  personal?: PersonalUsage;
}

export interface SnippetVersion extends Model {
  snippetId: number;
  title: string;
  description: string;
  language: string;
  code: string;
  docs: string;
  tags: string;
}
