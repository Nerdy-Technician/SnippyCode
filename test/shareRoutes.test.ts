/**
 * HTTP tests for /s/, /api/snippets/public and /raw against a real
 * PostgreSQL database. Set TEST_DATABASE_URL to a throwaway database whose
 * name contains "test"; its public schema is dropped and re-created.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = TEST_DATABASE_URL
  ? false
  : 'TEST_DATABASE_URL is not set, skipping HTTP share tests';

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: () => any;
}

const POWERSHELL_CODE = [
  '[CmdletBinding()]',
  'param([switch]$Force)',
  'Write-Host "Grüße aus SnippyCode ✓"',
  "Get-Process OneDrive -ErrorAction SilentlyContinue | Stop-Process -Force",
  ''
].join('\r\n');

describe('share links and raw endpoint', { skip }, () => {
  let server: http.Server;
  let port = 0;
  let cookie = '';
  let db: any;

  const request = (
    method: string,
    path: string,
    options: { body?: unknown; headers?: http.OutgoingHttpHeaders; auth?: boolean } = {}
  ): Promise<TestResponse> =>
    new Promise((resolve, reject) => {
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
      const headers: http.OutgoingHttpHeaders = { ...(options.headers || {}) };

      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(payload);
      }

      if (options.auth !== false && cookie) {
        headers.cookie = cookie;
      }

      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            text,
            json: () => JSON.parse(text)
          });
        });
      });

      req.on('error', reject);
      if (payload !== undefined) {
        req.write(payload);
      }
      req.end();
    });

  const createSnippet = async (body: { [key: string]: unknown }) => {
    const res = await request('POST', '/api/snippets', {
      body: { description: '', docs: '', tags: [], isPinned: false, ...body }
    });
    assert.equal(res.status, 201, res.text);
    return res.json().data;
  };

  before(async () => {
    const dbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');

    if (!/test/i.test(dbName)) {
      throw new Error(`Refusing to reset database "${dbName}": its name must contain "test"`);
    }

    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = 'snippycode-test-session-secret';
    process.env.GITHUB_TOKEN = '';
    delete process.env.PUBLIC_BASE_URL;

    // Same module load order as src/server.ts (utils before db) to keep the
    // utils <-> db <-> models import cycle resolving the way it does in prod.
    await import('../src/utils');
    db = await import('../src/db');
    await db.sequelize.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await db.connectDB();
    const { associateModels } = await import('../src/db/associateModels');
    await associateModels();

    const clientDir = mkdtempSync(join(tmpdir(), 'snippycode-client-'));
    writeFileSync(join(clientDir, 'index.html'), '<!doctype html><div id="root">spa-shell</div>');

    const { createApp } = await import('../src/app');
    server = createApp({ clientDirs: [clientDir] }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;

    const setup = await request('POST', '/api/auth/setup', {
      body: { email: 'owner@example.test', displayName: 'Owner', password: 'correct-horse-battery' }
    });
    assert.equal(setup.status, 201, setup.text);
    cookie = String(setup.headers['set-cookie']?.[0] || '').split(';')[0];
    assert.ok(cookie, 'setup should set a session cookie');
  });

  after(async () => {
    await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
    await db?.sequelize.close();
  });

  test('a PowerShell snippet gets a dotted slug that /s/ and /raw resolve once it is public', async () => {
    const snippet = await createSnippet({
      title: 'Purge OneDrive from Windows',
      language: 'powershell',
      code: POWERSHELL_CODE
    });
    const slug = 'purge-onedrive-from-windows.powershell';
    assert.equal(snippet.rawSlug, slug);
    assert.equal(snippet.isPublic, false);

    // The SPA shell is served for the dotted path, not treated as a file.
    const page = await request('GET', `/s/${slug}`, { auth: false });
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-type']), /text\/html/);
    assert.match(page.text, /spa-shell/);

    // Private: both share surfaces are a plain 404.
    assert.equal((await request('GET', `/api/snippets/public/${slug}`, { auth: false })).status, 404);
    assert.equal((await request('GET', `/raw/${slug}`, { auth: false })).status, 404);

    const patched = await request('PATCH', `/api/snippets/${snippet.id}`, { body: { isPublic: true } });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json().data.isPublic, true);

    const pub = await request('GET', `/api/snippets/public/${slug}`, { auth: false });
    assert.equal(pub.status, 200, pub.text);
    const data = pub.json().data;
    assert.equal(data.code, POWERSHELL_CODE);
    assert.equal(data.rawUrl, `http://127.0.0.1:${port}/raw/${slug}`);
    assert.equal(data.powerShellCommand, `irm http://127.0.0.1:${port}/raw/${slug} | iex`);

    const raw = await request('GET', `/raw/${slug}`, { auth: false });
    assert.equal(raw.status, 200);
    assert.equal(raw.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(raw.headers['x-content-type-options'], 'nosniff');
    assert.equal(raw.headers['cache-control'], 'no-store');
    assert.equal(raw.text, POWERSHELL_CODE);

    const byId = await request('GET', `/raw/${snippet.id}`, { auth: false });
    assert.equal(byId.status, 200);
    assert.equal(byId.text, POWERSHELL_CODE);

    const apiRaw = await request('GET', `/api/snippets/raw/${slug}`, { auth: false });
    assert.equal(apiRaw.status, 200);
    assert.equal(apiRaw.text, POWERSHELL_CODE);
  });

  test('regression: later edits and pin toggles do not unpublish a shared snippet', async () => {
    const snippet = await createSnippet({
      title: 'Share stays public',
      language: 'powershell',
      code: 'Write-Host 1',
      isPublic: true
    });
    const slug = snippet.rawSlug;
    assert.equal(slug, 'share-stays-public.powershell');

    // Pin toggle through the flags endpoint.
    const pinned = await request('PATCH', `/api/snippets/${snippet.id}`, { body: { isPinned: true } });
    assert.equal(pinned.status, 200, pinned.text);
    assert.equal(pinned.json().data.isPublic, true);
    assert.equal(pinned.json().data.isPinned, 1);

    // A PUT that leaves isPublic out (older client, CLI, stale tab) keeps it.
    const edited = await request('PUT', `/api/snippets/${snippet.id}`, {
      body: { title: 'Share stays public', language: 'powershell', code: 'Write-Host 2' }
    });
    assert.equal(edited.status, 200, edited.text);
    assert.equal(edited.json().data.isPublic, true);
    assert.equal(edited.json().data.isPinned, 1);
    assert.deepEqual(edited.json().data.tags, ['powershell']);

    const pub = await request('GET', `/api/snippets/public/${slug}`, { auth: false });
    assert.equal(pub.status, 200, pub.text);
    assert.equal((await request('GET', `/raw/${slug}`, { auth: false })).text, 'Write-Host 2');

    // Turning it off is explicit and audited.
    const privateRes = await request('PATCH', `/api/snippets/${snippet.id}`, { body: { isPublic: false } });
    assert.equal(privateRes.json().data.isPublic, false);
    assert.equal((await request('GET', `/api/snippets/public/${slug}`, { auth: false })).status, 404);
    assert.equal((await request('GET', `/raw/${slug}`, { auth: false })).status, 404);

    const [rows] = await db.sequelize.query(
      `SELECT metadata FROM audit_logs WHERE action = 'snippet.visibility_changed' AND target = 'snippet:${snippet.id}' ORDER BY id`
    );
    assert.deepEqual(
      rows.map((row: { metadata: unknown }) =>
        typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
      ),
      [{ from: 'public', to: 'private' }]
    );
  });

  test('number-like dotted slugs are looked up by slug, not by id', async () => {
    const snippet = await createSnippet({
      title: 'Version file',
      language: 'plaintext',
      fileName: '1.5',
      code: 'one point five',
      isPublic: true
    });
    assert.equal(snippet.rawSlug, '1.5');

    const raw = await request('GET', '/raw/1.5', { auth: false });
    assert.equal(raw.status, 200, raw.text);
    assert.equal(raw.text, 'one point five');
    assert.equal((await request('GET', '/api/snippets/public/1.5', { auth: false })).status, 200);
  });

  test('private snippets still work with a snippet raw token, and nothing else', async () => {
    const snippet = await createSnippet({
      title: 'Private deploy',
      language: 'bash',
      code: 'echo private'
    });
    const slug = snippet.rawSlug;
    assert.equal(slug, 'private-deploy.sh');

    const tokenRes = await request('POST', `/api/snippets/${snippet.id}/raw-token`);
    assert.equal(tokenRes.status, 201, tokenRes.text);
    const token = tokenRes.json().data.token;

    const withKey = await request('GET', `/raw/${slug}?key=${encodeURIComponent(token)}`, { auth: false });
    assert.equal(withKey.status, 200);
    assert.equal(withKey.text, 'echo private');
    assert.equal(withKey.headers['content-type'], 'text/plain; charset=utf-8');

    const withHeader = await request('GET', `/raw/${slug}`, {
      auth: false,
      headers: { 'x-api-key': token }
    });
    assert.equal(withHeader.status, 200);

    assert.equal((await request('GET', `/raw/${slug}?key=wrong`, { auth: false })).status, 404);
    assert.equal((await request('GET', `/raw/${slug}`, { auth: false })).status, 404);
    // A logged-in session is not a share: /s/ data stays hidden while private.
    assert.equal((await request('GET', `/api/snippets/public/${slug}`)).status, 404);
  });

  test('unknown refs and non-PowerShell snippets', async () => {
    assert.equal((await request('GET', '/raw/does-not-exist.powershell', { auth: false })).status, 404);
    assert.equal((await request('GET', '/api/snippets/public/does-not-exist.powershell', { auth: false })).status, 404);

    const snippet = await createSnippet({
      title: 'Public bash',
      language: 'bash',
      code: 'echo hi',
      isPublic: true
    });
    const pub = await request('GET', `/api/snippets/public/${snippet.rawSlug}`, { auth: false });
    assert.equal(pub.status, 200);
    assert.equal(pub.json().data.powerShellCommand, null);
  });

  test('PUBLIC_BASE_URL is used for the one-liner and auth status', async () => {
    process.env.PUBLIC_BASE_URL = 'https://snippycode.example.com/';

    try {
      const pub = await request('GET', '/api/snippets/public/purge-onedrive-from-windows.powershell', {
        auth: false
      });
      assert.equal(
        pub.json().data.powerShellCommand,
        'irm https://snippycode.example.com/raw/purge-onedrive-from-windows.powershell | iex'
      );

      const status = await request('GET', '/api/auth/status');
      assert.equal(status.json().data.publicBaseUrl, 'https://snippycode.example.com');
    } finally {
      delete process.env.PUBLIC_BASE_URL;
    }

    const status = await request('GET', '/api/auth/status');
    assert.equal(status.json().data.publicBaseUrl, '');
  });

  test('flag updates need an editor session and only accept flags', async () => {
    const snippet = await createSnippet({ title: 'Flags only', language: 'bash', code: 'true' });

    assert.equal(
      (await request('PATCH', `/api/snippets/${snippet.id}`, { body: { isPublic: true }, auth: false })).status,
      401
    );
    assert.equal(
      (await request('PATCH', `/api/snippets/${snippet.id}`, { body: { code: 'rm -rf /' } })).status,
      400
    );
    assert.equal(
      (await request('PATCH', `/api/snippets/${snippet.id}`, { body: { isPublic: 'yes' } })).status,
      400
    );
  });
});
