import { useContext } from 'react';
import { Link } from 'react-router-dom';
import { Card, Layout } from '../components/UI';
import { AuthContext } from '../store';
import {
  APP_AUTHOR,
  APP_AUTHOR_URL,
  APP_DESCRIPTION,
  APP_NAME,
  APP_VERSION,
  RELEASES_URL,
  REMOTE_EXECUTE_WARNING,
  REPO_URL
} from '../utils';

const features: { title: string; text: string }[] = [
  {
    title: 'Snippet library',
    text: 'Collections, tags, pinning, search and syntax highlighting.'
  },
  {
    title: 'Version history',
    text: 'Every change is saved and any earlier version can be restored.'
  },
  {
    title: 'Share links',
    text: 'Make a snippet public to share a read-only /s/ page with anyone.'
  },
  {
    title: 'Raw links',
    text: 'Plain-text /raw/ URLs for curl, scripts and automation, with tokens for private snippets.'
  },
  {
    title: 'PowerShell remote execute',
    text: 'Public PowerShell snippets get a copyable irm … | iex one-liner.'
  },
  {
    title: 'Accounts and roles',
    text: 'Local or OIDC sign-in, MFA, roles and an audit log.'
  }
];

/** Public About page; reachable signed in or not. */
export const About = (): JSX.Element => {
  const { user } = useContext(AuthContext);

  return (
    <Layout classes='public-snippet-page about-page'>
      <div className='col-12'>
        <header className='public-snippet-header'>
          <Link to='/' className='navbar-brand'>
            <img src='/CodeSnippy.png' alt='' />
            <span>{APP_NAME}</span>
          </Link>
          <Link to='/' className='btn btn-outline-secondary'>
            {user ? 'Back to app' : 'Sign in'}
          </Link>
        </header>
      </div>
      <div className='col-12'>
        <Card>
          <p className='eyebrow'>About</p>
          <h1>{APP_NAME}</h1>
          <p>{APP_DESCRIPTION}</p>
          <p className='about-version'>
            Version <strong data-testid='app-version'>{APP_VERSION}</strong>
            {' · '}
            <a href={RELEASES_URL} target='_blank' rel='noreferrer'>
              Release notes
            </a>
          </p>
        </Card>
      </div>
      <div className='col-12'>
        <Card title='Features'>
          <ul className='about-features'>
            {features.map(({ title, text }) => (
              <li key={title}>
                <strong>{title}</strong>: {text}
                {title === 'PowerShell remote execute' && (
                  <span className='remote-execute-warning d-block'>
                    {REMOTE_EXECUTE_WARNING}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <div className='col-12'>
        <Card title='Project'>
          <ul className='about-links'>
            <li>
              Source code:{' '}
              <a href={REPO_URL} target='_blank' rel='noreferrer'>
                github.com/Nerdy-Technician/SnippyCode
              </a>
            </li>
            <li>
              Author:{' '}
              <a href={APP_AUTHOR_URL} target='_blank' rel='noreferrer'>
                {APP_AUTHOR}
              </a>
            </li>
          </ul>
        </Card>
      </div>
    </Layout>
  );
};
