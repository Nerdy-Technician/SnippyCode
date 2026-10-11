import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { AlertCounts, AlertItem, Response } from '../../typescript/interfaces';
import { dateParser } from '../../utils';
import { apiError } from '../Variables/VariableFields';

type Status = 'active' | 'open' | 'acknowledged' | 'resolved' | 'all';

const since = (iso?: string | null) => (iso ? dateParser(iso).relative : '—');

const duration = (from: string, to?: string | null) => {
  const minutes = Math.round(((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 6) / 10} h`;
  return `${Math.round(minutes / 1440)} d`;
};

const SNOOZE_OPTIONS = [
  { minutes: 60, label: '1 hour' },
  { minutes: 240, label: '4 hours' },
  { minutes: 1440, label: '1 day' },
  { minutes: 10080, label: '1 week' }
];

export const SeverityBadge = (props: { severity: AlertItem['severity'] }) => (
  <span className={`alert-severity is-${props.severity}`}>
    <span aria-hidden='true'>{props.severity === 'critical' ? '●' : '▲'}</span>
    {props.severity === 'critical' ? 'Critical' : 'Warning'}
  </span>
);

/**
 * Alerts with selection and bulk acknowledge / snooze / resolve. Filters
 * (site, device, severity) come from the parent.
 */
export const AlertList = (props: {
  query?: { siteId?: number; deviceId?: number; severity?: string };
  showSite?: boolean;
  showDevice?: boolean;
  canAct: boolean;
  initialStatus?: Status;
  onCounts?: (counts: AlertCounts) => void;
  empty?: string;
}) => {
  const [status, setStatus] = useState<Status>(props.initialStatus || 'active');
  const [alerts, setAlerts] = useState<AlertItem[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const { siteId, deviceId, severity } = props.query || {};
  const { onCounts } = props;

  const load = useCallback(
    () =>
      axios
        .get<Response<AlertItem[]> & { counts: AlertCounts }>('/api/alerts', {
          params: { status, siteId, deviceId, severity: severity || undefined }
        })
        .then(res => {
          setAlerts(res.data.data);
          onCounts?.(res.data.counts);
          setSelected(current => new Set(Array.from(current).filter(id => res.data.data.some(alert => alert.id === id))));
        })
        .catch(err => setError(apiError(err, 'Could not load alerts.'))),
    [status, siteId, deviceId, severity, onCounts]
  );

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (action: string, ids: number[], minutes?: number) => {
    if (!ids.length) return;
    setWorking(true);
    setError('');
    try {
      await axios.post('/api/alerts/action', { ids, action, minutes });
      await load();
      setSelected(new Set());
    } catch (err) {
      setError(apiError(err, 'Could not update the alerts.'));
    } finally {
      setWorking(false);
    }
  };

  const toggle = (id: number) =>
    setSelected(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectable = (alerts || []).filter(alert => alert.status !== 'resolved');
  const ids = Array.from(selected);
  const allSelected = selectable.length > 0 && selectable.every(alert => selected.has(alert.id));

  return (
    <div className='alert-list'>
      <div className='device-toolbar'>
        <div className='segmented' role='group' aria-label='Alert status'>
          {(['active', 'open', 'acknowledged', 'resolved'] as Status[]).map(item => (
            <button key={item} type='button' className={status === item ? 'is-active' : ''} onClick={() => setStatus(item)}>
              {item === 'active' ? 'Active' : item === 'open' ? 'Unacknowledged' : item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </div>
        {props.canAct && ids.length > 0 && (
          <div className='alert-bulk'>
            <span className='form-text'>{ids.length} selected</span>
            <button type='button' className='btn btn-sm btn-outline-secondary' disabled={working} onClick={() => act('acknowledge', ids)}>
              Acknowledge
            </button>
            <select
              className='form-select form-select-sm'
              aria-label='Snooze selected alerts'
              value=''
              disabled={working}
              onChange={event => act('snooze', ids, Number(event.target.value))}
            >
              <option value='' disabled>
                Snooze…
              </option>
              {SNOOZE_OPTIONS.map(option => (
                <option key={option.minutes} value={option.minutes}>
                  {option.label}
                </option>
              ))}
            </select>
            <button type='button' className='btn btn-sm btn-outline-secondary' disabled={working} onClick={() => act('resolve', ids)}>
              Resolve
            </button>
          </div>
        )}
      </div>

      {error && <div className='alert alert-danger'>{error}</div>}

      {alerts === null ? (
        <p className='text-muted mb-0'>Loading…</p>
      ) : alerts.length === 0 ? (
        <p className='site-all-good'>✓ {props.empty || (status === 'resolved' ? 'Nothing resolved yet.' : 'No alerts. Everything monitored looks healthy.')}</p>
      ) : (
        <div className='values-table-wrap'>
          <table className='values-table alert-table'>
            <thead>
              <tr>
                {props.canAct && (
                  <th className='alert-check'>
                    <input
                      type='checkbox'
                      className='form-check-input'
                      aria-label='Select all'
                      checked={allSelected}
                      disabled={!selectable.length}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map(alert => alert.id)))}
                    />
                  </th>
                )}
                <th>Alert</th>
                {props.showDevice !== false && <th>Device</th>}
                {props.showSite !== false && <th>Site</th>}
                <th>Opened</th>
                <th>State</th>
                {props.canAct && <th className='text-end'>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {alerts.map(alert => (
                <tr key={alert.id} className={`${alert.status === 'resolved' ? 'is-resolved' : ''} ${alert.snoozed ? 'is-snoozed' : ''}`}>
                  {props.canAct && (
                    <td className='alert-check'>
                      {alert.status !== 'resolved' && (
                        <input
                          type='checkbox'
                          className='form-check-input'
                          aria-label={`Select ${alert.title}`}
                          checked={selected.has(alert.id)}
                          onChange={() => toggle(alert.id)}
                        />
                      )}
                    </td>
                  )}
                  <td>
                    <div className='alert-title'>
                      <SeverityBadge severity={alert.severity} />
                      <button type='button' className='btn btn-link p-0 text-start' onClick={() => setOpen(open === alert.id ? null : alert.id)}>
                        {alert.title}
                      </button>
                    </div>
                    {(open === alert.id || alert.detail.length < 90) && alert.detail && <div className='tool-sub alert-detail'>{alert.detail}</div>}
                    {open === alert.id && (
                      <div className='tool-sub'>
                        {alert.policy && <>Policy {alert.policy} · </>}
                        Last checked {since(alert.lastSeenAt)}
                        {alert.acknowledgedBy && <> · acknowledged by {alert.acknowledgedBy}</>}
                        {alert.resolvedAt && <> · resolved {alert.resolvedBy === 'auto' ? 'automatically' : `by ${alert.resolvedBy || 'someone'}`}</>}
                      </div>
                    )}
                  </td>
                  {props.showDevice !== false && (
                    <td>{alert.device ? <Link to={`/devices/${alert.device.id}?tab=alerts`}>{alert.device.name}</Link> : '—'}</td>
                  )}
                  {props.showSite !== false && <td>{alert.site ? <Link to={`/sites/${alert.site.id}?tab=alerts`}>{alert.site.name}</Link> : '—'}</td>}
                  <td className='tool-sub' title={new Date(alert.createdAt).toLocaleString()}>
                    {since(alert.createdAt)}
                    <div>{alert.status === 'resolved' ? `lasted ${duration(alert.createdAt, alert.resolvedAt)}` : `for ${duration(alert.createdAt)}`}</div>
                  </td>
                  <td>
                    <span className={`alert-state is-${alert.status}`}>
                      {alert.status === 'open' ? 'Open' : alert.status === 'acknowledged' ? 'Acknowledged' : 'Resolved'}
                    </span>
                    {alert.snoozed && alert.snoozedUntil && (
                      <div className='tool-sub'>Snoozed until {new Date(alert.snoozedUntil).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</div>
                    )}
                  </td>
                  {props.canAct && (
                    <td className='text-end alert-actions'>
                      {alert.status === 'open' && (
                        <button type='button' className='btn btn-sm btn-outline-secondary' disabled={working} onClick={() => act('acknowledge', [alert.id])}>
                          Ack
                        </button>
                      )}
                      {alert.status !== 'resolved' &&
                        (alert.snoozed ? (
                          <button type='button' className='btn btn-sm btn-outline-secondary' disabled={working} onClick={() => act('unsnooze', [alert.id])}>
                            Unsnooze
                          </button>
                        ) : (
                          <button type='button' className='btn btn-sm btn-outline-secondary' disabled={working} onClick={() => act('snooze', [alert.id], 240)} title='Snooze for 4 hours'>
                            Snooze 4h
                          </button>
                        ))}
                      {alert.status !== 'resolved' && (
                        <button type='button' className='btn btn-sm btn-outline-secondary' disabled={working} onClick={() => act('resolve', [alert.id])}>
                          Resolve
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {props.canAct && status !== 'resolved' && alerts && alerts.length > 0 && (
        <p className='form-text mb-0 mt-2'>
          Alerts resolve on their own when the monitor passes again. Resolving one by hand while the problem remains opens a new alert on the next check.
          Snoozed alerts stay listed but send no notifications.
        </p>
      )}
    </div>
  );
};
