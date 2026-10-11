#!/usr/bin/env node
/**
 * Back up and restore SnippyCode from the command line, e.g. when the web UI
 * is down. Uses DATABASE_URL like the server.
 *
 *   node build/backupCli.js create [--out FILE] [--no-history]
 *   node build/backupCli.js list
 *   node build/backupCli.js restore FILE --yes
 *
 * Set BACKUP_PASSPHRASE to encrypt (create) or decrypt (restore).
 * In Docker: docker compose exec snippycode node build/backupCli.js create
 */
import dotenv from 'dotenv';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

dotenv.config();

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const main = async () => {
  const command = args[0];

  if (!command || command === 'help' || flag('--help')) {
    console.log(
      'Usage:\n  backupCli create [--out FILE] [--no-history]\n  backupCli list\n  backupCli restore FILE --yes\n\nBACKUP_PASSPHRASE encrypts or decrypts.'
    );
    return;
  }

  // Same load order as the server
  const utils = await import('./utils');
  const db = await import('./db');
  await db.connectDB();
  const { associateModels } = await import('./db/associateModels');
  await associateModels();

  const passphrase = process.env.BACKUP_PASSPHRASE || '';

  if (command === 'create') {
    const out = option('--out');

    if (out) {
      const { json } = await utils.createBackupData({ passphrase, includeHistory: !flag('--no-history') });
      await writeFile(out, json, { mode: 0o600 });
      console.log(`Wrote ${out}${passphrase ? ' (encrypted)' : ''}`);
    } else {
      const saved = await utils.saveBackup({ passphrase, includeHistory: !flag('--no-history'), label: 'cli' });
      console.log(`Saved ${join(utils.backupDir(), saved.name)} (${Math.round(saved.size / 1024)} KB)`);
    }
  } else if (command === 'list') {
    utils.listBackups().forEach(item =>
      console.log(`${item.createdAt}\t${Math.round(item.size / 1024)} KB\t${item.encrypted ? 'encrypted' : 'plain'}\t${item.name}`)
    );
  } else if (command === 'restore') {
    const file = args[1];

    if (!file || !existsSync(file)) {
      fail('Usage: backupCli restore FILE --yes');
    }

    if (!flag('--yes')) {
      fail('Restoring replaces ALL data. Add --yes to confirm.');
    }

    const result = await utils.restoreBackupData(await readFile(file!), passphrase);
    console.log(`Restored backup from ${result.meta.createdAt}`);
    console.log(`Safety backup of the previous data: ${result.safetyBackup}`);
    Object.entries(result.restored).forEach(([table, count]) => console.log(`  ${table}: ${count}`));
  } else {
    fail(`Unknown command ${command}`);
  }

  await db.sequelize.close();
};

main().catch(err => fail(err instanceof Error ? err.message : String(err)));
