import { Router } from 'express';
import {
  createVariable,
  deleteVariable,
  getVariables,
  getVariableUsage,
  previewVariables,
  revealVariable,
  updateVariable
} from '../controllers/variables';
import { requireAuth } from '../middleware';

export const variableRouter = Router();

variableRouter.use(requireAuth);

variableRouter.route('/').get(getVariables).post(createVariable);
variableRouter.route('/preview').get(previewVariables);
variableRouter.route('/usage').get(getVariableUsage);
variableRouter.route('/:id').put(updateVariable).delete(deleteVariable);
variableRouter.route('/:id/reveal').get(revealVariable);
