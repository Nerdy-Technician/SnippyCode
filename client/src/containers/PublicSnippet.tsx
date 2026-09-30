import { useContext, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import axios from 'axios';
import copy from 'clipboard-copy';
import { SnippetCode } from '../components/Snippets/SnippetCode';
import { SnippetDocs } from '../components/Snippets/SnippetDocs';
import { Badge, Card, Layout } from '../components/UI';
import { Response } from '../typescript/interfaces';
import { AuthContext } from '../store';
import {
  buildPowerShellRemoteCommand,
  buildRawUrl,
  dateParser,
  isPowerShellLanguage,
  rawRefFor,
  resolveBaseUrl,
  REMOTE_EXECUTE_WARNING
} from '../utils';

interface Params {
  rawRef: string;
}

interface PublicSnippetData {
  id: number;
  title: string;
  description?: string;
  language: string;
  code: string;
  docs?: string;
  collection?: string;
  fileName?: string | null;
  rawSlug?: string | null;
  tags: string[];
  updatedAt: Date;
}

export const PublicSnippet = (): JSX.Element => {
  const { rawRef } = useParams<Params>();
  const [snippet, setSnippet] = useState<PublicSnippetData | null>(null);
  const [error, setError] = useState('');
  const { publicBaseUrl } = useContext(AuthContext);
  const rawUrl = snippet
    ? buildRawUrl(resolveBaseUrl(publicBaseUrl), rawRefFor(snippet))
    : '';
  const powerShellCommand =
    snippet && isPowerShellLanguage(snippet.language)
      ? buildPowerShellRemoteCommand(rawUrl)
      : '';

  useEffect(() => {
    setSnippet(null);
    setError('');
    axios
      .get<Response<PublicSnippetData>>(
        `/api/snippets/public/${encodeURIComponent(rawRef)}`
      )
      .then(res => setSnippet(res.data.data))
      .catch(() => setError('This snippet is not public, or it does not exist.'));
  }, [rawRef]);

  return (
    <Layout classes='public-snippet-page'>
      <div className='col-12'>
        <header className='public-snippet-header'>
          <Link to='/' className='navbar-brand'>
            <img src='/CodeSnippy.png' alt='' />
            <span>SnippyCode</span>
          </Link>
          <div className='public-snippet-header-links'>
            <Link to='/about' className='btn btn-link'>
              About
            </Link>
            <Link to='/' className='btn btn-outline-secondary'>
              Sign in
            </Link>
          </div>
        </header>
      </div>
      {error ? (
        <div className='col-12'>
          <Card>
            <p className='eyebrow'>Public snippet</p>
            <h2>Not available</h2>
            <p>{error}</p>
          </Card>
        </div>
      ) : !snippet ? (
        <div className='col-12'>Loading...</div>
      ) : (
        <>
          {/*
            Every column holds a single card: .app-card is height: 100% so
            cards in a row line up. Putting the code panel in the same column
            as a card made the card grow to the whole column (card + code),
            leaving screens of empty panels above the code.
          */}
          <div className='col-12 col-lg-8'>
            <Card classes='public-snippet-summary'>
              <p className='eyebrow'>{snippet.collection || 'General'}</p>
              <h2>{snippet.title}</h2>
              <p className='snippet-description'>
                {snippet.description || 'No description'}
              </p>
              <div className='public-snippet-tags'>
                {[snippet.language, ...snippet.tags]
                  .filter(
                    (tag, idx, all) =>
                      all.findIndex(t => t.toLowerCase() === tag.toLowerCase()) === idx
                  )
                  .map(tag => (
                    <Badge key={tag} text={tag} color='light' />
                  ))}
              </div>
              <p className='form-text mb-0 mt-3'>
                Updated {dateParser(snippet.updatedAt).relative}
              </p>
            </Card>
          </div>
          <div className='col-12 col-lg-4'>
            <Card classes='public-snippet-actions'>
              <h5 className='card-title'>Raw link</h5>
              <p className='form-text d-none d-sm-block'>
                Public snippets can be fetched without a token.
              </p>
              <code>{rawUrl}</code>
              <div className='mt-2'>
                <button
                  type='button'
                  className='btn btn-sm btn-outline-secondary'
                  onClick={() => copy(rawUrl)}
                >
                  Copy raw URL
                </button>
              </div>
              {powerShellCommand && (
                <div className='remote-execute mt-3'>
                  <h5 className='card-title'>PowerShell remote execute</h5>
                  <code>{powerShellCommand}</code>
                  <div className='mt-2'>
                    <button
                      type='button'
                      className='btn btn-sm btn-outline-secondary'
                      onClick={() => copy(powerShellCommand)}
                    >
                      Copy one-liner
                    </button>
                  </div>
                  <p className='remote-execute-warning' role='note'>
                    {REMOTE_EXECUTE_WARNING}
                  </p>
                </div>
              )}
            </Card>
          </div>
          <div className='col-12 public-snippet-code'>
            <SnippetCode code={snippet.code} language={snippet.language} />
          </div>
          {snippet.docs && (
            <div className='col-12'>
              <Card title='Snippet documentation'>
                <hr />
                <SnippetDocs markdown={snippet.docs} />
              </Card>
            </div>
          )}
        </>
      )}
    </Layout>
  );
};
