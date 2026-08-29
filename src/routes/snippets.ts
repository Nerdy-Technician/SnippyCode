import { Router } from 'express';
import {
  countTags,
  createSnippet,
  deleteSnippet,
  generateSnippetRawToken,
  getAllSnippets,
  getPublicSnippet,
  getRawCode,
  getSnippet,
  getSnippetRunner,
  getSnippetVersions,
  restoreSnippetVersion,
  revokeSnippetRawToken,
  renameCollection,
  runSnippet,
  searchSnippets,
  assistSnippet,
  updateSnippet
} from '../controllers/snippets';
import {
  requireAuth,
  requireAuthOrRawApiKey,
  requireBody,
  requireMinimumRole,
  validateSnippetBody,
  validateSnippetId
} from '../middleware';

export const snippetRouter = Router();

snippetRouter.route('/raw/:rawRef').get(getRawCode);
snippetRouter.route('/public/:rawRef').get(getPublicSnippet);

snippetRouter
  .route('/')
  .get(requireAuthOrRawApiKey, getAllSnippets)
  .post(
    requireAuth,
    requireMinimumRole('editor'),
    requireBody('title', 'language', 'code'),
    validateSnippetBody,
    createSnippet
  );

snippetRouter.route('/statistics/count').get(requireAuth, countTags);
snippetRouter.route('/search').post(requireAuthOrRawApiKey, searchSnippets);
snippetRouter
  .route('/collections/rename')
  .post(requireAuth, requireMinimumRole('editor'), renameCollection);
snippetRouter.route('/runner').get(requireAuth, getSnippetRunner);
snippetRouter
  .route('/assist')
  .post(requireAuth, requireMinimumRole('editor'), assistSnippet);

snippetRouter
  .route('/:id')
  .get(requireAuthOrRawApiKey, validateSnippetId, getSnippet)
  .put(
    requireAuth,
    validateSnippetId,
    requireMinimumRole('editor'),
    validateSnippetBody,
    updateSnippet
  )
  .delete(requireAuth, validateSnippetId, requireMinimumRole('editor'), deleteSnippet);

snippetRouter
  .route('/:id/raw-token')
  .post(requireAuth, validateSnippetId, requireMinimumRole('editor'), generateSnippetRawToken)
  .delete(requireAuth, validateSnippetId, requireMinimumRole('editor'), revokeSnippetRawToken);

snippetRouter
  .route('/:id/versions')
  .get(requireAuth, validateSnippetId, getSnippetVersions);

snippetRouter
  .route('/:id/versions/:versionId/restore')
  .post(requireAuth, validateSnippetId, requireMinimumRole('editor'), restoreSnippetVersion);

snippetRouter
  .route('/:id/run')
  .post(requireAuth, validateSnippetId, requireMinimumRole('editor'), runSnippet);
