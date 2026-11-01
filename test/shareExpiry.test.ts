import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isShareLive, MAX_SHARE_EXPIRY_MS, parseShareExpiry } from '../src/utils/shareLinks';
import { diffLines, MAX_DIFF_CELLS } from '../src/utils/lineDiff';

describe('parseShareExpiry', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');

  test('null and empty string clear the expiry', () => {
    assert.deepEqual(parseShareExpiry(null, now), { ok: true, value: null });
    assert.deepEqual(parseShareExpiry('', now), { ok: true, value: null });
  });

  test('accepts a future ISO date within a year', () => {
    const result = parseShareExpiry('2026-11-02T12:00:00Z', now);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value?.toISOString(), '2026-11-02T12:00:00.000Z');
  });

  test('rejects past, too-far, malformed and non-string values', () => {
    for (const value of ['2026-11-01T11:59:59Z', new Date(now + MAX_SHARE_EXPIRY_MS + 1000).toISOString(), 'soon', 123, true, {}]) {
      assert.equal(parseShareExpiry(value, now).ok, false, String(value));
    }
  });

  test('isShareLive', () => {
    assert.equal(isShareLive(null, now), true);
    assert.equal(isShareLive(new Date(now + 1), now), true);
    assert.equal(isShareLive(new Date(now), now), false);
  });
});

describe('diffLines', () => {
  test('identical input has no changes', () => {
    const diff = diffLines('a\nb', 'a\nb');
    assert.equal(diff.added, 0);
    assert.equal(diff.removed, 0);
    assert.deepEqual(diff.lines.map(l => l.type), ['same', 'same']);
  });

  test('reports added, removed and changed lines in order', () => {
    const diff = diffLines('one\ntwo\nthree', 'one\n2\nthree\nfour');
    assert.deepEqual(diff.lines, [
      { type: 'same', text: 'one' },
      { type: 'removed', text: 'two' },
      { type: 'added', text: '2' },
      { type: 'same', text: 'three' },
      { type: 'added', text: 'four' }
    ]);
    assert.equal(diff.added, 2);
    assert.equal(diff.removed, 1);
  });

  test('CRLF and LF compare equal', () => {
    assert.equal(diffLines('a\r\nb', 'a\nb').added, 0);
  });

  test('huge inputs fall back to a block replace', () => {
    const size = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 10;
    const a = Array.from({ length: size }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: size }, (_, i) => `b${i}`).join('\n');
    const diff = diffLines(a, b);
    assert.equal(diff.truncated, true);
    assert.equal(diff.added, size);
    assert.equal(diff.removed, size);
  });
});
