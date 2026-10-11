import { Router } from 'express';
import { getHelpDoc } from '../controllers/help';

export const helpRouter = Router();

helpRouter.route('/:doc').get(getHelpDoc);
