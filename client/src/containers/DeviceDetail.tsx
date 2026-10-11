import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useHistory, useLocation, useParams } from 'react-router-dom';
import axios from 'axios';
import { Card, Layout } from '../components/UI';
import {
  AgentJobState,
  DeviceDetail as Detail,
  InventoryEntry,
  LogEntry,
  ProcessInfo,
  ReadToolId,
  Response,
  ServiceInfo,
  SoftwareInfo,
  SystemAudit,
  TaskInfo,
  ToolJob,
  UpdateInfo
} from '../typescript/interfaces';
import { dateParser } from '../utils';
import { DeviceOsIcon, deviceAddress, formatUptime } from '../components/Sites/DeviceCard';
import { DeviceRunModal } from '../components/Sites/DeviceRunModal';
import { RunHistory, RunOutput } from '../components/Runs/RunHistory';
import { apiError } from '../components/Variables/VariableFields';
import {
  CronEditor,
  changeCronLine,
  describeCron,
  isSystemTarget,
  targetLabel
} from '../components/Devices/CronEditor';
import { PerformanceTab } from '../components/Devices/PerformanceTab';
import { FilesTab } from '../components/Devices/FilesTab';
import { TerminalTab } from '../components/Devices/TerminalTab';
import { DeviceFieldsCard } from '../components/Devices/DeviceFieldsCard';
import { DeviceTagsEditor } from '../components/Devices/DeviceTagsEditor';
import { AlertList } from '../components/Alerts/AlertList';
import { AuthContext } from '../store';
import { hasMinimumRole } from '../utils/roles';

const TABS = ['summary', 'performance', 'alerts', 'services', 'tasks', 'processes', 'software', 'updates', 'files', 'logs', 'shell', 'activity'] as const;
type Tab = typeof TABS[number];

const TAB_LABELS: { [tab in Tab]: string } = {
  summary: 'Summary',
  performance: 'Performance',
  alerts: 'Alerts',
  services: 'Services',
  tasks: 'Scheduled tasks',
  processes: 'Processes',
  software: 'Software',
  updates: 'Updates',
  logs: 'Event log',
  files: 'Files',
  shell: 'Terminal',
  activity: 'Activity'
};

// Which inventory a tab shows, and how old it may get before we refresh it
const TAB_TOOL: { [tab in Tab]?: ReadToolId } = {
  summary: 'system',
  services: 'services',
  tasks: 'tasks',
  processes: 'processes',
  software: 'software',
  updates: 'updates',
  logs: 'logs'
};
const STALE_MINUTES: { [tool in ReadToolId]: number } = {
  system: 60,
  services: 10,
  tasks: 30,
  processes: 1,
  software: 24 * 60,
  updates: 6 * 60,
  logs: 10
};

const FINISHED = ['done', 'failed', 'expired'];

const since = (iso?: string | null) => (iso ? dateParser(iso).relative : 'never');

const localTime = (value?: string): string => {
  if (!value) return '—';
  const date = new Date(value.replace(/ [A-Z]{2,5}$/, ''));
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

// Tool runner ------------------------------------------------------------------

const useDevice = (id: number) => {
  const [device, setDevice] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<{ [key: string]: boolean }>({});
  const [notice, setNotice] = useState<{ ok: boolean; text: string; run?: AgentJobState['run'] } | null>(null);
  const timers = useRef<number[]>([]);

  const load = useCallback(
    () =>
      axios
        .get<Response<Detail>>(`/api/devices/${id}`)
        .then(res => setDevice(res.data.data))
        .catch(() => setError('This device does not exist, was revoked, or you do not have access to its site.')),
    [id]
  );

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      window.clearInterval(timer);
      timers.current.forEach(window.clearInterval);
    };
  }, [load]);

  /** Queue a tool and resolve when the agent reports back */
  const runTool = (tool: string, args?: Record<string, unknown>, key = tool): Promise<AgentJobState | null> => {
    setBusy(current => ({ ...current, [key]: true }));

    return new Promise(resolve => {
      axios
        .post<Response<ToolJob>>(`/api/devices/${id}/tools/${tool}`, { args })
        .then(res => {
          const jobId = res.data.data.id;
          const timer = window.setInterval(async () => {
            try {
              const status = await axios.get<Response<AgentJobState[]>>('/api/devices/jobs', { params: { ids: jobId } });
              const job = status.data.data[0];

              if (job && FINISHED.includes(job.status)) {
                window.clearInterval(timer);
                setBusy(current => ({ ...current, [key]: false }));
                await load();
                resolve(job);
              }
            } catch {
              // keep polling
            }
          }, 1200);
          timers.current.push(timer);
        })
        .catch(err => {
          setBusy(current => ({ ...current, [key]: false }));
          setNotice({ ok: false, text: apiError(err, 'Could not reach the device.') });
          resolve(null);
        });
    });
  };

  /** Run an action, report its result, then refresh the related list */
  const act = async (tool: string, args: Record<string, unknown>, key: string, refresh?: ReadToolId) => {
    setNotice(null);
    const job = await runTool(tool, args, key);

    if (!job) return;

    setNotice({
      ok: job.status === 'done',
      text: job.status === 'expired' ? `${job.run?.snippetTitle || 'Action'}: the device did not answer.` : `${job.run?.snippetTitle || 'Action'}: ${job.status === 'done' ? 'done' : 'failed'}`,
      run: job.run
    });

    if (refresh) {
      runTool(refresh);
    }
  };

  return { device, error, busy, runTool, act, notice, setNotice, load };
};

// Shared bits -------------------------------------------------------------------

const Freshness = (props: {
  entry?: InventoryEntry<unknown>;
  busy: boolean;
  online: boolean;
  onRefresh: () => void;
  label: string;
}) => (
  <div className='freshness'>
    <span>
      {props.busy ? (
        <>
          <span className='enroll-waiting' aria-hidden='true' /> Asking the device…
        </>
      ) : props.entry ? (
        `Refreshed ${since(props.entry.at)}`
      ) : (
        'Not loaded yet'
      )}
      {!props.online && !props.busy && ' · device is offline'}
    </span>
    <button type='button' className='btn btn-sm btn-outline-secondary' onClick={props.onRefresh} disabled={props.busy}>
      Refresh {props.label.toLowerCase()}
    </button>
  </div>
);

const Search = (props: { value: string; onChange: (value: string) => void; placeholder: string }) => (
  <input
    className='form-control form-control-sm device-search'
    value={props.value}
    onChange={event => props.onChange(event.target.value)}
    placeholder={props.placeholder}
    aria-label={props.placeholder}
  />
);

const Empty = (props: { entry?: InventoryEntry<unknown>; what: string }) => (
  <p className='text-muted mb-0'>
    {props.entry?.error ? <span className='text-danger'>{props.entry.error}</span> : props.entry ? `No ${props.what} found.` : `Refresh to load ${props.what} from the device.`}
  </p>
);

const Pill = (props: { tone: 'ok' | 'bad' | 'warn' | 'muted'; children: React.ReactNode }) => (
  <span className={`run-status ${props.tone === 'ok' ? 'is-ok' : props.tone === 'bad' ? 'is-bad' : props.tone === 'warn' ? 'is-in_progress' : ''}`}>
    {props.children}
  </span>
);

const confirmAction = (text: string) => window.confirm(text);

// Tabs ------------------------------------------------------------------------------

const SummaryTab = (props: { device: Detail; onTab: (tab: Tab) => void }) => {
  const { device } = props;
  const audit = device.inventory.system?.data as SystemAudit | undefined;
  const services = (device.inventory.services?.data as ServiceInfo[] | undefined) || [];
  const updates = device.inventory.updates?.data;
  const failed = services.filter(service => service.status === 'failed');
  const autoStopped = services.filter(
    service => service.status === 'stopped' && ['auto', 'enabled'].includes(service.startup)
  );
  const fullDisks = (audit?.disks || []).filter(disk => disk.totalGb && disk.usedGb / disk.totalGb >= 0.9);

  const rows: [string, string | undefined][] = [
    ['Operating system', audit?.os || device.facts.osName],
    [device.toolOs === 'windows' ? 'Build' : 'Kernel', audit?.kernel || device.facts.kernel],
    ['Architecture', audit?.arch || device.arch],
    ['Manufacturer', audit?.manufacturer],
    ['Model', audit?.model],
    ['Serial number', audit?.serial],
    ['Processor', audit?.cpu],
    ['Logical CPUs', String(audit?.cores || device.facts.cpus || '') || undefined],
    ['Memory', audit?.memTotalMb ? `${(audit.memTotalMb / 1024).toFixed(1)} GB` : undefined],
    ['Load', audit?.load],
    ['Last boot', audit?.boot ? localTime(audit.boot) : undefined],
    ['Logged-in users', audit?.users || 'None'],
    ['Timezone', device.facts.timezone],
    ['Agent ID', device.agentId || 'not reported yet'],
    ['Agent', `${device.agentVersion}${device.updateAvailable ? ` (update to ${device.latestAgentVersion} pending)` : ''}`]
  ];

  const health: { tone: 'ok' | 'bad' | 'warn'; text: string; tab?: Tab }[] = [
    ...(!device.online ? [{ tone: 'bad' as const, text: `Offline since ${since(device.lastSeenAt)}` }] : []),
    ...failed.map(service => ({ tone: 'bad' as const, text: `${service.name} failed`, tab: 'services' as Tab })),
    ...(autoStopped.length ? [{ tone: 'warn' as const, text: `${autoStopped.length} auto-start services are not running`, tab: 'services' as Tab }] : []),
    ...fullDisks.map(disk => ({ tone: 'bad' as const, text: `${disk.mount} is ${Math.round((disk.usedGb / disk.totalGb) * 100)}% full` })),
    ...(updates?.reboot ? [{ tone: 'warn' as const, text: 'Restart required to finish updates', tab: 'updates' as Tab }] : []),
    ...(updates?.updates.length
      ? [{ tone: 'warn' as const, text: `${updates.updates.length} updates pending (${updates.updates.filter(u => u.security).length} security)`, tab: 'updates' as Tab }]
      : [])
  ];

  return (
    <div className='device-summary-grid'>
      <Card classes='variables-card'>
        <div className='site-section-head'>
          <h3>Health</h3>
        </div>
        {health.length === 0 ? (
          <p className='site-all-good'>✓ No problems found{device.inventory.services ? '' : '. Refresh services and updates for a full check'}.</p>
        ) : (
          <ul className='attention-list'>
            {health.map((item, index) => (
              <li key={index}>
                <button type='button' onClick={() => item.tab && props.onTab(item.tab)} disabled={!item.tab}>
                  <span className={`attention-dot is-${item.tone}`} aria-hidden='true' />
                  {item.text}
                  {item.tab && <span className='attention-go'>→</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card classes='variables-card'>
        <div className='site-section-head'>
          <h3>System</h3>
        </div>
        <dl className='device-properties'>
          {rows
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd title={value}>{value}</dd>
              </div>
            ))}
        </dl>
      </Card>

      <Card classes='variables-card'>
        <div className='site-section-head'>
          <h3>Disks</h3>
        </div>
        {audit?.disks.length ? (
          <div className='device-facts'>
            {audit.disks.map(disk => {
              const used = disk.totalGb ? Math.round((disk.usedGb / disk.totalGb) * 100) : 0;
              return (
                <div className='device-meter' key={disk.mount}>
                  <div className='device-meter-label'>
                    <span>
                      <strong>{disk.mount}</strong> <span className='text-muted'>{disk.type}</span>
                    </span>
                    <span>
                      {disk.usedGb} / {disk.totalGb} GB · {used}%
                    </span>
                  </div>
                  <div className={`device-meter-bar ${used >= 90 ? 'is-bad' : used >= 75 ? 'is-warn' : ''}`}>
                    <span style={{ width: `${used}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className='text-muted mb-0'>Refresh the system audit to list disks.</p>
        )}
      </Card>

      <Card classes='variables-card'>
        <div className='site-section-head'>
          <h3>Network</h3>
        </div>
        {audit?.networks.length ? (
          <dl className='device-properties'>
            {audit.networks.map(network => (
              <div key={`${network.name}-${network.address}`}>
                <dt>{network.name}</dt>
                <dd className='mono'>{network.address}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className='text-muted mb-0'>Refresh the system audit to list interfaces.</p>
        )}
      </Card>
    </div>
  );
};

const ServicesTab = (props: { device: Detail; busy: { [key: string]: boolean }; act: ReturnType<typeof useDevice>['act'] }) => {
  const { device, busy, act } = props;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'running' | 'stopped' | 'failed' | 'problem'>('all');
  const entry = device.inventory.services;
  const services = (entry?.data as ServiceInfo[] | undefined) || [];
  const auto = (service: ServiceInfo) => ['auto', 'enabled'].includes(service.startup);
  const counts = {
    all: services.length,
    running: services.filter(s => s.status === 'running').length,
    stopped: services.filter(s => s.status === 'stopped').length,
    failed: services.filter(s => s.status === 'failed').length,
    problem: services.filter(s => s.status === 'failed' || (s.status === 'stopped' && auto(s))).length
  };
  const shown = services.filter(service => {
    const term = query.trim().toLowerCase();
    const matches = !term || `${service.name} ${service.displayName}`.toLowerCase().includes(term);
    const byStatus =
      filter === 'all' ||
      (filter === 'problem' ? service.status === 'failed' || (service.status === 'stopped' && auto(service)) : service.status === filter);
    return matches && byStatus;
  });

  const run = (service: ServiceInfo, action: string) => {
    if ((action === 'stop' || action === 'disable') && !confirmAction(`${action === 'stop' ? 'Stop' : 'Disable'} ${service.displayName} on ${device.name}?`)) {
      return;
    }
    act('service', { name: service.name, action }, `service:${service.name}`, 'services');
  };

  return (
    <>
      <div className='device-toolbar'>
        <Search value={query} onChange={setQuery} placeholder='Find a service' />
        <div className='segmented'>
          {(['all', 'running', 'stopped', 'failed', 'problem'] as const).map(key => (
            <button key={key} type='button' className={filter === key ? 'is-active' : ''} onClick={() => setFilter(key)}>
              {{ all: 'All', running: 'Running', stopped: 'Stopped', failed: 'Failed', problem: 'Enabled, not running' }[key]} ({counts[key]})
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <Empty entry={entry} what='services' />
      ) : (
        <div className='values-table-wrap'>
          <table className='values-table tool-table'>
            <thead>
              <tr>
                <th>Service</th>
                <th>Status</th>
                <th>Startup</th>
                {device.canAct && <th aria-label='Actions' />}
              </tr>
            </thead>
            <tbody>
              {shown.map(service => {
                const working = busy[`service:${service.name}`];
                return (
                  <tr key={service.name}>
                    <td>
                      <strong className='tool-name'>{service.displayName}</strong>
                      {service.displayName !== service.name && <span className='tool-sub mono'>{service.name}</span>}
                    </td>
                    <td>
                      <Pill tone={service.status === 'running' ? 'ok' : service.status === 'failed' ? 'bad' : 'muted'}>
                        {service.status === 'other' ? service.state : service.status}
                      </Pill>
                    </td>
                    <td className='tool-sub'>
                      {service.startup}
                      {service.account ? ` · ${service.account}` : ''}
                    </td>
                    {device.canAct && (
                      <td className='values-actions'>
                        {working ? (
                          <span className='form-text'>
                            <span className='enroll-waiting' aria-hidden='true' /> Working…
                          </span>
                        ) : (
                          <>
                            {service.status !== 'running' && (
                              <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => run(service, 'start')}>
                                Start
                              </button>
                            )}
                            {service.status === 'running' && (
                              <>
                                <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => run(service, 'restart')}>
                                  Restart
                                </button>
                                <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => run(service, 'stop')}>
                                  Stop
                                </button>
                              </>
                            )}
                            <details className='device-menu'>
                              <summary className='btn btn-sm btn-outline-secondary' aria-label={`More for ${service.name}`}>
                                ⋯
                              </summary>
                              <div className='device-menu-list'>
                                <button type='button' onClick={() => run(service, 'enable')}>
                                  Start automatically
                                </button>
                                <button type='button' className='is-danger' onClick={() => run(service, 'disable')}>
                                  Disable
                                </button>
                              </div>
                            </details>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};

const TasksTab = (props: {
  device: Detail;
  busy: { [key: string]: boolean };
  act: ReturnType<typeof useDevice>['act'];
  runTool: ReturnType<typeof useDevice>['runTool'];
  setNotice: ReturnType<typeof useDevice>['setNotice'];
}) => {
  const { device, busy, act, runTool, setNotice } = props;
  const [editor, setEditor] = useState<{ target: string; line?: { raw: string; enabled: boolean } } | null>(null);
  const [newTarget, setNewTarget] = useState('user:root');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | TaskInfo['kind']>('all');
  const entry = device.inventory.tasks;
  const tasks = (entry?.data as TaskInfo[] | undefined) || [];
  const kinds = Array.from(new Set(tasks.map(task => task.kind)));
  const shown = tasks.filter(task => {
    const term = query.trim().toLowerCase();
    return (kind === 'all' || task.kind === kind) && (!term || `${task.name} ${task.command} ${task.source}`.toLowerCase().includes(term));
  });

  // Every crontab and cron file we know of, for "New cron job"
  const cronTargets = Array.from(
    new Set(['user:root', '/etc/crontab', ...tasks.filter(task => task.target).map(task => task.target!)])
  ).sort((a, b) => (a.startsWith('user:') === b.startsWith('user:') ? a.localeCompare(b) : a.startsWith('user:') ? -1 : 1));

  const openNew = () => {
    if (newTarget === 'new-file') {
      const name = window.prompt('Name for the new file in /etc/cron.d (letters, digits, - and _):', 'snippycode-jobs');
      if (!name) return;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        setNotice({ ok: false, text: 'Use letters, digits, - and _ only. cron ignores files with dots in their names.' });
        return;
      }
      setEditor({ target: `/etc/cron.d/${name}` });
      return;
    }
    setEditor({ target: newTarget });
  };

  const changeLine = async (task: TaskInfo, change: 'enable' | 'disable' | 'delete') => {
    if (!task.target || task.raw === undefined) return;
    if (change !== 'enable' && !confirmAction(`${change === 'delete' ? 'Delete' : 'Switch off'} this cron job on ${device.name}?\n\n${task.raw}`)) return;

    setSavingId(task.id);
    setNotice(null);
    try {
      await changeCronLine(runTool, task.target, task.raw, task.enabled, change);
      setNotice({ ok: true, text: `Cron job ${change === 'delete' ? 'deleted' : change === 'disable' ? 'switched off' : 'switched on'} in ${targetLabel(task.target)}` });
      runTool('tasks');
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : 'Could not change the cron job' });
    } finally {
      setSavingId(null);
    }
  };

  const actOn = (task: TaskInfo, action: 'run' | 'enable' | 'disable') => {
    if (action !== 'enable' && !confirmAction(`${action === 'run' ? 'Run' : 'Disable'} ${task.name} on ${device.name} now?`)) {
      return;
    }

    const args =
      task.kind === 'windows'
        ? { name: task.name, path: task.source, action }
        : { timer: task.id, unit: task.command, action };
    act('task', args, `task:${task.id}`, 'tasks');
  };

  const KIND_LABEL: { [key: string]: string } = { cron: 'Cron', timer: 'systemd timer', periodic: 'cron.d period', windows: 'Task Scheduler' };

  return (
    <>
      <div className='device-toolbar'>
        <Search value={query} onChange={setQuery} placeholder='Find a task or command' />
        {kinds.length > 1 && (
          <div className='segmented'>
            <button type='button' className={kind === 'all' ? 'is-active' : ''} onClick={() => setKind('all')}>
              All ({tasks.length})
            </button>
            {kinds.map(item => (
              <button key={item} type='button' className={kind === item ? 'is-active' : ''} onClick={() => setKind(item)}>
                {KIND_LABEL[item]} ({tasks.filter(task => task.kind === item).length})
              </button>
            ))}
          </div>
        )}
      </div>
      {device.toolOs === 'linux' && device.canAct && (
        <div className='cron-new'>
          <span>New cron job in</span>
          <select className='form-control form-control-sm' value={newTarget} onChange={event => setNewTarget(event.target.value)} aria-label='Where to add the job'>
            {cronTargets.map(target => (
              <option key={target} value={target}>
                {targetLabel(target)}
              </option>
            ))}
            <option value='new-file'>New file in /etc/cron.d…</option>
          </select>
          <button type='button' className='btn btn-sm btn-primary' onClick={openNew}>
            + New cron job
          </button>
          {newTarget !== 'new-file' && (
            <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => setEditor({ target: newTarget })}>
              Edit {isSystemTarget(newTarget) ? 'file' : 'crontab'}
            </button>
          )}
        </div>
      )}
      {device.toolOs === 'windows' && <p className='form-text'>Built-in \Microsoft\ tasks are hidden.</p>}
      {shown.length === 0 ? (
        <Empty entry={entry} what='scheduled tasks' />
      ) : (
        <div className='values-table-wrap'>
          <table className='values-table tool-table'>
            <thead>
              <tr>
                <th>Task</th>
                <th>Schedule</th>
                <th>Next / last run</th>
                <th>State</th>
                {device.canAct && <th aria-label='Actions' />}
              </tr>
            </thead>
            <tbody>
              {shown.map(task => {
                const actionable = task.kind === 'windows' || task.kind === 'timer';
                const working = busy[`task:${task.id}`];
                return (
                  <tr key={task.id}>
                    <td>
                      <strong className='tool-name'>{task.name}</strong>
                      <span className='tool-sub mono' title={task.command}>
                        {task.command}
                      </span>
                      <span className='tool-sub'>
                        {KIND_LABEL[task.kind]} · {task.source}
                        {task.user ? ` · ${task.user}` : ''}
                      </span>
                    </td>
                    <td>
                      <span title={task.schedule}>{task.kind === 'cron' || task.kind === 'periodic' ? describeCron(task.schedule) : task.schedule}</span>
                      {(task.kind === 'cron') && <span className='tool-sub mono'>{task.schedule}</span>}
                    </td>
                    <td className='tool-sub'>
                      {task.nextRun ? `Next ${localTime(task.nextRun)}` : task.kind === 'cron' ? '' : 'No next run'}
                      {task.lastRun && (
                        <>
                          <br />
                          Last {localTime(task.lastRun)}
                          {task.lastResult && task.lastResult !== '0x0' ? ` · result ${task.lastResult}` : ''}
                        </>
                      )}
                    </td>
                    <td>
                      <Pill tone={task.enabled ? 'ok' : 'muted'}>{task.enabled ? (task.state?.split(' ')[0] || 'enabled') : 'disabled'}</Pill>
                    </td>
                    {device.canAct && (
                      <td className='values-actions'>
                        {task.kind === 'cron' && task.target && task.raw !== undefined &&
                          (savingId === task.id ? (
                            <span className='form-text'>
                              <span className='enroll-waiting' aria-hidden='true' /> Saving…
                            </span>
                          ) : (
                            <>
                              <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => setEditor({ target: task.target!, line: { raw: task.raw!, enabled: task.enabled } })}>
                                Edit
                              </button>
                              <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => changeLine(task, task.enabled ? 'disable' : 'enable')}>
                                {task.enabled ? 'Disable' : 'Enable'}
                              </button>
                              <button type='button' className='btn btn-sm btn-outline-danger' onClick={() => changeLine(task, 'delete')}>
                                Delete
                              </button>
                            </>
                          ))}
                        {actionable &&
                          (working ? (
                            <span className='form-text'>
                              <span className='enroll-waiting' aria-hidden='true' /> Working…
                            </span>
                          ) : (
                            <>
                              <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => actOn(task, 'run')}>
                                Run now
                              </button>
                              <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => actOn(task, task.enabled ? 'disable' : 'enable')}>
                                {task.enabled ? 'Disable' : 'Enable'}
                              </button>
                            </>
                          ))}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editor && (
        <CronEditor
          deviceName={device.name}
          target={editor.target}
          editLine={editor.line}
          runTool={runTool}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setNotice({ ok: true, text: `Saved ${targetLabel(editor.target)} on ${device.name}` });
            runTool('tasks');
          }}
        />
      )}
    </>
  );
};

const ProcessesTab = (props: { device: Detail; busy: { [key: string]: boolean }; act: ReturnType<typeof useDevice>['act'] }) => {
  const { device, busy, act } = props;
  const [query, setQuery] = useState('');
  const entry = device.inventory.processes;
  const processes = (entry?.data as ProcessInfo[] | undefined) || [];
  const shown = processes.filter(item => !query.trim() || `${item.name} ${item.user || ''} ${item.pid}`.toLowerCase().includes(query.trim().toLowerCase()));

  const end = (item: ProcessInfo, force: boolean) => {
    if (!confirmAction(`${force ? 'Kill' : 'End'} ${item.name} (${item.pid}) on ${device.name}?`)) return;
    act('process', { pid: item.pid, force }, `process:${item.pid}`, 'processes');
  };

  return (
    <>
      <div className='device-toolbar'>
        <Search value={query} onChange={setQuery} placeholder='Find a process, user or PID' />
        <span className='form-text'>{processes.length} processes, busiest first</span>
      </div>
      {shown.length === 0 ? (
        <Empty entry={entry} what='processes' />
      ) : (
        <div className='values-table-wrap'>
          <table className='values-table tool-table'>
            <thead>
              <tr>
                <th>Process</th>
                <th>PID</th>
                {device.toolOs === 'linux' && <th>User</th>}
                <th>{processes[0]?.cpuUnit === 'seconds' ? 'CPU time' : 'CPU'}</th>
                <th>Memory</th>
                {device.canAct && <th aria-label='Actions' />}
              </tr>
            </thead>
            <tbody>
              {shown.map(item => (
                <tr key={item.pid}>
                  <td>
                    <strong className='tool-name'>{item.name}</strong>
                    {item.elapsedSeconds !== undefined && <span className='tool-sub'>running {formatUptime(item.elapsedSeconds)}</span>}
                  </td>
                  <td className='mono'>{item.pid}</td>
                  {device.toolOs === 'linux' && <td className='tool-sub'>{item.user}</td>}
                  <td className='mono'>{item.cpuUnit === 'seconds' ? `${item.cpu}s` : `${item.cpu}%`}</td>
                  <td className='mono'>{item.memMb >= 1024 ? `${(item.memMb / 1024).toFixed(1)} GB` : `${item.memMb} MB`}</td>
                  {device.canAct && (
                    <td className='values-actions'>
                      {busy[`process:${item.pid}`] ? (
                        <span className='form-text'>Working…</span>
                      ) : (
                        <>
                          <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => end(item, false)}>
                            End
                          </button>
                          {device.toolOs === 'linux' && (
                            <button type='button' className='btn btn-sm btn-outline-danger' onClick={() => end(item, true)}>
                              Kill
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};

const SoftwareTab = (props: { device: Detail }) => {
  const [query, setQuery] = useState('');
  const entry = props.device.inventory.software;
  const software = (entry?.data as SoftwareInfo[] | undefined) || [];
  const term = query.trim().toLowerCase();
  const shown = software.filter(item => !term || `${item.name} ${item.publisher || ''}`.toLowerCase().includes(term));

  return (
    <>
      <div className='device-toolbar'>
        <Search value={query} onChange={setQuery} placeholder='Find software' />
        <span className='form-text'>
          {shown.length === software.length ? `${software.length} installed` : `${shown.length} of ${software.length}`}
        </span>
      </div>
      {shown.length === 0 ? (
        <Empty entry={entry} what='software' />
      ) : (
        <div className='values-table-wrap tool-scroll'>
          <table className='values-table tool-table'>
            <thead>
              <tr>
                <th>Name</th>
                <th>Version</th>
                <th>Publisher</th>
                {props.device.toolOs === 'windows' && <th>Installed</th>}
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 500).map(item => (
                <tr key={`${item.name}-${item.version}`}>
                  <td className='tool-name'>{item.name}</td>
                  <td className='mono tool-sub'>{item.version}</td>
                  <td className='tool-sub'>{item.publisher || '—'}</td>
                  {props.device.toolOs === 'windows' && (
                    <td className='tool-sub'>{item.installed ? item.installed.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : '—'}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length > 500 && <p className='form-text mt-2'>Showing the first 500. Search to narrow down.</p>}
        </div>
      )}
    </>
  );
};

const UpdatesTab = (props: {
  device: Detail;
  busy: { [key: string]: boolean };
  act: ReturnType<typeof useDevice>['act'];
  runTool: ReturnType<typeof useDevice>['runTool'];
}) => {
  const { device, busy, act } = props;
  const [securityOnly, setSecurityOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reboot, setReboot] = useState<'never' | 'if-required' | 'always'>('never');
  const entry = device.inventory.updates;
  const data = entry?.data;
  const all = (data?.updates as UpdateInfo[] | undefined) || [];
  const updates = all.filter(item => !securityOnly || item.security);
  const security = all.filter(item => item.security).length;
  const windows = device.toolOs === 'windows';
  // Windows installs by KB number; Linux by package name
  const keyOf = (item: UpdateInfo) => (windows ? (/KB\d{4,9}/i.exec(item.name) || [''])[0].toUpperCase() : item.name);
  const patching = Boolean(busy.patch);

  const install = (mode: 'security' | 'all' | 'selected') => {
    const packages = mode === 'selected' ? Array.from(selected) : [];
    const what = mode === 'selected' ? `${packages.length} selected update${packages.length === 1 ? '' : 's'}` : mode === 'security' ? 'all security updates' : 'all updates';
    const restart = reboot === 'always' ? ' and then restart it' : reboot === 'if-required' ? ' and restart it if needed' : '';
    if (!confirmAction(`Install ${what} on ${device.name}${restart}?`)) return;
    act('patch', { mode, packages, reboot }, 'patch', 'updates').then(() => setSelected(new Set()));
  };

  const toggle = (key: string) =>
    setSelected(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      {data?.reboot && <div className='alert alert-warning'>A restart is required to finish installing updates.</div>}
      <div className='device-toolbar'>
        <div className='segmented'>
          <button type='button' className={!securityOnly ? 'is-active' : ''} onClick={() => setSecurityOnly(false)}>
            All ({all.length})
          </button>
          <button type='button' className={securityOnly ? 'is-active' : ''} onClick={() => setSecurityOnly(true)}>
            Security ({security})
          </button>
        </div>
        {!windows && (
          <button type='button' className='btn btn-sm btn-outline-secondary' disabled={Boolean(busy.updates) || !device.online} onClick={() => props.runTool('updates', { fetch: true }, 'updates')}>
            Check for new updates
          </button>
        )}
        <span className='form-text'>
          {windows ? 'From Windows Update; searching can take a few minutes.' : 'Checking runs apt-get update (or dnf makecache) first.'}
        </span>
      </div>

      {device.canAct && all.length > 0 && (
        <div className='patch-bar'>
          <label>
            <span>After installing</span>
            <select className='form-select form-select-sm' value={reboot} onChange={event => setReboot(event.target.value as typeof reboot)}>
              <option value='never'>Don’t restart</option>
              <option value='if-required'>Restart if required</option>
              <option value='always'>Always restart</option>
            </select>
          </label>
          <button type='button' className='btn btn-sm btn-primary' disabled={patching || !selected.size || !device.online} onClick={() => install('selected')}>
            Install selected ({selected.size})
          </button>
          <button type='button' className='btn btn-sm btn-outline-secondary' disabled={patching || !security || !device.online} onClick={() => install('security')}>
            Install security ({security})
          </button>
          <button type='button' className='btn btn-sm btn-outline-secondary' disabled={patching || !device.online} onClick={() => install('all')}>
            Install all
          </button>
          {patching && (
            <span className='form-text'>
              <span className='enroll-waiting' aria-hidden='true' /> Installing; this can take up to 30 minutes…
            </span>
          )}
        </div>
      )}

      {updates.length === 0 ? (
        entry && !entry.error ? <p className='site-all-good'>✓ Up to date.</p> : <Empty entry={entry} what='updates' />
      ) : (
        <div className='values-table-wrap'>
          <table className='values-table tool-table'>
            <thead>
              <tr>
                {device.canAct && (
                  <th className='alert-check'>
                    <input
                      type='checkbox'
                      className='form-check-input'
                      aria-label='Select all shown'
                      checked={updates.length > 0 && updates.every(item => !keyOf(item) || selected.has(keyOf(item)))}
                      onChange={event => setSelected(event.target.checked ? new Set(updates.map(keyOf).filter(Boolean)) : new Set())}
                    />
                  </th>
                )}
                <th>Update</th>
                <th>Version</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {updates.map(item => (
                <tr key={`${item.name}-${item.version}`}>
                  {device.canAct && (
                    <td className='alert-check'>
                      {keyOf(item) && (
                        <input type='checkbox' className='form-check-input' aria-label={`Select ${item.name}`} checked={selected.has(keyOf(item))} onChange={() => toggle(keyOf(item))} />
                      )}
                    </td>
                  )}
                  <td>
                    <strong className='tool-name'>{item.name}</strong> {item.security && <Pill tone='bad'>security</Pill>}
                  </td>
                  <td className='mono tool-sub'>
                    {item.from ? `${item.from} → ` : ''}
                    {item.version || '—'}
                  </td>
                  <td className='tool-sub'>{item.source || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};

const LogsTab = (props: { device: Detail }) => {
  const [level, setLevel] = useState<'all' | 'error'>('all');
  const [query, setQuery] = useState('');
  const entry = props.device.inventory.logs;
  const logs = ((entry?.data as LogEntry[] | undefined) || []).filter(
    item =>
      (level === 'all' || /error|critical/.test(item.level)) &&
      (!query.trim() || `${item.source} ${item.message}`.toLowerCase().includes(query.trim().toLowerCase()))
  );

  return (
    <>
      <div className='device-toolbar'>
        <Search value={query} onChange={setQuery} placeholder='Find in messages' />
        <div className='segmented'>
          <button type='button' className={level === 'all' ? 'is-active' : ''} onClick={() => setLevel('all')}>
            Warnings and errors
          </button>
          <button type='button' className={level === 'error' ? 'is-active' : ''} onClick={() => setLevel('error')}>
            Errors only
          </button>
        </div>
      </div>
      {logs.length === 0 ? (
        <Empty entry={entry} what='log entries' />
      ) : (
        <ul className='log-list'>
          {logs.map((item, index) => (
            <li key={index} className={/error|critical/.test(item.level) ? 'is-error' : 'is-warning'}>
              <span className='log-time mono'>{item.time ? localTime(item.time) : ''}</span>
              <span className='log-source'>{item.source}</span>
              <span className='log-message'>{item.message}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

// Page ------------------------------------------------------------------------------

export const DeviceDetail = (): JSX.Element => {
  const { id } = useParams<{ id: string }>();
  const history = useHistory();
  const location = useLocation();
  const { device, error, busy, runTool, act, notice, setNotice, load } = useDevice(Number(id));
  const { user } = useContext(AuthContext);
  const canAck = hasMinimumRole(user?.role, 'user');
  const isAdmin = hasMinimumRole(user?.role, 'admin');
  const [cloneError, setCloneError] = useState('');
  const decideClone = (decision: 'approve' | 'deny') => {
    if (decision === 'deny' && !window.confirm('Deny this clone? It is revoked and its token deleted.')) return;
    setCloneError('');
    axios
      .post(`/api/devices/${id}/${decision}-clone`)
      .then(() => load())
      .catch(err => setCloneError(apiError(err, 'Could not update the clone.')));
  };
  const [activationToken, setActivationToken] = useState<{ token: string; expiresAt: string } | null>(null);
  const makeActivationToken = () => {
    setCloneError('');
    axios
      .post(`/api/devices/${id}/activation-token`)
      .then(res => setActivationToken(res.data.data))
      .catch(err => setCloneError(apiError(err, 'Could not create an activation token.')));
  };
  const reviewFingerprint = (action: 'approve' | 'reset') => {
    if (action === 'reset' && !window.confirm('Reset the fingerprint? The next poll binds it again (from the last known address it is trusted).')) return;
    setCloneError('');
    axios
      .post(`/api/devices/${id}/fingerprint-review`, { action })
      .then(() => load())
      .catch(err => setCloneError(apiError(err, 'Could not update the fingerprint review.')));
  };
  const [dialog, setDialog] = useState<'run' | null>(null);
  const tabParam = new URLSearchParams(location.search).get('tab') as Tab;
  const tab: Tab = (TABS as readonly string[]).includes(tabParam) ? tabParam : 'summary';
  const setTab = (next: Tab) => {
    setNotice(null);
    history.replace({ search: next === 'summary' ? '' : `?tab=${next}` });
  };
  const autoRefreshed = useRef<Set<string>>(new Set());
  const tool = TAB_TOOL[tab];

  // Open a tab with fresh data when what we have is missing or stale
  useEffect(() => {
    if (!device || !tool || !device.online || !device.toolOs || autoRefreshed.current.has(tool)) return;
    const entry = device.inventory[tool];
    const stale = !entry || Date.now() - new Date(entry.at).getTime() > STALE_MINUTES[tool] * 60_000;
    const pending = device.pendingJobs.some(job => job.tool === tool);

    if (stale && !pending) {
      autoRefreshed.current.add(tool);
      runTool(tool);
    }
  }, [device?.id, device?.online, tool]);

  const refreshAll = () => {
    (['system', 'services', 'tasks', 'updates'] as ReadToolId[]).forEach(item => runTool(item));
  };

  const stats = useMemo(() => {
    if (!device) return [];
    const services = (device.inventory.services?.data as ServiceInfo[] | undefined) || [];
    const failed = services.filter(service => service.status === 'failed').length;
    const updates = device.inventory.updates?.data?.updates.length;
    const mem =
      device.facts.memTotalMb && device.facts.memAvailableMb !== undefined
        ? Math.round(((device.facts.memTotalMb - device.facts.memAvailableMb) / device.facts.memTotalMb) * 100)
        : null;
    const disk = device.facts.diskTotalGb && device.facts.diskUsedGb !== undefined ? Math.round((device.facts.diskUsedGb / device.facts.diskTotalGb) * 100) : null;
    const load = (device.inventory.system?.data as SystemAudit | undefined)?.load;

    return [
      { label: 'Memory used', value: mem === null ? '—' : `${mem}%`, tone: mem !== null && mem >= 90 ? 'bad' : '' },
      { label: 'Disk used', value: disk === null ? '—' : `${disk}%`, tone: disk !== null && disk >= 90 ? 'bad' : disk !== null && disk >= 75 ? 'warn' : '' },
      { label: 'Uptime', value: formatUptime(device.facts.uptimeSeconds), tone: '' },
      { label: device.toolOs === 'windows' ? 'CPU load' : 'Load (1/5/15m)', value: load || '—', tone: '' },
      { label: 'Failed services', value: device.inventory.services ? String(failed) : '—', tone: failed ? 'bad' : '', tab: 'services' as Tab },
      { label: 'Updates pending', value: updates === undefined ? '—' : String(updates), tone: updates ? 'warn' : '', tab: 'updates' as Tab }
    ];
  }, [device]);

  if (!device) {
    return (
      <Layout>
        <div className='col-12'>{error || 'Loading…'}</div>
      </Layout>
    );
  }

  const entry = tool ? device.inventory[tool] : undefined;

  return (
    <Layout>
      <div className='col-12'>
        <nav className='device-crumbs' aria-label='Breadcrumb'>
          <Link to='/devices'>Devices</Link>
          <span aria-hidden='true'>/</span>
          <Link to={`/sites/${device.site.id}?tab=devices`}>{device.site.name}</Link>
          <span aria-hidden='true'>/</span>
          <span>{device.name}</span>
        </nav>
      </div>

      <div className='col-12'>
        <Card classes='variables-card device-hero'>
          <div className='device-hero-head'>
            <DeviceOsIcon device={device} size={1.6} />
            <div className='device-hero-title'>
              <h1>{device.name}</h1>
              <p>
                <span className={`device-status ${device.online ? 'is-online' : ''}`}>
                  <span className={`device-dot ${device.online ? 'is-online' : ''}`} />
                  {device.online ? 'Online' : `Offline · seen ${since(device.lastSeenAt)}`}
                </span>
                <span>{device.facts.osName || device.os}</span>
                <span className='mono'>{deviceAddress(device)}</span>
                {device.hostname !== device.name && <span className='mono'>{device.hostname}</span>}
                <span>
                  agent {device.agentVersion}
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
                </span>
              </p>
            </div>
            <div className='site-header-actions'>
              {device.clonePendingApproval && isAdmin && (
                <>
                  <button type='button' className='btn btn-sm btn-success' onClick={() => decideClone('approve')}>
                    Approve clone
                  </button>
                  <button type='button' className='btn btn-sm btn-outline-danger' onClick={() => decideClone('deny')}>
                    Deny clone
                  </button>
                  <button type='button' className='btn btn-sm btn-outline-secondary' onClick={makeActivationToken} title='A single-use enrolment token that activates only this clone (24 hours)'>
                    Activation token
                  </button>
                </>
              )}
              {device.fingerprintPendingReview && isAdmin && (
                <>
                  <button type='button' className='btn btn-sm btn-outline-success' onClick={() => reviewFingerprint('approve')}>
                    Approve fingerprint
                  </button>
                  <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => reviewFingerprint('reset')}>
                    Reset fingerprint
                  </button>
                </>
              )}
              {activationToken && (
                <span className='small'>
                  Single-use token (shown once, expires {new Date(activationToken.expiresAt).toLocaleString()}):{' '}
                  <code className='mono'>{activationToken.token}</code>
                </span>
              )}
              {cloneError && <span className='text-danger small'>{cloneError}</span>}
              {device.canAct && (
                <button type='button' className='btn btn-sm btn-primary' onClick={() => setDialog('run')}>
                  Run snippet…
                </button>
              )}
              {device.toolOs && (
                <button type='button' className='btn btn-sm btn-outline-secondary' onClick={refreshAll} disabled={Object.values(busy).some(Boolean)}>
                  Refresh audit
                </button>
              )}
            </div>
          </div>

          <div className='device-stat-strip'>
            {stats.map(stat => (
              <button
                key={stat.label}
                type='button'
                className={`is-${stat.tone || 'plain'}`}
                onClick={() => stat.tab && setTab(stat.tab)}
                disabled={!stat.tab}
              >
                <strong>{stat.value}</strong>
                <span>{stat.label}</span>
              </button>
            ))}
          </div>
        </Card>
      </div>

      <div className='col-12'>
        <div className='site-tabs device-tabs' role='tablist' aria-label={`${device.name} sections`}>
          {TABS.filter(item => device.toolOs || ['summary', 'performance', 'alerts', 'activity'].includes(item)).map(item => (
            <button key={item} type='button' role='tab' aria-selected={tab === item} className={tab === item ? 'is-active' : ''} onClick={() => setTab(item)}>
              {TAB_LABELS[item]}
            </button>
          ))}
        </div>
      </div>

      <div className='col-12'>
        {notice && (
          <div className={`alert ${notice.ok ? 'alert-success' : 'alert-danger'} device-notice`}>
            <div className='d-flex justify-content-between align-items-center'>
              <strong>{notice.text}</strong>
              <button type='button' className='btn btn-sm btn-link' onClick={() => setNotice(null)}>
                Dismiss
              </button>
            </div>
            {notice.run && (notice.run.stdout || notice.run.stderr) && <RunOutput run={notice.run} />}
          </div>
        )}

        {tab === 'summary' ? (
          <>
            {device.toolOs && (
              <Freshness entry={entry} busy={Boolean(busy.system)} online={device.online} onRefresh={() => runTool('system')} label='System audit' />
            )}
            <SummaryTab device={device} onTab={setTab} />
            <DeviceTagsEditor deviceId={device.id} tags={device.tags || []} onSaved={load} />
            <DeviceFieldsCard device={device} address={deviceAddress(device)} onSaved={load} />
          </>
        ) : tab === 'performance' ? (
          <Card classes='variables-card'>
            <PerformanceTab deviceId={device.id} windows={device.toolOs === 'windows'} />
          </Card>
        ) : tab === 'alerts' ? (
          <Card classes='variables-card'>
            <AlertList query={{ deviceId: device.id }} showDevice={false} showSite={false} canAct={canAck} empty={`No alerts for ${device.name}.`} />
            <p className='form-text mb-0 mt-2'>
              Monitors come from <Link to='/policies'>policies</Link> that cover this device.
            </p>
          </Card>
        ) : tab === 'files' ? (
          <Card classes='variables-card'>
            <FilesTab deviceId={device.id} windows={device.toolOs === 'windows'} online={device.online} canAct={device.canAct} runTool={runTool} busy={Boolean(busy.files)} />
          </Card>
        ) : tab === 'activity' ? (
          <Card classes='variables-card'>
            <RunHistory query={{ deviceId: device.id }} showSite={false} empty={`Nothing has run on ${device.name} yet.`} />
          </Card>
        ) : tab === 'shell' ? (
          <Card classes='variables-card'>
            {device.canAct ? (
              <TerminalTab name={device.name} windows={device.toolOs === 'windows'} online={device.online} runTool={runTool} busy={Boolean(busy.terminal)} />
            ) : (
              <p className='text-muted mb-0'>Only admins (or editors, if allowed) can run commands on devices.</p>
            )}
          </Card>
        ) : (
          <Card classes='variables-card'>
            <Freshness entry={entry} busy={Boolean(tool && busy[tool])} online={device.online} onRefresh={() => tool && runTool(tool)} label={TAB_LABELS[tab]} />
            {tab === 'services' && <ServicesTab device={device} busy={busy} act={act} />}
            {tab === 'tasks' && <TasksTab device={device} busy={busy} act={act} runTool={runTool} setNotice={setNotice} />}
            {tab === 'processes' && <ProcessesTab device={device} busy={busy} act={act} />}
            {tab === 'software' && <SoftwareTab device={device} />}
            {tab === 'updates' && <UpdatesTab device={device} busy={busy} act={act} runTool={runTool} />}
            {tab === 'logs' && <LogsTab device={device} />}
          </Card>
        )}
      </div>

      {dialog === 'run' ? (
        <DeviceRunModal
          device={device}
          siteId={device.site.id}
          siteName={device.site.name}
          mode='run'
          onClose={() => setDialog(null)}
          onFinished={load}
        />
      ) : (
        <></>
      )}
    </Layout>
  );
};
