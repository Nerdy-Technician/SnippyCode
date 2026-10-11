import { useContext, useEffect, useState } from 'react';
import axios from 'axios';
import { SnippetsContext } from '../../store';
import { NotificationChannel, Response, WebhookType } from '../../typescript/interfaces';
import { dateParser } from '../../utils';
import { Card } from '../UI';
import { apiError } from '../Variables/VariableFields';

interface EventOption {
  id: string;
  label: string;
}

interface Draft {
  id?: number;
  name: string;
  type: WebhookType;
  url: string;
  signingSecret: string;
  events: string[];
  siteIds: number[];
  enabled: boolean;
}

const TYPE_LABELS: { [type in WebhookType]: string } = {
  slack: 'Slack',
  teams: 'Microsoft Teams',
  discord: 'Discord',
  webhook: 'Webhook (JSON)'
};

const URL_HELP: { [type in WebhookType]: string } = {
  slack: 'A Slack incoming webhook URL (https://hooks.slack.com/services/…).',
  teams: 'A Teams Workflows URL from “Post to a channel when a webhook request is received”.',
  discord: 'A Discord channel webhook URL (Server settings → Integrations → Webhooks).',
  webhook: 'Any URL. SnippyCode POSTs JSON and, with a signing secret, an X-SnippyCode-Signature header.'
};

const DEFAULT_EVENTS = ['run.failed', 'schedule.failed', 'runbook.failed', 'runbook.attention', 'device.offline', 'backup.failed'];

const emptyDraft = (): Draft => ({
  name: '',
  type: 'slack',
  url: '',
  signingSecret: '',
  events: DEFAULT_EVENTS,
  siteIds: [],
  enabled: true
});

export const AdminNotifications = (): JSX.Element => {
  const { sites, getSites } = useContext(SnippetsContext);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [events, setEvents] = useState<EventOption[]>([]);
  const [publicBaseUrl, setPublicBaseUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [deliveries, setDeliveries] = useState<{ id: number; items: any[] } | null>(null);

  const load = () =>
    axios
      .get<Response<{ webhooks: NotificationChannel[]; events: EventOption[]; publicBaseUrl: string | null }>>(
        '/api/notifications'
      )
      .then(res => {
        setChannels(res.data.data.webhooks);
        setEvents(res.data.data.events);
        setPublicBaseUrl(res.data.data.publicBaseUrl);
      });

  useEffect(() => {
    load();
    getSites();
  }, []);

  const save = async () => {
    if (!draft) {
      return;
    }

    setError('');

    const body: Record<string, unknown> = { ...draft };
    if (draft.id && !draft.url) {
      delete body.url;
    }
    if (draft.id && !draft.signingSecret) {
      delete body.signingSecret;
    }

    try {
      if (draft.id) {
        await axios.put(`/api/notifications/${draft.id}`, body);
      } else {
        await axios.post('/api/notifications', body);
      }
      setDraft(null);
      load();
    } catch (err) {
      setError(apiError(err, 'Could not save the channel.'));
    }
  };

  const test = async (channel: NotificationChannel) => {
    setMessage('');
    const res = await axios.post<Response<{ ok: boolean; statusCode: number | null; error: string | null }>>(
      `/api/notifications/${channel.id}/test`
    );
    setMessage(
      res.data.data.ok
        ? `Test sent to ${channel.name}.`
        : `Test to ${channel.name} failed: ${res.data.data.error || res.data.data.statusCode}`
    );
    load();
  };

  const remove = async (channel: NotificationChannel) => {
    if (window.confirm(`Delete the ${channel.name} channel?`)) {
      await axios.delete(`/api/notifications/${channel.id}`);
      load();
    }
  };

  const showDeliveries = async (channel: NotificationChannel) => {
    if (deliveries?.id === channel.id) {
      setDeliveries(null);
      return;
    }

    const res = await axios.get<Response<any[]>>(`/api/notifications/${channel.id}/deliveries`);
    setDeliveries({ id: channel.id, items: res.data.data });
  };

  const toggleEvent = (id: string) =>
    draft &&
    setDraft({
      ...draft,
      events: draft.events.includes(id) ? draft.events.filter(event => event !== id) : [...draft.events, id]
    });

  return (
    <Card classes='task-panel admin-tab-panel-wide'>
      <div className='variables-card-header'>
        <div>
          <p className='eyebrow'>Notifications</p>
          <h5 className='card-title'>Where SnippyCode sends alerts</h5>
          <p className='form-text mb-0'>
            Send failed runs, schedule results, secret reveals and more to Slack, Teams, Discord or any
            webhook. Deliveries retry twice.
          </p>
        </div>
        {!draft && (
          <button type='button' className='btn btn-sm btn-primary' onClick={() => setDraft(emptyDraft())}>
            Add channel
          </button>
        )}
      </div>

      {!publicBaseUrl && (
        <div className='alert alert-info'>
          Set <code>PUBLIC_BASE_URL</code> (e.g. https://snippycode.example) so messages link back to SnippyCode.
        </div>
      )}
      {message && <div className='alert alert-info'>{message}</div>}
      {error && <div className='alert alert-danger'>{error}</div>}

      {draft && (
        <form
          className='notification-form'
          onSubmit={event => {
            event.preventDefault();
            save();
          }}
        >
          <label>
            <span>Name</span>
            <input className='form-control' value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder='#ops-alerts' autoFocus />
          </label>
          <label>
            <span>Type</span>
            <select className='form-control' value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value as WebhookType })}>
              {(Object.keys(TYPE_LABELS) as WebhookType[]).map(type => (
                <option key={type} value={type}>
                  {TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <label className='notification-wide'>
            <span>URL</span>
            <input
              className='form-control'
              type='password'
              autoComplete='off'
              value={draft.url}
              onChange={e => setDraft({ ...draft, url: e.target.value })}
              placeholder={draft.id ? 'Unchanged. Paste a new URL to replace it' : 'https://…'}
            />
            <small className='form-text'>{URL_HELP[draft.type]} Stored encrypted.</small>
          </label>
          {draft.type === 'webhook' && (
            <label className='notification-wide'>
              <span>Signing secret (optional)</span>
              <input
                className='form-control'
                type='password'
                autoComplete='off'
                value={draft.signingSecret}
                onChange={e => setDraft({ ...draft, signingSecret: e.target.value })}
                placeholder={draft.id ? 'Unchanged' : 'Used for HMAC-SHA256 of "timestamp.body"'}
              />
            </label>
          )}
          <fieldset className='notification-wide'>
            <legend>Events</legend>
            <div className='notification-events'>
              {events.map(event => (
                <label key={event.id} className='site-member'>
                  <input type='checkbox' className='form-check-input' checked={draft.events.includes(event.id)} onChange={() => toggleEvent(event.id)} />
                  <span>{event.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {sites.length > 0 && (
            <fieldset className='notification-wide'>
              <legend>Only for these sites (optional)</legend>
              <div className='notification-events'>
                {sites.map(site => (
                  <label key={site.id} className='site-member'>
                    <input
                      type='checkbox'
                      className='form-check-input'
                      checked={draft.siteIds.includes(site.id)}
                      onChange={e =>
                        setDraft({
                          ...draft,
                          siteIds: e.target.checked ? [...draft.siteIds, site.id] : draft.siteIds.filter(id => id !== site.id)
                        })
                      }
                    />
                    <span>{site.name}</span>
                  </label>
                ))}
              </div>
              <small className='form-text'>With sites chosen, events without a site (like backups) are not sent here.</small>
            </fieldset>
          )}
          <label className='schedule-enabled'>
            <input type='checkbox' className='form-check-input' checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />
            <span>Enabled</span>
          </label>
          <div className='variable-editor-actions notification-wide'>
            <button type='submit' className='btn btn-primary' disabled={!draft.name.trim() || !draft.events.length || (!draft.id && !draft.url)}>
              Save channel
            </button>
            <button type='button' className='btn btn-outline-secondary' onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className='variable-list'>
        {channels.length === 0 && !draft && <p className='text-muted mb-0'>No channels yet.</p>}
        {channels.map(channel => (
          <div key={channel.id}>
            <div className='variable-row'>
              <div className='variable-row-main'>
                <span className={`device-dot ${channel.enabled && channel.lastStatus !== 'failed' ? 'is-online' : ''}`} />
                <strong>{channel.name}</strong>
                <span className='variable-description'>
                  {TYPE_LABELS[channel.type]} · {channel.host} · {channel.events.includes('*') ? 'all events' : `${channel.events.length} events`}
                  {channel.siteIds.length ? ` · ${channel.siteIds.length} sites` : ''}
                  {!channel.enabled && ' · paused'}
                </span>
                {channel.lastStatus === 'failed' && <span className='text-danger small'>{channel.lastError}</span>}
              </div>
              <span className='variable-usage'>
                {channel.lastDeliveredAt ? `Last sent ${dateParser(channel.lastDeliveredAt).relative}` : 'Nothing sent yet'}
              </span>
              <div className='variable-row-actions'>
                <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => test(channel)}>
                  Test
                </button>
                <button type='button' className='btn btn-sm btn-outline-secondary' onClick={() => showDeliveries(channel)}>
                  Log
                </button>
                <button
                  type='button'
                  className='btn btn-sm btn-outline-secondary'
                  onClick={() =>
                    setDraft({
                      id: channel.id,
                      name: channel.name,
                      type: channel.type,
                      url: '',
                      signingSecret: '',
                      events: channel.events,
                      siteIds: channel.siteIds,
                      enabled: channel.enabled
                    })
                  }
                >
                  Edit
                </button>
                <button type='button' className='btn btn-sm btn-outline-danger' onClick={() => remove(channel)}>
                  Delete
                </button>
              </div>
            </div>
            {deliveries?.id === channel.id && (
              <ul className='run-list mt-2'>
                {deliveries.items.length === 0 && <li className='p-2 text-muted'>No deliveries yet.</li>}
                {deliveries.items.map(item => (
                  <li key={item.id}>
                    <div className='run-row'>
                      <span className={`run-status ${item.ok ? 'is-ok' : 'is-bad'}`}>{item.ok ? 'Sent' : 'Failed'}</span>
                      <span className='run-row-main'>
                        <strong>{item.title}</strong>
                        <span>{item.event}{item.attempts > 1 ? ` · ${item.attempts} attempts` : ''}</span>
                        {item.error && <span className='text-danger'>{item.error}</span>}
                      </span>
                      <span className='run-row-time'>{dateParser(item.createdAt).relative}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
};
