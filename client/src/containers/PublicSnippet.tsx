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
  updatedAt: string;
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
          <div className='col-12 col-md-7 col-lg-8'>
            <Card>
              <p className='eyebrow'>{snippet.collection || 'General'}</p>
              <h2>{snippet.title}</h2>
              <p className='snippet-description'>
                {snippet.description || 'No description'}
              </p>
              <Badge text={snippet.language} color='light' />
            </Card>
            <div className='mt-3'>
              <SnippetCode code={snippet.code} language={snippet.language} />
            </div>
          </div>
          <div className='col-12 col-md-5 col-lg-4'>
            <Card>
              <h5 className='card-title'>Raw link</h5>
              <p className='form-text'>
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
