#!/usr/bin/env node
import http from 'http';
import https from 'https';
import { URL } from 'url';

type Json = {
  data?: unknown;
  error?: string;
};

const usage = (): string =>
  `Usage: snippycode [--url URL] [--key KEY] <command>

Commands:
  list                 List snippets
  get <id>             Show one snippet as JSON
  search <query>       Search titles, docs, and code
  raw <id-or-slug>     Print snippet code

Environment:
  SNIPPYCODE_URL       Base URL, for example https://snippycode.example
  SNIPPYCODE_API_KEY   Admin raw API key
`;

const argValue = (flag: string): string => {
  const index = process.argv.indexOf(flag);

  if (index === -1) {
    return '';
  }

  return String(process.argv[index + 1] || '').trim();
};

const positional = (): string[] => {
  const args = process.argv.slice(2);
  const skip = new Set(['--url', '--key']);
  const values: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    if (skip.has(args[i])) {
      i += 1;
      continue;
    }

    values.push(args[i]);
  }

  return values;
};

const requestJson = (url: string, key: string, method = 'GET', body?: unknown): Promise<Json> =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const lib = target.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          accept: 'application/json',
          'x-api-key': key,
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload)
              }
            : {})
        }
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error(text || `HTTP ${res.statusCode}`));
          }
        });
      }
    );

    req.on('error', reject);

    if (payload) {
      req.write(payload);
    }

    req.end();
  });

const requestText = (url: string, key: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: {
          'x-api-key': key
        }
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');

          if ((res.statusCode || 500) >= 400) {
            reject(new Error(text || `HTTP ${res.statusCode}`));
            return;
          }

          resolve(text);
        });
      }
    );

    req.on('error', reject);
    req.end();
  });

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const main = async (): Promise<void> => {
  const [command, ...rest] = positional();
  const baseUrl = (argValue('--url') || process.env.SNIPPYCODE_URL || '')
    .trim()
    .replace(/\/$/, '');
  const key = argValue('--key') || process.env.SNIPPYCODE_API_KEY || '';

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage());
    return;
  }

  if (!baseUrl) {
    fail('Set SNIPPYCODE_URL or pass --url');
  }

  if (!key) {
    fail('Set SNIPPYCODE_API_KEY or pass --key');
  }

  if (command === 'list') {
    const res = await requestJson(`${baseUrl}/api/snippets`, key);

    if (res.error) {
      fail(res.error);
    }

    const snippets = (res.data as Array<{
      id: number;
      title: string;
      language: string;
      collection?: string;
      isPublic?: boolean;
    }>) || [];

    snippets.forEach(snippet => {
      process.stdout.write(
        `${snippet.id}\t${snippet.language}\t${snippet.collection || 'General'}\t${
          snippet.isPublic ? 'public' : 'private'
        }\t${snippet.title}\n`
      );
    });
    return;
  }

  if (command === 'get') {
    const id = rest[0];

    if (!id) {
      fail('Usage: snippycode get <id>');
    }

    const res = await requestJson(`${baseUrl}/api/snippets/${encodeURIComponent(id)}`, key);

    if (res.error) {
      fail(res.error);
    }

    process.stdout.write(`${JSON.stringify(res.data, null, 2)}\n`);
    return;
  }

  if (command === 'search') {
    const query = rest.join(' ').trim();

    if (!query) {
      fail('Usage: snippycode search <query>');
    }

    const res = await requestJson(`${baseUrl}/api/snippets/search`, key, 'POST', {
      query,
      tags: [],
      languages: []
    });

    if (res.error) {
      fail(res.error);
    }

    const snippets = (res.data as Array<{ id: number; title: string; language: string }>) || [];
    snippets.forEach(snippet => {
      process.stdout.write(`${snippet.id}\t${snippet.language}\t${snippet.title}\n`);
    });
    return;
  }

  if (command === 'raw') {
    const rawRef = rest[0];

    if (!rawRef) {
      fail('Usage: snippycode raw <id-or-slug>');
    }

    const text = await requestText(
      `${baseUrl}/raw/${encodeURIComponent(rawRef)}`,
      key
    );
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    return;
  }

  fail(`Unknown command: ${command}\n\n${usage()}`);
};

main().catch(err => fail(err instanceof Error ? err.message : String(err)));
