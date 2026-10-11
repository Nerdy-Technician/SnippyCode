import https from 'https';

interface GithubRequestOptions {
  method: 'GET' | 'PUT';
  path: string;
  body?: unknown;
  token?: string;
}

interface GithubFileResult {
  path: string;
  status: 'created' | 'updated';
}

const requestGithub = <T>(options: GithubRequestOptions): Promise<T> => {
  const token = options.token || process.env.GITHUB_TOKEN;

  if (!token) {
    return Promise.reject(new Error('GITHUB_TOKEN is not configured'));
  }

  const body = options.body ? JSON.stringify(options.body) : undefined;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: options.path,
        method: options.method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'snippycode',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
        }
      },
      res => {
        const chunks: Buffer[] = [];

        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const data = raw ? JSON.parse(raw) : {};

          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new Error(
                `GitHub ${res.statusCode}: ${data.message || 'request failed'}`
              )
            );
            return;
          }

          resolve(data);
        });
      }
    );

    req.on('error', reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
};

const encodePath = (path: string): string =>
  path
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/');

export const upsertGithubFile = async (
  filePath: string,
  content: string,
  message: string,
  config?: {
    token?: string;
    owner?: string;
    repo?: string;
    branch?: string;
  }
): Promise<GithubFileResult> => {
  const owner = config?.owner || process.env.GITHUB_REPO_OWNER;
  const repo = config?.repo || process.env.GITHUB_REPO_NAME;
  const branch = config?.branch || process.env.GITHUB_REPO_BRANCH || 'main';

  if (!owner || !repo) {
    throw new Error('GITHUB_REPO_OWNER and GITHUB_REPO_NAME are required');
  }

  let sha: string | undefined;
  const encodedPath = encodePath(filePath);

  try {
    const existing = await requestGithub<{ sha?: string }>({
      method: 'GET',
      path: `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(
        branch
      )}`,
      token: config?.token
    });
    sha = existing.sha;
  } catch (err) {
    sha = undefined;
  }

  await requestGithub({
    method: 'PUT',
    path: `/repos/${owner}/${repo}/contents/${encodedPath}`,
    token: config?.token,
    body: {
      branch,
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      ...(sha ? { sha } : {})
    }
  });

  return {
    path: filePath,
    status: sha ? 'updated' : 'created'
  };
};

export const getGithubFileInfo = async (
  filePath: string,
  config: {
    token?: string;
    owner?: string;
    repo?: string;
    branch?: string;
  }
): Promise<{ sha: string; path: string } | null> => {
  const owner = config.owner || process.env.GITHUB_REPO_OWNER;
  const repo = config.repo || process.env.GITHUB_REPO_NAME;
  const branch = config.branch || process.env.GITHUB_REPO_BRANCH || 'main';

  if (!owner || !repo) {
    throw new Error('GITHUB_REPO_OWNER and GITHUB_REPO_NAME are required');
  }

  try {
    const file = await requestGithub<{ sha: string; path: string }>({
      method: 'GET',
      token: config.token,
      path: `/repos/${owner}/${repo}/contents/${encodePath(
        filePath
      )}?ref=${encodeURIComponent(branch)}`
    });

    return { sha: file.sha, path: file.path };
  } catch (err) {
    const message = err instanceof Error ? err.message : '';

    if (message.includes('GitHub 404')) {
      return null;
    }

    throw err;
  }
};

export const getGithubDirectory = async (
  directoryPath: string,
  config: {
    token?: string;
    owner?: string;
    repo?: string;
    branch?: string;
  }
): Promise<Array<{ name: string; path: string; type: 'file' | 'dir'; sha?: string }>> => {
  const owner = config.owner || process.env.GITHUB_REPO_OWNER;
  const repo = config.repo || process.env.GITHUB_REPO_NAME;
  const branch = config.branch || process.env.GITHUB_REPO_BRANCH || 'main';

  if (!owner || !repo) {
    throw new Error('GITHUB_REPO_OWNER and GITHUB_REPO_NAME are required');
  }

  const entries = await requestGithub<GithubDirEntry[]>({
    method: 'GET',
    token: config.token,
    path: `/repos/${owner}/${repo}/contents/${encodePath(
      directoryPath
    )}?ref=${encodeURIComponent(branch)}`
  });

  // The contents API stops at 1,000 entries; list bigger folders from the
  // git tree of the branch head instead
  if (!Array.isArray(entries) || entries.length < CONTENTS_LIMIT) {
    return entries;
  }

  return listDirectoryFromTree(directoryPath, { token: config.token, owner, repo, branch });
};

type GithubDirEntry = { name: string; path: string; type: 'file' | 'dir'; sha?: string };
export interface GitTreeItem { path: string; type: string; sha: string }
interface GitTree { sha: string; tree: GitTreeItem[]; truncated: boolean }

export const CONTENTS_LIMIT = 1000;

const trimSlashes = (path: string) => path.replace(/^\/+|\/+$/g, '');

/** Direct children of `dir` from a (recursive) git tree listing. */
export const directoryEntriesFromTree = (dir: string, items: GitTreeItem[], prefix = ''): GithubDirEntry[] => {
  const base = trimSlashes(dir);
  const root = trimSlashes(prefix);

  return items
    .map(item => ({ ...item, path: root ? `${root}/${item.path}` : item.path }))
    .filter(item => {
      const parent = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
      return parent === base && (item.type === 'blob' || item.type === 'tree');
    })
    .map(item => ({
      name: item.path.slice(item.path.lastIndexOf('/') + 1),
      path: item.path,
      type: item.type === 'tree' ? 'dir' : 'file',
      sha: item.sha
    }));
};

/**
 * List a folder through the git trees API: resolve the branch SHA, fetch the
 * recursive tree, and when GitHub truncates it, walk down to the folder and
 * read just its own (non-recursive) tree.
 */
const listDirectoryFromTree = async (
  directoryPath: string,
  config: { token?: string; owner: string; repo: string; branch: string }
): Promise<GithubDirEntry[]> => {
  const { owner, repo, branch, token } = config;
  const ref = await requestGithub<{ object: { sha: string } }>({
    method: 'GET',
    token,
    path: `/repos/${owner}/${repo}/git/ref/heads/${encodePath(branch)}`
  });
  const getTree = (sha: string, recursive: boolean) =>
    requestGithub<GitTree>({
      method: 'GET',
      token,
      path: `/repos/${owner}/${repo}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`
    });
  const full = await getTree(ref.object.sha, true);

  if (!full.truncated) {
    return directoryEntriesFromTree(directoryPath, full.tree);
  }

  let tree = await getTree(ref.object.sha, false);
  const parts = trimSlashes(directoryPath).split('/').filter(Boolean);

  for (const part of parts) {
    const next = tree.tree.find(item => item.type === 'tree' && item.path === part);

    if (!next) {
      return [];
    }

    tree = await getTree(next.sha, false);
  }

  return directoryEntriesFromTree(directoryPath, tree.tree, directoryPath);
};

export const getGithubFileText = async (
  filePath: string,
  config: {
    token?: string;
    owner?: string;
    repo?: string;
    branch?: string;
  }
): Promise<string> => {
  const owner = config.owner || process.env.GITHUB_REPO_OWNER;
  const repo = config.repo || process.env.GITHUB_REPO_NAME;
  const branch = config.branch || process.env.GITHUB_REPO_BRANCH || 'main';

  if (!owner || !repo) {
    throw new Error('GITHUB_REPO_OWNER and GITHUB_REPO_NAME are required');
  }

  const file = await requestGithub<{ content: string; encoding: string }>({
    method: 'GET',
    token: config.token,
    path: `/repos/${owner}/${repo}/contents/${encodePath(
      filePath
    )}?ref=${encodeURIComponent(branch)}`
  });

  return Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8');
};

export const testGithubRepositoryAccess = async (config: {
  token?: string;
  owner?: string;
  repo?: string;
  branch?: string;
}): Promise<{
  fullName?: string;
  private?: boolean;
  defaultBranch?: string;
  canRead: boolean;
}> => {
  const owner = config.owner || process.env.GITHUB_REPO_OWNER;
  const repo = config.repo || process.env.GITHUB_REPO_NAME;

  if (!owner || !repo) {
    throw new Error('GITHUB_REPO_OWNER and GITHUB_REPO_NAME are required');
  }

  const repository = await requestGithub<{
    full_name: string;
    private: boolean;
    default_branch: string;
  }>({
    method: 'GET',
    token: config.token,
    path: `/repos/${owner}/${repo}`
  });

  return {
    fullName: repository.full_name,
    private: repository.private,
    defaultBranch: repository.default_branch,
    canRead: true
  };
};
