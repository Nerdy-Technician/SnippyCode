import { Router } from 'express';
import { exportSnippetsToGithub } from '../controllers/github';
import { requireAuth } from '../middleware';

export const githubRouter = Router();

githubRouter.use(requireAuth);
githubRouter.route('/export-snippets').post(exportSnippetsToGithub);
