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
  patchSnippetFlags,
  restoreSnippetVersion,
  revokeSnippetRawToken,
  renameCollection,
  runSnippet,
  searchSnippets,
  assistSnippet,
  recordSnippetActivity,
  lintSnippet,
  getLintTools,
  explainSnippetRoute,
  convertSnippetRoute,
  searchByMeaningRoute,
  renderSnippet,
  setFavorite,
  updateSnippet
} from '../controllers/snippets';
import {
  requireAuth,
  requireAuthOrRawApiKey,
  requireBody,
  requireMinimumRole,
  validateSnippetBody,
  validateSnippetFlags,
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
snippetRouter.route('/search/meaning').post(requireAuth, searchByMeaningRoute);
snippetRouter
  .route('/collections/rename')
  .post(requireAuth, requireMinimumRole('editor'), renameCollection);
snippetRouter.route('/runner').get(requireAuth, getSnippetRunner);
snippetRouter
  .route('/lint')
  .get(requireAuth, getLintTools)
  .post(requireAuth, requireMinimumRole('editor'), lintSnippet);
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
  .patch(
    requireAuth,
    validateSnippetId,
    requireMinimumRole('editor'),
    validateSnippetFlags,
    patchSnippetFlags
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

snippetRouter
  .route('/:id/activity')
  .post(requireAuth, validateSnippetId, recordSnippetActivity);

snippetRouter
  .route('/:id/favorite')
  .put(requireAuth, validateSnippetId, setFavorite);

snippetRouter
  .route('/:id/render')
  .post(requireAuth, validateSnippetId, renderSnippet);

snippetRouter
  .route('/:id/explain')
  .post(requireAuth, validateSnippetId, explainSnippetRoute);

snippetRouter
  .route('/:id/convert')
  .post(requireAuth, validateSnippetId, requireMinimumRole('editor'), convertSnippetRoute);
