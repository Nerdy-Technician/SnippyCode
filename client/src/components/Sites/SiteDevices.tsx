import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import copy from 'clipboard-copy';
import { Device, Enrollment, Response } from '../../typescript/interfaces';
import { dateParser } from '../../utils';
import { apiError } from '../Variables/VariableFields';
import { DeviceCard } from './DeviceCard';
import { DeviceRunModal } from './DeviceRunModal';

interface Props {
  siteId: number;
  siteName: string;
  devices: Device[] | null;
  canManage: boolean;
  canRun: boolean;
  reload: () => void;
}

type Platform = 'linux' | 'windows';

export const SiteDevices = (props: Props): JSX.Element => {
  const { siteId, siteName, devices, canManage, canRun, reload } = props;
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [adding, setAdding] = useState(false);
  const [maxUses, setMaxUses] = useState(1);
  const [platform, setPlatform] = useState<Platform>('linux');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [dialog, setDialog] = useState<{ device: Device; mode: 'run' | 'history' } | null>(null);
  const knownIds = useRef<Set<number>>(new Set());
  const [newIds, setNewIds] = useState<number[]>([]);

  // While an enrollment is open, watch for the new device to join
  useEffect(() => {
    if (!enrollment) {
      return;
    }

    knownIds.current = new Set((devices || []).map(device => device.id));
    const timer = window.setInterval(reload, 4000);
    return () => window.clearInterval(timer);
  }, [enrollment]);

  useEffect(() => {
    if (!enrollment || !devices) {
      return;
    }

    const joined = devices.filter(device => !knownIds.current.has(device.id)).map(device => device.id);

    if (joined.length) {
      setNewIds(joined);
    }
  }, [devices]);

  const enroll = async () => {
    setError('');

    try {
      const res = await axios.post<Response<Enrollment>>('/api/devices/enrollments', {
        siteId,
        maxUses,
        expiresHours: 24
      });
      setEnrollment(res.data.data);
      setNewIds([]);
    } catch (err) {
      setError(apiError(err, 'Could not create an enrollment token.'));
    }
  };

  const rename = async (device: Device) => {
    const name = window.prompt('Device name', device.name);

    if (name && name !== device.name) {
      await axios.patch(`/api/devices/${device.id}`, { name });
      reload();
    }
  };

  const revoke = async (device: Device) => {
    if (window.confirm(`Revoke ${device.name}? Its agent stops working until it is enrolled again.`)) {
      await axios.delete(`/api/devices/${device.id}`);
      reload();
    }
  };

  const closeEnrollment = () => {
    setEnrollment(null);
    setAdding(false);
    reload();
  };

  const command = enrollment ? (platform === 'linux' ? enrollment.linux : enrollment.windows) : '';
  const online = (devices || []).filter(device => device.online).length;

  return (
    <div className='site-devices'>
      <div className='site-section-head'>
        <div>
          <h3>Devices</h3>
          <p>
            {devices === null
              ? 'Loading…'
              : devices.length === 0
              ? `No machines at ${siteName} run the agent yet.`
              : `${online} of ${devices.length} online. Snippets, runbooks and schedules can run on them with ${siteName} values.`}
          </p>
        </div>
        {canManage && !adding && (
          <button type='button' className='btn btn-primary btn-sm' onClick={() => setAdding(true)}>
            + Add device
          </button>
        )}
      </div>

      {error && <div className='alert alert-danger'>{error}</div>}

      {adding && (
        <section className='enroll-panel' aria-label='Add a device'>
          <ol className='enroll-steps'>
            <li className={enrollment ? 'is-done' : 'is-current'}>
              <strong>Create a one-time token</strong>
              {!enrollment ? (
                <div className='enroll-row'>
                  <select className='form-control form-control-sm' value={maxUses} onChange={e => setMaxUses(Number(e.target.value))} aria-label='How many devices'>
                    <option value={1}>For one device</option>
                    <option value={10}>For up to 10 devices</option>
                    <option value={100}>For up to 100 devices</option>
                  </select>
                  <button type='button' className='btn btn-sm btn-primary' onClick={enroll}>
                    Create token
                  </button>
                  <button type='button' className='btn btn-sm btn-link' onClick={() => setAdding(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <span className='form-text'>
                  Valid for {enrollment.maxUses === 1 ? 'one device' : `${enrollment.maxUses} devices`} until{' '}
                  {dateParser(enrollment.expiresAt).formatted}. Shown only once.
                </span>
              )}
            </li>
            <li className={enrollment && !newIds.length ? 'is-current' : enrollment ? 'is-done' : ''}>
              <strong>Run the installer on the device</strong>
              {enrollment && (
                <>
                  <div className='segmented enroll-platforms'>
                    <button type='button' className={platform === 'linux' ? 'is-active' : ''} onClick={() => setPlatform('linux')}>
                      Linux (root)
                    </button>
                    <button type='button' className={platform === 'windows' ? 'is-active' : ''} onClick={() => setPlatform('windows')}>
                      Windows (admin PowerShell)
                    </button>
                  </div>
                  <div className='device-update-command'>
                    <code>{command}</code>
                    <button
                      type='button'
                      onClick={() => {
                        copy(command);
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 2000);
                      }}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <span className='form-text'>
                    {platform === 'linux'
                      ? 'Installs a systemd service. Needs curl and bash.'
                      : 'Installs a scheduled task running as SYSTEM.'}{' '}
                    The agent only talks HTTPS (localhost excepted) because jobs can carry secrets.
                  </span>
                </>
              )}
            </li>
            <li className={newIds.length ? 'is-done' : ''}>
              <strong>{newIds.length ? 'Connected' : 'Wait for it to connect'}</strong>
              {enrollment && (
                <span className='form-text'>
                  {newIds.length ? (
                    <>
                      {(devices || []).filter(device => newIds.includes(device.id)).map(device => device.name).join(', ')} joined {siteName}.{' '}
                      <button type='button' className='btn btn-link btn-sm p-0' onClick={closeEnrollment}>
                        Done
                      </button>
                    </>
                  ) : (
                    <>
                      <span className='enroll-waiting' aria-hidden='true' /> Watching for new devices…{' '}
                      <button type='button' className='btn btn-link btn-sm p-0' onClick={closeEnrollment}>
                        Close
                      </button>
                    </>
                  )}
                </span>
              )}
            </li>
          </ol>
        </section>
      )}

      {devices && devices.length > 0 && (
        <div className='device-grid'>
          {devices.map(device => (
            <DeviceCard
              key={device.id}
              device={device}
              canManage={canManage}
              canRun={canRun}
              highlight={newIds.includes(device.id)}
              onRun={item => setDialog({ device: item, mode: 'run' })}
              onHistory={item => setDialog({ device: item, mode: 'history' })}
              onRename={rename}
              onRevoke={revoke}
            />
          ))}
        </div>
      )}

      {devices && devices.length === 0 && !adding && (
        <div className='site-empty'>
          <p>
            Install the agent on a server or PC at {siteName} to run snippets there, check them on a
            schedule, and see their disk, memory and uptime here.
          </p>
          {canManage ? (
            <button type='button' className='btn btn-outline-secondary btn-sm' onClick={() => setAdding(true)}>
              Add the first device
            </button>
          ) : (
            <p className='form-text mb-0'>Ask an admin to add one.</p>
          )}
        </div>
      )}

      {dialog && (
        <DeviceRunModal
          device={dialog.device}
          siteId={siteId}
          siteName={siteName}
          mode={dialog.mode}
          onClose={() => setDialog(null)}
          onFinished={reload}
        />
      )}
    </div>
  );
};
