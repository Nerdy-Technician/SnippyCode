import { FormEvent, useContext, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCircleCheck,
  faEye,
  faEyeSlash,
  faFingerprint,
  faKey,
  faRightToBracket,
  faShieldHalved,
  faUserShield
} from '@fortawesome/free-solid-svg-icons';
import { AuthContext } from '../../store';

interface Props {
  children: JSX.Element;
}

export const AuthGate = (props: Props): JSX.Element => {
  const { loading, needsSetup, user } = useContext(AuthContext);

  if (loading) {
    return (
      <main className='auth-shell'>
        <section className='auth-layout' aria-label='Loading SnippyCode'>
          <aside className='auth-intro' aria-hidden='true'>
            <div className='auth-mark'>
              <img src='/CodeSnippy.png' alt='' />
            </div>
            <div className='auth-brand-copy'>
              <p className='eyebrow'>SnippyCode</p>
              <h1>Private library</h1>
              <p>Preparing a workspace for snippets, raw links, and team workflows.</p>
            </div>
          </aside>
          <div className='auth-panel auth-login-panel'>
            <div className='auth-panel-heading'>
              <p className='eyebrow'>Loading</p>
              <h2>Preparing SnippyCode</h2>
              <p>Checking this instance and restoring your session.</p>
            </div>
          </div>
        </section>
      </main>
    );
  }

  if (needsSetup) {
    return <SetupWizard />;
  }

  if (!user) {
    return <LoginScreen />;
  }

  return props.children;
};

const SetupWizard = (): JSX.Element => {
  const { setup } = useContext(AuthContext);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'local' | 'sso'>('local');
  const [formData, setFormData] = useState({
    email: '',
    displayName: '',
    password: '',
    issuerUrl: '',
    clientId: '',
    clientSecret: '',
    redirectUri: `${window.location.origin}/api/auth/oidc/callback`
  });

  const submitHandler = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      if (mode === 'sso') {
        await setup({
          oidc: {
            enabled: true,
            issuerUrl: formData.issuerUrl,
            clientId: formData.clientId,
            clientSecret: formData.clientSecret,
            redirectUri: formData.redirectUri
          }
        });
        return;
      }

      await setup({
        email: formData.email,
        displayName: formData.displayName,
        password: formData.password
      });
    } catch (err) {
      setError(
        mode === 'sso'
          ? 'SSO setup failed. Check the issuer and client details.'
          : 'Setup failed. Check the fields and try again.'
      );
    }
  };

  return (
    <main className='auth-shell'>
      <section className='auth-layout auth-layout-setup' aria-label='SnippyCode first-run setup'>
        <aside className='auth-intro' aria-hidden='true'>
          <div className='auth-mark'>
            <img src='/CodeSnippy.png' alt='' />
          </div>
          <div className='auth-brand-copy'>
            <p className='eyebrow'>First run</p>
            <h1>Claim this instance</h1>
            <p>
              {mode === 'sso'
                ? 'Connect your identity provider. Owner name and email come from SSO.'
                : 'Create the owner account before anyone can open the library. This workspace stays private to your team.'}
            </p>
          </div>
          <div className='auth-status-list'>
            <div className='auth-status-item'>
              <FontAwesomeIcon icon={faUserShield} />
              <span>
                {mode === 'sso'
                  ? 'First SSO login becomes owner'
                  : 'Owner owns the first account'}
              </span>
            </div>
            <div className='auth-status-item'>
              <FontAwesomeIcon icon={faShieldHalved} />
              <span>Auth is required from day one</span>
            </div>
            <div className='auth-status-item'>
              <FontAwesomeIcon icon={faKey} />
              <span>
                {mode === 'sso'
                  ? 'Local passwords stay unused'
                  : 'SSO can wait until later'}
              </span>
            </div>
          </div>
        </aside>

        <form className='auth-panel auth-login-panel' onSubmit={submitHandler}>
          <div className='auth-panel-heading'>
            <p className='eyebrow'>Owner setup</p>
            <h2>{mode === 'sso' ? 'Connect SSO' : 'Create the owner account'}</h2>
            <p>
              {mode === 'sso'
                ? 'Identity details come from your provider. You will sign in there next.'
                : 'Authentication is required before anyone can access snippets.'}
            </p>
          </div>

          <div className='auth-choice' role='group' aria-label='Authentication method'>
            <button
              type='button'
              className={`auth-choice-button${mode === 'local' ? ' is-active' : ''}`}
              onClick={() => setMode('local')}
            >
              <strong>Local</strong>
              <span>Email, display name, and a password stored on this instance.</span>
            </button>
            <button
              type='button'
              className={`auth-choice-button${mode === 'sso' ? ' is-active' : ''}`}
              onClick={() => setMode('sso')}
            >
              <strong>SSO</strong>
              <span>Owner name and email come from your identity provider.</span>
            </button>
          </div>

          {error && <div className='alert alert-danger auth-alert'>{error}</div>}

          {mode === 'local' ? (
            <div className='row g-3'>
              <div className='col-12 col-md-6'>
                <label className='form-label' htmlFor='setup-email'>
                  Email
                </label>
                <input
                  id='setup-email'
                  className='form-control'
                  type='email'
                  value={formData.email}
                  required
                  onChange={e => setFormData({ ...formData, email: e.target.value })}
                />
              </div>
              <div className='col-12 col-md-6'>
                <label className='form-label' htmlFor='setup-name'>
                  Display name
                </label>
                <input
                  id='setup-name'
                  className='form-control'
                  value={formData.displayName}
                  required
                  onChange={e =>
                    setFormData({ ...formData, displayName: e.target.value })
                  }
                />
              </div>
              <div className='col-12'>
                <label className='form-label' htmlFor='setup-password'>
                  Password
                </label>
                <input
                  id='setup-password'
                  className='form-control'
                  type='password'
                  minLength={10}
                  required
                  value={formData.password}
                  onChange={e => setFormData({ ...formData, password: e.target.value })}
                />
              </div>
            </div>
          ) : (
            <div className='row g-3'>
              <div className='col-12'>
                <label className='form-label' htmlFor='oidc-issuer'>
                  Issuer URL
                </label>
                <input
                  id='oidc-issuer'
                  className='form-control'
                  placeholder='https://auth.example.com/realms/app'
                  value={formData.issuerUrl}
                  required
                  onChange={e =>
                    setFormData({ ...formData, issuerUrl: e.target.value })
                  }
                />
              </div>
              <div className='col-12 col-md-6'>
                <label className='form-label' htmlFor='oidc-client'>
                  Client ID
                </label>
                <input
                  id='oidc-client'
                  className='form-control'
                  value={formData.clientId}
                  required
                  onChange={e =>
                    setFormData({ ...formData, clientId: e.target.value })
                  }
                />
              </div>
              <div className='col-12 col-md-6'>
                <label className='form-label' htmlFor='oidc-secret'>
                  Client secret
                </label>
                <input
                  id='oidc-secret'
                  className='form-control'
                  type='password'
                  value={formData.clientSecret}
                  required
                  onChange={e =>
                    setFormData({ ...formData, clientSecret: e.target.value })
                  }
                />
              </div>
              <div className='col-12'>
                <label className='form-label' htmlFor='oidc-redirect'>
                  Redirect URI
                </label>
                <input
                  id='oidc-redirect'
                  className='form-control'
                  value={formData.redirectUri}
                  required
                  onChange={e =>
                    setFormData({ ...formData, redirectUri: e.target.value })
                  }
                />
              </div>
            </div>
          )}

          <button type='submit' className='btn btn-primary auth-submit'>
            {mode === 'sso' ? 'Continue with SSO' : 'Finish setup'}
          </button>
        </form>
      </section>
    </main>
  );
};

const LoginScreen = (): JSX.Element => {
  const { login, oidcEnabled, localLoginEnabled, oidcProviderName } = useContext(AuthContext);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submitHandler = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const nextMfaToken = await login(email, password, mfaCode, mfaToken);

      if (nextMfaToken) {
        setMfaToken(nextMfaToken);
        setMfaCode('');
      }
    } catch (err) {
      setError(mfaToken ? 'Invalid MFA code.' : 'Invalid email or password.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className='auth-shell'>
      <section className='auth-layout' aria-label='SnippyCode sign in'>
        <aside className='auth-intro' aria-hidden='true'>
          <div className='auth-mark'>
            <img src='/CodeSnippy.png' alt='' />
          </div>
          <div className='auth-brand-copy'>
            <p className='eyebrow'>Secure workspace</p>
            <h1>SnippyCode</h1>
            <p>
              Sign in to manage snippets, raw links, GitHub sync, and server tasks.
            </p>
          </div>
          <div className='auth-status-list'>
            <div className='auth-status-item'>
              <FontAwesomeIcon icon={faUserShield} />
              <span>Role based access</span>
            </div>
            <div className='auth-status-item'>
              <FontAwesomeIcon icon={faFingerprint} />
              <span>MFA supported</span>
            </div>
            <div className='auth-status-item'>
              <FontAwesomeIcon icon={faCircleCheck} />
              <span>Raw links stay protected</span>
            </div>
          </div>
        </aside>

        <form className='auth-panel auth-login-panel' onSubmit={submitHandler}>
          <div className='auth-panel-heading'>
            <p className='eyebrow'>{mfaToken ? 'Second factor' : 'Sign in'}</p>
            <h2>{mfaToken ? 'Verify it is you' : 'Unlock SnippyCode'}</h2>
            <p>
              {mfaToken
                ? 'Enter the six digit code from your authenticator app.'
                : 'Use your local account or continue with an enabled OIDC provider.'}
            </p>
          </div>

          {error && (
            <div className='alert alert-danger auth-alert' role='alert'>
              {error}
            </div>
          )}

          {localLoginEnabled && (
            <>
              {!mfaToken && (
                <>
                  <label className='form-label' htmlFor='login-email'>
                    Email
                  </label>
                  <input
                    id='login-email'
                    className='form-control'
                    type='email'
                    autoComplete='email'
                    value={email}
                    required
                    disabled={submitting}
                    onChange={e => setEmail(e.target.value)}
                  />

                  <label className='form-label' htmlFor='login-password'>
                    Password
                  </label>
                  <div className='password-field'>
                    <input
                      id='login-password'
                      className='form-control'
                      type={showPassword ? 'text' : 'password'}
                      autoComplete='current-password'
                      value={password}
                      required
                      disabled={submitting}
                      onChange={e => setPassword(e.target.value)}
                    />
                    <button
                      type='button'
                      className='password-toggle'
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      <FontAwesomeIcon icon={showPassword ? faEyeSlash : faEye} />
                    </button>
                  </div>
                </>
              )}

              {mfaToken && (
                <div className='auth-mfa-step'>
                  <div className='auth-mfa-icon'>
                    <FontAwesomeIcon icon={faKey} />
                  </div>
                  <label className='form-label' htmlFor='login-mfa'>
                    Authentication code
                  </label>
                  <input
                    id='login-mfa'
                    className='form-control'
                    inputMode='numeric'
                    autoComplete='one-time-code'
                    pattern='[0-9]*'
                    maxLength={8}
                    value={mfaCode}
                    required
                    disabled={submitting}
                    onChange={e => setMfaCode(e.target.value.replace(/\D/g, ''))}
                  />
                </div>
              )}

              <button
                type='submit'
                className='btn btn-primary auth-submit'
                disabled={submitting}
              >
                <FontAwesomeIcon icon={mfaToken ? faShieldHalved : faRightToBracket} />
                <span>
                  {submitting
                    ? 'Checking...'
                    : mfaToken
                    ? 'Verify and sign in'
                    : 'Sign in'}
                </span>
              </button>

              {mfaToken && (
                <button
                  type='button'
                  className='auth-secondary-action'
                  disabled={submitting}
                  onClick={() => {
                    setMfaToken('');
                    setMfaCode('');
                    setError('');
                  }}
                >
                  Use another account
                </button>
              )}
            </>
          )}

          {localLoginEnabled && oidcEnabled && (
            <div className='auth-divider'>
              <span>or</span>
            </div>
          )}

          {oidcEnabled && !mfaToken && (
            <a
              className='btn btn-outline-secondary auth-submit auth-oidc-button'
              href='/api/auth/oidc/start'
            >
              <FontAwesomeIcon icon={faShieldHalved} />
              <span>Continue with {oidcProviderName}</span>
            </a>
          )}

          {!localLoginEnabled && !oidcEnabled && (
            <div className='alert alert-danger auth-alert' role='alert'>
              No login methods are enabled. Use the first run setup or database access
              to restore an authentication method.
            </div>
          )}
        </form>
      </section>
    </main>
  );
};
