import http from 'http';
import https from 'https';
import { createHmac } from 'crypto';
import { URL } from 'url';
import { Op } from 'sequelize';
import { WebhookDeliveryModel, WebhookInstance, WebhookModel, WebhookType } from '../models';
import { decryptSecret } from './secretBox';
import { Logger } from './Logger';

const logger = new Logger('notify');

export const NOTIFICATION_EVENTS: { id: string; label: string }[] = [
  { id: 'alert.opened', label: 'A monitor alert opened' },
  { id: 'alert.resolved', label: 'A monitor alert resolved' },
  { id: 'run.failed', label: 'A run failed' },
  { id: 'run.succeeded', label: 'A run succeeded' },
  { id: 'schedule.failed', label: 'A scheduled job failed' },
  { id: 'schedule.succeeded', label: 'A scheduled job succeeded' },
  { id: 'runbook.completed', label: 'A runbook finished' },
  { id: 'runbook.failed', label: 'A runbook step failed' },
  { id: 'runbook.attention', label: 'A scheduled runbook needs a person' },
  { id: 'secret.revealed', label: 'A secret was revealed' },
  { id: 'site.changed', label: 'A site was created, changed, or deleted' },
  { id: 'device.enrolled', label: 'A device was enrolled' },
  { id: 'device.offline', label: 'A device went offline' },
  { id: 'device.clone_pending', label: 'A cloned machine enrolled itself and needs approval' },
  { id: 'device.fingerprint_review', label: 'A device fingerprint needs review' },
  { id: 'backup.completed', label: 'A backup finished' },
  { id: 'backup.failed', label: 'A backup failed' },
  { id: 'approval.requested', label: 'A risky run is waiting for approval' }
];

export type Severity = 'info' | 'success' | 'warning' | 'error';

export interface Notification {
  event: string;
  title: string;
  text: string;
  severity: Severity;
  siteId?: number | null;
  /** Path inside the app, e.g. /sites/3; made absolute with PUBLIC_BASE_URL */
  path?: string;
  fields?: { label: string; value: string }[];
  data?: Record<string, unknown>;
}

const colors: { [severity in Severity]: string } = {
  info: '#4c8bf5',
  success: '#2fb67c',
  warning: '#f6b73c',
  error: '#e85857'
};

const emoji: { [severity in Severity]: string } = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  error: '❌'
};

export const absoluteUrl = (path?: string): string | null => {
  const base = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  return base && path ? `${base}${path}` : null;
};

/**
 * The request body for each kind of channel.
 */
export const formatPayload = (type: WebhookType, notification: Notification, now = new Date()) => {
  const link = absoluteUrl(notification.path);
  const fields = notification.fields || [];

  if (type === 'slack') {
    return {
      text: `${emoji[notification.severity]} ${notification.title}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${emoji[notification.severity]} ${notification.title}*\n${notification.text}`
          }
        },
        ...(fields.length
          ? [
              {
                type: 'section',
                fields: fields.slice(0, 10).map(field => ({
                  type: 'mrkdwn',
                  text: `*${field.label}*\n${field.value}`
                }))
              }
            ]
          : []),
        ...(link
          ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `<${link}|Open in SnippyCode>` }] }]
          : [])
      ]
    };
  }

  if (type === 'discord') {
    return {
      username: 'SnippyCode',
      embeds: [
        {
          title: notification.title.slice(0, 256),
          description: notification.text.slice(0, 4000),
          url: link || undefined,
          color: parseInt(colors[notification.severity].slice(1), 16),
          fields: fields.slice(0, 25).map(field => ({
            name: field.label.slice(0, 256),
            value: field.value.slice(0, 1024) || '—',
            inline: true
          })),
          timestamp: now.toISOString()
        }
      ]
    };
  }

  if (type === 'teams') {
    // Teams Workflows ("Post to a channel when a webhook request is received")
    return {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              {
                type: 'TextBlock',
                text: `${emoji[notification.severity]} ${notification.title}`,
                weight: 'Bolder',
                size: 'Medium',
                wrap: true
              },
              { type: 'TextBlock', text: notification.text, wrap: true },
              ...(fields.length
                ? [
                    {
                      type: 'FactSet',
                      facts: fields.map(field => ({ title: field.label, value: field.value }))
                    }
                  ]
                : [])
            ],
            actions: link
              ? [{ type: 'Action.OpenUrl', title: 'Open in SnippyCode', url: link }]
              : []
          }
        }
      ]
    };
  }

  return {
    event: notification.event,
    title: notification.title,
    text: notification.text,
    severity: notification.severity,
    siteId: notification.siteId ?? null,
    url: link,
    fields,
    data: notification.data || {},
    timestamp: now.toISOString()
  };
};

export const signPayload = (secret: string, timestamp: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

export const validateWebhookUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
};

const post = (
  url: string,
  body: string,
  headers: Record<string, string>
): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'SnippyCode-Webhooks/1',
          ...headers
        },
        timeout: 10000
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8').slice(0, 500) })
        );
      }
    );

    req.on('timeout', () => req.destroy(new Error('Timed out after 10s')));
    req.on('error', reject);
    req.end(body);
  });

const RETRY_DELAYS_MS = [0, 2000, 10000];
const inFlight = new Set<Promise<void>>();

/** Wait for queued deliveries (used by tests and graceful shutdown). */
export const flushNotifications = async (): Promise<void> => {
  while (inFlight.size) {
    await Promise.all(Array.from(inFlight));
  }
};

export const deliverWebhook = async (
  webhook: WebhookInstance,
  notification: Notification,
  options: { retries?: boolean } = {}
): Promise<{ ok: boolean; statusCode: number | null; error: string | null; attempts: number }> => {
  const body = JSON.stringify(formatPayload(webhook.type, notification));
  const delays = options.retries === false ? [0] : RETRY_DELAYS_MS;
  let url: string;
  let secret = '';

  try {
    url = decryptSecret(webhook.url);
    secret = webhook.signingSecret ? decryptSecret(webhook.signingSecret) : '';
  } catch {
    return { ok: false, statusCode: null, error: 'Stored URL cannot be decrypted', attempts: 0 };
  }

  let last = { ok: false, statusCode: null as number | null, error: null as string | null };
  let attempts = 0;

  for (const delay of delays) {
    if (delay) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    attempts += 1;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> =
      webhook.type === 'webhook'
        ? {
            'x-snippycode-event': notification.event,
            'x-snippycode-timestamp': timestamp,
            ...(secret ? { 'x-snippycode-signature': signPayload(secret, timestamp, body) } : {})
          }
        : {};

    try {
      const res = await post(url, body, headers);
      last = {
        ok: res.status >= 200 && res.status < 300,
        statusCode: res.status,
        error: res.status >= 200 && res.status < 300 ? null : `HTTP ${res.status}: ${res.text}`
      };
    } catch (err) {
      last = { ok: false, statusCode: null, error: err instanceof Error ? err.message : String(err) };
    }

    // Client errors other than rate limits will not fix themselves
    if (last.ok || (last.statusCode && last.statusCode >= 400 && last.statusCode < 500 && last.statusCode !== 429)) {
      break;
    }
  }

  await WebhookDeliveryModel.create({
    webhookId: webhook.id,
    event: notification.event,
    title: notification.title.slice(0, 255),
    ok: last.ok,
    statusCode: last.statusCode,
    error: last.error,
    attempts
  });
  await webhook.update({
    lastStatus: last.ok ? 'ok' : 'failed',
    lastError: last.error,
    lastDeliveredAt: new Date()
  });

  // Keep the delivery log short
  const old = await WebhookDeliveryModel.findAll({
    where: { webhookId: webhook.id },
    order: [['createdAt', 'DESC']],
    offset: 100,
    attributes: ['id']
  });
  if (old.length) {
    await WebhookDeliveryModel.destroy({ where: { id: { [Op.in]: old.map(row => row.id) } } });
  }

  return { ...last, attempts };
};

const wants = (webhook: WebhookInstance, notification: Notification): boolean => {
  const events = webhook.events.split(',').filter(Boolean);
  const sites = webhook.siteIds.split(',').filter(Boolean).map(Number);

  if (!events.includes('*') && !events.includes(notification.event)) {
    return false;
  }

  // A site filter only lets through events about those sites
  return !sites.length || (Boolean(notification.siteId) && sites.includes(Number(notification.siteId)));
};

/**
 * Send a notification to every matching channel in the background. Never
 * throws, so callers can fire and forget.
 */
export const emitEvent = (notification: Notification): void => {
  const job = (async () => {
    try {
      const webhooks = await WebhookModel.findAll({ where: { enabled: true } });
      await Promise.all(
        webhooks
          .filter(webhook => wants(webhook, notification))
          .map(webhook => deliverWebhook(webhook, notification))
      );
    } catch (err) {
      logger.log(`Notification ${notification.event} failed: ${err instanceof Error ? err.message : err}`, 'WARN');
    }
  })();

  inFlight.add(job);
  job.finally(() => inFlight.delete(job));
};
