import { useEffect, useState } from 'react';
import axios from 'axios';
import { apiError } from '../Variables/VariableFields';

interface RolloutStatus {
  release: { version: string; files: string[] } | null;
  rollout: { mode: 'auto' | 'manual'; rings: string[]; percent: number; paused: boolean; pausedReason?: string; bootstrapUntil?: string | null };
  stage: string;
  bootstrapOpen: boolean;
  rings: string[];
  devices: { total: number; current: number; offered: number; pinned: number };
}

/**
 * Staged agent updates: which rings get a signed release straight away, what
 * share of the rest, and a per-device ring or version pin. Releases are
 * signed offline (scripts/agent-release.js); see docs/agent-updates.md.
 */
export const AgentRollout = (): JSX.Element => {
  const [status, setStatus] = useState<RolloutStatus | null>(null);
  const [notice, setNotice] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [ring, setRing] = useState('');
  const [pin, setPin] = useState('');

  const load = () =>
    axios
      .get<{ data: RolloutStatus }>('/api/devices/agent-rollout')
      .then(res => setStatus(res.data.data))
      .catch(err => setNotice(apiError(err, 'Could not load the agent rollout.')));

  useEffect(() => {
    load();
  }, []);

  const save = async (patch: Partial<RolloutStatus['rollout']>) => {
    if (!status) return;
    setNotice('');
    try {
      await axios.put('/api/devices/agent-rollout', { ...status.rollout, ...patch });
      setNotice('Rollout saved.');
      load();
    } catch (err) {
      setNotice(apiError(err, 'Could not save the rollout.'));
    }
  };

  const saveDevice = async () => {
    setNotice('');
    try {
      await axios.put(`/api/devices/${Number(deviceId)}/agent-update`, { ...(ring ? { ring } : {}), pin });
      setNotice('Device saved.');
      load();
    } catch (err) {
      setNotice(apiError(err, 'Could not save the device.'));
    }
  };

  if (!status) return <p className='text-muted'>{notice || 'Loading…'}</p>;

  return (
    <div className='agent-rollout'>
      <h5 className='card-title'>Agent updates</h5>
      <p className='form-text mt-0'>
        {status.release
          ? `Signed release ${status.release.version}: ${status.devices.current} of ${status.devices.total} devices on it, ${status.devices.offered} being offered it, ${status.devices.pinned} pinned.`
          : 'No signed release is installed on the server, so no agent is offered an update.'}
      </p>
      <div className='d-flex flex-wrap gap-3 align-items-center mb-2'>
        <select
          className='form-select form-select-sm w-auto'
          aria-label='Rollout mode'
          value={status.rollout.mode}
          onChange={e => save({ mode: e.target.value as 'auto' | 'manual' })}
        >
          <option value='auto'>Staged (canary → early → stable share)</option>
          <option value='manual'>Manual rings</option>
        </select>
        <span className='form-text m-0'>Stage: {status.stage}</span>
      </div>
      {status.rollout.paused && status.rollout.pausedReason ? (
        <div className='alert alert-warning py-1'>Paused: {status.rollout.pausedReason}</div>
      ) : (
        <></>
      )}
      <div className='d-flex flex-wrap gap-3 align-items-center mb-2'>
        {status.rollout.mode === 'manual' && status.rings.map(name => (
          <label key={name} className='form-check-label'>
            <input
              type='checkbox'
              className='form-check-input me-1'
              checked={status.rollout.rings.includes(name)}
              onChange={e =>
                save({ rings: e.target.checked ? [...status.rollout.rings, name] : status.rollout.rings.filter(item => item !== name) })
              }
            />
            {name} ring
          </label>
        ))}
        <label>
          {status.rollout.mode === 'auto' ? 'Stable share' : 'Rest of the fleet'}{' '}
          <input
            type='number'
            min={0}
            max={100}
            className='form-control form-control-sm d-inline-block w-auto'
            aria-label='Rollout percentage'
            defaultValue={status.rollout.percent}
            onBlur={e => save({ percent: Number(e.target.value) })}
          />{' '}
          %
        </label>
        <label className='form-check-label'>
          <input type='checkbox' className='form-check-input me-1' checked={status.rollout.paused} onChange={e => save({ paused: e.target.checked })} />
          Paused
        </label>
      </div>
      <div className='d-flex flex-wrap gap-2 align-items-center mb-2'>
        <label className='form-text m-0'>
          Pre-1.4.0 agents may take the one-time update until{' '}
          <input
            type='date'
            className='form-control form-control-sm d-inline-block w-auto'
            aria-label='Bootstrap window end'
            defaultValue={status.rollout.bootstrapUntil ? status.rollout.bootstrapUntil.slice(0, 10) : ''}
            onBlur={e => save({ bootstrapUntil: e.target.value ? new Date(`${e.target.value}T23:59:59Z`).toISOString() : null })}
          />{' '}
          ({status.bootstrapOpen ? 'open' : 'closed'}; needs AGENT_BOOTSTRAP_SHA256, max 30 days)
        </label>
      </div>
      <div className='d-flex flex-wrap gap-2 align-items-center'>
        <input className='form-control form-control-sm w-auto' placeholder='Device ID' aria-label='Device ID' value={deviceId} onChange={e => setDeviceId(e.target.value)} />
        <select className='form-select form-select-sm w-auto' aria-label='Ring' value={ring} onChange={e => setRing(e.target.value)}>
          <option value=''>Keep ring</option>
          {status.rings.map(name => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <input className='form-control form-control-sm w-auto' placeholder='Pin version (empty = none)' aria-label='Pin version' value={pin} onChange={e => setPin(e.target.value)} />
        <button type='button' className='btn btn-sm btn-outline-secondary' disabled={!Number(deviceId)} onClick={saveDevice}>
          Save device
        </button>
      </div>
      {notice && <div className='form-text'>{notice}</div>}
    </div>
  );
};
