/**
 * Full backups of SnippyCode's data, and restoring them.
 *
 * A backup is one JSON file: an envelope around gzipped table data (plus
 * avatar images). With a passphrase the data is encrypted (AES-256-GCM, key
 * from scrypt) and secret variables are stored in plain text inside that
 * encryption, so the backup restores on any server. Without a passphrase
 * secrets stay encrypted with this server's key and only restore where
 * VARIABLES_SECRET_KEY (or SESSION_SECRET) is the same.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { readFile, rm, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../db';
import { SettingModel } from '../models';
import { decryptSecret, encryptSecret, isBoundSecret, isEncryptedSecret } from './secretBox';
import { emitEvent } from './notify';
import { Logger } from './Logger';

const logger = new Logger('backup');

export const BACKUP_FORMAT = 'snippycode-backup';
const BACKUP_VERSION = 1;

/** Insert order; parents before children. */
const CORE_TABLES = [
  'users',
  'settings',
  'tags',
  'snippets',
  'snippets_tags',
  'snippet_versions',
  'snippet_stats',
  'user_snippets',
  'sites',
  'site_members',
  'variables',
  'runbooks',
  'runbook_steps',
  'devices',
  'webhooks',
  'schedules'
];

const HISTORY_TABLES = [
  'schedule_runs',
  'runbook_runs',
  'snippet_runs',
  'runbook_run_steps',
  'webhook_deliveries',
  'audit_logs'
];

/** Short-lived rows that are cleared on restore rather than kept. */
const TRANSIENT_TABLES = ['agent_jobs', 'device_enrollments', 'tasks'];

export const backupDir = (): string => {
  const dir = process.env.BACKUP_DIR || join(process.cwd(), 'data/backups');
  mkdirSync(dir, { recursive: true });
  return dir;
};

const avatarDir = (): string => join(process.cwd(), 'data/uploads/avatars');

interface BackupPayload {
  meta: {
    createdAt: string;
    appVersion: string;
    migration: string;
    secretsPortable: boolean;
    includesHistory: boolean;
    counts: { [table: string]: number };
  };
  tables: { [table: string]: Record<string, unknown>[] };
  files: { [path: string]: string };
}

interface Envelope {
  format: string;
  version: number;
  createdAt: string;
  encrypted: boolean;
  kdf?: { name: 'scrypt'; salt: string; N: number; r: number; p: number };
  iv?: string;
  tag?: string;
  data: string;
}

const existingTables = async (): Promise<Set<string>> => {
  const tables = (await sequelize.getQueryInterface().showAllTables()) as Array<string | { tableName: string }>;
  return new Set(tables.map(table => (typeof table === 'string' ? table : table.tableName)));
};

export const latestMigration = async (): Promise<string> => {
  const rows = await sequelize.query<{ name: string }>(
    `SELECT name FROM "SequelizeMeta" ORDER BY name DESC LIMIT 1`,
    { type: QueryTypes.SELECT }
  );
  return rows[0]?.name || '';
};

const migrationNumber = (name: string): number => Number((name.match(/^(\d+)/) || [])[1] || -1);

// Values encrypted with this server's key, by table
const SERVER_ENCRYPTED: { [table: string]: (row: Record<string, unknown>) => string[] } = {
  variables: row => (row.isSecret ? ['value'] : []),
  webhooks: () => ['url', 'signingSecret']
};

const convertSecrets = (
  tables: BackupPayload['tables'],
  convert: (value: string, aad?: string) => string
): void => {
  Object.entries(SERVER_ENCRYPTED).forEach(([table, fieldsFor]) => {
    (tables[table] || []).forEach(row => {
      fieldsFor(row).forEach(field => {
        const value = row[field];

        if (typeof value === 'string' && value !== '') {
          // Saved variables are bound to their row (see variableAad)
          row[field] = convert(value, table === 'variables' ? `variables:${row.id}:value` : undefined);
        }
      });
    });
  });
};

const keyFrom = (passphrase: string, salt: Buffer, N: number, r: number, p: number): Buffer =>
  scryptSync(passphrase, salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 });

export const createBackupData = async (
  options: { passphrase?: string; includeHistory?: boolean } = {}
): Promise<{ json: string; meta: BackupPayload['meta'] }> => {
  const includeHistory = options.includeHistory !== false;
  const available = await existingTables();
  const tables: BackupPayload['tables'] = {};
  const counts: { [table: string]: number } = {};

  for (const table of [...CORE_TABLES, ...(includeHistory ? HISTORY_TABLES : [])]) {
    if (!available.has(table)) {
      continue;
    }

    tables[table] = await sequelize.query(`SELECT * FROM "${table}"`, { type: QueryTypes.SELECT });
    counts[table] = tables[table].length;
  }

  // Avatar images, keyed by file name
  const files: BackupPayload['files'] = {};
  for (const user of tables.users || []) {
    const path = typeof user.avatarPath === 'string' ? user.avatarPath : '';
    const file = path ? join(avatarDir(), basename(path)) : '';

    if (file && existsSync(file)) {
      files[`avatars/${basename(path)}`] = (await readFile(file)).toString('base64');
    }
  }

  const passphrase = options.passphrase || '';

  if (passphrase) {
    // Inside the passphrase encryption, secrets travel in plain text
    convertSecrets(tables, (value, aad) =>
      isEncryptedSecret(value) ? decryptSecret(value, isBoundSecret(value) ? aad : undefined) : value
    );
  }

  const meta: BackupPayload['meta'] = {
    createdAt: new Date().toISOString(),
    appVersion: process.env.npm_package_version || '',
    migration: await latestMigration(),
    secretsPortable: Boolean(passphrase),
    includesHistory: includeHistory,
    counts
  };
  const packed = gzipSync(Buffer.from(JSON.stringify({ meta, tables, files })));
  const envelope: Envelope = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: meta.createdAt,
    encrypted: Boolean(passphrase),
    data: ''
  };

  if (passphrase) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const [N, r, p] = [2 ** 15, 8, 1];
    const cipher = createCipheriv('aes-256-gcm', keyFrom(passphrase, salt, N, r, p), iv);
    const body = Buffer.concat([cipher.update(packed), cipher.final()]);

    envelope.kdf = { name: 'scrypt', salt: salt.toString('base64'), N, r, p };
    envelope.iv = iv.toString('base64');
    envelope.tag = cipher.getAuthTag().toString('base64');
    envelope.data = body.toString('base64');
  } else {
    envelope.data = packed.toString('base64');
  }

  return { json: JSON.stringify(envelope), meta };
};

export const readBackupData = (raw: string | Buffer, passphrase = ''): BackupPayload => {
  let envelope: Envelope;

  try {
    envelope = JSON.parse(raw.toString());
  } catch {
    throw new Error('This is not a SnippyCode backup file');
  }

  if (envelope.format !== BACKUP_FORMAT) {
    throw new Error('This is not a SnippyCode backup file');
  }

  if (envelope.version > BACKUP_VERSION) {
    throw new Error('This backup was made by a newer SnippyCode. Upgrade first.');
  }

  let packed = Buffer.from(envelope.data, 'base64');

  if (envelope.encrypted) {
    if (!passphrase) {
      throw new Error('This backup is encrypted. Enter its passphrase.');
    }

    const kdf = envelope.kdf!;

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        keyFrom(passphrase, Buffer.from(kdf.salt, 'base64'), kdf.N, kdf.r, kdf.p),
        Buffer.from(envelope.iv!, 'base64')
      );
      decipher.setAuthTag(Buffer.from(envelope.tag!, 'base64'));
      packed = Buffer.concat([decipher.update(packed), decipher.final()]);
    } catch {
      throw new Error('Wrong passphrase, or the backup file is damaged');
    }
  }

  return JSON.parse(gunzipSync(packed).toString('utf8'));
};

const columnsOf = async (table: string): Promise<Set<string>> =>
  new Set(Object.keys(await sequelize.getQueryInterface().describeTable(table)));

/**
 * Replace everything with the backup's contents, in one transaction. A safety
 * backup of the current data is written first.
 */
export const restoreBackupData = async (
  raw: string | Buffer,
  passphrase = ''
): Promise<{ meta: BackupPayload['meta']; safetyBackup: string; restored: { [table: string]: number } }> => {
  const payload = readBackupData(raw, passphrase);
  const current = await latestMigration();

  if (migrationNumber(payload.meta.migration) > migrationNumber(current)) {
    throw new Error(
      `This backup is from a newer database (${payload.meta.migration}). Upgrade SnippyCode first.`
    );
  }

  const safety = await saveBackup({ includeHistory: true, label: 'before-restore' });
  const available = await existingTables();
  const order = [...CORE_TABLES, ...HISTORY_TABLES].filter(table => available.has(table));
  const restored: { [table: string]: number } = {};

  if (payload.meta.secretsPortable) {
    convertSecrets(payload.tables, (value, aad) => (isEncryptedSecret(value) ? value : encryptSecret(value, aad)));
  }

  // Point avatars at this server's avatar folder
  (payload.tables.users || []).forEach(user => {
    if (typeof user.avatarPath === 'string' && user.avatarPath) {
      user.avatarPath = join(avatarDir(), basename(user.avatarPath));
    }
  });

  await sequelize.transaction(async transaction => {
    const clear = [...TRANSIENT_TABLES.filter(table => available.has(table)), ...order.slice().reverse()];

    for (const table of clear) {
      await sequelize.query(`DELETE FROM "${table}"`, { transaction });
    }

    for (const table of order) {
      const rows = payload.tables[table] || [];

      if (!rows.length) {
        continue;
      }

      // Older backups may lack newer columns (defaults apply); unknown ones are dropped
      const columns = await columnsOf(table);
      const cleaned = rows.map(row =>
        Object.fromEntries(Object.entries(row).filter(([column]) => columns.has(column)))
      );

      for (let i = 0; i < cleaned.length; i += 500) {
        await sequelize.getQueryInterface().bulkInsert(table, cleaned.slice(i, i + 500), { transaction });
      }

      restored[table] = rows.length;

      if (columns.has('id')) {
        await sequelize.query(
          `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM "${table}"`,
          { transaction }
        );
      }
    }
  });

  mkdirSync(avatarDir(), { recursive: true });
  for (const [path, data] of Object.entries(payload.files || {})) {
    if (path.startsWith('avatars/')) {
      await writeFile(join(avatarDir(), basename(path)), Buffer.from(data, 'base64'));
    }
  }

  return { meta: payload.meta, safetyBackup: safety.name, restored };
};

// Stored backups ------------------------------------------------------------

export interface StoredBackup {
  name: string;
  size: number;
  createdAt: string;
  encrypted: boolean;
}

const SAFE_NAME = /^snippycode-[\w.-]+\.json$/;

export const backupPath = (name: string): string => {
  if (!SAFE_NAME.test(name)) {
    throw new Error('Unknown backup');
  }

  const path = join(backupDir(), name);

  if (!existsSync(path)) {
    throw new Error('Unknown backup');
  }

  return path;
};

export const listBackups = (): StoredBackup[] =>
  readdirSync(backupDir())
    .filter(name => SAFE_NAME.test(name))
    .map(name => {
      const stat = statSync(join(backupDir(), name));
      return {
        name,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
        encrypted: name.includes('.enc.')
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export const saveBackup = async (
  options: { passphrase?: string; includeHistory?: boolean; label?: string } = {}
): Promise<StoredBackup> => {
  const { json } = await createBackupData(options);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = options.label ? `-${options.label.replace(/[^\w-]/g, '')}` : '';
  const name = `snippycode-${stamp}${label}${options.passphrase ? '.enc' : ''}.json`;
  const path = join(backupDir(), name);

  await writeFile(path, json, { mode: 0o600 });

  return { name, size: Buffer.byteLength(json), createdAt: new Date().toISOString(), encrypted: Boolean(options.passphrase) };
};

export const deleteBackup = async (name: string): Promise<void> => {
  await rm(backupPath(name));
};

// Automatic backups ----------------------------------------------------------

export interface BackupSchedule {
  enabled: boolean;
  everyHours: number;
  keep: number;
  includeHistory: boolean;
  /** Stored encrypted with the server key */
  passphrase: string;
  lastBackupAt: string | null;
  lastError: string | null;
}

const SETTINGS_KEY = 'backupSchedule';

export const getBackupSchedule = async (): Promise<BackupSchedule> => {
  const row = await SettingModel.findByPk(SETTINGS_KEY);
  const defaults: BackupSchedule = {
    enabled: false,
    everyHours: 24,
    keep: 14,
    includeHistory: true,
    passphrase: '',
    lastBackupAt: null,
    lastError: null
  };

  try {
    return { ...defaults, ...(row ? JSON.parse(row.value) : {}) };
  } catch {
    return defaults;
  }
};

export const saveBackupSchedule = async (schedule: BackupSchedule): Promise<void> => {
  await SettingModel.upsert({ key: SETTINGS_KEY, value: JSON.stringify(schedule) });
};

/**
 * Called from the scheduler tick: take a backup when one is due, then prune
 * old automatic backups.
 */
export const runAutomaticBackup = async (now = new Date(), force = false): Promise<StoredBackup | null> => {
  const schedule = await getBackupSchedule();

  if (!schedule.enabled && !force) {
    return null;
  }

  const due =
    force ||
    !schedule.lastBackupAt ||
    now.getTime() - new Date(schedule.lastBackupAt).getTime() >= schedule.everyHours * 3600_000;

  if (!due) {
    return null;
  }

  try {
    const passphrase = schedule.passphrase ? decryptSecret(schedule.passphrase) : '';
    const saved = await saveBackup({ passphrase, includeHistory: schedule.includeHistory, label: 'auto' });
    const autos = listBackups().filter(item => item.name.includes('-auto'));

    for (const old of autos.slice(Math.max(schedule.keep, 1))) {
      await deleteBackup(old.name);
    }

    await saveBackupSchedule({ ...schedule, lastBackupAt: now.toISOString(), lastError: null });
    emitEvent({
      event: 'backup.completed',
      severity: 'success',
      title: 'Automatic backup finished',
      text: `${saved.name} (${Math.round(saved.size / 1024)} KB)`,
      path: '/admin',
      data: { name: saved.name, size: saved.size }
    });

    return saved;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.log(`Automatic backup failed: ${message}`, 'ERROR');
    await saveBackupSchedule({ ...schedule, lastBackupAt: now.toISOString(), lastError: message });
    emitEvent({
      event: 'backup.failed',
      severity: 'error',
      title: 'Automatic backup failed',
      text: message,
      path: '/admin',
      data: {}
    });

    return null;
  }
};
