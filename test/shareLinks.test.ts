import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Request } from 'express';
import {
  buildPowerShellRemoteCommand,
  buildRawUrl,
  configuredPublicBaseUrl,
  isPowerShellLanguage,
  parseRawRef,
  rawRefForSnippet,
  rawSlugForSnippet,
  resolvePublicBaseUrl
} from '../src/utils/shareLinks';

const fakeRequest = (host: string, protocol = 'https'): Request =>
  ({ protocol, get: (name: string) => (name.toLowerCase() === 'host' ? host : undefined) } as unknown as Request);

describe('raw slugs', () => {
  test('keeps the language extension as a dotted slug', () => {
    assert.equal(
      rawSlugForSnippet({ title: 'Purge OneDrive from Windows', language: 'powershell' }),
      'purge-onedrive-from-windows.powershell'
    );
    assert.equal(rawSlugForSnippet({ title: 'Linux: Preprovision', language: 'bash' }), 'linux-preprovision.sh');
    assert.equal(rawSlugForSnippet({ title: 'x', language: 'bash', fileName: 'Setup.PS1' }), 'setup.ps1');
  });

  test('a built slug is looked up by slug, never as an id or file', () => {
    const slugs = [
      rawSlugForSnippet({ title: 'Purge OneDrive from Windows', language: 'powershell' }),
      rawSlugForSnippet({ title: 'v1.2 release notes', language: 'markdown' }),
      rawSlugForSnippet({ title: '2024', language: 'powershell' }),
      rawSlugForSnippet({ title: 'anything', language: 'bash', fileName: '1.5' })
    ];

    assert.deepEqual(slugs, [
      'purge-onedrive-from-windows.powershell',
      'v1.2-release-notes',
      '2024.powershell',
      '1.5'
    ]);

    slugs.forEach(slug => assert.deepEqual(parseRawRef(slug), { rawSlug: slug }));
  });
});

describe('parseRawRef', () => {
  test('plain positive integers are ids', () => {
    assert.deepEqual(parseRawRef('16'), { id: 16 });
    assert.deepEqual(parseRawRef(' 42 '), { id: 42 });
  });

  test('dotted and number-like values are slugs', () => {
    ['1.5', '1e3', '0x10', '016', '16.ps1', 'purge-onedrive-from-windows.powershell'].forEach(ref =>
      assert.deepEqual(parseRawRef(ref), { rawSlug: ref })
    );
  });

  test('empty, oversized and non-string refs are rejected', () => {
    assert.equal(parseRawRef(''), null);
    assert.equal(parseRawRef('   '), null);
    assert.equal(parseRawRef(undefined), null);
    assert.equal(parseRawRef(['16']), null);
    assert.equal(parseRawRef('a'.repeat(256)), null);
    assert.equal(parseRawRef('99999999999999999999'), null);
  });

  test('rawRefForSnippet falls back to the id when the slug is empty', () => {
    assert.equal(rawRefForSnippet({ id: 4, rawSlug: '' }), '4');
    assert.equal(rawRefForSnippet({ id: 4, rawSlug: null }), '4');
    assert.equal(rawRefForSnippet({ id: 9, rawSlug: 'linux-preprovision.sh' }), 'linux-preprovision.sh');
  });
});

describe('PowerShell remote execute', () => {
  const originalBaseUrl = process.env.PUBLIC_BASE_URL;

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.PUBLIC_BASE_URL;
    } else {
      process.env.PUBLIC_BASE_URL = originalBaseUrl;
    }
  });

  test('detects PowerShell languages only', () => {
    ['powershell', 'PowerShell', 'pwsh', 'ps1', ' posh '].forEach(language =>
      assert.equal(isPowerShellLanguage(language), true, language)
    );
    ['bash', 'python', 'shell', '', null, undefined].forEach(language =>
      assert.equal(isPowerShellLanguage(language), false, String(language))
    );
  });

  test('builds the irm | iex one-liner from the raw URL', () => {
    const rawUrl = buildRawUrl('https://snippycode.example.com/', 'purge-onedrive-from-windows.powershell');

    assert.equal(rawUrl, 'https://snippycode.example.com/raw/purge-onedrive-from-windows.powershell');
    assert.equal(
      buildPowerShellRemoteCommand(rawUrl),
      'irm https://snippycode.example.com/raw/purge-onedrive-from-windows.powershell | iex'
    );
  });

  test('prefers PUBLIC_BASE_URL over the request host', () => {
    process.env.PUBLIC_BASE_URL = 'https://snippycode.example.com/';
    assert.equal(resolvePublicBaseUrl(fakeRequest('10.0.0.5:5000', 'http')), 'https://snippycode.example.com');
  });

  test('falls back to the request protocol and host', () => {
    delete process.env.PUBLIC_BASE_URL;
    assert.equal(resolvePublicBaseUrl(fakeRequest('snippycode.example.com')), 'https://snippycode.example.com');
    assert.equal(resolvePublicBaseUrl(fakeRequest('localhost:5000', 'http')), 'http://localhost:5000');
  });

  test('ignores unsafe base URLs and hosts', () => {
    process.env.PUBLIC_BASE_URL = 'https://evil.example.com/; Remove-Item C:\\';
    assert.equal(configuredPublicBaseUrl(), '');
    assert.equal(resolvePublicBaseUrl(fakeRequest('snippycode.example.com')), 'https://snippycode.example.com');
    process.env.PUBLIC_BASE_URL = 'javascript:alert(1)';
    assert.equal(configuredPublicBaseUrl(), '');
    delete process.env.PUBLIC_BASE_URL;
    assert.equal(resolvePublicBaseUrl(fakeRequest('evil.example.com; iex')), '');
  });
});
