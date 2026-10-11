import { Router } from 'express';
import {
  cancelRunbookRun,
  createRunbook,
  deleteRunbook,
  getRunbook,
  getRunbookRun,
  getRunbookRuns,
  getRunbooks,
  startRunbookRun,
  updateRunbook,
  updateRunbookRunStep
} from '../controllers/runbooks';
import { requireAuth, requireMinimumRole } from '../middleware';

export const runbookRouter = Router();

const editor = requireMinimumRole('editor');

runbookRouter.use(requireAuth);

// Run routes first so "runs" is not read as a runbook id
runbookRouter.route('/runs').get(getRunbookRuns);
runbookRouter.route('/runs/:runId').get(getRunbookRun);
runbookRouter.route('/runs/:runId/cancel').post(editor, cancelRunbookRun);
runbookRouter.route('/runs/:runId/steps/:stepId').post(editor, updateRunbookRunStep);

runbookRouter.route('/').get(getRunbooks).post(editor, createRunbook);
runbookRouter
  .route('/:id')
  .get(getRunbook)
  .put(editor, updateRunbook)
  .delete(editor, deleteRunbook);
runbookRouter.route('/:id/runs').post(editor, startRunbookRun);
