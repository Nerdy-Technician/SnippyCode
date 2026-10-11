import { Router } from 'express';
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  getSchedules,
  previewSchedule,
  runScheduleNow,
  updateSchedule
} from '../controllers/schedules';
import { requireAuth, requireMinimumRole } from '../middleware';

export const scheduleRouter = Router();

const editor = requireMinimumRole('editor');

scheduleRouter.use(requireAuth);

scheduleRouter.route('/').get(getSchedules).post(editor, createSchedule);
scheduleRouter.route('/preview').get(previewSchedule);
scheduleRouter
  .route('/:id')
  .get(getSchedule)
  .put(editor, updateSchedule)
  .delete(editor, deleteSchedule);
scheduleRouter.route('/:id/run').post(editor, runScheduleNow);
