/**
 * The SPA fallback must serve client routes such as /about to anyone,
 * without a session and without touching the database.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const get = (port: number, path: string): Promise<{ status: number; type: string; text: string }> =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (text += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, type: String(res.headers['content-type'] || ''), text })
        );
      })
      .on('error', reject);
  });

describe('SPA fallback', () => {
  let server: http.Server;
  let port = 0;

  before(async () => {
    const clientDir = mkdtempSync(join(tmpdir(), 'snippycode-client-'));
    writeFileSync(join(clientDir, 'index.html'), '<!doctype html><div id="root">spa-shell</div>');

    // Same module load order as src/server.ts (utils before db).
    await import('../src/utils');
    const { createApp } = await import('../src/app');
    server = createApp({ clientDirs: [clientDir] }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  test('serves the client shell for /about without a session', async () => {
    const res = await get(port, '/about');

    assert.equal(res.status, 200);
    assert.match(res.type, /^text\/html/);
    assert.match(res.text, /spa-shell/);
  });

  test('does not serve the client shell for unknown API routes', async () => {
    const res = await get(port, '/api/does-not-exist');

    assert.doesNotMatch(res.text, /spa-shell/);
  });
});
