import { useState } from 'react';
import axios from 'axios';
import { Card } from '../UI';
import { DeviceDetail, DeviceFields, DeviceRemote, RemoteType, Response } from '../../typescript/interfaces';
import { apiError } from '../Variables/VariableFields';

const REMOTE_LABELS: { [type in RemoteType]: string } = {
  rustdesk: 'RustDesk',
  vnc: 'VNC',
  rdp: 'Remote Desktop (RDP)',
  ssh: 'SSH',
  url: 'Web link'
};

const FIELD_ROWS: { key: keyof Omit<DeviceFields, 'custom'>; label: string; variable: string; placeholder?: string }[] = [
  { key: 'assetTag', label: 'Asset tag', variable: 'DEVICE_ASSET_TAG', placeholder: 'AT-0042' },
  { key: 'owner', label: 'Owner', variable: 'DEVICE_OWNER', placeholder: 'Jane at reception' },
  { key: 'location', label: 'Location', variable: 'DEVICE_LOCATION', placeholder: 'Rack B2, server room' },
  { key: 'warranty', label: 'Warranty until', variable: 'DEVICE_WARRANTY' }
];

const warrantyTone = (value?: string) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const days = (date.getTime() - Date.now()) / 86400_000;
  return days < 0 ? 'is-bad' : days < 60 ? 'is-warn' : '';
};

/** Where a launch button should point, or null for the .rdp download */
export const remoteLink = (remote: DeviceRemote, fallbackAddress: string): string | null => {
  const address = remote.address || fallbackAddress;
  const port = remote.port ? `:${remote.port}` : '';
  switch (remote.type) {
    case 'rustdesk':
      return remote.remoteId ? `rustdesk://connection/new/${encodeURIComponent(remote.remoteId.replace(/\s+/g, ''))}` : null;
    case 'vnc':
      return `vnc://${remote.username ? `${encodeURIComponent(remote.username)}@` : ''}${address}${port}`;
    case 'ssh':
      return `ssh://${remote.username ? `${encodeURIComponent(remote.username)}@` : ''}${address}${port}`;
    case 'url':
      return /^https?:\/\//i.test(address) ? address : `https://${address}`;
    default:
      return null;
  }
};

export const DeviceFieldsCard = (props: { device: DeviceDetail; address: string; onSaved: () => void }) => {
  const { device } = props;
  const [editing, setEditing] = useState<'fields' | 'remote' | null>(null);
  const [fields, setFields] = useState<DeviceFields>(device.fields || {});
  const [custom, setCustom] = useState<{ name: string; value: string }[]>([]);
  const [remote, setRemote] = useState<DeviceRemote & { password?: string }>(device.remote || {});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [password, setPassword] = useState<string | null>(null);

  const startFields = () => {
    setFields(device.fields || {});
    setCustom(Object.entries(device.fields?.custom || {}).map(([name, value]) => ({ name, value })));
    setEditing('fields');
    setError('');
  };

  const startRemote = () => {
    setRemote({ ...device.remote, password: undefined });
    setEditing('remote');
    setError('');
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      if (editing === 'fields') {
        await axios.put(`/api/devices/${device.id}/fields`, {
          ...fields,
          custom: Object.fromEntries(custom.filter(row => row.name.trim()).map(row => [row.name, row.value]))
        });
      } else {
        await axios.put(`/api/devices/${device.id}/remote`, remote);
      }
      setEditing(null);
      setPassword(null);
      props.onSaved();
    } catch (err) {
      setError(apiError(err, 'Could not save.'));
    } finally {
      setSaving(false);
    }
  };

  const reveal = async () => {
    try {
      const res = await axios.get<Response<{ password: string }>>(`/api/devices/${device.id}/remote/password`);
      setPassword(res.data.data.password);
    } catch (err) {
      setError(apiError(err, 'Could not show the password.'));
    }
  };

  const link = device.remote?.type ? remoteLink(device.remote, props.address) : null;
  const customEntries = Object.entries(device.fields?.custom || {});
  const hasFields = FIELD_ROWS.some(row => device.fields?.[row.key]) || customEntries.length > 0 || device.fields?.notes;

  return (
    <Card classes='variables-card device-fields-card'>
      <div className='site-section-head'>
        <h3>Details and remote access</h3>
        {device.canAct && !editing && (
          <div className='d-flex gap-2'>
            <button type='button' className='btn btn-sm btn-outline-secondary' onClick={startFields}>
              Edit details
            </button>
            <button type='button' className='btn btn-sm btn-outline-secondary' onClick={startRemote}>
              {device.remote?.type ? 'Edit remote' : 'Add remote access'}
            </button>
          </div>
        )}
      </div>

      {error && <div className='alert alert-danger'>{error}</div>}

      {editing === 'fields' ? (
        <div className='device-fields-form'>
          {FIELD_ROWS.map(row => (
            <label key={row.key}>
              <span>
                {row.label} <code>{`{{${row.variable}}}`}</code>
              </span>
              <input
                className='form-control form-control-sm'
                type={row.key === 'warranty' ? 'date' : 'text'}
                value={fields[row.key] || ''}
                placeholder={row.placeholder}
                onChange={event => setFields({ ...fields, [row.key]: event.target.value })}
              />
            </label>
          ))}
          <div className='device-fields-wide'>
            <span className='form-label'>Custom fields</span>
            {custom.map((row, index) => (
              <div key={index} className='device-custom-row'>
                <input
                  className='form-control form-control-sm mono'
                  value={row.name}
                  placeholder='RACK'
                  aria-label='Field name'
                  onChange={event =>
                    setCustom(custom.map((item, i) => (i === index ? { ...item, name: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') } : item)))
                  }
                />
                <input
                  className='form-control form-control-sm'
                  value={row.value}
                  placeholder='Value'
                  aria-label='Field value'
                  onChange={event => setCustom(custom.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)))}
                />
                <button type='button' className='btn btn-sm btn-link text-danger' onClick={() => setCustom(custom.filter((_, i) => i !== index))}>
                  Remove
                </button>
              </div>
            ))}
            <button type='button' className='btn btn-sm btn-link px-0' onClick={() => setCustom([...custom, { name: '', value: '' }])}>
              + Add a field
            </button>
            <p className='form-text mb-0'>Each field becomes a variable: RACK is <code>{'{{DEVICE_RACK}}'}</code> in snippets run on this device.</p>
          </div>
          <label className='device-fields-wide'>
            <span>Notes</span>
            <textarea className='form-control form-control-sm' rows={3} value={fields.notes || ''} onChange={event => setFields({ ...fields, notes: event.target.value })} />
          </label>
        </div>
      ) : editing === 'remote' ? (
        <div className='device-fields-form'>
          <label>
            <span>Type</span>
            <select className='form-select form-select-sm' value={remote.type || ''} onChange={event => setRemote({ ...remote, type: (event.target.value || undefined) as RemoteType })}>
              <option value=''>None</option>
              {(Object.keys(REMOTE_LABELS) as RemoteType[]).map(type => (
                <option key={type} value={type}>
                  {REMOTE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          {remote.type === 'rustdesk' ? (
            <label>
              <span>RustDesk ID</span>
              <input className='form-control form-control-sm mono' value={remote.remoteId || ''} onChange={event => setRemote({ ...remote, remoteId: event.target.value })} placeholder='123 456 789' />
            </label>
          ) : (
            remote.type && (
              <label>
                <span>{remote.type === 'url' ? 'Address (URL)' : 'Host or IP'}</span>
                <input className='form-control form-control-sm mono' value={remote.address || ''} onChange={event => setRemote({ ...remote, address: event.target.value })} placeholder={props.address} />
              </label>
            )
          )}
          {remote.type && remote.type !== 'rustdesk' && remote.type !== 'url' && (
            <label>
              <span>Port</span>
              <input
                className='form-control form-control-sm'
                inputMode='numeric'
                value={remote.port || ''}
                onChange={event => setRemote({ ...remote, port: Number(event.target.value.replace(/\D/g, '')) || undefined })}
                placeholder={remote.type === 'rdp' ? '3389' : remote.type === 'vnc' ? '5900' : '22'}
              />
            </label>
          )}
          {remote.type && remote.type !== 'url' && remote.type !== 'rustdesk' && (
            <label>
              <span>Username</span>
              <input className='form-control form-control-sm' value={remote.username || ''} onChange={event => setRemote({ ...remote, username: event.target.value })} />
            </label>
          )}
          {remote.type && (
            <label>
              <span>Password {device.remote?.hasPassword && '(saved)'}</span>
              <input
                className='form-control form-control-sm'
                type='password'
                autoComplete='new-password'
                value={remote.password ?? ''}
                placeholder={device.remote?.hasPassword ? 'Leave empty to keep it' : 'Optional; stored encrypted'}
                onChange={event => setRemote({ ...remote, password: event.target.value || undefined })}
              />
            </label>
          )}
          {device.remote?.hasPassword && (
            <label className='form-check device-fields-wide'>
              <input
                type='checkbox'
                className='form-check-input'
                checked={remote.password === ''}
                onChange={event => setRemote({ ...remote, password: event.target.checked ? '' : undefined })}
              />{' '}
              Remove the saved password
            </label>
          )}
          {!remote.type && <p className='form-text device-fields-wide mb-0'>Store how to reach this machine so anyone with access can connect from here.</p>}
        </div>
      ) : (
        <div className='device-fields-view'>
          <div>
            {hasFields ? (
              <dl className='device-properties'>
                {FIELD_ROWS.filter(row => device.fields?.[row.key]).map(row => (
                  <div key={row.key}>
                    <dt>{row.label}</dt>
                    <dd className={row.key === 'warranty' ? warrantyTone(device.fields.warranty) : ''}>
                      {row.key === 'warranty' && device.fields.warranty && !Number.isNaN(new Date(device.fields.warranty).getTime())
                        ? new Date(device.fields.warranty).toLocaleDateString(undefined, { dateStyle: 'medium' })
                        : device.fields[row.key]}
                    </dd>
                  </div>
                ))}
                {customEntries.map(([name, value]) => (
                  <div key={name}>
                    <dt className='mono'>{name}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className='text-muted mb-2'>No asset tag, owner or warranty recorded.</p>
            )}
            {device.fields?.notes && <p className='device-notes'>{device.fields.notes}</p>}
          </div>

          <div className='device-remote'>
            {device.remote?.type ? (
              <>
                <div className='device-remote-head'>
                  <strong>{REMOTE_LABELS[device.remote.type]}</strong>
                  <span className='mono tool-sub'>
                    {device.remote.type === 'rustdesk'
                      ? device.remote.remoteId
                      : `${device.remote.username ? `${device.remote.username}@` : ''}${device.remote.address || props.address}${device.remote.port ? `:${device.remote.port}` : ''}`}
                  </span>
                </div>
                <div className='d-flex flex-wrap gap-2 align-items-center'>
                  {device.remote.type === 'rdp' ? (
                    <a className='btn btn-sm btn-primary' href={`/api/devices/${device.id}/remote.rdp`}>
                      Download .rdp
                    </a>
                  ) : (
                    link && (
                      <a className='btn btn-sm btn-primary' href={link} target={device.remote.type === 'url' ? '_blank' : undefined} rel='noreferrer'>
                        Connect
                      </a>
                    )
                  )}
                  {device.remote.hasPassword &&
                    device.canAct &&
                    (password === null ? (
                      <button type='button' className='btn btn-sm btn-outline-secondary' onClick={reveal}>
                        Show password
                      </button>
                    ) : (
                      <>
                        <code className='device-remote-password'>{password}</code>
                        <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => navigator.clipboard?.writeText(password)}>
                          Copy
                        </button>
                      </>
                    ))}
                </div>
                <p className='form-text mb-0'>
                  {device.remote.type === 'rdp'
                    ? 'Opens in Remote Desktop Connection or your RDP app.'
                    : device.remote.type === 'url'
                    ? 'Opens in a new tab.'
                    : `Opens the ${REMOTE_LABELS[device.remote.type]} app on your computer if it is installed.`}
                  {device.remote.hasPassword && ' Showing the password is recorded in the audit log.'}
                </p>
              </>
            ) : (
              <p className='text-muted mb-0'>No remote access saved.</p>
            )}
          </div>
        </div>
      )}

      {editing && (
        <div className='variable-editor-actions mt-3'>
          <button type='button' className='btn btn-sm btn-primary' onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => setEditing(null)} disabled={saving}>
            Cancel
          </button>
        </div>
      )}
    </Card>
  );
};
