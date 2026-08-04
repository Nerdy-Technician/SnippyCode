import { ChangeEvent, FormEvent, useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faShieldHalved,
  faClipboardList,
  faDatabase,
  faServer,
  faUsers
} from '@fortawesome/free-solid-svg-icons';
import { Button, Card, Layout, PageHeader } from '../components/UI';
import { Response, Task } from '../typescript/interfaces';

const iconUrl = (name: string): string =>
  `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${name}.svg`;

const oidcProviders = [
  { value: 'keycloak', label: 'Keycloak', icon: 'keycloak' },
  { value: 'authentik', label: 'Authentik', icon: 'authentik' },
  { value: 'authelia', label: 'Authelia', icon: 'authelia' },
  { value: 'zitadel', label: 'Zitadel', icon: 'zitadel' },
  { value: 'logto', label: 'Logto', icon: 'logto' }
];

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
    clientSecretConfigured: boolean;
  };
  rawApiKey: {
    configured: boolean;
    prefix: string;
    createdAt: string | null;
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
    'github' | 'oidc' | 'library' | 'tasks' | 'audit' | 'users'
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
    localLoginEnabled: true
  });
  const [user, setUser] = useState({
    email: '',
    displayName: '',
    password: '',
    role: 'user'
  });

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
        localLoginEnabled: res.data.data.oidc.localLoginEnabled
      });
    });
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  const saveGithub = (e: FormEvent) => {
    e.preventDefault();
    axios.put('/api/admin/github', github).then(() => {
      setMessage('GitHub repository settings saved.');
      loadOverview();
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
    axios.post('/api/admin/users', {
      ...user,
      isOwner: user.role === 'owner'
    }).then(() => {
      setMessage('User created.');
      setUser({ email: '', displayName: '', password: '', role: 'user' });
      loadOverview();
    });
  };

  const exportJson = () => {
    window.location.href = '/api/admin/export';
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

  const selectOidcProvider = (value: string) => {
    const provider =
      oidcProviders.find(candidate => candidate.value === value) ||
      oidcProviders[0];
    setOidcProvider(provider);
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
                <h5 className='card-title'>{oidcProvider.label} OIDC setup</h5>
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

        {activeTab === 'tasks' && (
          <Card classes='task-panel admin-tab-panel'>
            <div className='admin-card-heading'>
              <FontAwesomeIcon
                className='admin-fa-icon tasks large'
                icon={faServer}
              />
              <div>
                <p className='eyebrow'>Server tasks</p>
                <h5 className='card-title'>History</h5>
              </div>
            </div>
            <div className='server-task-list'>
              {overview?.tasks.map(task => (
                <article key={task.id} className='server-task-row'>
                  <div>
                    <strong>{task.title}</strong>
                    <p>{task.description}</p>
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
                placeholder='Search action, target, metadata'
                value={auditFilters.auditQuery}
                onChange={e =>
                  setAuditFilters({ ...auditFilters, auditQuery: e.target.value })
                }
              />
              <input
                className='form-control'
                placeholder='Action'
                value={auditFilters.auditAction}
                onChange={e =>
                  setAuditFilters({ ...auditFilters, auditAction: e.target.value })
                }
              />
              <select
                className='form-control'
                value={auditFilters.auditUserId}
                onChange={e =>
                  setAuditFilters({ ...auditFilters, auditUserId: e.target.value })
                }
              >
                <option value=''>Any user</option>
                {overview?.users.map(account => (
                  <option key={account.id} value={account.id}>
                    {account.displayName}
                  </option>
                ))}
              </select>
              <input
                className='form-control'
                placeholder='IP'
                value={auditFilters.auditIp}
                onChange={e =>
                  setAuditFilters({ ...auditFilters, auditIp: e.target.value })
                }
              />
              <Button text='Filter' color='secondary' type='submit' />
            </form>
            <div className='server-task-list'>
              {overview?.auditLogs.map(entry => (
                <article key={entry.id} className='server-task-row'>
                  <div>
                    <strong>{entry.action}</strong>
                    <p>
                      {entry.target || 'system'}
                      {entry.ipAddress ? ` · ${entry.ipAddress}` : ''}
                    </p>
                    <small>{entry.metadata}</small>
                  </div>
                  <span className='task-priority low'>
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                </article>
              ))}
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
                    <option value='user'>User</option>
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
                          Role: {account.role || (account.isOwner ? 'owner' : 'user')} ·{' '}
                          {account.oidcSubject ? 'OIDC bound' : 'Local account'}
                          {account.mfaEnabled ? ' + MFA' : ''}
                        </small>
                      </div>
                      <span
                        className={`task-priority ${
                          account.role === 'owner' || account.isOwner ? 'high' : 'low'
                        }`}
                      >
                        {account.role || (account.isOwner ? 'owner' : 'user')}
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
