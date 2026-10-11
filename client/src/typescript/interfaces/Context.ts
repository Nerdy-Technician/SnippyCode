import { TagCount, NewSnippet, Snippet, SearchQuery, Site, VariableList } from '.';

export interface RenderResult {
  code: string;
  sha256: string;
  secretsUsed: string[];
  missing: string[];
}

export interface Context {
  snippets: Snippet[];
  searchResults: Snippet[];
  searchActive: boolean;
  currentSnippet: Snippet | null;
  tagCount: TagCount[];
  getSnippets: () => void;
  getSnippetById: (id: number) => void;
  setSnippet: (id: number) => void;
  createSnippet: (snippet: NewSnippet) => void;
  updateSnippet: (snippet: NewSnippet, id: number, isLocal?: boolean) => void;
  patchSnippetFlags: (
    id: number,
    flags: { isPinned?: boolean; isPublic?: boolean }
  ) => void;
  deleteSnippet: (id: number) => void;
  duplicateSnippet: (id: number) => void;
  renameCollection: (from: string, to: string) => Promise<void>;
  toggleSnippetPin: (id: number, isPinned?: boolean) => void;
  countTags: () => void;
  searchSnippets: (query: SearchQuery) => void;
  clearSearch: () => void;
  variables: VariableList;
  getVariables: () => void;
  sites: Site[];
  canManageSites: boolean;
  getSites: () => void;
  selectedSiteId: number | null;
  setSelectedSiteId: (id: number | null) => void;
  toggleFavorite: (id: number) => void;
  trackActivity: (id: number, type: 'view' | 'copy') => Promise<void>;
  renderSnippet: (
    id: number,
    options?: { siteId?: number | null; variables?: Record<string, string>; purpose?: 'copy' }
  ) => Promise<RenderResult>;
  copySnippetCode: (
    snippet: Snippet,
    options?: { siteId?: number | null; variables?: Record<string, string> }
  ) => Promise<void>;
}
