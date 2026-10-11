/**
 * Double-submit CSRF token on cookie-session writes from a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csrfProtection } from '../src/middleware/requestGuards';

const run = (options: { method?: string; cookies?: Record<string, string>; headers?: Record<string, string> }) => {
  const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const result: { status?: number; next: boolean; setCookie?: string } = { next: false };
  const req = { method: options.method || 'POST', cookies: options.cookies || {}, get: (name: string) => headers[name.toLowerCase()] } as any;
  const res = {
    cookie: (name: string) => (result.setCookie = name),
    status: (code: number) => {
      result.status = code;
      return { json: () => undefined };
    }
  } as any;
  csrfProtection(req, res, () => (result.next = true));
  return result;
};

test('a GET without the cookie is given one; writes never set it', () => {
  assert.equal(run({ method: 'POST' }).setCookie, undefined);
  const out = run({ method: 'GET' });
  assert.equal(out.next, true);
  assert.equal(out.setCookie, 'XSRF-TOKEN');
});

test('a browser write on the session cookie needs the matching header', () => {
  const session = { snippycode_session: 's', 'XSRF-TOKEN': 'tok-123' };
  assert.equal(run({ cookies: session, headers: { 'sec-fetch-site': 'same-origin' } }).status, 403);
  assert.equal(run({ cookies: session, headers: { origin: 'http://x', 'x-xsrf-token': 'wrong!!' } }).status, 403);
  assert.equal(run({ cookies: session, headers: { 'sec-fetch-site': 'same-origin', 'x-xsrf-token': 'tok-123' } }).next, true);
});

test('agents and API clients (no session cookie, no browser headers) pass', () => {
  assert.equal(run({ headers: { authorization: 'Bearer x' } }).next, true);
  assert.equal(run({ cookies: { snippycode_session: 's' } }).next, true);
});

test('cross-site writes are still blocked outright', () => {
  assert.equal(run({ headers: { 'sec-fetch-site': 'cross-site' } }).status, 403);
});
