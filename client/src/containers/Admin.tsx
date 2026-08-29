import { ChangeEvent, FormEvent, useCallback, useContext, useEffect, useState } from 'react';
import axios from 'axios';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faShieldHalved,
  faClipboardList,
  faDatabase,
  faRobot,
  faServer,
  faUsers
} from '@fortawesome/free-solid-svg-icons';
import { Button, Card, Layout, PageHeader } from '../components/UI';
import { AuthContext } from '../store';
import { Response, Task } from '../typescript/interfaces';
import {
  AUDIT_ACTIONS,
  auditActionLabel,
  auditDetails,
  auditGroup,
  auditTargetLabel,
  auditTone,
  dateParser,
  roleLabel
} from '../utils';
import copy from 'clipboard-copy';

const iconUrl = (name: string): string =>
  `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${name}.svg`;

const oidcProviders = [
  { value: 'keycloak', label: 'Keycloak', icon: 'keycloak' },
  { value: 'authentik', label: 'Authentik', icon: 'authentik' },
  { value: 'authelia', label: 'Authelia', icon: 'authelia' },
  { value: 'zitadel', label: 'Zitadel', icon: 'zitadel' },
  { value: 'logto', label: 'Logto', icon: 'logto' },
  { value: 'custom', label: 'Custom', icon: 'openid' }
];

const matchOidcProvider = (provider?: string, providerName?: string) => {
  const slug = String(provider || '').trim().toLowerCase();
  const name = String(providerName || '').trim().toLowerCase();

  if (!slug && !name) {
    return oidcProviders[0];
  }

  const bySlug = oidcProviders.find(
    candidate => candidate.value === slug && candidate.value !== 'custom'
  );

  if (bySlug) {
    return bySlug;
  }

  const byName = oidcProviders.find(
    candidate =>
      candidate.value !== 'custom' && candidate.label.toLowerCase() === name
  );

  if (byName) {
    return byName;
  }

  return oidcProviders.find(candidate => candidate.value === 'custom') || oidcProviders[0];
};

interface AdminOverview {
  github: {
    owner: string;
    repo: string;
    branch: string;
    path: string;
    tokenConfigured: boolean;
  };
  oidc: {
    enabled: boolean;
    issuerUrl: string;
    clientId: string;
    redirectUri: string;
    scopes: string;
    subjectClaim: string;
    emailClaim: string;
    nameClaim: string;
    matchMode: 'subject' | 'email' | 'subject_or_email';
    allowSignup: boolean;
    localLoginEnabled: boolean;
    provider: string;
    providerName: string;
    clientSecretConfigured: boolean;
  };
  rawApiKey: {
    configured: boolean;
    prefix: string;
    createdAt: string | null;
  };
  ai: {
    openai: {
      enabled: boolean;
      model: string;
      connected: boolean;
      email: string;
      planType: string;
    };
    anthropic: {
      enabled: boolean;
      model: string;
      connected: boolean;
      email: string;
      planType: string;
    };
    models?: {
      openai: { id: string; label: string }[];
      anthropic: { id: string; label: string }[];
    };
  };
  snippets: {
    id: number;
    title: string;
    language: string;
    updatedAt: string;
  }[];
  users: {
    id: number;
    email: string;
    displayName: string;
    isOwner: boolean;
    mfaEnabled: boolean;
    oidcSubject?: string | null;
    role: 'owner' | 'admin' | 'editor' | 'viewer' | 'user';
  }[];
  tasks: Task[];
  auditLogs: {
    id: number;
    userId?: number | null;
    action: string;
    target?: string | null;
    ipAddress?: string | null;
    metadata: string;
    createdAt: string;
  }[];
}

interface OidcTestResult {
  ok: boolean;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
}

interface GithubSyncResult {
  dryRun: boolean;
  files: { path: string; status: string; snippetId?: number; title?: string }[];
  skipped: { path: string; status: string; snippetId?: number; title?: string }[];
  secretWarnings: {
    snippetId: number;
    title: string;
    findings: { label: string; severity: string }[];
  }[];
}

const openaiModelOptions = [
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'gpt-5.5', label: 'GPT-5.5' }
];

const claudeModelOptions = [
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }
];

interface ImportPreview {
  total: number;
  valid: number;
  invalid: { index: number; title: string; reason: string }[];
  secrets: {
    index: number;
    title: string;
    findings: { label: string; severity: string }[];
  }[];
}

export const Admin = (): JSX.Element => {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [activeTab, setActiveTab] = useState<
    'github' | 'oidc' | 'ai' | 'library' | 'tasks' | 'audit' | 'users'
  >('github');
  const [message, setMessage] = useState('');
  const [oidcTest, setOidcTest] = useState<OidcTestResult | null>(null);
  const [oidcProvider, setOidcProvider] = useState(oidcProviders[0]);
  const [selectedSnippetIds, setSelectedSnippetIds] = useState<number[]>([]);
  const [githubDryRun, setGithubDryRun] = useState<GithubSyncResult | null>(null);
  const [githubMode, setGithubMode] = useState<'overwrite' | 'skip'>('overwrite');
  const [auditFilters, setAuditFilters] = useState({
    auditQuery: '',
    auditAction: '',
    auditUserId: '',
    auditIp: ''
  });
  const [pendingImport, setPendingImport] = useState<any | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [snippetBox, setSnippetBox] = useState({
    url: '',
    apiKey: '',
    collection: 'Snippet Box'
  });
  const [github, setGithub] = useState({
    owner: '',
    repo: '',
    branch: 'main',
    path: 'snippets',
    token: ''
  });
  const [oidc, setOidc] = useState({
    enabled: false,
    issuerUrl: '',
    clientId: '',
    clientSecret: '',
    redirectUri: `${window.location.origin}/api/auth/oidc/callback`,
    scopes: 'openid email profile',
    subjectClaim: 'sub',
    emailClaim: 'email',
    nameClaim: 'name',
    matchMode: 'subject_or_email',
    allowSignup: false,
    localLoginEnabled: true,
    provider: 'keycloak',
    providerName: 'Keycloak'
  });
  const { user: currentUser, refreshAuth } = useContext(AuthContext);
  const [user, setUser] = useState({
    email: '',
    displayName: '',
    password: '',
    role: 'editor'
  });
  const [revealedRawApiKey, setRevealedRawApiKey] = useState('');
  const [ai, setAi] = useState({
    openai: { enabled: false, model: 'gpt-5.6-terra' },
    anthropic: { enabled: false, model: 'claude-sonnet-4-5' }
  });
  const [aiTest, setAiTest] = useState('');
  const [openaiLogin, setOpenaiLogin] = useState<{
    verificationUrl: string;
    userCode: string;
  } | null>(null);
  const [anthropicLogin, setAnthropicLogin] = useState<{
    authorizeUrl: string;
    code: string;
  } | null>(null);

  const loadOverview = useCallback((filters = {
    auditQuery: '',
    auditAction: '',
    auditUserId: '',
    auditIp: ''
  }) => {
    axios.get<Response<AdminOverview>>('/api/admin', { params: filters }).then(res => {
      setOverview(res.data.data);
      setGithub({
        owner: res.data.data.github.owner,
        repo: res.data.data.github.repo,
        branch: res.data.data.github.branch,
        path: res.data.data.github.path,
        token: ''
      });
      setOidc({
        enabled: res.data.data.oidc.enabled,
        issuerUrl: res.data.data.oidc.issuerUrl,
        clientId: res.data.data.oidc.clientId,
        clientSecret: '',
        redirectUri:
          res.data.data.oidc.redirectUri ||
          `${window.location.origin}/api/auth/oidc/callback`,
        scopes: res.data.data.oidc.scopes,
        subjectClaim: res.data.data.oidc.subjectClaim,
        emailClaim: res.data.data.oidc.emailClaim,
        nameClaim: res.data.data.oidc.nameClaim,
        matchMode: res.data.data.oidc.matchMode,
        allowSignup: res.data.data.oidc.allowSignup,
        localLoginEnabled: res.data.data.oidc.localLoginEnabled,
        provider: res.data.data.oidc.provider || 'keycloak',
        providerName: res.data.data.oidc.providerName || 'Keycloak'
      });
      setOidcProvider(
        matchOidcProvider(
          res.data.data.oidc.provider,
          res.data.data.oidc.providerName
        )
      );
      setAi({
        openai: {
          enabled: Boolean(res.data.data.ai?.openai?.enabled),
          model: res.data.data.ai?.openai?.model || 'gpt-5.6-terra'
        },
        anthropic: {
          enabled: Boolean(res.data.data.ai?.anthropic?.enabled),
          model: res.data.data.ai?.anthropic?.model || 'claude-sonnet-4-5'
        }
      });
    });
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (!openaiLogin) {
      return;
    }

    const timer = window.setInterval(() => {
      axios
        .post('/api/admin/ai/openai/login/poll')
        .then(res => {
          if (res.data.data.connected) {
            setOpenaiLogin(null);
            setAiTest('ChatGPT is connected.');
            loadOverview();
            refreshAuth();
          }
        })
        .catch(err => {
          setOpenaiLogin(null);
          setAiTest(
            err.response?.data?.error || 'ChatGPT sign-in failed.'
          );
        });
    }, 3000);

    return () => window.clearInterval(timer);
  }, [openaiLogin, loadOverview, refreshAuth]);

  const saveGithub = (e: FormEvent) => {
    e.preventDefault();
    axios.put('/api/admin/github', github).then(() => {
      setMessage('GitHub repository settings saved.');
      loadOverview();
    });
  };

  const saveAi = (e: FormEvent) => {
    e.preventDefault();
    setAiTest('');
    axios.put('/api/admin/ai', ai).then(() => {
      setMessage('AI assistant settings saved.');
      loadOverview();
      refreshAuth();
    });
  };

  const testAi = (provider: 'openai' | 'anthropic') => {
    setAiTest('');
    axios
      .post('/api/admin/ai/test', { provider, [provider]: ai[provider] })
      .then(() => {
        setAiTest(
          provider === 'openai'
            ? 'Codex responded successfully.'
            : 'Claude Code responded successfully.'
        );
      })
      .catch(err => {
        setAiTest(
          err.response?.data?.error ||
            'Test failed. Sign in from this tab first, then try again.'
        );
      });
  };

  const startOpenaiLogin = () => {
    setAiTest('');
    axios.post('/api/admin/ai/openai/login').then(res => {
      setOpenaiLogin(res.data.data);
      window.open(res.data.data.verificationUrl, '_blank', 'noopener');
    }).catch(err => {
      setAiTest(err.response?.data?.error || 'Could not start ChatGPT sign-in.');
    });
  };

  const startAnthropicLogin = () => {
    setAiTest('');
    axios.post('/api/admin/ai/anthropic/login/start').then(res => {
      setAnthropicLogin({ ...res.data.data, code: '' });
      window.open(res.data.data.authorizeUrl, '_blank', 'noopener');
    }).catch(err => {
      setAiTest(err.response?.data?.error || 'Could not start Claude sign-in.');
    });
  };

  const completeAnthropicLogin = () => {
    if (!anthropicLogin?.code.trim()) {
      setAiTest('Paste the code Claude showed after you approved access.');
      return;
    }

    axios
      .post('/api/admin/ai/anthropic/login', { code: anthropicLogin.code })
      .then(() => {
        setAnthropicLogin(null);
        setAiTest('Claude is connected.');
        loadOverview();
        refreshAuth();
      })
      .catch(err => {
        setAiTest(err.response?.data?.error || 'Claude sign-in failed.');
      });
  };

  const disconnectAi = (provider: 'openai' | 'anthropic') => {
    axios.delete(`/api/admin/ai/${provider}/login`).then(() => {
      if (provider === 'openai') {
        setOpenaiLogin(null);
      } else {
        setAnthropicLogin(null);
      }
      setAiTest(
        provider === 'openai' ? 'ChatGPT signed out.' : 'Claude signed out.'
      );
      loadOverview();
      refreshAuth();
    });
  };

  const saveOidc = (e: FormEvent) => {
    e.preventDefault();
    setOidcTest(null);
    axios.put('/api/admin/oidc', oidc).then(() => {
      setMessage(
        oidc.enabled
          ? 'OIDC authentication settings saved.'
          : 'OIDC authentication disabled. Local auth remains available.'
      );
      loadOverview();
    });
  };

  const testOidc = () => {
    setMessage('Testing OIDC discovery...');
    setOidcTest(null);
    axios
      .post<Response<OidcTestResult>>('/api/admin/oidc/test', oidc)
      .then(res => {
        setOidcTest(res.data.data);
        setMessage('OIDC discovery works. You can switch to local auth any time.');
      })
      .catch(() => {
        setMessage('OIDC test failed. Check issuer, client ID, and redirect URI.');
      });
  };

  const runServerTask = (path: string, success: string) => {
    setMessage('Server task started...');
    axios
      .post(path)
      .then(() => {
        setMessage(success);
        loadOverview();
      })
      .catch(err => {
        setMessage(err.response?.data?.error || 'Server task failed.');
        loadOverview();
      });
  };

  const runGithubUpload = (dryRun: boolean) => {
    setMessage(dryRun ? 'Planning GitHub upload...' : 'GitHub upload started...');
    setGithubDryRun(null);
    axios
      .post<Response<GithubSyncResult>>('/api/admin/github/upload', {
        dryRun,
        overwriteMode: githubMode,
        snippetIds: selectedSnippetIds
      })
      .then(res => {
        setGithubDryRun(res.data.data);
        setMessage(
          dryRun
            ? `Dry run planned ${res.data.data.files.length} files.`
            : `GitHub upload wrote ${res.data.data.files.length} files and skipped ${res.data.data.skipped.length}.`
        );
        loadOverview();
      })
      .catch(err => {
        setMessage(err.response?.data?.error || 'GitHub upload failed.');
        loadOverview();
      });
  };

  const toggleSnippetSelection = (id: number) => {
    setSelectedSnippetIds(current =>
      current.includes(id)
        ? current.filter(selectedId => selectedId !== id)
        : [...current, id]
    );
  };

  const testGithub = () => {
    setMessage('Testing GitHub repository access...');
    axios
      .post('/api/admin/github/test', github)
      .then(res => {
        setMessage(`GitHub access works: ${res.data.data.fullName}`);
      })
      .catch(err => {
        setMessage(err.response?.data?.error || 'GitHub test failed.');
      });
  };

  const createUser = (e: FormEvent) => {
    e.preventDefault();
    axios
      .post('/api/admin/users', {
        ...user,
        isOwner: user.role === 'owner'
      })
      .then(() => {
        setMessage('User created.');
        setUser({ email: '', displayName: '', password: '', role: 'editor' });
        loadOverview();
      })
      .catch(err => {
        setMessage(err.response?.data?.error || 'Could not create user.');
      });
  };

  const changeUserRole = (id: number, role: string) => {
    axios
      .patch(`/api/admin/users/${id}`, { role })
      .then(() => {
        setMessage('User role updated.');
        loadOverview();
      })
      .catch(err => {
        setMessage(err.response?.data?.error || 'Could not update user.');
      });
  };

  const removeUser = (id: number, displayName: string) => {
    if (!window.confirm(`Delete ${displayName}? This cannot be undone.`)) {
      return;
    }

    axios
      .delete(`/api/admin/users/${id}`)
      .then(() => {
        setMessage('User deleted.');
        loadOverview();
      })
      .catch(err => {
        setMessage(err.response?.data?.error || 'Could not delete user.');
      });
  };

  const exportJson = () => {
    window.location.href = '/api/admin/export';
  };

  const generateRawApiKey = () => {
    if (
      overview?.rawApiKey.configured &&
      !window.confirm(
        'Regenerate the raw API key? The current key will stop working.'
      )
    ) {
      return;
    }

    axios.post<Response<{ key: string }>>('/api/admin/raw-api-key').then(res => {
      setRevealedRawApiKey(res.data.data.key);
      setMessage('Raw API key generated. Copy it now; it will not be shown again.');
      loadOverview();
    });
  };

  const revokeRawApiKey = () => {
    if (!window.confirm('Revoke the raw API key? Existing CI curl commands that use it will fail.')) {
      return;
    }

    axios.delete('/api/admin/raw-api-key').then(() => {
      setRevealedRawApiKey('');
      setMessage('Raw API key revoked.');
      loadOverview();
    });
  };

  const importJson = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];

    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || '{}'));
        setPendingImport(data);
        axios.post<Response<ImportPreview>>('/api/admin/import', {
          ...data,
          preview: true
        }).then(res => {
          setImportPreview(res.data.data);
          setMessage(`Import preview: ${res.data.data.valid} valid snippets.`);
        });
      } catch (err) {
        setMessage('Import failed. Choose a valid SnippyCode JSON export.');
      }
    };
    reader.readAsText(file);
  };

  const confirmImport = () => {
    if (!pendingImport) {
      return;
    }

    axios.post('/api/admin/import', pendingImport).then(res => {
      setMessage(`Imported ${res.data.data.imported} snippets.`);
      setPendingImport(null);
      setImportPreview(null);
      loadOverview();
    });
  };

  const previewSnippetBox = () => {
    if (!snippetBox.url.trim()) {
      setMessage('Enter the URL of a running Snippet Box instance.');
      return;
    }

    axios
      .post<Response<{ snippets: unknown[]; preview: ImportPreview }>>(
        '/api/admin/import/snippet-box',
        {
          ...snippetBox,
          preview: true
        }
      )
      .then(res => {
        setPendingImport({ snippets: res.data.data.snippets });
        setImportPreview(res.data.data.preview);
        setMessage(
          `Import preview: ${res.data.data.preview.valid} valid snippets.`
        );
      })
      .catch(err => {
        setMessage(
          err.response?.data?.error ||
            'Could not import from that Snippet Box instance.'
        );
      });
  };

  const selectOidcProvider = (value: string) => {
    const provider =
      oidcProviders.find(candidate => candidate.value === value) ||
      oidcProviders[0];
    setOidcProvider(provider);
    setOidc({
      ...oidc,
      provider: provider.value,
      providerName:
        provider.value === 'custom' ? oidc.providerName : provider.label
    });
  };

  return (
    <Layout classes='admin-layout'>
      <PageHeader title='Admin' />
      <div className='col-12'>
        {message && <div className='alert alert-info'>{message}</div>}
      </div>

      <div className='col-12 admin-page'>
        <div className='admin-tabs' role='tablist' aria-label='Admin sections'>
          <button
            type='button'
            role='tab'
            className={activeTab === 'github' ? 'active' : ''}
            aria-selected={activeTab === 'github'}
            onClick={() => setActiveTab('github')}
          >
            <img src={iconUrl('github-light')} alt='' />
            GitHub Sync
          </button>
          <button
            type='button'
            role='tab'
            className={activeTab === 'oidc' ? 'active' : ''}
            aria-selected={activeTab === 'oidc'}
            onClick={() => setActiveTab('oidc')}
          >
            <FontAwesomeIcon className='admin-fa-icon auth' icon={faShieldHalved} />
            OIDC Auth
          </button>
          <button
            type='button'
            role='tab'
            className={activeTab === 'ai' ? 'active' : ''}
            aria-selected={activeTab === 'ai'}
            onClick={() => setActiveTab('ai')}
          >
            <FontAwesomeIcon className='admin-fa-icon' icon={faRobot} />
            AI Assist
          </button>
          <button
            type='button'
            role='tab'
            className={activeTab === 'tasks' ? 'active' : ''}
            aria-selected={activeTab === 'tasks'}
            onClick={() => setActiveTab('tasks')}
          >
            <FontAwesomeIcon className='admin-fa-icon tasks' icon={faServer} />
            Server Tasks
          </button>
          <button
            type='button'
            role='tab'
            className={activeTab === 'library' ? 'active' : ''}
            aria-selected={activeTab === 'library'}
            onClick={() => setActiveTab('library')}
          >
            <FontAwesomeIcon className='admin-fa-icon' icon={faDatabase} />
            Library
          </button>
          <button
            type='button'
            role='tab'
            className={activeTab === 'audit' ? 'active' : ''}
            aria-selected={activeTab === 'audit'}
            onClick={() => setActiveTab('audit')}
          >
            <FontAwesomeIcon className='admin-fa-icon' icon={faClipboardList} />
            Audit
          </button>
          <button
            type='button'
            role='tab'
            className={activeTab === 'users' ? 'active' : ''}
            aria-selected={activeTab === 'users'}
            onClick={() => setActiveTab('users')}
          >
            <FontAwesomeIcon className='admin-fa-icon users' icon={faUsers} />
            Users
          </button>
        </div>

        {activeTab === 'github' && (
          <Card classes='task-panel admin-tab-panel'>
            <div className='admin-card-heading'>
              <img src={iconUrl('github-light')} alt='' />
              <div>
                <p className='eyebrow'>Repository</p>
                <h5 className='card-title'>Private GitHub sync</h5>
              </div>
            </div>
            <form onSubmit={saveGithub}>
              <div className='row g-3'>
                <div className='col-12 col-md-6'>
                  <label className='form-label'>Owner</label>
                  <input
                    className='form-control'
                    value={github.owner}
                    onChange={e =>
                      setGithub({ ...github, owner: e.target.value })
                    }
                  />
                </div>
                <div className='col-12 col-md-6'>
                  <label className='form-label'>Repo</label>
                  <input
                    className='form-control'
                    value={github.repo}
                    onChange={e =>
                      setGithub({ ...github, repo: e.target.value })
                    }
                  />
                </div>
                <div className='col-12 col-md-6'>
                  <label className='form-label'>Branch</label>
                  <input
                    className='form-control'
                    value={github.branch}
                    onChange={e =>
                      setGithub({ ...github, branch: e.target.value })
                    }
                  />
                </div>
                <div className='col-12 col-md-6'>
                  <label className='form-label'>Path</label>
                  <input
                    className='form-control'
                    value={github.path}
                    onChange={e =>
                      setGithub({ ...github, path: e.target.value })
                    }
                  />
                </div>
                <div className='col-12'>
                  <label className='form-label'>Token</label>
                  <input
                    className='form-control'
                    type='password'
                    placeholder={
                      overview?.github.tokenConfigured
                        ? 'Token configured, leave blank to keep it'
                        : 'GitHub fine-grained token'
                    }
                    value={github.token}
                    onChange={e =>
                      setGithub({ ...github, token: e.target.value })
                    }
                  />
                </div>
              </div>
              <div className='admin-actions mt-3'>
                <Button text='Save repo config' color='secondary' type='submit' />
                <Button
                  text='Test config'
                  color='secondary'
                  outline
                  handler={testGithub}
                />
                <Button
                  text='Dry run'
                  color='secondary'
                  outline
                  handler={() => runGithubUpload(true)}
                />
                <Button
                  text='Upload snippets'
                  color='secondary'
                  outline
                  handler={() => runGithubUpload(false)}
                />
                <Button
                  text='Download snippets'
                  color='secondary'
                  outline
                  handler={() =>
                    runServerTask(
                      '/api/admin/github/download',
                      'Download task completed.'
                    )
                  }
                />
              </div>
              <div className='github-sync-options'>
                <label className='form-label'>Conflict handling</label>
                <select
                  className='form-control'
                  value={githubMode}
                  onChange={e =>
                    setGithubMode(e.target.value === 'skip' ? 'skip' : 'overwrite')
                  }
                >
                  <option value='overwrite'>Overwrite existing files</option>
                  <option value='skip'>Skip existing files</option>
                </select>
                <div className='github-snippet-picker'>
                  <div className='github-snippet-picker-header'>
                    <strong>Selected snippets</strong>
                    <button
                      type='button'
                      onClick={() =>
                        setSelectedSnippetIds(
                          selectedSnippetIds.length === overview?.snippets.length
                            ? []
                            : overview?.snippets.map(snippet => snippet.id) || []
                        )
                      }
                    >
                      {selectedSnippetIds.length === overview?.snippets.length
                        ? 'Clear'
                        : 'Select all'}
                    </button>
                  </div>
                  <div className='github-snippet-list'>
                    {overview?.snippets.map(snippet => (
                      <label key={snippet.id} className='github-snippet-option'>
                        <input
                          type='checkbox'
                          checked={selectedSnippetIds.includes(snippet.id)}
                          onChange={() => toggleSnippetSelection(snippet.id)}
                        />
                        <span>{snippet.title}</span>
                        <small>{snippet.language}</small>
                      </label>
                    ))}
                  </div>
                  <p className='text-muted'>
                    Leave empty to sync every snippet.
                  </p>
                </div>
              </div>
            </form>
            {githubDryRun && (
              <div className='github-sync-result'>
                <strong>
                  {githubDryRun.dryRun ? 'Dry-run plan' : 'Sync result'}
                </strong>
                {githubDryRun.secretWarnings.length > 0 && (
                  <div className='alert alert-warning'>
                    Possible secrets before GitHub sync:{' '}
                    {githubDryRun.secretWarnings
                      .map(warning => `${warning.title}: ${warning.findings.map(f => f.label).join(', ')}`)
                      .join(' · ')}
                  </div>
                )}
                <div className='server-task-list'>
                  {[...githubDryRun.files, ...githubDryRun.skipped].map(
                    (file, index) => (
                      <article key={`${file.path}-${index}`} className='server-task-row'>
                        <div>
                          <strong>{file.path}</strong>
                          {file.title && <p>{file.title}</p>}
                        </div>
                        <span className='task-priority low'>{file.status}</span>
                      </article>
                    )
                  )}
                </div>
              </div>
            )}
          </Card>
        )}

        {activeTab === 'oidc' && (
          <Card classes='task-panel admin-tab-panel admin-tab-panel-wide'>
            <div className='admin-card-heading'>
              <img src={iconUrl(oidcProvider.icon)} alt='' />
              <div>
                <p className='eyebrow'>Authentication</p>
                <h5 className='card-title'>
                  {oidc.providerName || oidcProvider.label} OIDC setup
                </h5>
              </div>
            </div>
            <form onSubmit={saveOidc}>
              <div className='row g-3'>
                <div className='col-12 col-md-6'>
                  <label className='form-label'>Provider</label>
                  <select
                    className='form-control'
                    value={oidcProvider.value}
                    onChange={e => selectOidcProvider(e.target.value)}
                  >
                    {oidcProviders.map(provider => (
                      <option key={provider.value} value={provider.value}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className='col-12 col-md-6'>
                  <label className='form-label'>Provider name</label>
                  <input
                    className='form-control'
                    value={oidc.providerName}
                    onChange={e => {
                      const providerName = e.target.value;
                      const matched = matchOidcProvider(undefined, providerName);
                      setOidc({
                        ...oidc,
                        providerName,
                        provider: matched.value
                      });
                      setOidcProvider(matched);
                    }}
                  />
                </div>
                <div className='col-12 col-md-6'>
                  <label className='form-check oidc-toggle mb-0'>
                    <input
                      className='form-check-input'
                      type='checkbox'
                      checked={oidc.enabled}
                      onChange={e =>
                        setOidc({ ...oidc, enabled: e.target.checked })
                      }
                    />
                    <span className='form-check-label'>Enable OIDC login</span>
                  </label>
                </div>
                <div className='col-12 col-md-6'>
                  <label className='form-check oidc-toggle mb-0'>
                    <input
                      className='form-check-input'
                      type='checkbox'
                      checked={oidc.localLoginEnabled}
                      onChange={e =>
                        setOidc({
                          ...oidc,
                          localLoginEnabled: e.target.checked
                        })
                      }
                    />
                    <span className='form-check-label'>Allow local auth</span>
                  </label>
                </div>
                <div className='col-12'>
                  <label className='form-label'>Issuer URL</label>
                  <input
                    className='form-control'
                    placeholder='https://auth.example.com/realms/main'
                    value={oidc.issuerUrl}
                    onChange={e =>
                      setOidc({ ...oidc, issuerUrl: e.target.value })
                    }
                  />
                </div>
                <div className='col-12 col-md-6'>
                  <label className='form-label'>Client ID</label>
                  <input
                    className='form-control'
                    value={oidc.clientId}
                    onChange={e =>
                      setOidc({ ...oidc, clientId: e.target.value })
                    }
                  />
                </div>
                <div className='col-12 col-md-6'>
                  <label className='form-label'>Client secret</label>
                  <input
                    className='form-control'
                    type='password'
                    placeholder={
                      overview?.oidc.clientSecretConfigured
                        ? 'Secret configured, leave blank to keep it'
                        : 'OIDC client secret'
                    }
                    value={oidc.clientSecret}
                    onChange={e =>
                      setOidc({ ...oidc, clientSecret: e.target.value })
                    }
                  />
                </div>
                <div className='col-12'>
                  <label className='form-label'>Redirect URI</label>
                  <input
                    className='form-control'
                    value={oidc.redirectUri}
                    onChange={e =>
                      setOidc({ ...oidc, redirectUri: e.target.value })
                    }
                  />
                </div>
                <div className='col-12 col-md-6'>
                  <label className='form-label'>Scopes</label>
                  <input
                    className='form-control'
                    value={oidc.scopes}
                    onChange={e =>
                      setOidc({ ...oidc, scopes: e.target.value })
                    }
                  />
                </div>
                <div className='col-12 col-md-6'>
                  <label className='form-label'>Account matching</label>
                  <select
                    className='form-control'
                    value={oidc.matchMode}
                    onChange={e =>
                      setOidc({ ...oidc, matchMode: e.target.value })
                    }
                  >
                    <option value='subject_or_email'>Subject or email</option>
                    <option value='subject'>Subject only</option>
                    <option value='email'>Email only</option>
                  </select>
                </div>
                <div className='col-12 col-md-4'>
                  <label className='form-label'>Subject claim</label>
                  <input
                    className='form-control'
                    value={oidc.subjectClaim}
                    onChange={e =>
                      setOidc({ ...oidc, subjectClaim: e.target.value })
                    }
                  />
                </div>
                <div className='col-12 col-md-4'>
                  <label className='form-label'>Email claim</label>
                  <input
                    className='form-control'
                    value={oidc.emailClaim}
                    onChange={e =>
                      setOidc({ ...oidc, emailClaim: e.target.value })
                    }
                  />
                </div>
                <div className='col-12 col-md-4'>
                  <label className='form-label'>Name claim</label>
                  <input
                    className='form-control'
                    value={oidc.nameClaim}
                    onChange={e =>
                      setOidc({ ...oidc, nameClaim: e.target.value })
                    }
                  />
                </div>
                <div className='col-12'>
                  <label className='form-check oidc-toggle'>
                    <input
                      className='form-check-input'
                      type='checkbox'
                      checked={oidc.allowSignup}
                      onChange={e =>
                        setOidc({ ...oidc, allowSignup: e.target.checked })
                      }
                    />
                    <span className='form-check-label'>
                      Create users automatically after successful OIDC login
                    </span>
                  </label>
                </div>
              </div>
              <div className='admin-actions mt-3'>
                <Button text='Save OIDC config' color='secondary' type='submit' />
                <Button
                  text='Test OIDC'
                  color='secondary'
                  outline
                  handler={testOidc}
                />
                <a className='btn btn-outline-secondary' href='/api/auth/oidc/start'>
                  Try sign-in
                </a>
              </div>
            </form>
            {oidcTest && (
              <div className='oidc-test-result'>
                <strong>{oidcTest.issuer}</strong>
                <span>{oidcTest.authorizationEndpoint}</span>
                <span>{oidcTest.tokenEndpoint}</span>
                {oidcTest.userinfoEndpoint && (
                  <span>{oidcTest.userinfoEndpoint}</span>
                )}
              </div>
            )}
          </Card>
        )}

        {activeTab === 'ai' && (
          <Card classes='task-panel admin-tab-panel'>
            <div className='admin-card-heading'>
              <FontAwesomeIcon className='admin-fa-icon' icon={faRobot} />
              <div>
                <p className='eyebrow'>Assistants</p>
                <h5 className='card-title'>Codex and Claude Code</h5>
              </div>
            </div>
            <p className='text-muted'>
              Sign in with your ChatGPT and Claude accounts. Editors can generate
              snippet code, markdown docs, and tags from the editor. Tokens stay
              on this server. Nothing is saved until they apply it.
            </p>
            <form onSubmit={saveAi}>
              <div className='row g-4'>
                <div className='col-12 col-lg-6'>
                  <h6>OpenAI Codex</h6>
                  <label className='form-check oidc-toggle mb-3'>
                    <input
                      className='form-check-input'
                      type='checkbox'
                      checked={ai.openai.enabled}
                      onChange={e =>
                        setAi({
                          ...ai,
                          openai: { ...ai.openai, enabled: e.target.checked }
                        })
                      }
                    />
                    <span className='form-check-label'>Enable Codex</span>
                  </label>
                  <p className='form-text mt-0 mb-3'>
                    {overview?.ai?.openai.connected
                      ? `Signed in${
                          overview.ai.openai.email
                            ? ` as ${overview.ai.openai.email}`
                            : ''
                        }${
                          overview.ai.openai.planType
                            ? ` (${overview.ai.openai.planType})`
                            : ''
                        }.`
                      : 'Not signed in. Uses your ChatGPT Plus/Pro subscription.'}
                  </p>
                  <label className='form-label'>Model</label>
                  <select
                    className='form-control mb-3'
                    value={ai.openai.model}
                    onChange={e =>
                      setAi({
                        ...ai,
                        openai: { ...ai.openai, model: e.target.value }
                      })
                    }
                  >
                    {(overview?.ai?.models?.openai || openaiModelOptions).map(
                      option => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      )
                    )}
                  </select>
                  {openaiLogin && (
                    <div className='alert alert-info'>
                      <p className='mb-2'>
                        Open{' '}
                        <a
                          href={openaiLogin.verificationUrl}
                          target='_blank'
                          rel='noreferrer'
                        >
                          {openaiLogin.verificationUrl}
                        </a>{' '}
                        and enter this code:
                      </p>
                      <p className='mb-0'>
                        <strong>{openaiLogin.userCode}</strong>
                      </p>
                    </div>
                  )}
                  <div className='admin-actions'>
                    {overview?.ai?.openai.connected ? (
                      <Button
                        text='Sign out of ChatGPT'
                        color='secondary'
                        outline
                        small
                        handler={() => disconnectAi('openai')}
                      />
                    ) : (
                      <Button
                        text='Sign in with ChatGPT'
                        color='secondary'
                        handler={startOpenaiLogin}
                      />
                    )}
                    <Button
                      text='Test Codex'
                      color='secondary'
                      outline
                      small
                      handler={() => testAi('openai')}
                    />
                  </div>
                </div>
                <div className='col-12 col-lg-6'>
                  <h6>Claude Code</h6>
                  <label className='form-check oidc-toggle mb-3'>
                    <input
                      className='form-check-input'
                      type='checkbox'
                      checked={ai.anthropic.enabled}
                      onChange={e =>
                        setAi({
                          ...ai,
                          anthropic: {
                            ...ai.anthropic,
                            enabled: e.target.checked
                          }
                        })
                      }
                    />
                    <span className='form-check-label'>Enable Claude Code</span>
                  </label>
                  <p className='form-text mt-0 mb-3'>
                    {overview?.ai?.anthropic.connected
                      ? `Signed in${
                          overview.ai.anthropic.email
                            ? ` as ${overview.ai.anthropic.email}`
                            : ''
                        }.`
                      : 'Not signed in. Uses your Claude Pro/Max subscription.'}
                  </p>
                  <label className='form-label'>Model</label>
                  <select
                    className='form-control mb-3'
                    value={ai.anthropic.model}
                    onChange={e =>
                      setAi({
                        ...ai,
                        anthropic: { ...ai.anthropic, model: e.target.value }
                      })
                    }
                  >
                    {(
                      overview?.ai?.models?.anthropic || claudeModelOptions
                    ).map(option => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {anthropicLogin && (
                    <div className='mb-3'>
                      <label className='form-label'>
                        Paste the code Claude showed after you approved access
                      </label>
                      <input
                        className='form-control'
                        value={anthropicLogin.code}
                        placeholder='code#state'
                        onChange={e =>
                          setAnthropicLogin({
                            ...anthropicLogin,
                            code: e.target.value
                          })
                        }
                      />
                      <div className='admin-actions mt-2'>
                        <Button
                          text='Complete Claude sign-in'
                          color='secondary'
                          handler={completeAnthropicLogin}
                        />
                      </div>
                    </div>
                  )}
                  <div className='admin-actions'>
                    {overview?.ai?.anthropic.connected ? (
                      <Button
                        text='Sign out of Claude'
                        color='secondary'
                        outline
                        small
                        handler={() => disconnectAi('anthropic')}
                      />
                    ) : (
                      <Button
                        text='Sign in with Claude'
                        color='secondary'
                        handler={startAnthropicLogin}
                      />
                    )}
                    <Button
                      text='Test Claude Code'
                      color='secondary'
                      outline
                      small
                      handler={() => testAi('anthropic')}
                    />
                  </div>
                </div>
              </div>
              {aiTest && <p className='form-text mt-3 mb-0'>{aiTest}</p>}
              <div className='admin-actions mt-3'>
                <Button text='Save AI config' color='secondary' type='submit' />
              </div>
            </form>
          </Card>
        )}

        {activeTab === 'tasks' && (
          <Card classes='task-panel admin-tab-panel'>
            <div className='admin-card-heading'>
              <FontAwesomeIcon
                className='admin-fa-icon tasks large'
                icon={faServer}
              />
              <div>
                <p className='eyebrow'>Jobs</p>
                <h5 className='card-title'>Server tasks</h5>
              </div>
            </div>
            <p className='text-muted'>
              GitHub sync, library import/export, and AI tests are recorded here.
            </p>
            <div className='admin-actions mb-3'>
              <Button
                text='Download from GitHub'
                color='secondary'
                outline
                handler={() =>
                  runServerTask(
                    '/api/admin/github/download',
                    'Download task completed.'
                  )
                }
              />
              <Button
                text='Upload to GitHub'
                color='secondary'
                outline
                handler={() => runGithubUpload(false)}
              />
              <Button
                text='Export JSON'
                color='secondary'
                outline
                handler={exportJson}
              />
            </div>
            <div className='server-task-list'>
              {(overview?.tasks || []).length === 0 && (
                <article className='server-task-row'>
                  <div>
                    <strong>No jobs yet</strong>
                    <p>
                      Run a task above, or import/export from Library. Completed
                      jobs will show up here.
                    </p>
                  </div>
                </article>
              )}
              {overview?.tasks.map(task => (
                <article key={task.id} className='server-task-row'>
                  <div>
                    <strong>{task.title}</strong>
                    <p>{task.description}</p>
                    {task.createdAt && (
                      <small>{new Date(task.createdAt).toLocaleString()}</small>
                    )}
                  </div>
                  <span
                    className={`task-priority ${
                      task.status === 'done'
                        ? 'low'
                        : task.status === 'failed'
                        ? 'high'
                        : 'medium'
                    }`}
                  >
                    {task.status}
                  </span>
                </article>
              ))}
            </div>
          </Card>
        )}

        {activeTab === 'library' && (
          <Card classes='task-panel admin-tab-panel'>
            <div className='admin-card-heading'>
              <FontAwesomeIcon className='admin-fa-icon large' icon={faDatabase} />
              <div>
                <p className='eyebrow'>Library</p>
                <h5 className='card-title'>Raw API key</h5>
              </div>
            </div>
            <p className='text-muted'>
              A global key for CI and curl. It can fetch any snippet at
              <code> /raw/:slug</code> with <code>?key=</code> or the
              <code> x-api-key</code> header, without replacing per-snippet tokens.
            </p>
            <div className='profile-meta'>
              <span>Status</span>
              <strong>
                {overview?.rawApiKey.configured
                  ? `${overview.rawApiKey.prefix}...`
                  : 'Not generated'}
              </strong>
            </div>
            {revealedRawApiKey && (
              <div className='raw-modal-row'>
                <span>Key</span>
                <code>{revealedRawApiKey}</code>
                <button type='button' onClick={() => copy(revealedRawApiKey)}>
                  Copy
                </button>
              </div>
            )}
            {revealedRawApiKey && (
              <p className='raw-token-notice'>
                Copy this key now. It will not be shown again.
              </p>
            )}
            <div className='admin-actions mb-4'>
              <Button
                text={overview?.rawApiKey.configured ? 'Regenerate key' : 'Generate key'}
                color='secondary'
                handler={generateRawApiKey}
              />
              <Button
                text='Revoke key'
                color='danger'
                outline
                handler={revokeRawApiKey}
              />
            </div>
            <hr />
            <div className='admin-card-heading'>
              <div>
                <p className='eyebrow'>Backup</p>
                <h5 className='card-title'>Import / export</h5>
              </div>
            </div>
            <p className='text-muted'>
              Export the current snippet library as JSON or import a previous
              SnippyCode JSON export.
            </p>
            <div className='admin-actions'>
              <Button text='Export JSON' color='secondary' outline handler={exportJson} />
              <label className='btn btn-outline-secondary'>
                Import JSON
                <input type='file' accept='application/json' hidden onChange={importJson} />
              </label>
            </div>
            <hr />
            <div className='admin-card-heading'>
              <div>
                <p className='eyebrow'>Migration</p>
                <h5 className='card-title'>Import from Snippet Box</h5>
              </div>
            </div>
            <p className='text-muted'>
              Pull all snippets from a running original Snippet Box instance
              (<code>GET /api/snippets</code>). Preview first, then confirm.
            </p>
            <div className='row g-3'>
              <div className='col-12'>
                <label className='form-label'>URL</label>
                <input
                  className='form-control'
                  type='url'
                  placeholder='https://snippet-box.example'
                  value={snippetBox.url}
                  onChange={e =>
                    setSnippetBox({ ...snippetBox, url: e.target.value })
                  }
                />
              </div>
              <div className='col-12 col-md-6'>
                <label className='form-label'>API key (optional)</label>
                <input
                  className='form-control'
                  type='password'
                  autoComplete='off'
                  value={snippetBox.apiKey}
                  onChange={e =>
                    setSnippetBox({ ...snippetBox, apiKey: e.target.value })
                  }
                />
              </div>
              <div className='col-12 col-md-6'>
                <label className='form-label'>Collection name</label>
                <input
                  className='form-control'
                  value={snippetBox.collection}
                  onChange={e =>
                    setSnippetBox({
                      ...snippetBox,
                      collection: e.target.value
                    })
                  }
                />
              </div>
            </div>
            <div className='admin-actions mt-3'>
              <Button
                text='Preview Snippet Box import'
                color='secondary'
                handler={previewSnippetBox}
              />
            </div>
            {importPreview && (
              <div className='import-preview'>
                <strong>
                  Preview: {importPreview.valid} of {importPreview.total} snippets
                  are ready to import.
                </strong>
                {importPreview.invalid.length > 0 && (
                  <p>
                    Invalid: {importPreview.invalid.map(item => item.title).join(', ')}
                  </p>
                )}
                {importPreview.secrets.length > 0 && (
                  <div className='alert alert-warning'>
                    Possible secrets:{' '}
                    {importPreview.secrets
                      .map(item => `${item.title}: ${item.findings.map(f => f.label).join(', ')}`)
                      .join(' · ')}
                  </div>
                )}
                <div className='admin-actions'>
                  <Button
                    text='Confirm import'
                    color='secondary'
                    handler={confirmImport}
                  />
                  <Button
                    text='Cancel'
                    color='danger'
                    outline
                    handler={() => {
                      setPendingImport(null);
                      setImportPreview(null);
                    }}
                  />
                </div>
              </div>
            )}
          </Card>
        )}

        {activeTab === 'audit' && (
          <Card classes='task-panel admin-tab-panel admin-tab-panel-wide'>
            <div className='admin-card-heading'>
              <FontAwesomeIcon
                className='admin-fa-icon large'
                icon={faClipboardList}
              />
              <div>
                <p className='eyebrow'>Security</p>
                <h5 className='card-title'>Audit log</h5>
              </div>
            </div>
            <form
              className='audit-filters'
              onSubmit={e => {
                e.preventDefault();
                loadOverview(auditFilters);
              }}
            >
              <input
                className='form-control'
                placeholder='Search'
                value={auditFilters.auditQuery}
                onChange={e =>
                  setAuditFilters({ ...auditFilters, auditQuery: e.target.value })
                }
              />
              <select
                className='form-control'
                value={auditFilters.auditAction}
                onChange={e => {
                  const next = { ...auditFilters, auditAction: e.target.value };
                  setAuditFilters(next);
                  loadOverview(next);
                }}
              >
                <option value=''>Any action</option>
                {AUDIT_ACTIONS.map(action => (
                  <option key={action.id} value={action.id}>
                    {action.label}
                  </option>
                ))}
              </select>
              <select
                className='form-control'
                value={auditFilters.auditUserId}
                onChange={e => {
                  const next = { ...auditFilters, auditUserId: e.target.value };
                  setAuditFilters(next);
                  loadOverview(next);
                }}
              >
                <option value=''>Any person</option>
                {overview?.users.map(account => (
                  <option key={account.id} value={account.id}>
                    {account.displayName}
                  </option>
                ))}
              </select>
              <input
                className='form-control'
                placeholder='IP address'
                value={auditFilters.auditIp}
                onChange={e =>
                  setAuditFilters({ ...auditFilters, auditIp: e.target.value })
                }
              />
              <Button text='Filter' color='secondary' type='submit' />
            </form>
            <div className='audit-log-list'>
              {(overview?.auditLogs || []).length === 0 && (
                <article className='audit-log-row'>
                  <div>
                    <strong>No matching events</strong>
                    <p>Try clearing the filters or wait for the next sign-in or edit.</p>
                  </div>
                </article>
              )}
              {overview?.auditLogs.map(entry => {
                const actor =
                  overview.users.find(account => account.id === entry.userId)
                    ?.displayName || '';
                const target = auditTargetLabel(entry.target, entry.metadata);
                const details = auditDetails(entry.metadata);
                const when = dateParser(entry.createdAt as unknown as Date);
                const tone = auditTone(entry.action);
                const facts = [actor, target, entry.ipAddress].filter(Boolean);

                return (
                  <article key={entry.id} className='audit-log-row'>
                    <div>
                      <div className='audit-log-heading'>
                        <span className='audit-log-group'>{auditGroup(entry.action)}</span>
                        <strong>{auditActionLabel(entry.action)}</strong>
                      </div>
                      {facts.length > 0 && <p>{facts.join(' · ')}</p>}
                      {details.length > 0 && (
                        <ul className='audit-log-details'>
                          {details.map(line => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <span className={`audit-log-time audit-log-time-${tone}`} title={when.formatted}>
                      {when.relative}
                    </span>
                  </article>
                );
              })}
            </div>
          </Card>
        )}

        {activeTab === 'users' && (
          <div className='row g-3'>
            <div className='col-12'>
              <Card classes='task-panel'>
                <p className='eyebrow'>Roles</p>
                <h5 className='card-title'>Permissions matrix</h5>
                <div className='permissions-matrix'>
                  {[
                    ['Viewer', 'Read snippets and raw metadata'],
                    ['Editor', 'Create, edit, delete snippets, generate raw tokens'],
                    ['Admin', 'Run server tasks, manage GitHub/OIDC/import/export/users'],
                    ['Owner', 'Full access and ownership transfer-ready account']
                  ].map(([role, permissions]) => (
                    <article key={role}>
                      <strong>{role}</strong>
                      <span>{permissions}</span>
                    </article>
                  ))}
                </div>
              </Card>
            </div>
            <div className='col-12 col-lg-5'>
              <Card classes='task-panel'>
                <div className='admin-card-heading'>
                  <FontAwesomeIcon
                    className='admin-fa-icon users large'
                    icon={faUsers}
                  />
                  <div>
                    <p className='eyebrow'>Users</p>
                    <h5 className='card-title'>Create user</h5>
                  </div>
                </div>
                <form onSubmit={createUser}>
                  <label className='form-label'>Email</label>
                  <input
                    className='form-control mb-3'
                    type='email'
                    value={user.email}
                    onChange={e => setUser({ ...user, email: e.target.value })}
                  />
                  <label className='form-label'>Display name</label>
                  <input
                    className='form-control mb-3'
                    value={user.displayName}
                    onChange={e =>
                      setUser({ ...user, displayName: e.target.value })
                    }
                  />
                  <label className='form-label'>Password</label>
                  <input
                    className='form-control mb-3'
                    type='password'
                    value={user.password}
                    onChange={e =>
                      setUser({ ...user, password: e.target.value })
                    }
                  />
                  <label className='form-label'>Role</label>
                  <select
                    className='form-control mb-3'
                    value={user.role}
                    onChange={e => setUser({ ...user, role: e.target.value })}
                  >
                    <option value='viewer'>Viewer</option>
                    <option value='editor'>Editor</option>
                    <option value='admin'>Admin</option>
                    <option value='owner'>Owner</option>
                  </select>
                  <Button text='Create user' color='secondary' type='submit' />
                </form>
              </Card>
            </div>

            <div className='col-12 col-lg-7'>
              <Card classes='task-panel'>
                <p className='eyebrow'>Users</p>
                <h5 className='card-title'>Accounts</h5>
                <div className='server-task-list'>
                  {overview?.users.map(account => (
                    <article key={account.id} className='server-task-row'>
                      <div>
                        <strong>{account.displayName}</strong>
                        <p>{account.email}</p>
                        <small>
                          {account.oidcSubject ? 'OIDC bound' : 'Local account'}
                          {account.mfaEnabled ? ' + MFA' : ''}
                        </small>
                        <div className='user-account-actions'>
                          <select
                            className='form-control'
                            value={
                              account.isOwner
                                ? 'owner'
                                : account.role === 'user'
                                ? 'editor'
                                : account.role
                            }
                            onChange={e => changeUserRole(account.id, e.target.value)}
                          >
                            <option value='viewer'>Viewer</option>
                            <option value='editor'>Editor</option>
                            <option value='admin'>Admin</option>
                            <option value='owner'>Owner</option>
                          </select>
                          <button
                            type='button'
                            className='btn btn-outline-danger btn-sm'
                            disabled={currentUser?.id === account.id}
                            onClick={() =>
                              removeUser(account.id, account.displayName)
                            }
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                      <span
                        className={`task-priority ${
                          account.role === 'owner' || account.isOwner
                            ? 'high'
                            : 'low'
                        }`}
                      >
                        {roleLabel(account.role, account.isOwner)}
                      </span>
                    </article>
                  ))}
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
};
