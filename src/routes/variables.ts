import { Router } from 'express';
import {
  createVariable,
  deleteVariable,
  getVariables,
  revealVariable,
  updateVariable
} from '../controllers/variables';
import { requireAuth } from '../middleware';

export const variableRouter = Router();

variableRouter.use(requireAuth);

variableRouter.route('/').get(getVariables).post(createVariable);
variableRouter.route('/:id').put(updateVariable).delete(deleteVariable);
variableRouter.route('/:id/reveal').get(revealVariable);
