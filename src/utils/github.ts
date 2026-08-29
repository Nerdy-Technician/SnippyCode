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
): Promise<Array<{ name: string; path: string; type: 'file' | 'dir' }>> => {
  const owner = config.owner || process.env.GITHUB_REPO_OWNER;
  const repo = config.repo || process.env.GITHUB_REPO_NAME;
  const branch = config.branch || process.env.GITHUB_REPO_BRANCH || 'main';

  if (!owner || !repo) {
    throw new Error('GITHUB_REPO_OWNER and GITHUB_REPO_NAME are required');
  }

  return requestGithub({
    method: 'GET',
    token: config.token,
    path: `/repos/${owner}/${repo}/contents/${encodePath(
      directoryPath
    )}?ref=${encodeURIComponent(branch)}`
  });
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
