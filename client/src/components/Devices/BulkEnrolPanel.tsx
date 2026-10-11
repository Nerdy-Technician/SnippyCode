import { useContext, useEffect, useState } from 'react';
import axios from 'axios';
import copy from 'clipboard-copy';
import { SnippetsContext } from '../../store';
import { Enrollment, EnrollmentToken, Response } from '../../typescript/interfaces';
import {
  DEFAULT_ENROL_EXPIRY_DAYS,
  MAX_ENROL_EXPIRY_DAYS,
  dateParser,
  describeStatus,
  describeUses,
  enrolmentRequest
} from '../../utils';
import { apiError } from '../Variables/VariableFields';

/**
 * Bulk enrolment: one reusable token and install one-liners that enrol many
 * machines into a site, plus the list of tokens with Revoke.
 */
export const BulkEnrolPanel = (): JSX.Element => {
  const { sites } = useContext(SnippetsContext);
  const [siteId, setSiteId] = useState('');
  const [maxUses, setMaxUses] = useState('');
  const [expiryDays, setExpiryDays] = useState(String(DEFAULT_ENROL_EXPIRY_DAYS));
  const [label, setLabel] = useState('');
  const [allowReenrol, setAllowReenrol] = useState(false);
  const [created, setCreated] = useState<Enrollment | null>(null);
  const [tokens, setTokens] = useState<EnrollmentToken[]>([]);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  const load = () =>
    axios
      .get<Response<EnrollmentToken[]>>('/api/devices/enrollments')
      .then(res => setTokens(res.data.data))
      .catch(() => setTokens([]));

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!siteId && sites.length) {
      setSiteId(String(sites[0].id));
    }
  }, [sites, siteId]);

  const create = async () => {
    setError('');
    setCopied('');

    try {
      const res = await axios.post<Response<Enrollment>>(
        '/api/devices/enrollments',
        enrolmentRequest(Number(siteId), maxUses, expiryDays, label, allowReenrol)
      );
      setCreated(res.data.data);
      load();
    } catch (err) {
      setError(apiError(err, 'Could not create an enrolment token.'));
    }
  };

  const revoke = async (token: EnrollmentToken) => {
    if (!window.confirm(`Revoke ${token.tokenPrefix}…? Machines already enrolled keep working.`)) {
      return;
    }

    try {
      await axios.delete(`/api/devices/enrollments/${token.id}`);
      if (created?.id === token.id) {
        setCreated(null);
      }
      load();
    } catch (err) {
      setError(apiError(err, 'Could not revoke the token.'));
    }
  };

  const copyLine = (key: string, text: string) => {
    copy(text).then(() => setCopied(key));
  };

  return (
    <section className='bulk-enrol' aria-label='Bulk enrol'>
      <div className='bulk-enrol-form'>
        <label>
          <span>Site</span>
          <select className='form-select form-select-sm' value={siteId} onChange={event => setSiteId(event.target.value)} aria-label='Site'>
            {sites.map(site => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Max uses</span>
          <input
            className='form-control form-control-sm'
            type='number'
            min={1}
            placeholder='Unlimited'
            value={maxUses}
            onChange={event => setMaxUses(event.target.value)}
            aria-label='Max uses'
          />
        </label>
        <label>
          <span>Expires in (days)</span>
          <input
            className='form-control form-control-sm'
            type='number'
            min={1}
            max={MAX_ENROL_EXPIRY_DAYS}
            value={expiryDays}
            onChange={event => setExpiryDays(event.target.value)}
            aria-label='Expires in days'
          />
        </label>
        <label>
          <span>Label</span>
          <input
            className='form-control form-control-sm'
            placeholder='Optional, e.g. Office rollout'
            value={label}
            onChange={event => setLabel(event.target.value)}
            aria-label='Label'
          />
        </label>
        <label className='bulk-enrol-check' title='Admins only. Lets machines that are already enrolled get a new device token without using up the token.'>
          <span>Re-enrol</span>
          <input type='checkbox' checked={allowReenrol} onChange={event => setAllowReenrol(event.target.checked)} aria-label='Allow re-enrolling existing machines' />
        </label>
        <button type='button' className='btn btn-sm btn-primary' onClick={create} disabled={!siteId}>
          Create install script
        </button>
      </div>

      {error && <p className='text-danger small mb-2' role='alert'>{error}</p>}

      {created && (
        <div className='bulk-enrol-commands'>
          <p className='form-text'>
            Run on each machine. Valid for{' '}
            {created.maxUses === null ? 'any number of machines' : `up to ${created.maxUses} machines`} until{' '}
            {dateParser(created.expiresAt).formatted}. The token is shown only once.
          </p>
          {([
            ['linux', 'Linux (bash)', created.linux],
            ['windows', 'Windows (elevated PowerShell)', created.windows]
          ] as [string, string, string][]).map(([key, title, line]) => (
            <div key={key} className='bulk-enrol-command'>
              <strong>{title}</strong>
              <code>{line}</code>
              <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => copyLine(key, line)}>
                {copied === key ? 'Copied' : 'Copy install script'}
              </button>
            </div>
          ))}
        </div>
      )}

      <table className='table table-sm bulk-enrol-tokens'>
        <thead>
          <tr>
            <th scope='col'>Token</th>
            <th scope='col'>Site</th>
            <th scope='col'>Uses</th>
            <th scope='col'>Expires</th>
            <th scope='col'>Last used</th>
            <th scope='col'>Status</th>
            <th scope='col' aria-label='Actions' />
          </tr>
        </thead>
        <tbody>
          {tokens.length === 0 ? (
            <tr>
              <td colSpan={7} className='text-muted'>
                No enrolment tokens yet.
              </td>
            </tr>
          ) : (
            tokens.map(token => (
              <tr key={token.id}>
                <td>
                  <code>{token.tokenPrefix}…</code>
                  {token.label && <span className='ms-1 text-muted'>{token.label}</span>}
                  {token.allowReenrol && <span className='badge bg-warning text-dark ms-1'>re-enrol</span>}
                </td>
                <td>{token.site?.name || '—'}</td>
                <td>{describeUses(token)}</td>
                <td>{dateParser(token.expiresAt).formatted}</td>
                <td>{token.lastUsedAt ? dateParser(token.lastUsedAt).relative : 'Never'}</td>
                <td>
                  <span className={`badge enrol-status is-${token.status}`}>{describeStatus(token)}</span>
                </td>
                <td>
                  {token.status !== 'revoked' && (
                    <button type='button' className='btn btn-sm btn-outline-danger' onClick={() => revoke(token)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
};
