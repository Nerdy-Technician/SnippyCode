import { Router } from 'express';
import {
  createUser,
  downloadSnippetsFromGithub,
  generateRawApiKey,
  getAdminOverview,
  exportLibraryJson,
  importLibraryJson,
  revokeRawApiKey,
  testGithubSettings,
  testOidcSettings,
  updateGithubSettings,
  updateOidcSettings,
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
adminRouter.route('/import').post(importLibraryJson);
adminRouter.route('/oidc').put(updateOidcSettings);
adminRouter.route('/oidc/test').post(testOidcSettings);
adminRouter.route('/users').post(createUser);
