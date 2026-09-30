/**
 * Snippet body after validateSnippetBody. Optional fields are only present
 * when the client sent them; isPinned is normalised to 0 or 1.
 */
export interface Body {
  title: string;
  description?: string;
  language: string;
  code: string;
  docs?: string;
  isPinned?: number;
  tags?: string[];
  collection?: string;
  fileName?: string;
  isPublic?: boolean;
}
