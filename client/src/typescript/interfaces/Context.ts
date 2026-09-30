import { TagCount, NewSnippet, Snippet, SearchQuery } from '.';

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
}
