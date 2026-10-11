/**
 * Production never falls back to SESSION_SECRET for stored secrets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSecretKeyConfigured, decryptSecret, encryptSecret } from '../src/utils/secretBox';

const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.entries(env).forEach(([key, value]) => (value === undefined ? delete process.env[key] : (process.env[key] = value)));
  try {
    fn();
  } finally {
    Object.entries(saved).forEach(([key, value]) => (value === undefined ? delete process.env[key] : (process.env[key] = value)));
  }
};

test('production refuses to start, or encrypt, with only SESSION_SECRET', () => {
  withEnv({ NODE_ENV: 'production', VARIABLES_SECRET_KEY: undefined, SESSION_SECRET: 'session-only' }, () => {
    assert.throws(() => assertSecretKeyConfigured(), /VARIABLES_SECRET_KEY must be set/);
    assert.throws(() => encryptSecret('x'), /VARIABLES_SECRET_KEY must be set/);
  });
});

test('setting VARIABLES_SECRET_KEY to the old SESSION_SECRET keeps existing secrets readable', () => {
  let stored = '';
  withEnv({ NODE_ENV: 'development', VARIABLES_SECRET_KEY: undefined, SESSION_SECRET: 'the-old-session-secret' }, () => {
    stored = encryptSecret('kept');
  });
  withEnv({ NODE_ENV: 'production', VARIABLES_SECRET_KEY: 'the-old-session-secret', SESSION_SECRET: 'rotated' }, () => {
    assertSecretKeyConfigured();
    assert.equal(decryptSecret(stored), 'kept');
  });
});
