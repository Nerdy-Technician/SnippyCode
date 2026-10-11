import { useState, useEffect, createContext } from 'react';
import { useHistory } from 'react-router-dom';
import axios from 'axios';
import { copyAsync } from '../utils/copyAsync';
import {
  Context,
  Snippet,
  Response,
  TagCount,
  NewSnippet,
  SearchQuery,
  RenderResult,
  Site,
  VariableList
} from '../typescript/interfaces';

const emptyVariables: VariableList = { team: [], personal: [], site: [], canEditTeam: false };
const SITE_STORAGE_KEY = 'snippycode:selectedSite';

// The chosen site is a per-browser convenience; storage may be unavailable
const readStoredSite = (): number | null => {
  try {
    return Number(window.localStorage.getItem(SITE_STORAGE_KEY)) || null;
  } catch {
    return null;
  }
};

const writeStoredSite = (id: number | null): void => {
  try {
    if (id) {
      window.localStorage.setItem(SITE_STORAGE_KEY, String(id));
    } else {
      window.localStorage.removeItem(SITE_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
};


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
  clearSearch: () => {},
  variables: emptyVariables,
  getVariables: () => {},
  sites: [],
  canManageSites: false,
  getSites: () => {},
  selectedSiteId: null,
  setSelectedSiteId: (id: number | null) => {},
  toggleFavorite: (id: number) => {},
  trackActivity: async (id: number, type: 'view' | 'copy') => {},
  renderSnippet: async () => ({ code: '', sha256: '', secretsUsed: [], missing: [] }),
  copySnippetCode: async () => {}
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
  const [variables, setVariables] = useState<VariableList>(emptyVariables);
  const [sites, setSites] = useState<Site[]>([]);
  const [canManageSites, setCanManageSites] = useState(false);
  const [selectedSiteId, setSelectedSiteIdState] = useState<number | null>(readStoredSite());

  const setSelectedSiteId = (id: number | null): void => {
    setSelectedSiteIdState(id);
    writeStoredSite(id);
  };

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

  const getSites = (): void => {
    axios
      .get<Response<{ sites: Site[]; canManage: boolean }>>('/api/sites')
      .then(res => {
        setSites(res.data.data.sites);
        setCanManageSites(res.data.data.canManage);

        // Forget a remembered site the user can no longer use
        if (selectedSiteId && !res.data.data.sites.some(site => site.id === selectedSiteId)) {
          setSelectedSiteId(null);
        }
      })
      .catch(() => setSites([]));
  };

  const getVariables = (): void => {
    axios
      .get<Response<VariableList>>('/api/variables')
      .then(res => setVariables(res.data.data))
      .catch(() => setVariables(emptyVariables));
  };

  // Apply a change to a snippet wherever it is held locally
  const patchLocalSnippet = (id: number, patch: (snippet: Snippet) => Snippet) => {
    const apply = (items: Snippet[]) =>
      items.map(item => (item.id === id ? patch(item) : item));

    setSnippets(apply);
    setSearchResults(apply);
    setCurrentSnippet(current =>
      current && current.id === id ? patch(current) : current
    );
  };

  const personalOf = (snippet: Snippet) =>
    snippet.personal || {
      isFavorite: false,
      views: 0,
      copies: 0,
      lastViewedAt: null,
      lastCopiedAt: null
    };

  const toggleFavorite = (id: number): void => {
    const snippet =
      snippets.find(item => item.id === id) ||
      (currentSnippet?.id === id ? currentSnippet : null);
    const favorite = !(snippet?.personal?.isFavorite || false);

    patchLocalSnippet(id, item => ({
      ...item,
      personal: { ...personalOf(item), isFavorite: favorite }
    }));

    axios.put(`/api/snippets/${id}/favorite`, { favorite }).catch(() =>
      patchLocalSnippet(id, item => ({
        ...item,
        personal: { ...personalOf(item), isFavorite: !favorite }
      }))
    );
  };

  const trackActivity = (id: number, type: 'view' | 'copy'): Promise<void> => {
    const now = new Date().toISOString();

    patchLocalSnippet(id, item => {
      const personal = personalOf(item);

      return {
        ...item,
        personal:
          type === 'view'
            ? { ...personal, views: personal.views + 1, lastViewedAt: now }
            : { ...personal, copies: personal.copies + 1, lastCopiedAt: now }
      };
    });

    return axios
      .post(`/api/snippets/${id}/activity`, { type })
      .then(() => undefined)
      .catch(() => undefined);
  };

  // Filled in on the server so secret values never sit in the page
  const renderSnippet = async (
    id: number,
    options: { siteId?: number | null; variables?: Record<string, string>; purpose?: 'copy' } = {}
  ): Promise<RenderResult> => {
    const res = await axios.post<Response<RenderResult>>(`/api/snippets/${id}/render`, {
      siteId: options.siteId || undefined,
      variables: options.variables || {},
      purpose: options.purpose
    });

    return res.data.data;
  };

  const copySnippetCode = async (
    snippet: Snippet,
    options: { siteId?: number | null; variables?: Record<string, string> } = {}
  ): Promise<void> => {
    const rendered = renderSnippet(snippet.id, { ...options, purpose: 'copy' });
    await copyAsync(rendered.then(result => result.code));

    // The server counted the copy; mirror it locally for Home
    const now = new Date().toISOString();
    patchLocalSnippet(snippet.id, item => {
      const personal = personalOf(item);
      return { ...item, personal: { ...personal, copies: personal.copies + 1, lastCopiedAt: now } };
    });
  };

  // The provider only mounts behind AuthGate, so the session is ready here
  useEffect(() => {
    getVariables();
    getSites();
  }, []);

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
    clearSearch,
    variables,
    getVariables,
    sites,
    canManageSites,
    getSites,
    selectedSiteId,
    setSelectedSiteId,
    toggleFavorite,
    trackActivity,
    renderSnippet,
    copySnippetCode
  };

  return (
    <SnippetsContext.Provider value={context}>
      {props.children}
    </SnippetsContext.Provider>
  );
};
