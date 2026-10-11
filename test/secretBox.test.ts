import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  maskSecrets,
  SECRET_MASK
} from '../src/utils/secretBox';

const originalKey = process.env.VARIABLES_SECRET_KEY;

describe('secret encryption', () => {
  afterEach(() => {
    process.env.VARIABLES_SECRET_KEY = originalKey;
  });

  test('round-trips unicode and never stores the plain value', () => {
    process.env.VARIABLES_SECRET_KEY = 'unit-test-key';
    const plain = 'p@ss wörd ✓ with "quotes"';
    const stored = encryptSecret(plain);

    assert.ok(isEncryptedSecret(stored));
    assert.ok(!stored.includes(plain));
    assert.equal(decryptSecret(stored), plain);
  });

  test('uses a fresh IV each time', () => {
    process.env.VARIABLES_SECRET_KEY = 'unit-test-key';
    assert.notEqual(encryptSecret('same'), encryptSecret('same'));
  });

  test('rejects tampered values and the wrong key', () => {
    process.env.VARIABLES_SECRET_KEY = 'unit-test-key';
    const stored = encryptSecret('top secret');
    const bytes = Buffer.from(stored.slice('enc:v1:'.length), 'base64');
    bytes[bytes.length - 1] ^= 1;

    assert.throws(() => decryptSecret(`enc:v1:${bytes.toString('base64')}`));

    process.env.VARIABLES_SECRET_KEY = 'a-different-key';
    assert.throws(() => decryptSecret(stored));
  });

  test('plain values pass through', () => {
    assert.equal(decryptSecret('not encrypted'), 'not encrypted');
  });
});

describe('maskSecrets', () => {
  test('masks every occurrence, longest first', () => {
    assert.equal(
      maskSecrets('token=abcd1234 again abcd1234 prefix abcd', ['abcd', 'abcd1234']),
      `token=${SECRET_MASK} again ${SECRET_MASK} prefix ${SECRET_MASK}`
    );
  });

  test('skips very short values that would mangle output', () => {
    assert.equal(maskSecrets('a b c', ['a', '']), 'a b c');
  });
});
