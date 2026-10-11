import { Router } from 'express';
import { createTag, deleteTag, getTags, updateTag } from '../controllers/tags';
import { requireAuth, requireMinimumRole } from '../middleware';

export const tagRouter = Router();
const admin = requireMinimumRole('admin');

tagRouter.use(requireAuth);
tagRouter.route('/').get(getTags).post(admin, createTag);
tagRouter.route('/:id').put(admin, updateTag).delete(admin, deleteTag);
