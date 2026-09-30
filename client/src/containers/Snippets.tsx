import { useEffect, useContext, useMemo, Fragment } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { AuthContext, SnippetsContext } from '../store';
import { SnippetGrid } from '../components/Snippets/SnippetGrid';
import { Button, Card, EmptyState, Layout } from '../components/UI';
import { SearchBar } from '../components/SearchBar';
import { canEditSnippets } from '../utils';
import { Snippet } from '../typescript/interfaces';

const collectionName = (value?: string | null): string =>
  (value || 'General').trim() || 'General';

type LibrarySort = 'updated' | 'title' | 'language';

const sortSnippets = (items: Snippet[], sort: LibrarySort): Snippet[] => {
  const next = [...items];

  next.sort((a, b) => {
    if (sort === 'title') {
      return a.title.localeCompare(b.title);
    }

    if (sort === 'language') {
      return a.language.localeCompare(b.language) || a.title.localeCompare(b.title);
    }

    return (
      new Date(b.updatedAt || b.createdAt).getTime() -
      new Date(a.updatedAt || a.createdAt).getTime()
    );
  });

  return next;
};

export const Snippets = (): JSX.Element => {
  const {
    snippets,
    tagCount,
    getSnippets,
    countTags,
    searchResults,
    searchActive,
    renameCollection
  } = useContext(SnippetsContext);
  const { user } = useContext(AuthContext);
  const canEdit = canEditSnippets(user?.role);
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const collectionFilter = params.get('collection');
  const tagFilter = params.get('tag');
  const languageFilter = params.get('lang');
  const sort = (params.get('sort') as LibrarySort) || 'updated';

  useEffect(() => {
    getSnippets();
    countTags();
  }, []);

  const setLibraryFilter = (next: {
    collection?: string | null;
    tag?: string | null;
    lang?: string | null;
    sort?: LibrarySort | null;
  }) => {
    const query = new URLSearchParams(location.search);
    const collection =
      next.collection === undefined ? collectionFilter : next.collection;
    const tag = next.tag === undefined ? tagFilter : next.tag;
    const lang = next.lang === undefined ? languageFilter : next.lang;
    const nextSort = next.sort === undefined ? sort : next.sort;

    if (collection) {
      query.set('collection', collection);
    } else {
      query.delete('collection');
    }

    if (tag) {
      query.set('tag', tag);
    } else {
      query.delete('tag');
    }

    if (lang) {
      query.set('lang', lang);
    } else {
      query.delete('lang');
    }

    if (nextSort && nextSort !== 'updated') {
      query.set('sort', nextSort);
    } else {
      query.delete('sort');
    }

    const search = query.toString();
    navigate(
      {
        pathname: '/snippets',
        search: search ? `?${search}` : ''
      },
      { replace: true }
    );
  };

  const collections = useMemo(() => {
    const counts: { [name: string]: number } = {};

    snippets.forEach(snippet => {
      const name = collectionName(snippet.collection);
      counts[name] = (counts[name] || 0) + 1;
    });

    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [snippets]);

  const languages = useMemo(() => {
    const counts: { [name: string]: number } = {};

    snippets.forEach(snippet => {
      const name = snippet.language || 'plaintext';
      counts[name] = (counts[name] || 0) + 1;
    });

    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [snippets]);

  const visibleSnippets = sortSnippets(
    (searchActive ? searchResults : snippets).filter(snippet => {
      const matchesCollection =
        !collectionFilter ||
        collectionName(snippet.collection) === collectionFilter;
      const matchesTag = !tagFilter || (snippet.tags || []).includes(tagFilter);
      const matchesLanguage =
        !languageFilter || snippet.language === languageFilter;

      return matchesCollection && matchesTag && matchesLanguage;
    }),
    sort
  );

  const renameActiveCollection = async () => {
    if (!collectionFilter) {
      return;
    }

    const nextName = window.prompt('Rename collection', collectionFilter);

    if (!nextName || nextName.trim() === collectionFilter) {
      return;
    }

    await renameCollection(collectionFilter, nextName.trim());
    setLibraryFilter({ collection: nextName.trim() });
  };

  return (
    <Layout>
      {snippets.length === 0 ? (
        <EmptyState />
      ) : (
        <Fragment>
          <div className='col-12 col-md-4 col-lg-3'>
            <Card>
              <h5 className='card-title'>Library</h5>
              <div className='metric-row'>
                <span>Total</span>
                <span>{snippets.length}</span>
              </div>
              <hr />

              <h5 className='card-title'>Collections</h5>
              <div
                className={`tag-filter ${!collectionFilter ? 'is-active' : ''}`}
                onClick={() => setLibraryFilter({ collection: null })}
              >
                <span>All collections</span>
                <span>{snippets.length}</span>
              </div>
              {collections.map(collection => {
                const isActive = collectionFilter === collection.name;

                return (
                  <div
                    key={collection.name}
                    className={`tag-filter ${isActive ? 'is-active' : ''}`}
                    onClick={() =>
                      setLibraryFilter({
                        collection: isActive ? null : collection.name
                      })
                    }
                  >
                    <span>{collection.name}</span>
                    <span>{collection.count}</span>
                  </div>
                );
              })}
              {canEdit && collectionFilter && (
                <div className='d-grid mt-2'>
                  <Button
                    text='Rename collection'
                    color='secondary'
                    small
                    outline
                    handler={renameActiveCollection}
                  />
                </div>
              )}

              <hr />

              <h5 className='card-title'>Languages</h5>
              <div
                className={`tag-filter ${!languageFilter ? 'is-active' : ''}`}
                onClick={() => setLibraryFilter({ lang: null })}
              >
                <span>All languages</span>
                <span>{snippets.length}</span>
              </div>
              {languages.map(language => {
                const isActive = languageFilter === language.name;

                return (
                  <div
                    key={language.name}
                    className={`tag-filter ${isActive ? 'is-active' : ''}`}
                    onClick={() =>
                      setLibraryFilter({
                        lang: isActive ? null : language.name
                      })
                    }
                  >
                    <span>{language.name}</span>
                    <span>{language.count}</span>
                  </div>
                );
              })}

              <hr />

              <h5 className='card-title'>Filter by tags</h5>
              <Fragment>
                {tagCount.map((tag, idx) => {
                  const isActiveFilter = tagFilter === tag.name;

                  return (
                    <div
                      key={idx}
                      className={`tag-filter ${isActiveFilter ? 'is-active' : ''}`}
                      onClick={() =>
                        setLibraryFilter({
                          tag: isActiveFilter ? null : tag.name
                        })
                      }
                    >
                      <span>{tag.name}</span>
                      <span>{tag.count}</span>
                    </div>
                  );
                })}
              </Fragment>
              <div className='d-grid mt-3'>
                <Button
                  text='Clear filters'
                  color='secondary'
                  small
                  outline
                  handler={() =>
                    setLibraryFilter({
                      collection: null,
                      tag: null,
                      lang: null
                    })
                  }
                />
              </div>
            </Card>
          </div>
          <div className='col-12 col-md-8 col-lg-9'>
            <Card classes='home-panel home-search-panel library-panel'>
              <div className='library-toolbar'>
                <div>
                  <p className='eyebrow'>Search</p>
                </div>
                <label className='library-sort'>
                  <span>Sort</span>
                  <select
                    className='form-control'
                    value={sort}
                    onChange={e =>
                      setLibraryFilter({ sort: e.target.value as LibrarySort })
                    }
                  >
                    <option value='updated'>Last updated</option>
                    <option value='title'>Title</option>
                    <option value='language'>Language</option>
                  </select>
                </label>
              </div>
              <SearchBar autoFocus={false} />
              <div className='library-results'>
                {searchActive && visibleSnippets.length === 0 ? (
                  <p className='text-muted mb-0'>No matching snippets.</p>
                ) : (
                  <SnippetGrid snippets={visibleSnippets} />
                )}
              </div>
            </Card>
          </div>
        </Fragment>
      )}
    </Layout>
  );
};
