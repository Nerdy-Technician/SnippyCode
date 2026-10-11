import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { directoryEntriesFromTree } from '../src/utils/github';

describe('git tree directory listing', () => {
  const items = [
    { path: 'snippets', type: 'tree', sha: 'a' },
    { path: 'snippets/bash', type: 'tree', sha: 'b' },
    { path: 'snippets/bash/one.json', type: 'blob', sha: 'c' },
    { path: 'snippets/readme.md', type: 'blob', sha: 'd' },
    { path: 'snippets/sub', type: 'commit', sha: 'e' },
    { path: 'other.txt', type: 'blob', sha: 'f' }
  ];

  test('only direct children of the folder, typed like the contents API', () => {
    assert.deepEqual(directoryEntriesFromTree('snippets/', items), [
      { name: 'bash', path: 'snippets/bash', type: 'dir', sha: 'b' },
      { name: 'readme.md', path: 'snippets/readme.md', type: 'file', sha: 'd' }
    ]);
  });

  test('root folder', () => {
    assert.deepEqual(directoryEntriesFromTree('', items).map(entry => entry.path), ['snippets', 'other.txt']);
  });

  test('non-recursive subtree paths get the folder prefix', () => {
    const sub = [{ path: 'one.json', type: 'blob', sha: 'c' }];
    assert.deepEqual(directoryEntriesFromTree('snippets/bash', sub, 'snippets/bash'), [
      { name: 'one.json', path: 'snippets/bash/one.json', type: 'file', sha: 'c' }
    ]);
  });

  test('handles more than 1,000 entries', () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({ path: `s/f${i}.json`, type: 'blob', sha: String(i) }));
    assert.equal(directoryEntriesFromTree('s', many).length, 2500);
  });
});
