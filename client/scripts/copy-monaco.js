import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '../node_modules/monaco-editor/min/vs');
const dest = join(here, '../public/monaco/vs');

if (!existsSync(src)) {
  throw new Error('monaco-editor is not installed');
}

mkdirSync(join(here, '../public/monaco'), { recursive: true });
cpSync(src, dest, { recursive: true });
