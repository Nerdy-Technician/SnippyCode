import { useState } from 'react';
import copy from 'clipboard-copy';
import { Link } from 'react-router-dom';
import Icon from '@mdi/react';
import {
  mdiApple,
  mdiArch,
  mdiCentos,
  mdiDebian,
  mdiFedora,
  mdiLinux,
  mdiMicrosoftWindows,
  mdiRaspberryPi,
  mdiRedhat,
  mdiServer,
  mdiUbuntu
} from '@mdi/js';
import { Device } from '../../typescript/interfaces';
import { dateParser } from '../../utils';

interface Props {
  device: Device;
  canManage: boolean;
  canRun: boolean;
  compact?: boolean;
  highlight?: boolean;
  onRun: (device: Device) => void;
  onHistory: (device: Device) => void;
  onRename: (device: Device) => void;
  onRevoke: (device: Device) => void;
  /** Admins: clear the possible-duplicate flag */
  onClearDuplicate?: (device: Device) => void;
}

export const osKind = (device: Device): 'linux' | 'windows' | 'mac' | 'other' => {
  const text = `${device.os} ${device.facts.osName || ''}`.toLowerCase();
  if (text.includes('windows')) return 'windows';
  if (text.includes('darwin') || text.includes('mac')) return 'mac';
  if (text.includes('linux')) return 'linux';
  return 'other';
};

// The most specific logo we can tell from what the agent reported
const osIcon = (device: Device, kind: string): { path: string; label: string; tone: string } => {
  const name = (device.facts.osName || '').toLowerCase();
  const distros: [string, string, string][] = [
    ['ubuntu', mdiUbuntu, 'ubuntu'],
    ['debian', mdiDebian, 'debian'],
    ['raspbian', mdiRaspberryPi, 'raspberry'],
    ['fedora', mdiFedora, 'fedora'],
    ['red hat', mdiRedhat, 'redhat'],
    ['centos', mdiCentos, 'centos'],
    ['arch', mdiArch, 'arch']
  ];
  const distro = distros.find(([match]) => name.includes(match));

  if (distro) {
    return { path: distro[1], label: device.facts.osName || distro[0], tone: distro[2] };
  }

  if (kind === 'windows') {
    return { path: mdiMicrosoftWindows, label: 'Windows', tone: 'windows' };
  }

  if (kind === 'mac') {
    return { path: mdiApple, label: 'macOS', tone: 'mac' };
  }

  if (kind === 'linux') {
    return { path: mdiLinux, label: 'Linux', tone: 'linux' };
  }

  return { path: mdiServer, label: 'Device', tone: 'other' };
};

export const DeviceOsIcon = (props: { device: Device; size?: number }): JSX.Element => {
  const icon = osIcon(props.device, osKind(props.device));
  return (
    <span className={`device-os is-${icon.tone}`} title={icon.label}>
      <Icon path={icon.path} size={props.size || 0.95} aria-label={icon.label} />
    </span>
  );
};

const OS_BADGE: { [kind: string]: string } = {
  linux: 'Linux',
  windows: 'Windows',
  mac: 'macOS',
  other: 'Device'
};

export const isLoopback = (ip?: string | null): boolean =>
  !ip || ip === '::1' || ip.startsWith('127.') || ip === '::ffff:127.0.0.1';

// "Europe/London" reads better as "London"
const shortZone = (zone?: string): string =>
  zone ? zone.split('/').pop()!.replace(/_/g, ' ') : '—';

export const deviceAddress = (device: Device): string =>
  device.facts.ip && !isLoopback(device.facts.ip)
    ? device.facts.ip
    : device.lastIp && !isLoopback(device.lastIp)
    ? device.lastIp
    : device.lastIp
    ? 'this machine'
    : '—';

export const formatUptime = (seconds?: number): string => {
  if (!seconds) {
    return '—';
  }

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
};

const gb = (value: number): string => (value >= 100 ? value.toFixed(0) : value.toFixed(1));

const Meter = (props: { label: string; used?: number; total?: number; unit: 'GB' | 'MB' }) => {
  const { label, used, total, unit } = props;

  if (!total || used === undefined) {
    return null;
  }

  const percent = Math.min(100, Math.round((used / total) * 100));
  const [shownUsed, shownTotal] =
    unit === 'MB' ? [gb(used / 1024), gb(total / 1024)] : [gb(used), gb(total)];

  return (
    <div className='device-meter'>
      <div className='device-meter-label'>
        <span>{label}</span>
        <span>
          {shownUsed} / {shownTotal} GB
        </span>
      </div>
      <div
        className={`device-meter-bar ${percent >= 90 ? 'is-bad' : percent >= 75 ? 'is-warn' : ''}`}
        role='meter'
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} ${percent}% used`}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
};

// Agents from 1.1 replace themselves when the server has a newer version
const selfUpdates = (version: string): boolean => {
  const [major = 0, minor = 0] = (version.match(/\d+/g) || []).map(Number);
  return major > 1 || (major === 1 && minor >= 1);
};

export const upgradeCommand = (device: Device): string => {
  const origin = window.location.origin;
  return osKind(device) === 'windows'
    ? `& ([scriptblock]::Create((irm ${origin}/agent/install.ps1))) -Upgrade`
    : `curl -fsSL ${origin}/agent/install.sh | sudo bash -s -- --upgrade`;
};

export const DeviceCard = (props: Props): JSX.Element => {
  const { device, canManage, canRun, compact, highlight } = props;
  const [copied, setCopied] = useState(false);
  const facts = device.facts || {};
  const kind = osKind(device);
  const memUsed =
    facts.memTotalMb !== undefined && facts.memAvailableMb !== undefined
      ? facts.memTotalMb - facts.memAvailableMb
      : undefined;

  const status = device.online
    ? 'Online'
    : device.lastSeenAt
    ? `Offline · seen ${dateParser(device.lastSeenAt).relative}`
    : 'Never connected';

  return (
    <article className={`device-card ${device.online ? 'is-online' : 'is-offline'} ${highlight ? 'is-new' : ''}`}>
      <header className='device-card-head'>
        <DeviceOsIcon device={device} />
        <div className='device-card-title'>
          <h3>
            <Link to={`/devices/${device.id}`}>{device.name}</Link>
          </h3>
          <p>
            {device.hostname && device.hostname !== device.name ? `${device.hostname} · ` : ''}
            {facts.ip && !isLoopback(facts.ip)
              ? facts.ip
              : device.lastIp && !isLoopback(device.lastIp)
              ? device.lastIp
              : device.lastIp
              ? 'this machine'
              : 'no address yet'}
          </p>
        </div>
        <span className={`device-status ${device.online ? 'is-online' : ''}`}>
          <span className={`device-dot ${device.online ? 'is-online' : ''}`} />
          {status}
        </span>
      </header>

      <p className='device-system'>
        {facts.osName || OS_BADGE[kind]}
        {facts.kernel ? ` · ${kind === 'windows' ? 'build' : 'kernel'} ${facts.kernel}` : ''}
        {device.arch ? ` · ${device.arch}` : ''}
      </p>

      {!compact && (
        <>
          {device.factsAt ? (
            <div className='device-facts'>
              <Meter label='Memory' used={memUsed} total={facts.memTotalMb} unit='MB' />
              <Meter label='Disk' used={facts.diskUsedGb} total={facts.diskTotalGb} unit='GB' />
              <dl className='device-stats'>
                <div>
                  <dt>CPUs</dt>
                  <dd>{facts.cpus || '—'}</dd>
                </div>
                <div>
                  <dt>Uptime</dt>
                  <dd>{formatUptime(facts.uptimeSeconds)}</dd>
                </div>
                <div>
                  <dt>Timezone</dt>
                  <dd title={facts.timezone}>{shortZone(facts.timezone)}</dd>
                </div>
              </dl>
            </div>
          ) : (
            <p className='device-facts-empty'>
              System details appear once the agent reports them (agent 1.1 or newer).
            </p>
          )}

          {device.capabilities.length > 0 && (
            <div className='device-chips' aria-label='Can run'>
              {device.capabilities.map(capability => (
                <span key={capability} className='device-chip'>
                  {capability}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {device.updateAvailable && canManage && !compact && (
        <div className='device-update'>
          <p>
            <strong>Agent {device.latestAgentVersion} is available.</strong>{' '}
            {selfUpdates(device.agentVersion)
              ? 'It updates itself on its next check-in. If it does not, run this on the device:'
              : `This agent (${device.agentVersion}) cannot update itself. Run this once on the device; it keeps its enrollment:`}
          </p>
          <div className='device-update-command'>
            <code>{upgradeCommand(device)}</code>
            <button
              type='button'
              onClick={() => {
                copy(upgradeCommand(device));
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      <footer className='device-card-foot'>
        <span className='device-last-run'>
          {device.lastRun ? (
            <>
              <span className={`run-status ${device.lastRun.ok ? 'is-ok' : 'is-bad'}`}>
                {device.lastRun.ok ? 'OK' : 'Failed'}
              </span>
              <span title={device.lastRun.snippetTitle}>
                {device.lastRun.snippetTitle} · {dateParser(device.lastRun.createdAt).relative}
              </span>
            </>
          ) : (
            <span className='text-muted'>Nothing run here yet</span>
          )}
        </span>
        <span className='device-version'>
          agent {device.agentVersion || '?'}
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
      </footer>

      {!compact && (
        <div className='device-actions'>
          {canRun && (
            <button type='button' className='btn btn-sm btn-primary' onClick={() => props.onRun(device)}>
              Run snippet…
            </button>
          )}
          <Link to={`/devices/${device.id}`} className='btn btn-sm btn-outline-secondary'>
            Open
          </Link>
          <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => props.onHistory(device)}>
            History
          </button>
          {canManage && (
            <details className='device-menu'>
              <summary className='btn btn-sm btn-outline-secondary' aria-label={`More actions for ${device.name}`}>
                ⋯
              </summary>
              <div className='device-menu-list'>
                <button type='button' onClick={() => props.onRename(device)}>
                  Rename
                </button>
                {device.possibleDuplicate && props.onClearDuplicate && (
                  <button type='button' onClick={() => props.onClearDuplicate!(device)}>
                    Clear duplicate
                  </button>
                )}
                <button type='button' className='is-danger' onClick={() => props.onRevoke(device)}>
                  Revoke access
                </button>
              </div>
            </details>
          )}
        </div>
      )}
    </article>
  );
};
