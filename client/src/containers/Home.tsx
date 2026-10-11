import { useEffect, useContext } from 'react';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBook,
  faCode,
  faDatabase,
  faGear,
  faMagnifyingGlass,
  faStar
} from '@fortawesome/free-solid-svg-icons';
import { AuthContext, SnippetsContext } from '../store';
import { Layout, Card } from '../components/UI';
import { SnippetGrid } from '../components/Snippets/SnippetGrid';
import { SearchBar } from '../components/SearchBar';
import { canAdmin, canEditSnippets, dateParser } from '../utils';
import { Snippet } from '../typescript/interfaces';

const time = (value?: string | null): number => (value ? new Date(value).getTime() : 0);

const QuickList = (props: {
  title: string;
  empty: string;
  items: Snippet[];
  meta: (snippet: Snippet) => string;
}): JSX.Element => (
  <Card classes='home-panel h-100'>
    <p className='eyebrow'>{props.title}</p>
    {props.items.length === 0 ? (
      <p className='text-muted mb-0'>{props.empty}</p>
    ) : (
      <ul className='quick-list'>
        {props.items.map(snippet => (
          <li key={snippet.id}>
            <Link to={{ pathname: `/snippet/${snippet.id}`, state: { from: '/' } }}>
              {snippet.title}
            </Link>
            <span>{props.meta(snippet)}</span>
          </li>
        ))}
      </ul>
    )}
  </Card>
);

export const Home = (): JSX.Element => {
  const { snippets, getSnippets, searchResults, searchActive } =
    useContext(SnippetsContext);
  const { user } = useContext(AuthContext);
  const canEdit = canEditSnippets(user?.role);
  const showAdmin = canAdmin(user?.role);
  const pinnedSnippets = snippets.filter(snippet => snippet.isPinned);
  const favoriteSnippets = snippets.filter(snippet => snippet.personal?.isFavorite);
  const recentlyViewed = snippets
    .filter(snippet => snippet.personal?.lastViewedAt)
    .sort((a, b) => time(b.personal?.lastViewedAt) - time(a.personal?.lastViewedAt))
    .slice(0, 6);
  const mostCopied = snippets
    .filter(snippet => (snippet.personal?.copies || 0) > 0)
    .sort(
      (a, b) =>
        (b.personal?.copies || 0) - (a.personal?.copies || 0) ||
        time(b.personal?.lastCopiedAt) - time(a.personal?.lastCopiedAt)
    )
    .slice(0, 6);
  const recentSnippets = [...snippets]
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    .slice(0, 4);
  const languages = Array.from(
    new Set(snippets.map(snippet => snippet.language))
  );
  const tags = Array.from(
    new Set(snippets.flatMap(snippet => snippet.tags || []))
  );

  useEffect(() => {
    getSnippets();
  }, []);

  return (
    <Layout classes='home-dashboard'>
      <div className='col-12'>
        <section className='home-hero'>
          <div>
            <p className='eyebrow'>SnippyCode</p>
            <h1>Your working memory, versioned.</h1>
            <p>
              Save commands, patterns, docs, and fixes in one fast searchable
              workspace.
            </p>
          </div>
          <div className='home-actions'>
            {canEdit && (
              <Link to='/editor' className='btn btn-primary'>
                <FontAwesomeIcon icon={faCode} />
                <span>
                  {snippets.length ? 'New snippet' : 'Create first snippet'}
                </span>
              </Link>
            )}
            <Link to='/snippets' className='btn btn-outline-secondary'>
              <FontAwesomeIcon icon={faBook} />
              <span>Browse library</span>
            </Link>
            {showAdmin && (
              <Link to='/admin' className='btn btn-outline-secondary'>
                <FontAwesomeIcon icon={faGear} />
                <span>Admin</span>
              </Link>
            )}
          </div>
        </section>
      </div>

      <div className='col-12'>
        <section className='home-metrics'>
          <article>
            <FontAwesomeIcon icon={faDatabase} />
            <div>
              <strong>{snippets.length}</strong>
              <span>Snippets</span>
            </div>
          </article>
          <article>
            <FontAwesomeIcon icon={faStar} />
            <div>
              <strong>{favoriteSnippets.length}</strong>
              <span>My favorites</span>
            </div>
          </article>
          <article>
            <FontAwesomeIcon icon={faCode} />
            <div>
              <strong>{languages.length}</strong>
              <span>Languages</span>
            </div>
          </article>
          <article>
            <FontAwesomeIcon icon={faMagnifyingGlass} />
            <div>
              <strong>{tags.length}</strong>
              <span>Tags</span>
            </div>
          </article>
        </section>
      </div>

      {snippets.length === 0 ? (
        <>
          <div className='col-12 col-lg-7'>
            <Card classes='home-panel'>
              <p className='eyebrow'>Start here</p>
              <h5 className='card-title'>Build the library around real work</h5>
              <div className='home-checklist'>
                <span>Add your first shell command or config fragment</span>
                <span>Tag it by language, tool, or project</span>
                <span>Pin anything you reach for every week</span>
                {showAdmin && (
                  <span>Use Admin to configure GitHub sync and auth</span>
                )}
              </div>
            </Card>
          </div>
          <div className='col-12 col-lg-5'>
            <Card classes='home-panel'>
              <p className='eyebrow'>Quick capture</p>
              <h5 className='card-title'>Paste now, polish later</h5>
              <p className='text-muted'>
                The editor auto-detects language from your code, so you can keep
                moving and organize after the idea is safely stored.
              </p>
              {canEdit && (
                <Link to='/editor' className='btn btn-primary'>
                  Open editor
                </Link>
              )}
            </Card>
          </div>
        </>
      ) : (
        <>
          <div className='col-12'>
            <Card classes='home-panel home-search-panel'>
              <p className='eyebrow'>Search</p>
              <SearchBar />
            </Card>
          </div>
          {favoriteSnippets.length > 0 && (
            <div className='col-12'>
              <div className='home-section-header'>
                <h2>My favorites</h2>
                <Link to='/snippets?show=favorites'>View all</Link>
              </div>
              <SnippetGrid snippets={favoriteSnippets.slice(0, 6)} />
            </div>
          )}
          <div className='col-12 col-lg-6'>
            <QuickList
              title='Recently viewed'
              empty='Snippets you open show up here.'
              items={recentlyViewed}
              meta={snippet =>
                dateParser(snippet.personal!.lastViewedAt!).relative
              }
            />
          </div>
          <div className='col-12 col-lg-6'>
            <QuickList
              title='Copied most'
              empty='Snippets you copy show up here.'
              items={mostCopied}
              meta={snippet =>
                `${snippet.personal!.copies} ${
                  snippet.personal!.copies === 1 ? 'copy' : 'copies'
                }`
              }
            />
          </div>
          {pinnedSnippets.length > 0 && (
            <div className='col-12'>
              <div className='home-section-header'>
                <h2>Pinned snippets</h2>
                <Link to='/snippets'>View all</Link>
              </div>
              <SnippetGrid snippets={pinnedSnippets.slice(0, 4)} />
            </div>
          )}
          <div className='col-12'>
            <div className='home-section-header'>
              <h2>{searchActive ? 'Matching snippets' : 'Recent snippets'}</h2>
              {canEdit && <Link to='/editor'>Add snippet</Link>}
            </div>
            {searchActive && searchResults.length === 0 ? (
              <p className='text-muted'>No matching snippets.</p>
            ) : (
              <SnippetGrid
                snippets={
                  searchActive ? searchResults.slice(0, 6) : recentSnippets
                }
              />
            )}
          </div>
        </>
      )}
    </Layout>
  );
};
