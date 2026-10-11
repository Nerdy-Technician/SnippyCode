#!/usr/bin/env node
// Runs every compiled server test. Node 20's `node --test` does not expand
// globs, so the files are listed here and passed explicitly (works on 20+).
// Set TEST_COVERAGE=1 to also write coverage/lcov.info.
'use strict';
const { readdirSync, statSync, mkdirSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const root = join(__dirname, '..', '.test-build', 'test');
const walk = dir =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : name.endsWith('.test.js') ? [path] : [];
  });

// The database-backed suites skip themselves without TEST_DATABASE_URL, so a
// CI run without it would look green while testing almost nothing
if (process.env.CI && !/test/i.test(process.env.TEST_DATABASE_URL || '')) {
  console.error('CI needs TEST_DATABASE_URL pointing at a throwaway database whose name contains "test".');
  process.exit(1);
}

const files = (process.argv.length > 2 ? process.argv.slice(2) : walk(root)).sort();
if (!files.length) {
  console.error(`No test files found under ${root}`);
  process.exit(1);
}

const args = ['--test', '--test-concurrency=1'];
if (process.env.TEST_COVERAGE === '1') {
  mkdirSync(join(__dirname, '..', 'coverage'), { recursive: true });
  args.push(
    '--experimental-test-coverage',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=lcov', '--test-reporter-destination=coverage/lcov.info'
  );
}
const result = spawnSync(process.execPath, [...args, ...files], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
