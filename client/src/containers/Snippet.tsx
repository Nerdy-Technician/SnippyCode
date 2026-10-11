import { Fragment, useContext, useEffect, useMemo, useState } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import { SnippetCode } from '../components/Snippets/SnippetCode';
import { Layout, PageHeader, Card } from '../components/UI';
import { SnippetsContext } from '../store';
import { SnippetDetails } from '../components/Snippets/SnippetDetails';
import { SnippetDocs } from '../components/Snippets/SnippetDocs';
import { SnippetVariables } from '../components/Snippets/SnippetVariables';
import { renderForDisplay, resolveVariables } from '../utils';

interface Params {
  id: string;
}

export const Snippet = (): JSX.Element => {
  const { currentSnippet, getSnippetById, trackActivity, variables, sites, selectedSiteId } =
    useContext(SnippetsContext);
  const { id } = useParams<Params>();
  const [inputs, setInputs] = useState<Record<string, string>>({});

  // Get previous location
  const location = useLocation<{ from: string }>();
  const { from } = location.state || '/snippets';

  useEffect(() => {
    setInputs({});
    // Record the view first so the loaded usage counts include it
    trackActivity(+id, 'view').then(() => getSnippetById(+id));
  }, [id]);

  const snippet = currentSnippet && currentSnippet.id === +id ? currentSnippet : null;
  const site = sites.find(item => item.id === selectedSiteId) || null;

  const resolved = useMemo(
    () =>
      snippet
        ? resolveVariables(snippet.code, {
            inputs,
            personal: variables.personal,
            site: site ? variables.site.filter(item => item.siteId === site.id) : [],
            team: variables.team
          })
        : [],
    [snippet, variables, inputs, site]
  );

  const displayCode = snippet ? renderForDisplay(snippet.code, resolved) : '';

  return (
    <Layout>
      {!snippet ? (
        <div className='col-12'>Loading...</div>
      ) : (
        <Fragment>
          <PageHeader title='' prevDest={from} />
          <div className='col-12 col-md-7 col-lg-8 mt-3'>
            {resolved.length > 0 && (
              <SnippetVariables
                variables={resolved}
                siteName={site?.name || null}
                onChange={(name, value) => setInputs(current => ({ ...current, [name]: value }))}
                onReset={() => setInputs({})}
              />
            )}
            <SnippetCode code={displayCode} language={snippet.language} />
          </div>
          <div className='col-12 col-md-5 col-lg-4 mt-md-3'>
            <SnippetDetails snippet={snippet} variables={resolved} inputs={inputs} />
          </div>
          {snippet.docs && (
            <div className='col-12'>
              <Card title='Snippet documentation'>
                <hr />
                <SnippetDocs markdown={snippet.docs} />
              </Card>
            </div>
          )}
        </Fragment>
      )}
    </Layout>
  );
};
