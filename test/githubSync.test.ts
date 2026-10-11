/**
 * Automatic two-way GitHub sync against an in-memory remote: skipping when
 * nothing changed, uploads, downloads with backups, conflicts, deletes,
 * backoff, locking and the owner-only settings API.
 * Needs TEST_DATABASE_URL (a throwaway database whose name contains "test").
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import { createHash } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set, skipping GitHub sync tests';

interface TestResponse {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
  json: () => any;
}

describe('automatic GitHub sync', { skip }, () => {
  let server: http.Server;
  let port = 0;
  let db: any;
  let models: typeof import('../src/models');
  const cookies: { [who: string]: string } = {};

  const request = (
    method: string,
    path: string,
    options: { body?: unknown; form?: Record<string, string>; as?: string | null; ip?: string } = {}
  ): Promise<TestResponse> =>
    new Promise((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = {};
      let payload: string | undefined;

      if (options.form) {
        payload = new URLSearchParams(options.form).toString();
        headers['content-type'] = 'application/x-www-form-urlencoded';
      } else if (options.body !== undefined) {
        payload = JSON.stringify(options.body);
        headers['content-type'] = 'application/json';
      }
      if (payload !== undefined) headers['content-length'] = Buffer.byteLength(payload);

      const who = options.as === undefined ? 'owner' : options.as;
      if (who && cookies[who]) headers.cookie = cookies[who];
      if (options.ip) headers['x-forwarded-for'] = options.ip;

      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 0, text, headers: res.headers, json: () => JSON.parse(text) });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });

  const ok = async (res: Promise<TestResponse>, status = 200) => {
    const response = await res;
    assert.equal(response.status, status, response.text);
    return response.json().data;
  };

  let sync: typeof import('../src/utils/githubSync');
  let backup: typeof import('../src/utils/backup');

  // In-memory GitHub: path -> content, sha from content like git
  const files = new Map<string, string>();
  let calls = { list: 0, read: 0, write: 0 };
  let failWith: string | null = null;
  const sha = (content: string) => createHash('sha1').update(content).digest('hex');
  const remote = {
    list: async (dir: string) => {
      calls.list += 1;
      if (failWith) throw new Error(failWith);
      return Array.from(files.keys())
        .filter(key => key.startsWith(`${dir}/`) && !key.slice(dir.length + 1).includes('/'))
        .map(key => ({ name: key.slice(dir.length + 1), path: key, sha: sha(files.get(key)!) }));
    },
    read: async (file: string) => {
      calls.read += 1;
      return files.get(file)!;
    },
    write: async (file: string, content: string) => {
      calls.write += 1;
      files.set(file, content);
    }
  };
  const run = () => sync.runGithubSync({ trigger: 'schedule', remote });
  const configure = async (patch: Record<string, unknown>) =>
    sync.saveSyncSettings({ ...(await sync.getSyncSettings()), nextAttemptAt: null, ...patch } as any);
  const snippetFiles = () => Array.from(files.keys()).filter(key => key.includes('/.snippycode-sync/snippets/'));
  const fileOf = async (snippetId: number) => {
    const state = await models.GithubSyncItemModel.findOne({ where: { itemType: 'snippet', itemId: snippetId } });
    return `snippets/.snippycode-sync/snippets/${state!.syncId}.json`;
  };
  const editRemote = (file: string, patch: Record<string, unknown>) =>
    files.set(file, JSON.stringify({ ...JSON.parse(files.get(file)!), ...patch }, null, 2));
  const syncBackups = () => backup.listBackups().filter(item => item.name.includes('-github-sync'));

  let disk: any;
  let runbook: any;

  before(async () => {
    const dbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
    if (!/test/i.test(dbName)) throw new Error(`Refusing to reset database "${dbName}"`);

    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = 'snippycode-test-session-secret';
    process.env.VARIABLES_SECRET_KEY = 'snippycode-test-variables-key';
    process.env.BACKUP_DIR = mkdtempSync(path.join(tmpdir(), 'snippycode-sync-'));
    process.env.GITHUB_TOKEN = 'github_pat_TESTTOKEN123';
    process.env.GITHUB_REPO_OWNER = 'owner';
    process.env.GITHUB_REPO_NAME = 'repo';

    await import('../src/utils');
    db = await import('../src/db');
    await db.sequelize.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await db.connectDB();
    const { associateModels } = await import('../src/db/associateModels');
    await associateModels();
    models = await import('../src/models');
    sync = await import('../src/utils/githubSync');
    backup = await import('../src/utils/backup');

    const { createApp } = await import('../src/app');
    server = createApp({ clientDirs: [] }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;

    const setup = await request('POST', '/api/auth/setup', {
      body: { email: 'owner@example.test', displayName: 'Owner', password: 'correct-horse-battery' },
      as: null
    });
    assert.equal(setup.status, 201, setup.text);
    cookies.owner = String(setup.headers['set-cookie']?.[0] || '').split(';')[0];

    await ok(
      request('POST', '/api/admin/users', {
        body: { email: 'ed@example.test', displayName: 'Ed', password: 'ed-password-123', role: 'editor' }
      }),
      201
    );
    const login = await request('POST', '/api/auth/login', { body: { email: 'ed@example.test', password: 'ed-password-123' }, as: null });
    cookies.editor = String(login.headers['set-cookie']?.[0] || '').split(';')[0];

    disk = await models.SnippetModel.create({ title: 'Disk', language: 'bash', code: 'df -h\n', description: '', docs: '', isPinned: 0 });
    runbook = await models.RunbookModel.create({ title: 'Weekly', description: 'checks' });
    await models.RunbookStepModel.create({ runbookId: runbook.id, position: 0, snippetId: disk.id, title: 'Disk', note: '' });
  });

  after(async () => {
    await new Promise(resolve => server?.close(resolve));
    await db?.sequelize.close();
  });

  test('off by default, and settings are owner-only and audited', async () => {
    const status = await ok(request('GET', '/api/admin/github/sync'));
    assert.equal(status.settings.uploadEnabled, false);
    assert.equal(status.settings.downloadEnabled, false);
    assert.equal(status.settings.intervalMinutes, 60);
    assert.equal((await run()).status, 'disabled');

    assert.equal((await request('PUT', '/api/admin/github/sync', { body: { uploadEnabled: true }, as: 'editor' })).status, 403);
    assert.equal((await request('PUT', '/api/admin/github/sync', { body: { intervalMinutes: 7 } })).status, 400);
    const saved = await ok(request('PUT', '/api/admin/github/sync', { body: { uploadEnabled: true, intervalMinutes: 30 } }));
    assert.equal(saved.uploadEnabled, true);
    assert.equal(saved.intervalMinutes, 30);

    const [audit] = await db.sequelize.query(`SELECT metadata FROM audit_logs WHERE action = 'github.sync.settings_updated' ORDER BY id DESC LIMIT 1`);
    const metadata = (audit as any[])[0].metadata;
    const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    assert.equal(parsed.after.uploadEnabled, true);
    assert.ok(!JSON.stringify(parsed).includes('TESTTOKEN'));
  });

  test('upload-only pushes snippets and runbooks, then skips when nothing changed', async () => {
    await configure({ uploadEnabled: true, downloadEnabled: false });
    const first = await run();
    assert.equal(first.status, 'success', first.error);
    assert.equal(first.uploaded, 2);
    assert.equal(snippetFiles().length, 1);
    const runbookFile = Array.from(files.keys()).find(key => key.includes('/runbooks/'))!;
    const uploaded = JSON.parse(files.get(runbookFile)!);
    const diskState = await models.GithubSyncItemModel.findOne({ where: { itemType: 'snippet', itemId: disk.id } });
    assert.equal(uploaded.steps[0].snippet, diskState!.syncId, 'runbook steps point at snippets by sync id');

    calls = { list: 0, read: 0, write: 0 };
    const second = await run();
    assert.equal(second.status, 'skipped');
    assert.equal(calls.list + calls.write, 0, 'no GitHub calls when nothing changed locally');
  });

  test('download applies remote edits after a backup; unchanged runs skip', async () => {
    await configure({ uploadEnabled: true, downloadEnabled: true });
    editRemote(await fileOf(disk.id), { code: 'df -hT\n' });

    const result = await run();
    assert.equal(result.status, 'success', result.error);
    assert.equal(result.downloaded, 1);
    assert.equal(result.uploaded, 0);
    assert.ok(result.backup && result.backup.includes('github-sync'));
    assert.equal(syncBackups().length, 1);
    assert.equal((await models.SnippetModel.findByPk(disk.id))!.code, 'df -hT\n');

    calls = { list: 0, read: 0, write: 0 };
    const again = await run();
    assert.equal(again.status, 'skipped');
    assert.equal(calls.read + calls.write, 0);
    assert.equal(syncBackups().length, 1, 'no backup when nothing changes locally');
  });

  test('changes on both sides keep both copies and never overwrite', async () => {
    const file = await fileOf(disk.id);
    await disk.reload();
    await disk.update({ code: 'df -h /\n' });
    editRemote(file, { code: 'df -h /var\n' });
    const remoteBefore = files.get(file);
    calls = { list: 0, read: 0, write: 0 };

    const result = await run();
    assert.equal(result.conflicts, 1);
    assert.equal(calls.write, 0, 'nothing uploaded over the remote edit');
    assert.equal(files.get(file), remoteBefore);
    assert.equal((await models.SnippetModel.findByPk(disk.id))!.code, 'df -h /\n', 'local kept');

    const status = await ok(request('GET', '/api/admin/github/sync'));
    assert.equal(status.conflicts.length, 1);
    const conflict = status.conflicts[0];
    assert.equal(conflict.title, 'Disk');
    assert.equal(conflict.conflictTitle, 'Disk (GitHub conflict)');
    const copy = await models.SnippetModel.findByPk(conflict.conflictItemId);
    assert.equal(copy!.code, 'df -h /var\n');

    // Still a conflict on the next run; the copy is not synced as a new item
    const next = await run();
    assert.equal(next.conflicts, 1);
    assert.equal(snippetFiles().length, 1);

    // Keep local: the copy goes and the next run uploads the local version
    await ok(request('POST', `/api/admin/github/sync/conflicts/${conflict.id}`, { body: { keep: 'local' } }));
    assert.equal(await models.SnippetModel.findByPk(conflict.conflictItemId), null);
    const resolved = await run();
    assert.equal(resolved.uploaded, 1, resolved.error);
    assert.equal(JSON.parse(files.get(file)!).code, 'df -h /\n');
  });

  test('keep remote and keep both', async () => {
    const file = await fileOf(disk.id);
    await disk.reload();
    await disk.update({ code: 'local-2\n' });
    editRemote(file, { code: 'remote-2\n' });
    await run();
    let [conflict] = (await ok(request('GET', '/api/admin/github/sync'))).conflicts;
    await ok(request('POST', `/api/admin/github/sync/conflicts/${conflict.id}`, { body: { keep: 'remote' } }));
    assert.equal((await models.SnippetModel.findByPk(disk.id))!.code, 'remote-2\n');
    const quiet = await run();
    assert.equal(quiet.uploaded + quiet.downloaded + quiet.conflicts, 0, 'in sync after taking the remote copy');

    await disk.reload();
    await disk.update({ code: 'local-3\n' });
    editRemote(file, { code: 'remote-3\n' });
    await run();
    [conflict] = (await ok(request('GET', '/api/admin/github/sync'))).conflicts;
    await ok(request('POST', `/api/admin/github/sync/conflicts/${conflict.id}`, { body: { keep: 'both' } }));
    const both = await run();
    assert.equal(both.uploaded, 2, 'local overwrites its file and the copy uploads as a new item');
    assert.equal(snippetFiles().length, 2);
    assert.equal(JSON.parse(files.get(file)!).code, 'local-3\n');
  });

  test('remote-only items are imported; deletes are not propagated', async () => {
    files.set(
      'snippets/.snippycode-sync/snippets/0f0e0d0c-aaaa-bbbb-cccc-000000000001.json',
      JSON.stringify({ type: 'snippet', title: 'From GitHub', language: 'bash', code: 'uptime\n' })
    );
    const imported = await run();
    assert.equal(imported.downloaded, 1);
    const local = await models.SnippetModel.findOne({ where: { title: 'From GitHub' } });
    assert.ok(local);

    // Local delete: the GitHub file stays and is not imported again
    const file = await fileOf(local!.id);
    await local!.destroy();
    await run();
    assert.ok(files.has(file), 'remote file kept');
    await run();
    assert.equal(await models.SnippetModel.count({ where: { title: 'From GitHub' } }), 0, 'not resurrected');

    // Remote delete: the local item stays
    const diskFile = await fileOf(disk.id);
    files.delete(diskFile);
    await run();
    assert.ok(await models.SnippetModel.findByPk(disk.id));
    assert.ok(!files.has(diskFile), 'not re-created while the local copy is unchanged');
  });

  test('upload-only flags a conflict instead of overwriting', async () => {
    await configure({ uploadEnabled: true, downloadEnabled: false });
    const other = await models.SnippetModel.create({ title: 'Mem', language: 'bash', code: 'free\n', description: '', docs: '', isPinned: 0 });
    await run();
    const file = await fileOf(other.id);
    await other.update({ code: 'free -m\n' });
    editRemote(file, { code: 'free -g\n' });
    const before = await models.SnippetModel.count();

    const result = await run();
    assert.equal(result.conflicts, 1);
    assert.equal(JSON.parse(files.get(file)!).code, 'free -g\n', 'remote untouched');
    assert.equal(await models.SnippetModel.count(), before, 'no copy imported without auto-download');
    const conflict = (await ok(request('GET', '/api/admin/github/sync'))).conflicts.find((item: any) => item.itemId === other.id);
    assert.equal(conflict.conflictItemId, null);
    assert.equal((await request('POST', `/api/admin/github/sync/conflicts/${conflict.id}`, { body: { keep: 'remote' } })).status, 400);
    await ok(request('POST', `/api/admin/github/sync/conflicts/${conflict.id}`, { body: { keep: 'local' } }));
  });

  test('manual Upload/Download buttons run one direction, even with auto-sync off', async () => {
    await configure({ uploadEnabled: false, downloadEnabled: false });
    const local = await models.SnippetModel.create({ title: 'Manual only', description: '', language: 'bash', code: 'id\n', docs: '', isPinned: 0 });

    const up = await sync.runGithubSync({ trigger: 'manual', remote, direction: 'upload' });
    assert.equal(up.status, 'success', up.error);
    assert.equal(up.downloaded, 0);
    const file = await fileOf(local.id);
    assert.ok(files.has(file), 'manual upload writes the sync layout');

    editRemote(file, { description: 'edited on GitHub' });
    const upAgain = await sync.runGithubSync({ trigger: 'manual', remote, direction: 'upload' });
    assert.equal(upAgain.downloaded, 0, 'upload never pulls remote edits');
    assert.equal((await models.SnippetModel.findByPk(local.id))!.description, '');

    const writes = calls.write;
    const down = await sync.runGithubSync({ trigger: 'manual', remote, direction: 'download' });
    assert.equal(down.status, 'success', down.error);
    assert.equal(down.uploaded, 0);
    assert.equal(calls.write, writes, 'download never writes to GitHub');
    assert.equal((await models.SnippetModel.findByPk(local.id))!.description, 'edited on GitHub');
  });

  test('failures back off exponentially, capped, without leaking the token', async () => {
    await configure({ uploadEnabled: true, downloadEnabled: true, intervalMinutes: 60, failures: 0 });
    failWith = 'Bad credentials for github_pat_TESTTOKEN123';
    const now = new Date('2026-10-11T12:00:00Z');

    const first = await sync.runGithubSync({ remote, now });
    assert.equal(first.status, 'failed');
    assert.ok(!first.error!.includes('TESTTOKEN'));
    let settings = await sync.getSyncSettings();
    assert.equal(settings.failures, 1);
    assert.equal(new Date(settings.nextAttemptAt!).getTime() - now.getTime(), 60 * 60_000);

    await sync.runGithubSync({ remote, now });
    settings = await sync.getSyncSettings();
    assert.equal(new Date(settings.nextAttemptAt!).getTime() - now.getTime(), 120 * 60_000);

    await sync.saveSyncSettings({ ...settings, failures: 20 });
    await sync.runGithubSync({ remote, now });
    settings = await sync.getSyncSettings();
    assert.equal(new Date(settings.nextAttemptAt!).getTime() - now.getTime(), 24 * 3600_000, 'capped at a day');

    // The tick respects the backoff
    calls = { list: 0, read: 0, write: 0 };
    await sync.githubSyncTick(new Date(now.getTime() + 60_000));
    assert.equal(calls.list, 0);

    failWith = null;
    const ok2 = await sync.runGithubSync({ remote, now });
    assert.notEqual(ok2.status, 'failed');
    assert.equal((await sync.getSyncSettings()).failures, 0);

    const [rows] = await db.sequelize.query(`SELECT error FROM github_sync_runs WHERE status = 'failed'`);
    assert.ok((rows as any[]).length >= 3);
    assert.ok((rows as any[]).every(row => !String(row.error).includes('TESTTOKEN')));
  });

  test('never runs twice at once, and recovers from a run left behind by a restart', async () => {
    const [a, b] = await Promise.all([run(), run()]);
    assert.ok([a.status, b.status].includes('busy'));

    await models.GithubSyncRunModel.create({ trigger: 'schedule', status: 'running', startedAt: new Date(Date.now() - 3600_000) });
    const after = await run();
    assert.notEqual(after.status, 'busy');
    assert.equal(await models.GithubSyncRunModel.count({ where: { status: 'abandoned' } }), 1);
  });

  test('sync backups are pruned to the newest five', async () => {
    for (let i = 0; i < 7; i++) {
      await backup.saveBackup({ includeHistory: false, label: 'github-sync' });
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    files.set(
      'snippets/.snippycode-sync/snippets/0f0e0d0c-aaaa-bbbb-cccc-000000000002.json',
      JSON.stringify({ type: 'snippet', title: 'Another', language: 'bash', code: 'id\n' })
    );
    const result = await run();
    assert.ok(result.backup);
    assert.equal(syncBackups().length, 5);
  });
});
