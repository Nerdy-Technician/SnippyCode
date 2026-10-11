import { useCallback, useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuthContext, SnippetsContext } from '../store';
import { Card, Layout } from '../components/UI';
import { AlertList } from '../components/Alerts/AlertList';
import { AlertCounts } from '../typescript/interfaces';
import { canAdmin } from '../utils';
import { hasMinimumRole } from '../utils/roles';

export const Alerts = (): JSX.Element => {
  const { user } = useContext(AuthContext);
  const { sites, getSites } = useContext(SnippetsContext);
  const [siteId, setSiteId] = useState('');
  const [severity, setSeverity] = useState('');
  const [counts, setCounts] = useState<AlertCounts | null>(null);
  const onCounts = useCallback((next: AlertCounts) => setCounts(next), []);

  useEffect(() => {
    getSites();
  }, []);

  const tiles = [
    { label: 'Active', value: counts?.active, tone: counts?.active ? 'warn' : 'ok' },
    { label: 'Critical', value: counts?.critical, tone: counts?.critical ? 'bad' : 'ok' },
    { label: 'Not acknowledged', value: counts?.unacknowledged, tone: counts?.unacknowledged ? 'warn' : 'ok' },
    { label: 'Snoozed', value: counts?.snoozed, tone: 'plain' }
  ];

  return (
    <Layout>
      <div className='col-12'>
        <section className='variables-intro'>
          <div>
            <p className='eyebrow'>Alerts</p>
            <h1>Open alerts across every site</h1>
            <p>
              Monitors from your <Link to='/policies'>policies</Link> check each device as it reports in. Alerts close on their own once the
              problem clears; acknowledge them to show someone is on it, or snooze them to silence notifications for a while.
            </p>
          </div>
          {canAdmin(user?.role) && (
            <Link className='btn btn-outline-secondary' to='/policies'>
              Manage policies
            </Link>
          )}
        </section>
      </div>

      <div className='col-12'>
        <div className='alert-tiles'>
          {tiles.map(tile => (
            <div key={tile.label} className={`alert-tile is-${tile.tone}`}>
              <strong>{tile.value ?? '—'}</strong>
              <span>{tile.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className='col-12'>
        <Card classes='variables-card'>
          <div className='alert-filters'>
            <select className='form-select form-select-sm' value={siteId} onChange={event => setSiteId(event.target.value)} aria-label='Site'>
              <option value=''>All sites</option>
              {sites.map(site => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
            <select className='form-select form-select-sm' value={severity} onChange={event => setSeverity(event.target.value)} aria-label='Severity'>
              <option value=''>Any severity</option>
              <option value='critical'>Critical</option>
              <option value='warning'>Warning</option>
            </select>
          </div>
          <AlertList
            query={{ siteId: Number(siteId) || undefined, severity: severity || undefined }}
            canAct={hasMinimumRole(user?.role, 'user')}
            onCounts={onCounts}
          />
        </Card>
      </div>
    </Layout>
  );
};
