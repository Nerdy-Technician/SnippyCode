#!/usr/bin/env node
/**
 * One-off, read-only report of snippets with placeholders inside quotes,
 * backticks, $( ), ${ }, heredocs or template literals. From v1.2.3 those
 * snippets are refused at save and at run time until the quotes around the
 * placeholder are removed (values are quoted automatically) or an admin marks
 * the variable raw. Uses DATABASE_URL; runs no migrations and writes nothing.
 *
 *   node build/quotedPlaceholdersReport.js [--json]
 */
import dotenv from 'dotenv';
import { Sequelize, QueryTypes } from 'sequelize';
import { scanQuotedPlaceholders } from './utils/placeholderContext';
import { rawNames } from './utils/snippetVariables';

dotenv.config();

const main = async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const sequelize = new Sequelize(url, { logging: false });
  try {
    const columns = await sequelize.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'snippets'",
      { type: QueryTypes.SELECT }
    );
    const hasVariables = columns.some(c => c.column_name === 'variables');
    const rows = await sequelize.query<any>(
      `SELECT id, title, language, code${hasVariables ? ', variables' : ''} FROM snippets ORDER BY id`,
      { type: QueryTypes.SELECT }
    );
    const report = scanQuotedPlaceholders(rows, rawNames);
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ scanned: rows.length, flagged: report }, null, 2));
      return;
    }
    console.log(`Scanned ${rows.length} snippets; ${report.length} would be refused.`);
    report.forEach(item => {
      console.log(`\n#${item.id} ${item.title} (${item.language})`);
      item.problems.forEach(p => console.log(`  line ${p.line}: {{${p.name}}} inside ${p.context}`));
    });
  } finally {
    await sequelize.close();
  }
};

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
