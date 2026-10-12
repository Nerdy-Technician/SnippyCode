import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { Card } from '../UI';
import { apiError } from '../Variables/VariableFields';

interface SiteOption {
  id: number;
  name: string;
}

// GET /api/sites answers { sites, canManage }; accept a bare list too
type SitesResponse = { sites?: SiteOption[] } | SiteOption[] | null | undefined;

export const siteList = (data: SitesResponse): SiteOption[] => {
  const list = Array.isArray(data) ? data : data?.sites;
  return Array.isArray(list) ? list : [];
};

interface ImportResult {
  runbookId: number;
  created: { snippets: number; runbook: boolean; variables: number };
}

interface Props {
  onImported?: (result: ImportResult) => void;
}

export const ImportExampleRunbook = ({ onImported }: Props): JSX.Element => {
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [siteId, setSiteId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    axios
      .get<{ data: SitesResponse }>('/api/sites')
      .then(res => {
        const list = siteList(res.data?.data);
        setSites(list);
        if (list.length === 1) {
          setSiteId(String(list[0].id));
        }
      })
      .catch(() => setSites([]));
  }, []);

  const importExample = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await axios.post<{ data: ImportResult }>('/api/runbooks/example', { siteId: Number(siteId) });
      setResult(res.data.data);
      onImported?.(res.data.data);
    } catch (err) {
      setError(apiError(err, 'Could not import the example runbook.'));
    } finally {
      setBusy(false);
    }
  };

  const nothingNew =
    result && !result.created.runbook && !result.created.snippets && !result.created.variables;

  return (
    <Card classes='variables-card import-example'>
      <h2 className='h6'>Example runbook</h2>
      <p className='text-muted small'>
        Adds a "Linux disk cleanup" runbook, its snippets and site variables with safe defaults.
        Importing again reuses what is already there.
      </p>
      <div className='d-flex gap-2'>
        <select className='form-select' aria-label='Site' value={siteId} onChange={e => setSiteId(e.target.value)}>
          <option value=''>Choose a site…</option>
          {sites.map(site => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </select>
        <button type='button' className='btn btn-outline-primary text-nowrap' disabled={!siteId || busy} onClick={importExample}>
          Import example runbook
        </button>
      </div>
      {error && <div className='alert alert-danger mt-2 mb-0'>{error}</div>}
      {result && (
        <div className='alert alert-success mt-2 mb-0'>
          {nothingNew
            ? 'Already imported, nothing new was added. '
            : `Imported ${result.created.snippets} snippet(s), ${result.created.variables} site variable(s)${result.created.runbook ? ' and the runbook' : ''}. `}
          <Link to={`/runbooks/${result.runbookId}`}>Open the runbook</Link>
        </div>
      )}
    </Card>
  );
};
