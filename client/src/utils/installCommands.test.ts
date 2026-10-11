import { installCommands } from './installCommands';

const url = 'https://snippy.example/raw/setup.sh?key=abc';

describe('installCommands', () => {
  test('shell snippets pipe to bash, with a verify step when hashed', () => {
    const commands = installCommands('bash', url, 'setup.sh', 'deadbeef');

    expect(commands.map(command => command.label)).toEqual(['Run', 'wget', 'Verify + run']);
    expect(commands[0].command).toBe(`curl -fsSL "${url}" | bash`);
    expect(commands[2].command).toContain('echo "deadbeef  /tmp/setup.sh" | sha256sum -c -');
  });

  test('PowerShell uses irm | iex and upper-case hashes', () => {
    const commands = installCommands('powershell', url, 'setup.ps1', 'deadbeef');

    expect(commands[0].command).toBe(`irm "${url}" | iex`);
    expect(commands[1].command).toContain('"DEADBEEF"');
  });

  test('other languages are downloaded, not run', () => {
    expect(installCommands('yaml', url, 'config.yml').map(command => command.label)).toEqual([
      'Download'
    ]);
  });

  test('no checksum means no verify step', () => {
    expect(installCommands('python', url, 'x.py').map(command => command.label)).toEqual(['Run']);
  });
});
