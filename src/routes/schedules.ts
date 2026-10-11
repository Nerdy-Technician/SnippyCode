import { Router } from 'express';
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  getScheduleForEdit,
  getSchedules,
  previewSchedule,
  runScheduleNow,
  getScheduleRunDevices,
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
scheduleRouter.route('/:id/edit').get(editor, getScheduleForEdit);
scheduleRouter.route('/:id/run').post(editor, runScheduleNow);
scheduleRouter.route('/:id/runs/:runId').get(getScheduleRunDevices);
