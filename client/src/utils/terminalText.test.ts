import { renderTerminal, versionAtLeast } from './terminalText';

describe('terminal text', () => {
  it('overwrites a line on carriage return and erases with backspace', () => {
    expect(renderTerminal('hello\rbye')).toBe('byelo');
    expect(renderTerminal('hello\b\b \b')).toBe('hel o');
  });

  it('strips colour codes and keeps the prompt', () => {
    expect(renderTerminal('\u001b[31mPassword:\u001b[0m ')).toBe('Password: ');
  });

  it('compares agent versions by number', () => {
    expect(versionAtLeast('1.5.0', '1.5.0')).toBe(true);
    expect(versionAtLeast('1.4.0', '1.5.0')).toBe(false);
    expect(versionAtLeast('1.5.1', '1.5.0')).toBe(true);
  });
});
