import { Router } from 'express';
import {
  createUser,
  deleteUser,
  downloadSnippetsFromGithub,
  generateRawApiKey,
  getAdminOverview,
  exportLibraryJson,
  importLibraryJson,
  importSnippetBox,
  revokeRawApiKey,
  startAnthropicAiLogin,
  completeAnthropicAiLogin,
  startOpenaiAiLogin,
  pollOpenaiAiLogin,
  disconnectAiLogin,
  testGithubSettings,
  testOidcSettings,
  updateAiSettings,
  testAiSettings,
  updateGithubSettings,
  updateOidcSettings,
  updateUser,
  uploadSnippetsToGithub
} from '../controllers/admin';
import { requireAuth, requireOwner } from '../middleware';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireOwner);

adminRouter.route('/').get(getAdminOverview);
adminRouter.route('/github').put(updateGithubSettings);
adminRouter.route('/github/test').post(testGithubSettings);
adminRouter.route('/github/upload').post(uploadSnippetsToGithub);
adminRouter.route('/github/download').post(downloadSnippetsFromGithub);
adminRouter.route('/raw-api-key').post(generateRawApiKey).delete(revokeRawApiKey);
adminRouter.route('/export').get(exportLibraryJson);
adminRouter.route('/import/snippet-box').post(importSnippetBox);
adminRouter.route('/import').post(importLibraryJson);
adminRouter.route('/oidc').put(updateOidcSettings);
adminRouter.route('/oidc/test').post(testOidcSettings);
adminRouter.route('/ai').put(updateAiSettings);
adminRouter.route('/ai/test').post(testAiSettings);
adminRouter.route('/ai/openai/login').post(startOpenaiAiLogin);
adminRouter.route('/ai/openai/login/poll').post(pollOpenaiAiLogin);
adminRouter.route('/ai/anthropic/login/start').post(startAnthropicAiLogin);
adminRouter.route('/ai/anthropic/login').post(completeAnthropicAiLogin);
adminRouter.route('/ai/:provider/login').delete(disconnectAiLogin);
adminRouter.route('/users').post(createUser);
adminRouter.route('/users/:id').patch(updateUser).delete(deleteUser);
