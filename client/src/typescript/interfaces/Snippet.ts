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
  /** Placeholders inside quotes that the run rule refuses (legacy snippets) */
  quotedPlaceholders?: Array<{ name: string; line: number; context: string }>;
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
  /** ISO time the public share stops working, or null for never */
  shareExpiresAt?: string | null;
  /** The public share is burned by its first anonymous view */
  shareOneShot?: boolean;
  /** Public, but the share expiry has passed */
  shareExpired?: boolean;
  usage?: SnippetUsage;
  personal?: PersonalUsage;
}

export interface SnippetVersionDiff {
  from: { versionId: number; title: string; language: string; createdAt: string };
  to: { versionId: number | null; title: string; language: string; createdAt: string };
  changed: { title: boolean; language: boolean; description: boolean; docs: boolean };
  added: number;
  removed: number;
  truncated: boolean;
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
