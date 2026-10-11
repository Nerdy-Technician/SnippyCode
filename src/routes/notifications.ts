import { Router } from 'express';
import {
  createWebhook,
  deleteWebhook,
  getDeliveries,
  getWebhooks,
  testWebhook,
  updateWebhook
} from '../controllers/notifications';
import { requireAuth, requireOwner } from '../middleware';

export const notificationRouter = Router();

notificationRouter.use(requireAuth, requireOwner);

notificationRouter.route('/').get(getWebhooks).post(createWebhook);
notificationRouter.route('/:id').put(updateWebhook).delete(deleteWebhook);
notificationRouter.route('/:id/test').post(testWebhook);
notificationRouter.route('/:id/deliveries').get(getDeliveries);
