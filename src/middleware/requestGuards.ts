import { NextFunction, Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

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
export const CSRF_COOKIE = 'XSRF-TOKEN';
export const CSRF_HEADER = 'x-xsrf-token';
const SESSION_COOKIES = ['snippycode_session', 'snippysafe_session'];

const tokensEqual = (cookieToken: unknown, headerToken: unknown): boolean => {
  if (typeof cookieToken !== 'string' || typeof headerToken !== 'string' || !cookieToken || !headerToken) return false;
  const a = Buffer.from(cookieToken);
  const b = Buffer.from(headerToken);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const csrfProtection = (req: Request, res: Response, next: NextFunction): void => {
  // Double-submit token: a readable cookie the app's own pages echo back in
  // the X-XSRF-TOKEN header (axios does this for same-origin requests).
  // Another site can make the browser send the cookie, but cannot read it.
  const cookies = req.cookies || {};
  const cookieToken = cookies['XSRF-TOKEN'];
  // Issued on page loads and other reads, so the app has it before any write
  if (!cookieToken && SAFE_METHODS.has(req.method)) {
    res.cookie('XSRF-TOKEN', randomBytes(24).toString('base64url'), {
      httpOnly: false,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/'
    });
  }

  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  // Any write that rides on the session cookie must carry the token, whether
  // or not the client sent Origin or Sec-Fetch-Site. Agents (device tokens)
  // and API keys never use the session cookie, so they are unaffected.
  const hasSession = SESSION_COOKIES.some(name => Boolean(cookies[name]));
  if (hasSession && !tokensEqual(req.cookies['XSRF-TOKEN'], req.get(CSRF_HEADER))) {
    res.status(403).json({ success: false, error: 'Missing or invalid CSRF token. Reload the page and try again.' });
    return;
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

/**
 * Enrolment limits. A bulk rollout from one office shares one address, so
 * the per-address limit is generous; each token gets its own budget too, so
 * a leaked token cannot be hammered from many addresses.
 */
export const enrollIpRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: envNumber('ENROLL_RATE_LIMIT_PER_IP', 300),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Too many enrolments from this address, try again later' }
});

export const enrollTokenRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: envNumber('ENROLL_RATE_LIMIT_PER_TOKEN', 300),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Keyed by the token's public prefix; requests without one fall back to the address
  keyGenerator: req => {
    const token = String(req.body?.token || req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    return token.startsWith('sc_enroll_') ? `token:${token.slice(0, 16)}` : `ip:${ipKeyGenerator(req.ip || '')}`;
  },
  message: { success: false, error: 'Too many enrolments with this token, try again later' }
});
