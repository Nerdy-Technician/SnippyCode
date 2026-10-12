import { useContext, useEffect, useState } from 'react';
import axios from 'axios';
import { SnippetsContext } from '../../store';
import { ResolvedVariable, Response } from '../../typescript/interfaces';

const SOURCE_LABEL: Record<string, string> = {
  prompt: 'Runtime prompt',
  user: 'User',
  device: 'Device',
  site: 'Site',
  global: 'Global',
  default: 'Snippet default',
  missing: 'Prompted at run time'
};

interface Props {
  snippetId?: number;
  /** Changes to the code re-run the preview (after saving) */
  code: string;
}

/**
 * Pick a site or device and see each variable's value and the scope it came
 * from. Secrets are masked by the server; nothing is decrypted here.
 */
export const ResolvedPreview = ({ snippetId, code }: Props): JSX.Element => {
  const { sites } = useContext(SnippetsContext);
  const [siteId, setSiteId] = useState<number | null>(null);
  const [deviceId, setDeviceId] = useState<number | null>(null);
  const [devices, setDevices] = useState<Array<{ id: number; name: string }>>([]);
  const [items, setItems] = useState<ResolvedVariable[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setDeviceId(null);
    setDevices([]);
    if (!siteId) return;
    axios
      .get<Response<Array<{ id: number; name: string }>>>('/api/devices', { params: { siteId } })
      .then(res => setDevices(res.data.data.map(device => ({ id: device.id, name: device.name }))))
      .catch(() => setDevices([]));
  }, [siteId]);

  useEffect(() => {
    if (!snippetId) return;
    setError('');
    axios
      .get<Response<{ variables: ResolvedVariable[] }>>('/api/variables/preview', {
        params: { snippetId, siteId: siteId || undefined, deviceId: deviceId || undefined }
      })
      .then(res => setItems(res.data.data.variables))
      .catch(() => {
        setItems(null);
        setError('The preview could not be loaded.');
      });
  }, [snippetId, siteId, deviceId, code]);

  if (!snippetId) {
    return <p className='form-text mb-0'>Save the snippet to preview its resolved values.</p>;
  }

  return (
    <div className='resolved-preview'>
      <div className='d-flex flex-wrap gap-2 mb-2'>
        <select
          className='form-select form-select-sm w-auto'
          aria-label='Preview site'
          value={siteId ?? ''}
          onChange={event => setSiteId(Number(event.target.value) || null)}
        >
          <option value=''>No site</option>
          {sites.map(site => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </select>
        {siteId && (
          <select
            className='form-select form-select-sm w-auto'
            aria-label='Preview device'
            value={deviceId ?? ''}
            onChange={event => setDeviceId(Number(event.target.value) || null)}
          >
            <option value=''>Any device</option>
            {devices.map(device => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && <div className='alert alert-danger mb-0'>{error}</div>}
      {items && items.length === 0 && <p className='text-muted mb-0'>This snippet has no variables.</p>}
      {items && items.length > 0 && (
        <table className='table table-sm mb-0'>
          <thead>
            <tr>
              <th>Variable</th>
              <th>Value</th>
              <th>From</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.name}>
                <td>
                  <code>{item.name}</code>
                  {item.ref && <span className='form-text'> → {item.ref}</span>}
                </td>
                <td>{item.source === 'missing' ? <em className='text-muted'>none</em> : <code>{item.value}</code>}</td>
                <td>
                  <span className={`snippet-variable-source is-${item.source}`}>{SOURCE_LABEL[item.source]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
