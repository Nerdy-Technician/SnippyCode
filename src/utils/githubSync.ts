import { createHash, randomUUID } from 'crypto';
import { Op } from 'sequelize';
import { sequelize } from '../db';
import {
  GithubSyncItemInstance,
  GithubSyncItemModel,
  GithubSyncItemType,
  GithubSyncRunInstance,
  GithubSyncRunModel,
  RunbookModel,
  RunbookStepModel,
  SnippetModel,
  Snippet_TagModel,
  TagModel
} from '../models';
import { deleteBackup, listBackups, saveBackup } from './backup';
import { getGithubDirectory, getGithubFileText, upsertGithubFile } from './github';
import { getSetting, setSetting } from './oidcSettings';
import { Logger } from './Logger';
import { cleanStepValues, cleanVariableDefinitions } from './snippetVariables';
import { createTags } from './createTags';
import { tagParser } from './tagParser';

/**
 * Automatic two-way GitHub sync for snippets and runbooks.
 *
 * Each item is one JSON file, `<path>/.snippycode-sync/<type>s/<syncId>.json`.
 * For every item we keep the hash both sides last agreed on (the base), so a
 * run can tell local-only, remote-only and both-sides changes apart:
 * - local only: uploaded (when auto-upload is on)
 * - remote only: applied locally (when auto-download is on), after a backup
 * - both, different: a conflict. Nothing is overwritten: the remote copy is
 *   imported as a separate item flagged as a conflict (or, upload-only, the
 *   upload is skipped and the item flagged) until someone resolves it.
 * Deletes are never propagated: a local delete leaves the GitHub file alone
 * and stops syncing that item; a remote delete leaves the local item alone.
 */

const logger = new Logger('github-sync');
const LOCK_KEY = 7_311_843;
const STALE_RUN_MS = 30 * 60_000;
const MAX_BACKOFF_MS = 24 * 3600_000;
const KEEP_RUNS = 200;
const KEEP_BACKUPS = 5;
const BACKUP_LABEL = 'github-sync';
export const SYNC_INTERVALS = [15, 30, 60, 180, 360, 720, 1440];

export interface GithubSyncSettings {
  uploadEnabled: boolean;
  downloadEnabled: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  failures: number;
  nextAttemptAt: string | null;
  remoteFingerprint: string | null;
}

export const defaultSyncSettings = (): GithubSyncSettings => ({
  uploadEnabled: false,
  downloadEnabled: false,
  intervalMinutes: 60,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  failures: 0,
  nextAttemptAt: null,
  remoteFingerprint: null
});

export const getSyncSettings = async (): Promise<GithubSyncSettings> => ({
  ...defaultSyncSettings(),
  ...(await getSetting<Partial<GithubSyncSettings>>('githubSync', {}))
});

export const saveSyncSettings = (settings: GithubSyncSettings) => setSetting('githubSync', settings);

interface RepoSettings {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

export const getRepoSettings = (): Promise<RepoSettings> =>
  getSetting<RepoSettings>('github', {
    token: process.env.GITHUB_TOKEN || '',
    owner: process.env.GITHUB_REPO_OWNER || '',
    repo: process.env.GITHUB_REPO_NAME || '',
    branch: process.env.GITHUB_REPO_BRANCH || 'main',
    path: process.env.GITHUB_SNIPPETS_PATH || 'snippets'
  });

/** Where the files live; swapped for an in-memory one in tests */
export interface SyncRemote {
  list(dir: string): Promise<Array<{ name: string; path: string; sha: string }>>;
  read(path: string): Promise<string>;
  write(path: string, content: string, message: string): Promise<void>;
}

export const githubRemote = (settings: RepoSettings): SyncRemote => ({
  list: async dir => {
    try {
      const entries = await getGithubDirectory(dir, settings);
      return entries
        .filter(entry => entry.type === 'file')
        .map(entry => ({ name: entry.name, path: entry.path, sha: entry.sha || '' }));
    } catch (err) {
      if (err instanceof Error && err.message.includes('GitHub 404')) {
        return [];
      }
      throw err;
    }
  },
  read: path => getGithubFileText(path, settings),
  write: async (path, content, message) => {
    await upsertGithubFile(path, content, message, settings);
  }
});

/** Never store or show a token in an error */
export const cleanSyncError = (err: unknown, token = ''): string => {
  let message = err instanceof Error ? err.message : String(err);
  if (token) {
    message = message.split(token).join('***');
  }
  return message
    .replace(/(github_pat_|ghp_|gho_|ghs_)[A-Za-z0-9_]+/g, '$1***')
    .slice(0, 500);
};

// Canonical item content ------------------------------------------------------

type Canonical = { [key: string]: unknown };

const str = (value: unknown, max = 200_000) => String(value ?? '').slice(0, max);

export const canonicalSnippet = (raw: any): Canonical => ({
  type: 'snippet',
  title: str(raw.title, 200).trim() || 'Untitled',
  description: str(raw.description),
  language: str(raw.language, 60).trim().toLowerCase() || 'plaintext',
  code: str(raw.code),
  docs: str(raw.docs),
  collection: str(raw.collection, 200) || 'General',
  fileName: str(raw.fileName, 200),
  // Tags as plain names, sorted, so order never counts as a change
  tags: Array.from(
    new Set(
      (Array.isArray(raw.tags) ? raw.tags : [])
        .map((tag: any) => str(typeof tag === 'string' ? tag : tag?.name, 60).trim().toLowerCase())
        .filter(Boolean)
    )
  ).sort() as string[],
  variables: safeDefinitions(raw.variables)
});

/** Definitions in the sync file; anything invalid is dropped rather than failing the run */
const safeDefinitions = (input: unknown) => {
  try {
    // Raw (unquoted) is an admin decision made in SnippetCode, never imported
    return cleanVariableDefinitions(input).map(({ raw: _raw, ...def }) => def);
  } catch {
    return [];
  }
};

export const canonicalRunbook = (raw: any): Canonical => ({
  type: 'runbook',
  title: str(raw.title, 200).trim() || 'Untitled',
  description: str(raw.description, 5000),
  steps: (Array.isArray(raw.steps) ? raw.steps : []).slice(0, 100).map((step: any) => ({
    title: str(step.title, 200),
    note: str(step.note, 5000),
    snippet: step.snippet ? str(step.snippet, 40) : null,
    values: cleanStepValues(step.values)
  }))
});

export const hashCanonical = (value: Canonical): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const fileFor = (base: string, type: GithubSyncItemType, syncId: string) =>
  `${base}/.snippycode-sync/${type}s/${syncId}.json`;

const SYNC_ID = /^[a-f0-9-]{8,40}$/;

// Runs ------------------------------------------------------------------------

export interface SyncResult {
  status: 'success' | 'skipped' | 'failed' | 'busy' | 'disabled';
  uploaded: number;
  downloaded: number;
  conflicts: number;
  unchanged: number;
  backup: string | null;
  error?: string;
  runId?: number;
}

const startRun = async (trigger: 'schedule' | 'manual'): Promise<GithubSyncRunInstance | null> =>
  sequelize.transaction(async transaction => {
    const [[lock]] = (await sequelize.query('SELECT pg_try_advisory_xact_lock(:key) AS locked', {
      replacements: { key: LOCK_KEY },
      transaction
    })) as [Array<{ locked: boolean }>, unknown];

    if (!lock?.locked) {
      return null;
    }

    // A run left 'running' by a restart is abandoned after a while
    await GithubSyncRunModel.update(
      { status: 'abandoned', finishedAt: new Date() },
      { where: { status: 'running', startedAt: { [Op.lt]: new Date(Date.now() - STALE_RUN_MS) } }, transaction }
    );

    if (await GithubSyncRunModel.count({ where: { status: 'running' }, transaction })) {
      return null;
    }

    return GithubSyncRunModel.create({ trigger, startedAt: new Date() }, { transaction });
  });

const pruneRuns = async () => {
  const keep = await GithubSyncRunModel.findAll({
    attributes: ['id'],
    order: [['id', 'DESC']],
    offset: KEEP_RUNS - 1,
    limit: 1
  });
  if (keep[0]) {
    await GithubSyncRunModel.destroy({ where: { id: { [Op.lt]: keep[0].id } } });
  }
};

const pruneSyncBackups = async () => {
  const ours = listBackups().filter(item => item.name.includes(`-${BACKUP_LABEL}`));
  for (const old of ours.slice(KEEP_BACKUPS)) {
    await deleteBackup(old.name);
  }
};

interface LocalItem {
  id: number;
  canonical: Canonical;
  hash: string;
}

interface Plan {
  type: GithubSyncItemType;
  syncId: string;
  state: GithubSyncItemInstance | null;
  local: LocalItem | null;
  remote: { path: string; sha: string; canonical?: Canonical; hash?: string } | null;
  action: 'unchanged' | 'upload' | 'download' | 'import' | 'conflict' | 'flag' | 'agree' | 'deleted_local' | 'remote_missing' | 'skip';
}

const loadStates = async () => GithubSyncItemModel.findAll();

const localSnippets = async (): Promise<Map<number, LocalItem>> => {
  const rows = await SnippetModel.findAll({
    include: { model: TagModel, as: 'tags', attributes: ['name'], through: { attributes: [] } }
  });
  return new Map(
    rows.map(row => {
      const canonical = canonicalSnippet(row.get({ plain: true }));
      return [row.id, { id: row.id, canonical, hash: hashCanonical(canonical) }];
    })
  );
};

const localRunbooks = async (snippetSyncIds: Map<number, string>): Promise<Map<number, LocalItem>> => {
  const [rows, steps] = await Promise.all([
    RunbookModel.findAll(),
    RunbookStepModel.findAll({ order: [['position', 'ASC']] })
  ]);
  return new Map(
    rows.map(row => {
      const canonical = canonicalRunbook({
        title: row.title,
        description: row.description,
        steps: steps
          .filter(step => step.runbookId === row.id)
          .map(step => ({
            title: step.title,
            note: step.note,
            snippet: step.snippetId ? snippetSyncIds.get(step.snippetId) || null : null,
            values: step.values
          }))
      });
      return [row.id, { id: row.id, canonical, hash: hashCanonical(canonical) }];
    })
  );
};

const applySnippet = async (canonical: Canonical, itemId: number | null, titleSuffix = ''): Promise<number> => {
  const fields = {
    title: `${canonical.title}${titleSuffix}`.slice(0, 200),
    description: String(canonical.description),
    language: String(canonical.language),
    code: String(canonical.code),
    docs: String(canonical.docs),
    collection: String(canonical.collection),
    fileName: String(canonical.fileName),
    variables: JSON.stringify(canonical.variables || []) as any
  };
  let id = itemId;
  if (id) {
    await SnippetModel.update(fields, { where: { id } });
  } else {
    id = (await SnippetModel.create({ ...fields, isPinned: 0 })).id;
  }
  const tags = Array.isArray(canonical.tags) ? (canonical.tags as string[]) : [];
  await Snippet_TagModel.destroy({ where: { snippet_id: id } });
  // Apply the synced tags exactly: adding the language as an extra tag made
  // the local copy differ from the file, so the next run saw a change again
  if (tags.length) {
    await createTags(tagParser(tags), id);
  }
  return id;
};

const applyRunbook = async (
  canonical: Canonical,
  itemId: number | null,
  snippetIds: Map<string, number>,
  titleSuffix = ''
): Promise<number> => {
  const title = `${canonical.title}${titleSuffix}`.slice(0, 200);
  const steps = canonical.steps as Array<{ title: string; note: string; snippet: string | null }>;

  return sequelize.transaction(async transaction => {
    let id = itemId;
    if (id) {
      await RunbookModel.update({ title, description: String(canonical.description) }, { where: { id }, transaction });
    } else {
      id = (await RunbookModel.create({ title, description: String(canonical.description) }, { transaction })).id;
    }
    // Runs in progress keep their own copy of step states
    await RunbookStepModel.destroy({ where: { runbookId: id }, transaction });
    for (const [position, step] of steps.entries()) {
      await RunbookStepModel.create(
        {
          runbookId: id,
          position,
          snippetId: step.snippet ? snippetIds.get(step.snippet) || null : null,
          title: step.title || (step.snippet ? '' : 'Step'),
          note: step.note,
          values: JSON.stringify((step as any).values || {}) as any
        },
        { transaction }
      );
    }
    return id;
  });
};

/**
 * One sync run. Safe to call at any time: concurrent calls return 'busy'.
 */
export const runGithubSync = async (
  options: {
    trigger?: 'schedule' | 'manual';
    remote?: SyncRemote;
    now?: Date;
    /** Manual Upload/Download buttons run one direction only */
    direction?: 'both' | 'upload' | 'download';
  } = {}
): Promise<SyncResult> => {
  const now = options.now || new Date();
  const settings = await getSyncSettings();
  const empty = { uploaded: 0, downloaded: 0, conflicts: 0, unchanged: 0, backup: null };

  if (!settings.uploadEnabled && !settings.downloadEnabled && options.trigger !== 'manual') {
    return { status: 'disabled', ...empty };
  }

  const run = await startRun(options.trigger || 'schedule');

  if (!run) {
    return { status: 'busy', ...empty };
  }

  const repo = await getRepoSettings();
  const direction = options.direction || 'both';
  const upload = (settings.uploadEnabled || options.trigger === 'manual') && direction !== 'download';
  const download = (settings.downloadEnabled || options.trigger === 'manual') && direction !== 'upload';
  const result: SyncResult = { status: 'success', ...empty, runId: run.id };

  try {
    if (!options.remote && (!repo.token || !repo.owner || !repo.repo)) {
      throw new Error('GitHub repo is not configured');
    }

    const remote = options.remote || githubRemote(repo);
    const base = (repo.path || 'snippets').replace(/\/+$/, '');
    const states = await loadStates();
    const stateFor = (type: GithubSyncItemType) => states.filter(state => state.itemType === type);

    // Conflict copies are local scratch items, never synced themselves
    const conflictCopies = (type: GithubSyncItemType) =>
      new Set(stateFor(type).map(state => state.conflictItemId).filter(Boolean) as number[]);

    // Give every local item a stable sync id
    const snippets = await localSnippets();
    for (const id of snippets.keys()) {
      if (!conflictCopies('snippet').has(id) && !stateFor('snippet').some(state => state.itemId === id)) {
        states.push(await GithubSyncItemModel.create({ itemType: 'snippet', itemId: id, syncId: randomUUID(), baseHash: null }));
      }
    }
    const snippetSyncIds = new Map(
      stateFor('snippet').filter(state => state.itemId).map(state => [state.itemId!, state.syncId])
    );
    const runbooks = await localRunbooks(snippetSyncIds);
    for (const id of runbooks.keys()) {
      if (!conflictCopies('runbook').has(id) && !stateFor('runbook').some(state => state.itemId === id)) {
        states.push(await GithubSyncItemModel.create({ itemType: 'runbook', itemId: id, syncId: randomUUID(), baseHash: null }));
      }
    }
    const locals = { snippet: snippets, runbook: runbooks };

    const localChanged = states.some(state => {
      if (state.status === 'conflict' || state.status === 'deleted_local') return false;
      const local = state.itemId ? locals[state.itemType].get(state.itemId) : null;
      return !local ? Boolean(state.itemId) : local.hash !== state.baseHash;
    });

    const openConflicts = states.filter(state => state.status === 'conflict').length;

    // Upload-only with nothing changed locally: no need to ask GitHub
    if (!download && !localChanged) {
      result.status = 'skipped';
      result.conflicts = openConflicts;
      return result;
    }

    // Always look before writing, so an upload never overwrites a remote edit
    const listing = {
      snippet: await remote.list(`${base}/.snippycode-sync/snippets`),
      runbook: await remote.list(`${base}/.snippycode-sync/runbooks`)
    };
    const fingerprint = createHash('sha256')
      .update(
        [...listing.snippet, ...listing.runbook]
          .map(file => `${file.path}:${file.sha}`)
          .sort()
          .join('\n')
      )
      .digest('hex');

    if (!localChanged && fingerprint === settings.remoteFingerprint) {
      result.status = 'skipped';
      result.conflicts = openConflicts;
      return result;
    }

    const plans: Plan[] = [];

    for (const type of ['snippet', 'runbook'] as GithubSyncItemType[]) {
      const remoteFiles = new Map(
        listing[type]
          .filter(file => file.name.endsWith('.json') && SYNC_ID.test(file.name.slice(0, -5)))
          .map(file => [file.name.slice(0, -5), file])
      );
      const syncIds = new Set([...stateFor(type).map(state => state.syncId), ...remoteFiles.keys()]);

      for (const syncId of syncIds) {
        const state = stateFor(type).find(item => item.syncId === syncId) || null;
        const file = remoteFiles.get(syncId) || null;
        const local = state?.itemId ? locals[type].get(state.itemId) || null : null;
        const plan: Plan = { type, syncId, state, local, remote: file ? { path: file.path, sha: file.sha } : null, action: 'skip' };

        if (state?.status === 'conflict') {
          result.conflicts += 1;
          continue;
        }
        if (state?.status === 'deleted_local') {
          continue;
        }
        if (state && state.itemId && !local) {
          plan.action = 'deleted_local';
          plans.push(plan);
          continue;
        }

        // Only fetch remote content when it may have changed
        if (plan.remote) {
          if (state && state.remoteSha && state.remoteSha === plan.remote.sha && state.baseHash) {
            plan.remote.hash = state.baseHash;
          } else {
            const parsed = JSON.parse(await remote.read(plan.remote.path));
            plan.remote.canonical = type === 'snippet' ? canonicalSnippet(parsed) : canonicalRunbook(parsed);
            plan.remote.hash = hashCanonical(plan.remote.canonical);
          }
        }

        const baseHash = state?.baseHash || null;

        if (!local) {
          // Remote-only item we have never seen
          plan.action = plan.remote && download ? 'import' : 'skip';
        } else if (!plan.remote) {
          const changed = local.hash !== baseHash;
          if (baseHash && !changed) {
            plan.action = 'remote_missing';
          } else {
            plan.action = upload ? 'upload' : 'skip';
          }
        } else {
          const localChange = local.hash !== baseHash;
          const remoteChange = plan.remote.hash !== baseHash;
          if (local.hash === plan.remote.hash) {
            plan.action = baseHash === local.hash && state?.remoteSha === plan.remote.sha ? 'unchanged' : 'agree';
          } else if (localChange && !remoteChange) {
            plan.action = upload ? 'upload' : 'skip';
          } else if (!localChange && remoteChange) {
            plan.action = download ? 'download' : 'skip';
          } else {
            plan.action = download ? 'conflict' : 'flag';
          }
        }
        plans.push(plan);
      }
    }

    // Back up before anything changes local data
    if (plans.some(plan => ['download', 'import', 'conflict'].includes(plan.action))) {
      const saved = await saveBackup({ includeHistory: false, label: BACKUP_LABEL });
      result.backup = saved.name;
      await pruneSyncBackups();
    }

    const snippetIds = () =>
      new Map(
        states.filter(state => state.itemType === 'snippet' && state.itemId).map(state => [state.syncId, state.itemId!])
      );

    for (const plan of plans) {
      const state = plan.state;
      const canonical = () => plan.remote!.canonical!;
      const apply = (item: Canonical, id: number | null, suffix = '') =>
        plan.type === 'snippet' ? applySnippet(item, id, suffix) : applyRunbook(item, id, snippetIds(), suffix);
      const ensureCanonical = async () => {
        if (!plan.remote!.canonical) {
          const parsed = JSON.parse(await remote.read(plan.remote!.path));
          plan.remote!.canonical = plan.type === 'snippet' ? canonicalSnippet(parsed) : canonicalRunbook(parsed);
        }
      };

      switch (plan.action) {
        case 'unchanged':
          result.unchanged += 1;
          break;
        case 'agree':
          await state!.update({ baseHash: plan.local!.hash, remoteSha: plan.remote!.sha, status: 'synced' });
          result.unchanged += 1;
          break;
        case 'upload':
          await remote.write(
            fileFor(base, plan.type, plan.syncId),
            `${JSON.stringify({ ...plan.local!.canonical, syncId: plan.syncId }, null, 2)}\n`,
            `SnippyCode sync: ${plan.type} ${String(plan.local!.canonical.title).slice(0, 60)}`
          );
          await state!.update({ baseHash: plan.local!.hash, remoteSha: null, status: 'synced' });
          result.uploaded += 1;
          break;
        case 'download': {
          await ensureCanonical();
          await apply(canonical(), state!.itemId);
          await state!.update({ baseHash: plan.remote!.hash!, remoteSha: plan.remote!.sha, status: 'synced' });
          result.downloaded += 1;
          break;
        }
        case 'import': {
          await ensureCanonical();
          const id = await apply(canonical(), null);
          const created = await GithubSyncItemModel.create({
            itemType: plan.type,
            itemId: id,
            syncId: plan.syncId,
            baseHash: plan.remote!.hash!,
            remoteSha: plan.remote!.sha
          });
          states.push(created);
          result.downloaded += 1;
          break;
        }
        case 'conflict': {
          await ensureCanonical();
          const copyId = await apply(canonical(), null, ' (GitHub conflict)');
          await state!.update({
            status: 'conflict',
            conflictItemId: copyId,
            conflictRemoteHash: plan.remote!.hash!,
            remoteSha: plan.remote!.sha,
            conflictAt: now
          });
          result.conflicts += 1;
          break;
        }
        case 'flag':
          await state!.update({
            status: 'conflict',
            conflictItemId: null,
            conflictRemoteHash: plan.remote!.hash!,
            remoteSha: plan.remote!.sha,
            conflictAt: now
          });
          result.conflicts += 1;
          break;
        case 'deleted_local':
          await state!.update({ status: 'deleted_local', itemId: null });
          break;
        case 'remote_missing':
          if (state!.status !== 'remote_missing') {
            await state!.update({ status: 'remote_missing' });
          }
          result.unchanged += 1;
          break;
        default:
          break;
      }
    }

    // What GitHub looks like now that we have written to it
    settings.remoteFingerprint = result.uploaded ? null : fingerprint;
    return result;
  } catch (err) {
    result.status = 'failed';
    result.error = cleanSyncError(err, repo.token);
    logger.log(`GitHub sync failed: ${result.error}`, 'WARN');
    return result;
  } finally {
    const fresh = await getSyncSettings();
    const failed = result.status === 'failed';
    const failures = failed ? fresh.failures + 1 : 0;
    const intervalMs = Math.max(fresh.intervalMinutes, 15) * 60_000;
    const delay = failed ? Math.min(intervalMs * 2 ** Math.min(failures - 1, 10), MAX_BACKOFF_MS) : intervalMs;

    await saveSyncSettings({
      ...fresh,
      remoteFingerprint: failed ? fresh.remoteFingerprint : settings.remoteFingerprint ?? fresh.remoteFingerprint,
      lastRunAt: now.toISOString(),
      lastStatus: result.status,
      lastError: result.error || null,
      failures,
      nextAttemptAt: new Date(now.getTime() + delay).toISOString()
    });
    await run.update({
      status: result.status as GithubSyncRunInstance['status'],
      uploaded: result.uploaded,
      downloaded: result.downloaded,
      conflicts: result.conflicts,
      unchanged: result.unchanged,
      backup: result.backup,
      error: result.error || null,
      finishedAt: new Date()
    });
    await pruneRuns();
  }
};

/** Joins the existing 30-second scheduler tick */
export const githubSyncTick = async (now: Date): Promise<void> => {
  const settings = await getSyncSettings();

  if (!settings.uploadEnabled && !settings.downloadEnabled) {
    return;
  }

  if (settings.nextAttemptAt && now.getTime() < new Date(settings.nextAttemptAt).getTime()) {
    return;
  }

  // Run in the background so the scheduler tick is not held up by GitHub
  runGithubSync({ trigger: 'schedule', now }).catch(err =>
    logger.log(`GitHub sync crashed: ${cleanSyncError(err)}`, 'ERROR')
  );
};

/**
 * Resolve a conflict:
 * - local: keep the local item; the next run uploads it over the GitHub copy
 * - remote: replace the local item with the GitHub copy
 * - both: keep both; the conflict copy becomes a separate item that syncs as new
 */
export const resolveGithubConflict = async (
  stateId: number,
  keep: 'local' | 'remote' | 'both'
): Promise<GithubSyncItemInstance> => {
  const state = await GithubSyncItemModel.findByPk(stateId);

  if (!state || state.status !== 'conflict') {
    throw new Error('Conflict was not found');
  }

  const destroyItem = (id: number) =>
    state.itemType === 'snippet'
      ? SnippetModel.destroy({ where: { id } })
      : RunbookModel.destroy({ where: { id } });
  const copyId = state.conflictItemId;

  if (keep === 'remote') {
    if (!copyId) {
      throw new Error('The GitHub copy has not been downloaded. Turn on auto-download or keep the local copy.');
    }
    if (state.itemType === 'snippet') {
      const copy = await SnippetModel.findByPk(copyId);
      if (!copy) throw new Error('The GitHub copy was deleted');
      const canonical = canonicalSnippet(copy.get({ plain: true }));
      canonical.title = String(canonical.title).replace(/ \(GitHub conflict\)$/, '');
      await applySnippet(canonical, state.itemId);
    } else {
      const copy = await RunbookModel.findByPk(copyId);
      if (!copy) throw new Error('The GitHub copy was deleted');
      await sequelize.transaction(async transaction => {
        await RunbookModel.update(
          { title: copy.title.replace(/ \(GitHub conflict\)$/, ''), description: copy.description },
          { where: { id: state.itemId! }, transaction }
        );
        await RunbookStepModel.destroy({ where: { runbookId: state.itemId! }, transaction });
        await RunbookStepModel.update({ runbookId: state.itemId! }, { where: { runbookId: copyId }, transaction });
      });
    }
    await destroyItem(copyId);
  } else if (keep === 'local' && copyId) {
    await destroyItem(copyId);
  }

  // 'both' leaves the copy as an ordinary item; it gets its own sync id next run.
  // The base becomes the GitHub version, so a kept local copy counts as a local
  // change and is uploaded, while a taken GitHub copy is simply in sync.
  await state.update({
    status: 'synced',
    baseHash: state.conflictRemoteHash,
    conflictItemId: null,
    conflictRemoteHash: null,
    conflictAt: null
  });

  if (keep === 'remote') {
    // The local item now matches GitHub exactly
    const snippets = await localSnippets();
    const fresh =
      state.itemType === 'snippet'
        ? snippets
        : await localRunbooks(
            new Map(
              (await GithubSyncItemModel.findAll({ where: { itemType: 'snippet', itemId: { [Op.ne]: null } } })).map(
                item => [item.itemId!, item.syncId]
              )
            )
          );
    if (state.itemId && fresh.get(state.itemId)) {
      await state.update({ baseHash: fresh.get(state.itemId)!.hash });
    }
  }

  // Force the next run to look at GitHub again
  const settings = await getSyncSettings();
  await saveSyncSettings({ ...settings, remoteFingerprint: null, nextAttemptAt: null });

  return state;
};

export const listGithubConflicts = async () => {
  const states = await GithubSyncItemModel.findAll({ where: { status: 'conflict' }, order: [['conflictAt', 'DESC']] });
  const titles = async (type: GithubSyncItemType, ids: number[]): Promise<Array<{ id: number; title: string }>> =>
    ids.length
      ? type === 'snippet'
        ? SnippetModel.findAll({ where: { id: ids }, attributes: ['id', 'title'] })
        : RunbookModel.findAll({ where: { id: ids }, attributes: ['id', 'title'] })
      : [];
  const ids = (type: GithubSyncItemType) =>
    states
      .filter(state => state.itemType === type)
      .flatMap(state => [state.itemId, state.conflictItemId])
      .filter(Boolean) as number[];
  const [snippets, runbooks] = await Promise.all([titles('snippet', ids('snippet')), titles('runbook', ids('runbook'))]);
  const title = (type: GithubSyncItemType, id: number | null) =>
    id ? (type === 'snippet' ? snippets : runbooks).find(item => item.id === id)?.title || null : null;

  return states.map(state => ({
    id: state.id,
    itemType: state.itemType,
    itemId: state.itemId,
    title: title(state.itemType, state.itemId),
    conflictItemId: state.conflictItemId,
    conflictTitle: title(state.itemType, state.conflictItemId),
    syncId: state.syncId,
    conflictAt: state.conflictAt
  }));
};
