import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import axios from 'axios';
import { SnippetCode } from '../components/Snippets/SnippetCode';
import { SnippetDocs } from '../components/Snippets/SnippetDocs';
import { Badge, Card, Layout } from '../components/UI';
import { Response } from '../typescript/interfaces';

type Params = {
  rawRef: string;
};

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
  const { rawRef = '' } = useParams<Params>();
  const [snippet, setSnippet] = useState<PublicSnippetData | null>(null);
  const [error, setError] = useState('');

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
          <Link to='/' className='btn btn-outline-secondary'>
            Sign in
          </Link>
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
              <code>{`/raw/${snippet.rawSlug || snippet.id}`}</code>
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
