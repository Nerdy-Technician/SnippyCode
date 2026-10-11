import { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';

const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * General limit for the API and raw links. Generous, because agents poll and
 * a busy UI makes many calls; it only stops floods from a single address.
 */
export const apiRateLimit = rateLimit({
  windowMs: 60_000,
  limit: envNumber('RATE_LIMIT_PER_MINUTE', 600),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please slow down' }
});

/** Strict limit for sign-in, setup and MFA, against password guessing. */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: envNumber('AUTH_RATE_LIMIT_PER_15_MIN', 30),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Too many sign-in attempts, try again later' }
});

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const hostOf = (value?: string | null): string | null => {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * CSRF protection for the cookie session. Browsers mark cross-site requests
 * with Sec-Fetch-Site; older ones are checked by comparing Origin with the
 * host (or PUBLIC_BASE_URL). Requests without these headers (agents, curl,
 * API keys) carry no browser cookies by accident and pass through.
 */
export const csrfProtection = (req: Request, res: Response, next: NextFunction): void => {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();

  if (fetchSite === 'cross-site') {
    res.status(403).json({ success: false, error: 'Cross-site request blocked' });
    return;
  }

  const origin = hostOf(req.get('origin'));

  if (!fetchSite && origin) {
    const allowed = [
      String(req.get('x-forwarded-host') || '').split(',')[0].trim().toLowerCase(),
      String(req.get('host') || '').toLowerCase(),
      hostOf(process.env.PUBLIC_BASE_URL)
    ].filter(Boolean);

    if (!allowed.includes(origin)) {
      res.status(403).json({ success: false, error: 'Cross-site request blocked' });
      return;
    }
  }

  next();
};
