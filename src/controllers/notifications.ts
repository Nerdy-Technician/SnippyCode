import { Response, NextFunction } from 'express';
import { URL } from 'url';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import { WebhookDeliveryModel, WebhookInstance, WebhookModel, WebhookType } from '../models';
import {
  ErrorResponse,
  NOTIFICATION_EVENTS,
  auditLog,
  decryptSecret,
  deliverWebhook,
  encryptSecret,
  requestIp,
  validateWebhookUrl
} from '../utils';

const TYPES: WebhookType[] = ['slack', 'teams', 'discord', 'webhook'];

const auditActor = (req: AuthenticatedRequest) => ({
  userId: req.user?.id || null,
  ipAddress: requestIp(req)
});

// Webhook URLs are credentials, so only the host is ever shown again
const webhookJson = (webhook: WebhookInstance) => {
  let host = '';

  try {
    host = new URL(decryptSecret(webhook.url)).host;
  } catch {
    host = '(unreadable)';
  }

  return {
    id: webhook.id,
    name: webhook.name,
    type: webhook.type,
    host,
    hasSigningSecret: Boolean(webhook.signingSecret),
    events: webhook.events.split(',').filter(Boolean),
    siteIds: webhook.siteIds.split(',').filter(Boolean).map(Number),
    enabled: webhook.enabled,
    lastStatus: webhook.lastStatus,
    lastError: webhook.lastError,
    lastDeliveredAt: webhook.lastDeliveredAt
  };
};

const readWebhook = (body: any, next: NextFunction, existing?: WebhookInstance) => {
  const name = String(body.name || '').trim().slice(0, 120);
  const type = TYPES.includes(body.type) ? (body.type as WebhookType) : null;
  const known = NOTIFICATION_EVENTS.map(event => event.id);
  const events: string[] = (Array.isArray(body.events) ? body.events : []).filter(
    (event: string) => event === '*' || known.includes(event)
  );
  const siteIds: number[] = (Array.isArray(body.siteIds) ? body.siteIds : [])
    .map(Number)
    .filter((id: number) => Number.isSafeInteger(id) && id > 0);
  const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';

  if (!name || !type) {
    next(new ErrorResponse(400, 'Give the channel a name and type'));
    return null;
  }

  if (!events.length) {
    next(new ErrorResponse(400, 'Choose at least one event'));
    return null;
  }

  // Leave the URL out when editing to keep the current one
  const url = rawUrl ? validateWebhookUrl(rawUrl) : null;

  if (rawUrl && !url) {
    next(new ErrorResponse(400, 'The URL must start with https:// or http://'));
    return null;
  }

  if (!url && !existing) {
    next(new ErrorResponse(400, 'A webhook URL is required'));
    return null;
  }

  const secret = typeof body.signingSecret === 'string' ? body.signingSecret : undefined;

  return {
    name,
    type,
    events: events.join(','),
    siteIds: siteIds.join(','),
    enabled: body.enabled !== false,
    ...(url ? { url: encryptSecret(url) } : {}),
    ...(secret !== undefined ? { signingSecret: secret ? encryptSecret(secret) : '' } : {})
  };
};

const findWebhook = async (req: AuthenticatedRequest, next: NextFunction) => {
  const webhook = await WebhookModel.findByPk(Number(req.params.id) || -1);

  if (!webhook) {
    next(new ErrorResponse(404, 'Notification channel was not found'));
    return null;
  }

  return webhook;
};

/**
 * @description Notification channels and the events they can subscribe to
 * @route /api/notifications
 * @request GET
 */
export const getWebhooks = asyncWrapper(
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const webhooks = await WebhookModel.findAll({ order: [['name', 'ASC']] });

    res.status(200).json({
      data: {
        webhooks: webhooks.map(webhookJson),
        events: NOTIFICATION_EVENTS,
        publicBaseUrl: process.env.PUBLIC_BASE_URL || null
      }
    });
  }
);

export const createWebhook = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const fields = readWebhook(req.body, next);

    if (!fields) {
      return;
    }

    const webhook = await WebhookModel.create(fields as any);

    await auditLog('notification.created', {
      ...auditActor(req),
      target: `webhook:${webhook.id}`,
      metadata: { name: webhook.name, type: webhook.type }
    });

    res.status(201).json({ data: webhookJson(webhook) });
  }
);

export const updateWebhook = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const webhook = await findWebhook(req, next);
    const fields = webhook && readWebhook(req.body, next, webhook);

    if (!webhook || !fields) {
      return;
    }

    await webhook.update(fields);

    await auditLog('notification.updated', {
      ...auditActor(req),
      target: `webhook:${webhook.id}`,
      metadata: { name: webhook.name, type: webhook.type, enabled: webhook.enabled }
    });

    res.status(200).json({ data: webhookJson(webhook) });
  }
);

export const deleteWebhook = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const webhook = await findWebhook(req, next);

    if (!webhook) {
      return;
    }

    await webhook.destroy();

    await auditLog('notification.deleted', {
      ...auditActor(req),
      target: `webhook:${req.params.id}`,
      metadata: { name: webhook.name }
    });

    res.status(200).json({ data: {} });
  }
);

/**
 * @description Send a test message now, without retries
 * @route /api/notifications/:id/test
 * @request POST
 */
export const testWebhook = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const webhook = await findWebhook(req, next);

    if (!webhook) {
      return;
    }

    const result = await deliverWebhook(
      webhook,
      {
        event: 'test',
        severity: 'info',
        title: 'SnippyCode test notification',
        text: `${req.user?.displayName || 'An admin'} sent this to check the "${webhook.name}" channel.`,
        path: '/admin',
        fields: [{ label: 'Channel', value: webhook.name }]
      },
      { retries: false }
    );

    res.status(200).json({ data: result });
  }
);

export const getDeliveries = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const webhook = await findWebhook(req, next);

    if (!webhook) {
      return;
    }

    const deliveries = await WebhookDeliveryModel.findAll({
      where: { webhookId: webhook.id },
      order: [['createdAt', 'DESC']],
      limit: 50
    });

    res.status(200).json({ data: deliveries });
  }
);
