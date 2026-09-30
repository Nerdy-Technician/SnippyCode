import {
  buildPowerShellRemoteCommand,
  buildRawUrl,
  buildShareUrl,
  isPowerShellLanguage,
  rawRefFor,
  resolveBaseUrl
} from './shareLinks';

describe('share links', () => {
  it('keeps dotted slugs intact in share and raw URLs', () => {
    const ref = rawRefFor({ id: 16, rawSlug: 'purge-onedrive-from-windows.powershell' });

    expect(buildShareUrl('https://snippycode.example.com/', ref)).toBe(
      'https://snippycode.example.com/s/purge-onedrive-from-windows.powershell'
    );
    expect(buildRawUrl('https://snippycode.example.com', ref)).toBe(
      'https://snippycode.example.com/raw/purge-onedrive-from-windows.powershell'
    );
  });

  it('falls back to the id when there is no slug', () => {
    expect(rawRefFor({ id: 4, rawSlug: '' })).toBe('4');
    expect(rawRefFor({ id: 4, rawSlug: null })).toBe('4');
  });

  it('builds the PowerShell one-liner', () => {
    expect(
      buildPowerShellRemoteCommand(
        buildRawUrl('https://snippycode.example.com', 'purge-onedrive-from-windows.powershell')
      )
    ).toBe('irm https://snippycode.example.com/raw/purge-onedrive-from-windows.powershell | iex');
  });

  it('only treats PowerShell languages as PowerShell', () => {
    expect(isPowerShellLanguage('PowerShell')).toBe(true);
    expect(isPowerShellLanguage('pwsh')).toBe(true);
    expect(isPowerShellLanguage('bash')).toBe(false);
    expect(isPowerShellLanguage(undefined)).toBe(false);
  });

  it('prefers the server base URL over the page origin', () => {
    expect(resolveBaseUrl('https://snippycode.example.com/')).toBe('https://snippycode.example.com');
    expect(resolveBaseUrl('')).toBe(window.location.origin);
  });
});
