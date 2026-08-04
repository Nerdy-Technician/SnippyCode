import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserModel } from '../models';
import { ErrorResponse, verifyRawApiKey } from '../utils';

export const SESSION_COOKIE = 'snippysafe_session';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    email: string;
    displayName: string;
    avatarUrl: string;
    isOwner: boolean;
    role: string;
  };
}

const effectiveRole = (user: { isOwner: boolean; role?: string }): string =>
  user.isOwner ? 'owner' : user.role || 'user';

const roleRank: { [key: string]: number } = {
  viewer: 10,
  user: 20,
  editor: 30,
  admin: 40,
  owner: 50
};

const getJwtSecret = (): string => {
  const secret = process.env.SESSION_SECRET;

  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is required in production');
  }

  return secret || 'dev-only-change-me';
};

export const signSession = (userId: number): string =>
  jwt.sign({ userId }, getJwtSecret(), { expiresIn: '7d' });

export const getUserFromSession = async (token?: string) => {
  if (!token) {
    return null;
  }

  const payload = jwt.verify(token, getJwtSecret()) as { userId?: number };

  if (!payload.userId) {
    return null;
  }

  return UserModel.findByPk(payload.userId);
};

export const requireAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = req.cookies?.[SESSION_COOKIE];

    if (!token) {
      return next(new ErrorResponse(401, 'Authentication required'));
    }

    const user = await getUserFromSession(token);

    if (!user) {
      return next(new ErrorResponse(401, 'Authentication required'));
    }

    req.user = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: `/api/auth/me/avatar?v=${user.updatedAt.getTime()}`,
      isOwner: user.isOwner,
      role: effectiveRole(user)
    };

    next();
  } catch (err) {
    next(new ErrorResponse(401, 'Authentication required'));
  }
};

export const requireAuthOrRawApiKey = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    const user = await getUserFromSession(token).catch(() => null);

    if (user) {
      req.user = {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: `/api/auth/me/avatar?v=${user.updatedAt.getTime()}`,
        isOwner: user.isOwner,
        role: effectiveRole(user)
      };
      next();
      return;
    }

    const apiKey = String(req.query.key || req.header('x-api-key') || '');

    if (await verifyRawApiKey(apiKey)) {
      next();
      return;
    }

    next(new ErrorResponse(401, 'Authentication or raw API key required'));
  } catch (err) {
    next(new ErrorResponse(401, 'Authentication or raw API key required'));
  }
};

export const requireRawApiKey = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const apiKey = String(req.query.key || req.header('x-api-key') || '');

    if (await verifyRawApiKey(apiKey)) {
      next();
      return;
    }

    next(new ErrorResponse(401, 'Valid raw API key required'));
  } catch (err) {
    next(new ErrorResponse(401, 'Valid raw API key required'));
  }
};

export const requireOwner = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user?.isOwner && req.user?.role !== 'admin') {
    return next(new ErrorResponse(403, 'Admin access required'));
  }

  next();
};

export const requireRole =
  (...roles: string[]) =>
  (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const currentRole = req.user?.role || (req.user?.isOwner ? 'owner' : '');

    if (!currentRole || !roles.includes(currentRole)) {
      return next(new ErrorResponse(403, 'Insufficient role permissions'));
    }

    next();
  };

export const requireMinimumRole =
  (role: string) =>
  (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const currentRole = req.user?.role || (req.user?.isOwner ? 'owner' : '');

    if ((roleRank[currentRole] || 0) < (roleRank[role] || 0)) {
      return next(new ErrorResponse(403, 'Insufficient role permissions'));
    }

    next();
  };

export const setSessionCookie = (res: Response, userId: number): void => {
  res.cookie(SESSION_COOKIE, signSession(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
};

export const clearSessionCookie = (res: Response): void => {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  });
};
