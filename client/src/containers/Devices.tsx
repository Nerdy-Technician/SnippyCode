import { useEffect, useMemo, useState } from 'react';
import { Link, useHistory, useLocation } from 'react-router-dom';
import axios from 'axios';
import { Card, Layout } from '../components/UI';
import { DeviceListItem, Response } from '../typescript/interfaces';
import { dateParser } from '../utils';
import { DeviceOsIcon, deviceAddress, formatUptime, osKind } from '../components/Sites/DeviceCard';
import { BulkEnrolPanel } from '../components/Devices/BulkEnrolPanel';

type Status = 'all' | 'online' | 'offline' | 'attention';
type SortKey = 'name' | 'site' | 'lastSeen' | 'disk' | 'memory';

const percent = (used?: number, total?: number): number | null =>
  total && used !== undefined ? Math.round((used / total) * 100) : null;

const MiniBar = (props: { value: number | null; label: string }) =>
  props.value === null ? (
    <span className='text-muted'>—</span>
  ) : (
    <span className='mini-bar' title={`${props.label} ${props.value}%`}>
      <span className={`mini-bar-track ${props.value >= 90 ? 'is-bad' : props.value >= 75 ? 'is-warn' : ''}`}>
        <span style={{ width: `${props.value}%` }} />
      </span>
      <span className='mini-bar-value'>{props.value}%</span>
    </span>
  );

const diskPercent = (device: DeviceListItem) => percent(device.facts.diskUsedGb, device.facts.diskTotalGb);
const memoryPercent = (device: DeviceListItem) =>
  device.facts.memTotalMb !== undefined && device.facts.memAvailableMb !== undefined
    ? percent(device.facts.memTotalMb - device.facts.memAvailableMb, device.facts.memTotalMb)
    : null;

/** Needs a look: offline, nearly full disk, or an outdated agent */
const needsAttention = (device: DeviceListItem): boolean =>
  !device.online || (diskPercent(device) || 0) >= 90 || device.updateAvailable;

export const Devices = (): JSX.Element => {
  const history = useHistory();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const [devices, setDevices] = useState<DeviceListItem[] | null>(null);
  const [query, setQuery] = useState(params.get('q') || '');
  const status = (params.get('status') as Status) || 'all';
  const siteFilter = params.get('site') || '';
  const osFilter = params.get('os') || '';
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false });
  const [bulkOpen, setBulkOpen] = useState(false);

  const load = () =>
    axios
      .get<Response<DeviceListItem[]>>('/api/devices')
      .then(res => setDevices(res.data.data))
      .catch(() => setDevices([]));

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 20_000);
    return () => window.clearInterval(timer);
  }, []);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(location.search);
    if (value) {
      next.set(key, value);
    } else {
      next.delete(key);
    }
    history.replace({ search: next.toString() ? `?${next}` : '' });
  };

  const sites = useMemo(
    () =>
      Array.from(new Map((devices || []).filter(d => d.site).map(d => [d.site!.id, d.site!])).values()).sort((a, b) =>
        a.name.localeCompare(b.name)
      ),
    [devices]
  );

  const counts = {
    all: devices?.length || 0,
    online: (devices || []).filter(d => d.online).length,
    offline: (devices || []).filter(d => !d.online).length,
    attention: (devices || []).filter(needsAttention).length
  };

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    const list = (devices || []).filter(device => {
      const text = `${device.name} ${device.hostname} ${device.facts.osName || device.os} ${deviceAddress(device)} ${device.site?.name || ''}`.toLowerCase();
      return (
        (!term || text.includes(term)) &&
        (status === 'all' ||
          (status === 'online' && device.online) ||
          (status === 'offline' && !device.online) ||
          (status === 'attention' && needsAttention(device))) &&
        (!siteFilter || String(device.site?.id) === siteFilter) &&
        (!osFilter || osKind(device) === osFilter)
      );
    });

    const value = (device: DeviceListItem): string | number => {
      switch (sort.key) {
        case 'site':
          return device.site?.name || '';
        case 'lastSeen':
          return device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
        case 'disk':
          return diskPercent(device) ?? -1;
        case 'memory':
          return memoryPercent(device) ?? -1;
        default:
          return device.name.toLowerCase();
      }
    };

    return list.sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      const order = x < y ? -1 : x > y ? 1 : 0;
      return sort.desc ? -order : order;
    });
  }, [devices, query, status, siteFilter, osFilter, sort]);

  const header = (key: SortKey, label: string) => (
    <th scope='col' aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button type='button' onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : key !== 'name' && key !== 'site' })}>
        {label}
        {sort.key === key && <span aria-hidden='true'>{sort.desc ? ' ↓' : ' ↑'}</span>}
      </button>
    </th>
  );

  return (
    <Layout>
      <div className='col-12'>
        <section className='variables-intro schedules-intro'>
          <div>
            <p className='eyebrow'>Devices</p>
            <h1>Every machine running the agent</h1>
            <p>Open a device for its services, scheduled tasks, processes, software, updates and logs.</p>
          </div>
          <button type='button' className='btn btn-sm btn-primary' onClick={() => setBulkOpen(!bulkOpen)} aria-expanded={bulkOpen}>
            {bulkOpen ? 'Close bulk enrol' : 'Bulk enrol'}
          </button>
        </section>
      </div>

      {bulkOpen ? (
        <div className='col-12'>
          <Card classes='variables-card'>
            <BulkEnrolPanel />
          </Card>
        </div>
      ) : (
        <></>
      )}

      <div className='col-12'>
        <div className='device-summary'>
          {([
            ['all', 'All devices'],
            ['online', 'Online'],
            ['offline', 'Offline'],
            ['attention', 'Need attention']
          ] as [Status, string][]).map(([key, label]) => (
            <button
              key={key}
              type='button'
              className={`device-summary-tile is-${key} ${status === key ? 'is-active' : ''}`}
              onClick={() => setParam('status', key === 'all' ? '' : key)}
            >
              <strong>{counts[key]}</strong>
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className='col-12'>
        <Card classes='variables-card'>
          <div className='device-filters'>
            <input
              className='form-control'
              placeholder='Search name, hostname, IP, OS or site'
              value={query}
              onChange={event => setQuery(event.target.value)}
              aria-label='Search devices'
            />
            <select className='form-control' value={siteFilter} onChange={event => setParam('site', event.target.value)} aria-label='Site'>
              <option value=''>All sites</option>
              {sites.map(site => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
            <select className='form-control' value={osFilter} onChange={event => setParam('os', event.target.value)} aria-label='Operating system'>
              <option value=''>All systems</option>
              <option value='linux'>Linux</option>
              <option value='windows'>Windows</option>
              <option value='mac'>macOS</option>
            </select>
          </div>

          {devices === null ? (
            <p className='text-muted mb-0'>Loading…</p>
          ) : visible.length === 0 ? (
            <div className='site-empty'>
              <p>
                {devices.length === 0
                  ? 'No devices yet. Open a site and use Devices → Add device to install the agent.'
                  : 'No devices match these filters.'}
              </p>
              {devices.length === 0 && (
                <Link to='/sites' className='btn btn-sm btn-outline-secondary'>
                  Go to sites
                </Link>
              )}
            </div>
          ) : (
            <div className='values-table-wrap'>
              <table className='device-table'>
                <thead>
                  <tr>
                    {header('name', 'Device')}
                    {header('site', 'Site')}
                    <th scope='col'>Address</th>
                    {header('memory', 'Memory')}
                    {header('disk', 'Disk')}
                    <th scope='col'>Uptime</th>
                    {header('lastSeen', 'Last seen')}
                    <th scope='col'>Last job</th>
                    <th scope='col'>Agent</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(device => (
                    <tr
                      key={device.id}
                      className={device.online ? '' : 'is-offline'}
                      onClick={event => {
                        if (!(event.target as HTMLElement).closest('a')) {
                          history.push(`/devices/${device.id}`);
                        }
                      }}
                    >
                      <td>
                        <div className='device-table-name'>
                          <DeviceOsIcon device={device} size={0.8} />
                          <div>
                            <Link to={`/devices/${device.id}`}>{device.name}</Link>
                            <span>{device.facts.osName || device.os}</span>
                          </div>
                        </div>
                      </td>
                      <td>{device.site ? <Link to={`/sites/${device.site.id}?tab=devices`}>{device.site.name}</Link> : '—'}</td>
                      <td className='mono'>{deviceAddress(device)}</td>
                      <td>
                        <MiniBar value={memoryPercent(device)} label='Memory used' />
                      </td>
                      <td>
                        <MiniBar value={diskPercent(device)} label='Disk used' />
                      </td>
                      <td>{formatUptime(device.facts.uptimeSeconds)}</td>
                      <td>
                        <span className={`device-status ${device.online ? 'is-online' : ''}`}>
                          <span className={`device-dot ${device.online ? 'is-online' : ''}`} />
                          {device.online ? 'Online' : device.lastSeenAt ? dateParser(device.lastSeenAt).relative : 'Never'}
                        </span>
                      </td>
                      <td>
                        {device.lastRun ? (
                          <span className='device-last-run'>
                            <span className={`run-status ${device.lastRun.ok ? 'is-ok' : 'is-bad'}`}>{device.lastRun.ok ? 'OK' : 'Failed'}</span>
                            <span title={device.lastRun.snippetTitle}>{device.lastRun.snippetTitle}</span>
                          </span>
                        ) : (
                          <span className='text-muted'>—</span>
                        )}
                      </td>
                      <td>
                        {device.agentVersion || '?'}
                        {device.updateAvailable && <span className='device-update-badge'>update</span>}
{device.clonePendingApproval && (
                          <span className='device-update-badge device-pending-badge' title='A self-enrolled clone; it gets no jobs until an admin approves it'>
                            Pending approval
                          </span>
                        )}
                        {device.fingerprintPendingReview && (
                          <span className='device-update-badge device-duplicate-badge' title='The first hardware fingerprint came from an unexpected address'>
                            fingerprint review
                          </span>
                        )}
{device.possibleDuplicate && (
                          <span
                            className='device-update-badge device-duplicate-badge'
                            title={`Possible duplicate of device ${(device.duplicateOf || []).map(id => `#${id}`).join(', ')}`}
                          >
                            possible duplicate
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Layout>
  );
};
