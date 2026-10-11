import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TAG_COLOR, normaliseTagNames } from '../src/db/migrations/22_shared_tags';

describe('tag migration normalisation', () => {
  test('trims, drops blanks and dedupes case-insensitively', () => {
    assert.deepEqual(normaliseTagNames(' Web , web,DB,, db ,  '), ['web', 'db']);
  });

  test('empty input gives no tags', () => {
    assert.deepEqual(normaliseTagNames(''), []);
  });

  test('default colour is a valid #rrggbb', () => {
    assert.match(DEFAULT_TAG_COLOR, /^#[0-9a-f]{6}$/);
  });
});
