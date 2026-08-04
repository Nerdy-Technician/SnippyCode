import { Router } from 'express';
import {
  countTags,
  createSnippet,
  deleteSnippet,
  generateSnippetRawToken,
  getAllSnippets,
  getRawCode,
  getSnippet,
  getSnippetVersions,
  revokeSnippetRawToken,
  searchSnippets,
  updateSnippet
} from '../controllers/snippets';
import {
  requireAuth,
  requireBody,
  requireMinimumRole,
  validateSnippetBody,
  validateSnippetId
} from '../middleware';

export const snippetRouter = Router();

snippetRouter
  .route('/raw/:rawRef')
  .get(getRawCode);

snippetRouter.use(requireAuth);

snippetRouter
  .route('/')
  .post(
    requireMinimumRole('editor'),
    requireBody('title', 'language', 'code'),
    validateSnippetBody,
    createSnippet
  )
  .get(getAllSnippets);

snippetRouter.route('/statistics/count').get(countTags);
snippetRouter.route('/search').post(searchSnippets);

snippetRouter
  .route('/:id')
  .get(validateSnippetId, getSnippet)
  .put(validateSnippetId, requireMinimumRole('editor'), validateSnippetBody, updateSnippet)
  .delete(validateSnippetId, requireMinimumRole('editor'), deleteSnippet);

snippetRouter
  .route('/:id/raw-token')
  .post(validateSnippetId, requireMinimumRole('editor'), generateSnippetRawToken)
  .delete(validateSnippetId, requireMinimumRole('editor'), revokeSnippetRawToken);
snippetRouter
  .route('/:id/versions')
  .get(validateSnippetId, getSnippetVersions);
