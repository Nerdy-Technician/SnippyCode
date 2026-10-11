import { Router } from 'express';
import { getRun, getRuns } from '../controllers/runs';
import { requireAuth } from '../middleware';

export const runRouter = Router();

runRouter.use(requireAuth);

runRouter.route('/').get(getRuns);
runRouter.route('/:id').get(getRun);
