import { Router } from 'express';
import multer from 'multer';
import {
  createUser,
  deleteUser,
  downloadSnippetsFromGithub,
  generateRawApiKey,
  getAdminOverview,
  exportLibraryJson,
  getGithubSync,
  updateGithubSync,
  runGithubSyncNow,
  resolveGithubSyncConflict,
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
import {
  createBackup,
  downloadBackup,
  getBackups,
  removeBackup,
  restoreBackup,
  runBackupNow,
  updateBackupSchedule
} from '../controllers/backups';
import { requireAuth, requireOwner } from '../middleware';

const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024, files: 1 } });

export const adminRouter = Router();

adminRouter.use(requireAuth, requireOwner);

adminRouter.route('/').get(getAdminOverview);
adminRouter.route('/github').put(updateGithubSettings);
adminRouter.route('/github/test').post(testGithubSettings);
adminRouter.route('/github/upload').post(uploadSnippetsToGithub);
adminRouter.route('/github/download').post(downloadSnippetsFromGithub);
adminRouter.route('/github/sync').get(getGithubSync).put(updateGithubSync);
adminRouter.route('/github/sync/run').post(runGithubSyncNow);
adminRouter.route('/github/sync/conflicts/:id').post(resolveGithubSyncConflict);
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
adminRouter.route('/backups').get(getBackups).post(createBackup);
adminRouter.route('/backups/schedule').put(updateBackupSchedule);
adminRouter.route('/backups/run').post(runBackupNow);
adminRouter.route('/backups/restore').post(backupUpload.single('file'), restoreBackup);
adminRouter.route('/backups/:name').get(downloadBackup).delete(removeBackup);
