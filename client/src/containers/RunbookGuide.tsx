import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { Card, Layout } from '../components/UI';
import { SnippetDocs } from '../components/Snippets/SnippetDocs';

// Renders docs/playbooks.md, served by this SnippyCode server (works offline)
export const RunbookGuide = (): JSX.Element => {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    axios
      .get<{ data: { markdown: string } }>('/api/help/playbooks')
      .then(res => setMarkdown(res.data.data.markdown))
      .catch(() => setError('The runbook guide could not be loaded.'));
  }, []);

  return (
    <Layout>
      <div className='col-12'>
        <Link to='/runbooks' className='back-link'>
          All runbooks
        </Link>
      </div>
      <div className='col-12 col-lg-9'>
        <Card classes='runbook-guide'>
          {error && <div className='alert alert-danger mb-0'>{error}</div>}
          {!error && markdown === null && <p className='text-muted mb-0'>Loading the guide…</p>}
          {markdown !== null && <SnippetDocs markdown={markdown} />}
        </Card>
      </div>
    </Layout>
  );
};
