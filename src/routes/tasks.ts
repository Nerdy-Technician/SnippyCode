import { Router } from 'express';
import { createTask, deleteTask, getTasks, updateTask } from '../controllers/tasks';
import { requireAuth, requireMinimumRole, validateSnippetId } from '../middleware';

export const taskRouter = Router();

taskRouter.use(requireAuth);

taskRouter.route('/').get(requireMinimumRole('admin'), getTasks).post(requireMinimumRole('admin'), createTask);
taskRouter
  .route('/:id')
  .put(validateSnippetId, requireMinimumRole('admin'), updateTask)
  .delete(validateSnippetId, requireMinimumRole('admin'), deleteTask);
