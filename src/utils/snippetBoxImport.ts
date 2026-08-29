import http from 'http';
import https from 'https';
import { URL } from 'url';

export interface SnippetBoxSnippet {
  title: string;
  description: string;
  language: string;
  code: string;
  docs: string;
  isPinned: boolean;
  collection: string;
  fileName: string;
  tags: string[];
}

const getJson = (
  url: string,
  headers: Record<string, string>,
  timeoutMs = 30000
): Promise<any> =>
  new Promise((resolve, reject) => {
    let parsed: URL;

    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new Error('Enter a valid Snippet Box URL'));
      return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('URL must start with http:// or https://'));
      return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...headers
        }
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');

          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new Error(
                `Snippet Box returned ${res.statusCode}. Check the URL and API key.`
              )
            );
            return;
          }

          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (err) {
            reject(new Error('Snippet Box did not return JSON'));
          }
        });
      }
    );

    req.on('error', () => {
      reject(new Error('Could not reach that Snippet Box instance'));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Snippet Box request timed out'));
    });
    req.end();
  });

const normalizeTags = (tags: unknown): string[] => {
  if (!Array.isArray(tags)) {
    if (typeof tags === 'string' && tags.trim()) {
      return tags
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean);
    }

    return [];
  }

  return tags
    .map(tag => {
      if (typeof tag === 'string') {
        return tag.trim();
      }

      if (tag && typeof tag === 'object' && 'name' in tag) {
        return String((tag as { name?: string }).name || '').trim();
      }

      return '';
    })
    .filter(Boolean);
};

const mapSnippet = (item: any, collection: string): SnippetBoxSnippet => ({
  title: String(item.title || '').trim(),
  description: String(item.description || ''),
  language: String(item.language || 'plaintext').trim().toLowerCase(),
  code: String(item.code || ''),
  docs: String(item.docs || ''),
  isPinned: Boolean(item.isPinned),
  collection: String(item.collection || collection || 'Snippet Box').trim() || 'Snippet Box',
  fileName: String(item.fileName || ''),
  tags: normalizeTags(item.tags)
});

const extractList = (body: any): any[] => {
  if (Array.isArray(body)) {
    return body;
  }

  if (Array.isArray(body?.data)) {
    return body.data;
  }

  if (Array.isArray(body?.snippets)) {
    return body.snippets;
  }

  return [];
};

export const fetchSnippetBoxSnippets = async (options: {
  url: string;
  apiKey?: string;
  collection?: string;
}): Promise<SnippetBoxSnippet[]> => {
  const rawUrl = String(options.url || '').trim().replace(/\/+$/, '');

  if (!rawUrl) {
    throw new Error('Snippet Box URL is required');
  }

  const origin = new URL(rawUrl);
  const base = `${origin.protocol}//${origin.host}`;
  const headers: Record<string, string> = {};
  const apiKey = String(options.apiKey || '').trim();

  if (apiKey) {
    headers['x-api-key'] = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const collection = String(options.collection || 'Snippet Box').trim() || 'Snippet Box';
  const list = extractList(await getJson(`${base}/api/snippets`, headers));

  if (!list.length) {
    throw new Error('No snippets were found at that URL');
  }

  const snippets = list.map(item => mapSnippet(item, collection));
  const missing = snippets
    .map((snippet, index) => ({ snippet, id: list[index]?.id }))
    .filter(item => !item.snippet.code && item.id);

  for (const item of missing) {
    const detail = await getJson(`${base}/api/snippets/${item.id}`, headers);
    const raw = detail?.data || detail;
    const mapped = mapSnippet(raw, collection);
    item.snippet.code = mapped.code;
    item.snippet.docs = mapped.docs || item.snippet.docs;
    item.snippet.tags = mapped.tags.length ? mapped.tags : item.snippet.tags;
  }

  return snippets;
};
