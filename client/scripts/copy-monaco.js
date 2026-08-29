const { cpSync, mkdirSync, existsSync } = require('fs');
const { join } = require('path');

const src = join(__dirname, '../node_modules/monaco-editor/min/vs');
const dest = join(__dirname, '../public/monaco/vs');

if (!existsSync(src)) {
  throw new Error('monaco-editor is not installed');
}

mkdirSync(join(__dirname, '../public/monaco'), { recursive: true });
cpSync(src, dest, { recursive: true });
