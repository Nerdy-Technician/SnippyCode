#!/usr/bin/env node
// CI helper: run the migrations of a compiled build against DATABASE_URL.
//   node scripts/ci-migrate.js <build dir> [--expect <migrations dir>]
// With --expect, also checks every migration in that folder is recorded.
'use strict';
const { resolve, basename } = require('path');
const { readdirSync } = require('fs');

const dir = resolve(process.argv[2] || 'build');
const expectAt = process.argv.indexOf('--expect');

(async () => {
  require(`${dir}/utils`);
  const db = require(`${dir}/db`);
  await db.connectDB();
  if (expectAt > 0) {
    const want = readdirSync(resolve(process.argv[expectAt + 1]))
      .filter(name => /^\d+_.*\.js$/.test(name))
      .map(name => basename(name, '.js'))
      .sort();
    const { Sequelize } = require('sequelize');
    const sequelize = new Sequelize(process.env.DATABASE_URL, { logging: false });
    const [rows] = await sequelize.query('SELECT name FROM "SequelizeMeta" ORDER BY name');
    const have = new Set(rows.map(row => String(row.name).replace(/\.(js|ts)$/, '')));
    const missing = want.filter(name => !have.has(name));
    console.log(`Applied migrations: ${[...have].sort().join(', ')}`);
    await sequelize.close();
    if (missing.length) throw new Error(`Missing migrations: ${missing.join(', ')}`);
  }
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
