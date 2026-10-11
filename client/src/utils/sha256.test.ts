/**
 * @jest-environment node
 */
import { sha256HexSync } from './sha256';

describe('sha256 fallback', () => {
  test.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    ],
    // UTF-8, checked against Node's crypto
    ['ünïcødé ✓', 'a6745d77670391f486b213eef2a38cf5c7ff62becd7b95217acf1f962a602162'],
    // 56 bytes forces an extra padding block
    ['x'.repeat(56), '04c26261370ee7541549d16dee320c723e3fd14671e66a099afe0a377c16888e']
  ])('hashes %j', (input, expected) => {
    expect(sha256HexSync(input)).toBe(expected);
  });
});
