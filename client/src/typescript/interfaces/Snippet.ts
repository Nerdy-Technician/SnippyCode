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
}

export interface Snippet extends Model, NewSnippet {
  rawSlug?: string | null;
  rawTokenPrefix?: string | null;
  rawTokenConfigured?: boolean;
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
