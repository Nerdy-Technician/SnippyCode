import { createHash } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { unlink } from 'fs/promises';
import { join } from 'path';
import bcrypt from 'bcryptjs';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { generators, Issuer } from 'openid-client';
import QRCode from 'qrcode';
import { Op } from 'sequelize';
import {
  asyncWrapper,
  AuthenticatedRequest,
  clearSessionCookie,
  getUserFromSession,
  setSessionCookie,
  SESSION_COOKIE
} from '../middleware';
import { UserModel } from '../models';
import { ErrorResponse, auditLog } from '../utils';
import {
  getOidcSettings,
  oidcIsReady,
  setSetting
} from '../utils/oidcSettings';

const avatarDir = join(process.cwd(), 'data/uploads/avatars');
const getSessionSecret = (): string =>
  process.env.SESSION_SECRET || 'dev-only-change-me';

const publicUser = (user: {
  id: number;
  email: string;
  displayName: string;
  updatedAt: Date;
  isOwner: boolean;
  role?: string;
  mfaEnabled?: boolean;
}) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  avatarUrl: `/api/auth/me/avatar?v=${user.updatedAt.getTime()}`,
  isOwner: user.isOwner,
  role: user.isOwner ? 'owner' : user.role || 'user',
  mfaEnabled: Boolean(user.mfaEnabled)
});

export const getAuthStatus = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const usersCount = await UserModel.count();
    const oidc = await getOidcSettings();
    const sessionUser = await getUserFromSession(req.cookies?.[SESSION_COOKIE]).catch(
      () => null
    );

    res.status(200).json({
      data: {
        needsSetup: usersCount === 0,
        oidcEnabled: oidcIsReady(oidc),
        localLoginEnabled: oidc.localLoginEnabled,
        user: sessionUser ? publicUser(sessionUser) : null
      }
    });
  }
);

export const setupOwner = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const usersCount = await UserModel.count();

    if (usersCount > 0) {
      return next(new ErrorResponse(409, 'First-run setup is already complete'));
    }

    const { email, displayName, password, oidc } = req.body;

    if (!email || !displayName || !password || password.length < 10) {
      return next(
        new ErrorResponse(
          400,
          'Email, display name, and a password of at least 10 characters are required'
        )
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await UserModel.create({
      email: String(email).trim().toLowerCase(),
      displayName: String(displayName).trim(),
      passwordHash,
      isOwner: true,
      role: 'owner'
    });

    if (oidc?.enabled) {
      await setSetting('oidc', {
        enabled: true,
        issuerUrl: String(oidc.issuerUrl || '').trim(),
        clientId: String(oidc.clientId || '').trim(),
        clientSecret: String(oidc.clientSecret || '').trim(),
        redirectUri: String(oidc.redirectUri || '').trim(),
        scopes: String(oidc.scopes || 'openid email profile').trim(),
        subjectClaim: String(oidc.subjectClaim || 'sub').trim(),
        emailClaim: String(oidc.emailClaim || 'email').trim(),
        nameClaim: String(oidc.nameClaim || 'name').trim(),
        matchMode: oidc.matchMode || 'subject_or_email',
        allowSignup: Boolean(oidc.allowSignup),
        localLoginEnabled: true
      });
    }

    setSessionCookie(res, user.id);
    await auditLog('auth.setup_owner', {
      userId: user.id,
      target: `user:${user.id}`
    });

    res.status(201).json({
      data: publicUser(user)
    });
  }
);

export const login = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { email, password, mfaCode, mfaToken } = req.body;
    const oidc = await getOidcSettings();

    if (!oidc.localLoginEnabled) {
      return next(new ErrorResponse(403, 'Local password login is disabled'));
    }

    if (!email || !password) {
      return next(new ErrorResponse(400, 'Email and password are required'));
    }

    const user = await UserModel.findOne({
      where: { email: String(email).trim().toLowerCase() }
    });

    if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      await auditLog('auth.login_failed', {
        metadata: { email: String(email || '').trim().toLowerCase() }
      });
      return next(new ErrorResponse(401, 'Invalid email or password'));
    }

    if (user.mfaEnabled) {
      let validChallenge = false;

      try {
        const challenge = mfaToken
          ? (jwt.verify(mfaToken, getSessionSecret()) as {
              userId?: number;
              type?: string;
            })
          : null;
        validChallenge = challenge?.userId === user.id && challenge.type === 'mfa';
      } catch (err) {
        validChallenge = false;
      }

      const validCode =
        user.mfaSecret &&
        mfaCode &&
        authenticator.verify({ token: String(mfaCode), secret: user.mfaSecret });

      if (!validChallenge || !validCode) {
        res.status(200).json({
          data: {
            mfaRequired: true,
            mfaToken: jwt.sign(
              { userId: user.id, type: 'mfa' },
              getSessionSecret(),
              { expiresIn: '5m' }
            )
          }
        });
        return;
      }
    }

    setSessionCookie(res, user.id);
    await auditLog('auth.login', {
      userId: user.id,
      target: `user:${user.id}`
    });

    res.status(200).json({
      data: publicUser(user)
    });
  }
);

export const logout = asyncWrapper(
  async (req: Request, res: Response): Promise<void> => {
    const user = await getUserFromSession(req.cookies?.[SESSION_COOKIE]).catch(
      () => null
    );
    clearSessionCookie(res);
    await auditLog('auth.logout', {
      userId: user?.id || null,
      target: user ? `user:${user.id}` : null
    });

    res.status(200).json({ data: {} });
  }
);

export const me = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(200).json({ data: req.user });
  }
);

export const setupMfa = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const user = await UserModel.findByPk(req.user?.id);

    if (!user) {
      return next(new ErrorResponse(404, 'User was not found'));
    }

    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(
      user.email,
      'SnippySafe',
      secret
    );
    await user.update({ mfaSecret: secret, mfaEnabled: false });

    res.status(200).json({
      data: {
        secret,
        qrCode: await QRCode.toDataURL(otpauth)
      }
    });
  }
);

export const enableMfa = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const user = await UserModel.findByPk(req.user?.id);
    const code = String(req.body.code || '');

    if (!user?.mfaSecret) {
      return next(new ErrorResponse(400, 'MFA setup has not been started'));
    }

    if (!authenticator.verify({ token: code, secret: user.mfaSecret })) {
      return next(new ErrorResponse(400, 'Invalid MFA code'));
    }

    await user.update({ mfaEnabled: true });

    res.status(200).json({ data: publicUser(user) });
  }
);

export const disableMfa = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const user = await UserModel.findByPk(req.user?.id);

    if (!user) {
      return next(new ErrorResponse(404, 'User was not found'));
    }

    await user.update({ mfaEnabled: false, mfaSecret: null });

    res.status(200).json({ data: publicUser(user) });
  }
);

export const updateMe = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const user = await UserModel.findByPk(req.user?.id);

    if (!user) {
      return next(new ErrorResponse(404, 'User was not found'));
    }

    const displayName = String(req.body.displayName || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();

    if (!displayName || !email) {
      return next(new ErrorResponse(400, 'Email and display name are required'));
    }

    await user.update({ displayName, email });

    res.status(200).json({ data: publicUser(user) });
  }
);

export const uploadAvatar = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const user = await UserModel.findByPk(req.user?.id);

    if (!user || !req.file) {
      return next(new ErrorResponse(400, 'Avatar upload is required'));
    }

    await user.update({ avatarPath: req.file.path });

    res.status(200).json({ data: publicUser(user) });
  }
);

export const deleteAvatar = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const user = await UserModel.findByPk(req.user?.id);

    if (!user) {
      return next(new ErrorResponse(404, 'User was not found'));
    }

    const avatarPath = user.avatarPath;

    if (avatarPath && existsSync(avatarPath)) {
      await unlink(avatarPath);
    }

    await user.update({ avatarPath: null });

    res.status(200).json({ data: publicUser(user) });
  }
);

export const getAvatar = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const user = await UserModel.findByPk(req.user?.id);

    if (!user) {
      return next(new ErrorResponse(404, 'User was not found'));
    }

    if (user.avatarPath && existsSync(user.avatarPath)) {
      res.sendFile(user.avatarPath);
      return;
    }

    const emailHash = createHash('md5')
      .update(user.email.trim().toLowerCase())
      .digest('hex');
    res.redirect(`https://www.gravatar.com/avatar/${emailHash}?d=mp&s=160`);
  }
);

export const oidcStart = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const settings = await getOidcSettings();

    if (!oidcIsReady(settings)) {
      return next(new ErrorResponse(404, 'OIDC login is not configured'));
    }

    const issuer = await Issuer.discover(settings.issuerUrl);
    const client = new issuer.Client({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      redirect_uris: [settings.redirectUri],
      response_types: ['code']
    });
    const state = generators.state();
    const nonce = generators.nonce();

    res.cookie('snippysafe_oidc', JSON.stringify({ state, nonce }), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 10 * 60 * 1000
    });

    res.redirect(
      client.authorizationUrl({
        scope: settings.scopes || 'openid email profile',
        state,
        nonce
      })
    );
  }
);

export const oidcCallback = asyncWrapper(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const settings = await getOidcSettings();

    if (!oidcIsReady(settings)) {
      return next(new ErrorResponse(404, 'OIDC login is not configured'));
    }

    const cookieState = JSON.parse(req.cookies?.snippysafe_oidc || '{}');
    const issuer = await Issuer.discover(settings.issuerUrl);
    const client = new issuer.Client({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      redirect_uris: [settings.redirectUri],
      response_types: ['code']
    });
    const params = client.callbackParams(req);
    const tokenSet = await client.callback(settings.redirectUri, params, {
      state: cookieState.state,
      nonce: cookieState.nonce
    });
    const claims = tokenSet.claims();
    const subject = String(claims[settings.subjectClaim] || '').trim();
    const email = String(claims[settings.emailClaim] || '').trim().toLowerCase();
    const displayName = String(claims[settings.nameClaim] || email).trim();

    if (!email || !subject) {
      return next(
        new ErrorResponse(
          401,
          'OIDC profile did not include required subject and email claims'
        )
      );
    }

    const where =
      settings.matchMode === 'subject'
        ? { oidcSubject: subject }
        : settings.matchMode === 'email'
        ? { email }
        : { [Op.or]: [{ oidcSubject: subject }, { email }] };

    let user = await UserModel.findOne({ where });

    if (!user && !settings.allowSignup) {
      return next(
        new ErrorResponse(
          403,
          'OIDC login succeeded, but no matching local account exists'
        )
      );
    }

    if (!user) {
      user = await UserModel.create({
        email,
        displayName,
        oidcSubject: subject,
        isOwner: false,
        role: 'viewer'
      });
    }

    if (!user.oidcSubject) {
      await user.update({ oidcSubject: subject });
    }

    setSessionCookie(res, user.id);
    await auditLog('auth.oidc_login', {
      userId: user.id,
      target: `user:${user.id}`,
      metadata: { email }
    });
    res.clearCookie('snippysafe_oidc');
    res.redirect('/');
  }
);

export const ensureAvatarDir = (): string => {
  mkdirSync(avatarDir, { recursive: true });

  return avatarDir;
};
