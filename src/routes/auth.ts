import { Router } from 'express';
import multer from 'multer';
import {
  getAuthStatus,
  getAvatar,
  login,
  logout,
  me,
  deleteAvatar,
  disableMfa,
  enableMfa,
  oidcCallback,
  oidcStart,
  setupMfa,
  setupOwner,
  updateMe,
  uploadAvatar,
  ensureAvatarDir
} from '../controllers/auth';
import { authRateLimit, requireAuth } from '../middleware';

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ensureAvatarDir()),
  filename: (req, file, cb) => {
    const extension = file.mimetype === 'image/png' ? 'png' : 'jpg';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}.${extension}`);
  }
});

const avatarUpload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ['image/jpeg', 'image/png'].includes(file.mimetype));
  }
});

export const authRouter = Router();

authRouter.route('/status').get(getAuthStatus);
authRouter.route('/setup').post(authRateLimit, setupOwner);
authRouter.route('/login').post(authRateLimit, login);
authRouter.route('/logout').post(logout);
authRouter.route('/me').get(requireAuth, me).put(requireAuth, updateMe);
authRouter.route('/me/mfa/setup').post(authRateLimit, requireAuth, setupMfa);
authRouter.route('/me/mfa/enable').post(authRateLimit, requireAuth, enableMfa);
authRouter.route('/me/mfa/disable').post(authRateLimit, requireAuth, disableMfa);
authRouter.route('/me/avatar').get(requireAuth, getAvatar);
authRouter
  .route('/me/avatar')
  .post(requireAuth, avatarUpload.single('avatar'), uploadAvatar);
authRouter.route('/me/avatar').delete(requireAuth, deleteAvatar);
authRouter.route('/oidc/start').get(authRateLimit, oidcStart);
authRouter.route('/oidc/callback').get(authRateLimit, oidcCallback);
