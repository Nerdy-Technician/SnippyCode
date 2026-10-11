import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { Device, PatchRow, Response, Site, SiteHealth } from '../../typescript/interfaces';
import { dateParser } from '../../utils';
import { DeviceOsIcon } from './DeviceCard';

export const useSitesHealth = () => {
  const [health, setHealth] = useState<{ [siteId: number]: SiteHealth } | null>(null);

  useEffect(() => {
    const load = () =>
      axios
        .get<Response<{ [siteId: number]: SiteHealth }>>('/api/sites/health')
        .then(res => setHealth(res.data.data))
        .catch(() => setHealth({}));
    load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return health;
};

const EMPTY: SiteHealth = { devices: 0, online: 0, alerts: 0, critical: 0, compliance: null, runs30d: 0, lastActivityAt: null };

/** The worst thing about a site, for the card's status line */
const siteState = (item: SiteHealth): { tone: 'ok' | 'warn' | 'bad' | 'idle'; text: string } => {
  if (item.critical) return { tone: 'bad', text: `${item.critical} critical alert${item.critical === 1 ? '' : 's'}` };
  if (item.devices && item.online < item.devices) return { tone: 'bad', text: `${item.devices - item.online} device${item.devices - item.online === 1 ? '' : 's'} offline` };
  if (item.alerts) return { tone: 'warn', text: `${item.alerts} open alert${item.alerts === 1 ? '' : 's'}` };
  if (item.compliance !== null && item.compliance < 100) return { tone: 'warn', text: 'Updates waiting' };
  if (!item.devices) return { tone: 'idle', text: 'No devices yet' };
  return { tone: 'ok', text: 'Healthy' };
};

const STATE_ICON = { ok: '✓', warn: '▲', bad: '●', idle: '○' };

export const SiteHealthGrid = (props: { sites: Site[]; health: { [siteId: number]: SiteHealth } | null; selectedSiteId: number | null }) => {
  const [sort, setSort] = useState<'attention' | 'name'>('attention');
  const rank = { bad: 0, warn: 1, ok: 2, idle: 3 };
  const rows = props.sites
    .map(site => ({ site, item: props.health?.[site.id] || EMPTY }))
    .sort((a, b) =>
      sort === 'name'
        ? a.site.name.localeCompare(b.site.name)
        : rank[siteState(a.item).tone] - rank[siteState(b.item).tone] || b.item.alerts - a.item.alerts || a.site.name.localeCompare(b.site.name)
    );

  return (
    <>
      <div className='site-grid-toolbar'>
        <span className='form-text'>
          {props.sites.length} site{props.sites.length === 1 ? '' : 's'}
        </span>
        <div className='segmented'>
          <button type='button' className={sort === 'attention' ? 'is-active' : ''} onClick={() => setSort('attention')}>
            Needs attention first
          </button>
          <button type='button' className={sort === 'name' ? 'is-active' : ''} onClick={() => setSort('name')}>
            A–Z
          </button>
        </div>
      </div>
      <div className='site-health-grid'>
        {rows.map(({ site, item }) => {
          const state = siteState(item);
          const onlinePct = item.devices ? Math.round((item.online / item.devices) * 100) : 0;
          return (
            <Link key={site.id} to={`/sites/${site.id}`} className={`site-health-card is-${state.tone}`}>
              <div className='site-health-head'>
                <div>
                  <h3>
                    {site.access === 'members' && <span title='Members only'>🔒 </span>}
                    {site.name}
                  </h3>
                  <div className='site-health-tags'>
                    {site.tags.map(tag => (
                      <span key={tag} className='site-tag'>
                        {tag}
                      </span>
                    ))}
                    {props.selectedSiteId === site.id && <span className='site-selected'>✓ in use</span>}
                  </div>
                </div>
                <span className={`site-health-state is-${state.tone}`}>
                  <span aria-hidden='true'>{STATE_ICON[state.tone]}</span> {state.text}
                </span>
              </div>

              <div className='site-health-devices'>
                <div className='site-health-label'>
                  <span>Devices online</span>
                  <strong>
                    {item.online}
                    <small>/{item.devices}</small>
                  </strong>
                </div>
                <div className='site-health-bar' role='img' aria-label={`${item.online} of ${item.devices} devices online`}>
                  <span style={{ width: `${onlinePct}%` }} />
                </div>
              </div>

              <dl className='site-health-stats'>
                <div className={item.alerts ? (item.critical ? 'is-bad' : 'is-warn') : ''}>
                  <dt>Open alerts</dt>
                  <dd>{item.alerts}</dd>
                </div>
                <div className={item.compliance !== null && item.compliance < 100 ? 'is-warn' : ''}>
                  <dt>Patched</dt>
                  <dd>{item.compliance === null ? '—' : `${item.compliance}%`}</dd>
                </div>
                <div>
                  <dt>Runs (30d)</dt>
                  <dd>{item.runs30d}</dd>
                </div>
              </dl>
              <p className='site-health-foot'>
                {item.lastActivityAt ? `Last activity ${dateParser(item.lastActivityAt).relative}` : 'No activity yet'}
                {site.variableCount ? ` · ${site.variableCount} values` : ''}
              </p>
            </Link>
          );
        })}
      </div>
    </>
  );
};

export const SitePatching = (props: { siteId: number }) => {
  const [data, setData] = useState<{ compliance: number | null; devices: PatchRow[] } | null>(null);

  useEffect(() => {
    setData(null);
    axios
      .get<Response<{ compliance: number | null; devices: PatchRow[] }>>(`/api/sites/${props.siteId}/patching`)
      .then(res => setData(res.data.data))
      .catch(() => setData({ compliance: null, devices: [] }));
  }, [props.siteId]);

  if (!data) return <p className='text-muted mb-0'>Loading…</p>;
  if (!data.devices.length) return <p className='text-muted mb-0'>No devices are enrolled at this site.</p>;

  const counts = {
    compliant: data.devices.filter(row => row.compliant === true).length,
    behind: data.devices.filter(row => row.compliant === false).length,
    unknown: data.devices.filter(row => row.compliant === null).length
  };

  return (
    <>
      <div className='patch-summary'>
        <div className='trend-hero'>
          <strong>{data.compliance === null ? '—' : `${data.compliance}%`}</strong>
          <span>of checked devices are up to date</span>
        </div>
        <ul className='patch-counts'>
          <li className='is-ok'>
            <span aria-hidden='true'>✓</span> {counts.compliant} up to date
          </li>
          <li className='is-bad'>
            <span aria-hidden='true'>●</span> {counts.behind} need updates or a restart
          </li>
          <li>
            <span aria-hidden='true'>○</span> {counts.unknown} not checked in 7 days
          </li>
        </ul>
      </div>
      <div className='values-table-wrap'>
        <table className='values-table tool-table'>
          <thead>
            <tr>
              <th>Device</th>
              <th>Status</th>
              <th className='text-end'>Security</th>
              <th className='text-end'>All updates</th>
              <th>Last patched</th>
              <th>Patch window</th>
            </tr>
          </thead>
          <tbody>
            {data.devices.map(row => (
              <tr key={row.id}>
                <td>
                  <Link to={`/devices/${row.id}?tab=updates`} className='patch-device'>
                    <DeviceOsIcon device={{ os: row.os, facts: {} } as unknown as Device} size={0.8} />
                    {row.name}
                  </Link>
                  {!row.online && <div className='tool-sub'>offline</div>}
                </td>
                <td>
                  {row.compliant === null ? (
                    <span className='patch-state'>○ Not checked</span>
                  ) : row.compliant ? (
                    <span className='patch-state is-ok'>✓ Up to date</span>
                  ) : (
                    <span className='patch-state is-bad'>● {row.security ? 'Security updates' : 'Restart needed'}</span>
                  )}
                  {row.checkedAt && <div className='tool-sub'>checked {dateParser(row.checkedAt).relative}</div>}
                </td>
                <td className='text-end'>{row.checkedAt ? row.security : '—'}</td>
                <td className='text-end'>
                  {row.checkedAt ? row.pending : '—'}
                  {row.reboot && <div className='tool-sub'>restart pending</div>}
                </td>
                <td className='tool-sub'>
                  {row.lastPatch ? (
                    <>
                      {dateParser(row.lastPatch.at).relative}
                      <div>{row.lastPatch.status === 'done' ? 'succeeded' : row.lastPatch.status}</div>
                    </>
                  ) : (
                    'Never through SnippyCode'
                  )}
                </td>
                <td className='tool-sub'>
                  {row.window ? (
                    <>
                      {row.window.policy}
                      {row.window.nextAt && <div>next {dateParser(row.window.nextAt).relative}</div>}
                    </>
                  ) : (
                    <Link to='/policies'>None</Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className='form-text mb-0 mt-2'>
        A device is up to date when it has no security updates waiting and needs no restart, as of a check in the last 7 days. Install updates from
        each device’s Updates tab, or on a schedule with a policy’s patch window.
      </p>
    </>
  );
};

const lastMonths = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - index);
    return {
      value: date.toISOString().slice(0, 7),
      label: date.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    };
  });

export const SiteReport = (props: { siteId: number; siteName: string }) => {
  const months = lastMonths(12);
  const [month, setMonth] = useState(months[0].value);
  // Only ever link to a month from the list, never raw DOM text
  const safeMonth = months.some(item => item.value === month) ? month : months[0].value;
  const url = `/api/sites/${encodeURIComponent(String(props.siteId))}/report?month=${encodeURIComponent(safeMonth)}`;

  return (
    <div className='site-report'>
      <div className='device-toolbar'>
        <select className='form-select form-select-sm site-report-month' value={month} onChange={event => setMonth(event.target.value)} aria-label='Month'>
          {months.map(item => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <a className='btn btn-sm btn-primary' href={url} target='_blank' rel='noreferrer'>
          Open to print or save as PDF
        </a>
        <a className='btn btn-sm btn-outline-secondary' href={`${url}&download=1`}>
          Download HTML
        </a>
        <span className='form-text'>Uptime, patch status, disk trends, alerts and work done for {props.siteName}.</span>
      </div>
      <iframe className='site-report-frame' title={`${props.siteName} report`} src={url} />
    </div>
  );
};
