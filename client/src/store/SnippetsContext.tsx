import { useState, createContext } from 'react';
import { useHistory } from 'react-router-dom';
import axios from 'axios';
import {
  Context,
  Snippet,
  Response,
  TagCount,
  NewSnippet,
  SearchQuery
} from '../typescript/interfaces';

export const SnippetsContext = createContext<Context>({
  snippets: [],
  searchResults: [],
  searchActive: false,
  currentSnippet: null,
  tagCount: [],
  getSnippets: () => {},
  getSnippetById: (id: number) => {},
  setSnippet: (id: number) => {},
  createSnippet: (snippet: NewSnippet) => {},
  updateSnippet: (snippet: NewSnippet, id: number, isLocal?: boolean) => {},
  patchSnippetFlags: () => {},
  deleteSnippet: (id: number) => {},
  duplicateSnippet: (id: number) => {},
  renameCollection: async () => {},
  toggleSnippetPin: (id: number, isPinned?: boolean) => {},
  countTags: () => {},
  searchSnippets: (query: SearchQuery) => {},
  clearSearch: () => {}
});

interface Props {
  children: JSX.Element | JSX.Element[];
}

export const SnippetsContextProvider = (props: Props): JSX.Element => {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [searchResults, setSearchResults] = useState<Snippet[]>([]);
  const [searchActive, setSearchActive] = useState(false);
  const [currentSnippet, setCurrentSnippet] = useState<Snippet | null>(null);
  const [tagCount, setTagCount] = useState<TagCount[]>([]);

  const history = useHistory();

  const redirectOnError = () => {
    history.push('/');
  };

  const getSnippets = (): void => {
    axios
      .get<Response<Snippet[]>>('/api/snippets')
      .then(res => setSnippets(res.data.data))
      .catch(err => redirectOnError());
  };

  const getSnippetById = (id: number): void => {
    axios
      .get<Response<Snippet>>(`/api/snippets/${id}`)
      .then(res => {
        setCurrentSnippet(res.data.data);
        setSnippets(current => {
          const idx = current.findIndex(s => s.id === id);

          if (idx < 0) {
            return current;
          }

          return [
            ...current.slice(0, idx),
            res.data.data,
            ...current.slice(idx + 1)
          ];
        });
      })
      .catch(err => redirectOnError());
  };

  const setSnippet = (id: number): void => {
    if (id < 0) {
      setCurrentSnippet(null);
      return;
    }

    getSnippetById(id);

    const snippet = snippets.find(s => s.id === id);

    if (snippet) {
      setCurrentSnippet(snippet);
    }
  };

  const createSnippet = (snippet: NewSnippet): void => {
    axios
      .post<Response<Snippet>>('/api/snippets', snippet)
      .then(res => {
        setSnippets([...snippets, res.data.data]);
        setCurrentSnippet(res.data.data);
        history.push({
          pathname: `/snippet/${res.data.data.id}`,
          state: { from: '/snippets' }
        });
      })
      .catch(err => redirectOnError());
  };

  // Merge a fresh server copy into the list without relying on a possibly
  // stale closure, and without duplicating entries when it is not listed yet.
  const replaceSnippet = (updated: Snippet): void => {
    setSnippets(current => {
      const idx = current.findIndex(s => s.id === updated.id);

      if (idx < 0) {
        return [...current, updated];
      }

      return [...current.slice(0, idx), updated, ...current.slice(idx + 1)];
    });
  };

  /**
   * Change only the pin and/or public flags. The server patches just these
   * fields, so a stale copy of the snippet can never overwrite others (for
   * example, pinning must not unpublish a shared snippet).
   */
  const patchSnippetFlags = (
    id: number,
    flags: { isPinned?: boolean; isPublic?: boolean }
  ): void => {
    axios
      .patch<Response<Snippet>>(`/api/snippets/${id}`, flags)
      .then(res => {
        replaceSnippet(res.data.data);
        setCurrentSnippet(current =>
          current && current.id === id ? res.data.data : current
        );
      })
      .catch(err => redirectOnError());
  };

  const updateSnippet = (
    snippet: NewSnippet,
    id: number,
    isLocal?: boolean
  ): void => {
    axios
      .put<Response<Snippet>>(`/api/snippets/${id}`, snippet)
      .then(res => {
        replaceSnippet(res.data.data);
        setCurrentSnippet(res.data.data);

        if (!isLocal) {
          history.push({
            pathname: `/snippet/${res.data.data.id}`,
            state: { from: '/snippets' }
          });
        }
      })
      .catch(err => redirectOnError());
  };

  const deleteSnippet = (id: number): void => {
    if (window.confirm('Are you sure you want to delete this snippet?')) {
      axios
        .delete<Response<{}>>(`/api/snippets/${id}`)
        .then(res => {
          const deletedSnippetIdx = snippets.findIndex(s => s.id === id);
          setSnippets([
            ...snippets.slice(0, deletedSnippetIdx),
            ...snippets.slice(deletedSnippetIdx + 1)
          ]);
          setSnippet(-1);
          history.push('/snippets');
        })
        .catch(err => redirectOnError());
    }
  };

  const duplicateSnippet = (id: number): void => {
    const snippet =
      snippets.find(item => item.id === id) ||
      (currentSnippet?.id === id ? currentSnippet : null);

    if (!snippet) {
      return;
    }

    createSnippet({
      title: `${snippet.title} copy`,
      description: snippet.description,
      language: snippet.language,
      code: snippet.code,
      docs: snippet.docs,
      isPinned: false,
      tags: snippet.tags || [],
      collection: snippet.collection,
      fileName: snippet.fileName,
      isPublic: false
    });
  };

  const renameCollection = async (from: string, to: string): Promise<void> => {
    await axios.post('/api/snippets/collections/rename', { from, to });
    getSnippets();
  };

  const toggleSnippetPin = (id: number, isPinned?: boolean): void => {
    const snippet =
      snippets.find(s => s.id === id) ||
      (currentSnippet?.id === id ? currentSnippet : null);
    const nextPinned = isPinned ?? !snippet?.isPinned;

    patchSnippetFlags(id, { isPinned: nextPinned });
  };

  const countTags = (): void => {
    axios
      .get<Response<TagCount[]>>('/api/snippets/statistics/count')
      .then(res => setTagCount(res.data.data))
      .catch(err => redirectOnError());
  };

  const clearSearch = (): void => {
    setSearchResults([]);
    setSearchActive(false);
  };

  const searchSnippets = (query: SearchQuery): void => {
    const isEmpty =
      !query.query.trim() &&
      !query.tags.length &&
      !query.languages.length &&
      !(query.collections && query.collections.length);

    if (isEmpty) {
      clearSearch();
      return;
    }

    axios
      .post<Response<Snippet[]>>('/api/snippets/search', query)
      .then(res => {
        setSearchResults(res.data.data);
        setSearchActive(true);
      })
      .catch(() => {
        setSearchResults([]);
        setSearchActive(true);
      });
  };

  const context = {
    snippets,
    searchResults,
    searchActive,
    currentSnippet,
    tagCount,
    getSnippets,
    getSnippetById,
    setSnippet,
    createSnippet,
    updateSnippet,
    patchSnippetFlags,
    deleteSnippet,
    duplicateSnippet,
    renameCollection,
    toggleSnippetPin,
    countTags,
    searchSnippets,
    clearSearch
  };

  return (
    <SnippetsContext.Provider value={context}>
      {props.children}
    </SnippetsContext.Provider>
  );
};
