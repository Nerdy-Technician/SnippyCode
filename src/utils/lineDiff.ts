/**
 * Small line diff used by the version history API. It is a plain LCS over
 * lines, which is fine for snippets; very large inputs fall back to a
 * whole-block replace so a request can never burn unbounded CPU.
 */
export type DiffLine = { type: 'same' | 'added' | 'removed'; text: string };

export interface LineDiff {
  added: number;
  removed: number;
  lines: DiffLine[];
  truncated: boolean;
}

export const MAX_DIFF_CELLS = 4_000_000;

const splitLines = (value: string): string[] => (value === '' ? [] : value.replace(/\r\n/g, '\n').split('\n'));

export const diffLines = (before: string, after: string): LineDiff => {
  const a = splitLines(before || '');
  const b = splitLines(after || '');

  // Trim common prefix/suffix so the LCS table only covers the changed part
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const head: DiffLine[] = a.slice(0, start).map(text => ({ type: 'same', text }));
  const tail: DiffLine[] = a.slice(endA).map(text => ({ type: 'same', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  let middle: DiffLine[] = [];
  let truncated = false;

  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) {
    truncated = true;
    middle = [
      ...midA.map(text => ({ type: 'removed' as const, text })),
      ...midB.map(text => ({ type: 'added' as const, text }))
    ];
  } else {
    const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        middle.push({ type: 'same', text: midA[i] });
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        middle.push({ type: 'removed', text: midA[i] });
        i += 1;
      } else {
        middle.push({ type: 'added', text: midB[j] });
        j += 1;
      }
    }
    while (i < n) middle.push({ type: 'removed', text: midA[i++] });
    while (j < m) middle.push({ type: 'added', text: midB[j++] });
  }

  const lines = [...head, ...middle, ...tail];

  return {
    added: lines.filter(line => line.type === 'added').length,
    removed: lines.filter(line => line.type === 'removed').length,
    lines,
    truncated
  };
};
