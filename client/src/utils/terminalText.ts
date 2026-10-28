/** Turn a PTY byte stream into the text a simple terminal would show. */

const ANSI =
  // eslint-disable-next-line no-control-regex -- terminal control sequences
  /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

export const versionAtLeast = (current: string, target: string): boolean => {
  const parts = (value: string): number[] => (value.match(/\d+/g) || []).slice(0, 3).map(Number);
  const left = parts(current || '');
  const right = parts(target);
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) > (right[i] || 0);
  }
  return true;
};

export const renderTerminal = (raw: string): string => {
  const text = raw.replace(ANSI, '');
  const lines: string[][] = [[]];
  let row = 0;
  let col = 0;

  const line = (): string[] => {
    while (lines.length <= row) lines.push([]);
    return lines[row];
  };

  for (const ch of text) {
    if (ch === '\n') {
      row += 1;
      col = 0;
      line();
      continue;
    }
    if (ch === '\r') {
      col = 0;
      continue;
    }
    if (ch === '\b' || ch === '\u007f') {
      if (col > 0) col -= 1;
      continue;
    }
    if (ch === '\t') {
      col += 8 - (col % 8);
      continue;
    }
    if (ch < ' ') continue;

    const cells = line();
    while (cells.length < col) cells.push(' ');
    cells[col] = ch;
    col += 1;
  }

  return lines.map((cells, index) => (index === lines.length - 1 ? cells.join('') : cells.join('').trimEnd())).join('\n');
};
