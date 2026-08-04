import { ChangeEvent, FormEvent, useContext, useEffect, useState } from 'react';
import axios from 'axios';
import { AuthContext, ThemeContext } from '../../store';
import { AuthUser, Response } from '../../typescript/interfaces';

interface Props {
  close: () => void;
}

export const ProfileModal = (props: Props): JSX.Element | null => {
  const { user, updateProfile, uploadAvatar, deleteAvatar, logout } =
    useContext(AuthContext);
  const { primaryColor, setPrimaryColor, resetPrimaryColor } =
    useContext(ThemeContext);
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [email, setEmail] = useState(user?.email || '');
  const [mfaQr, setMfaQr] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [error, setError] = useState('');
  const [primaryDraft, setPrimaryDraft] = useState(primaryColor);

  useEffect(() => {
    setPrimaryDraft(primaryColor);
  }, [primaryColor]);

  if (!user) {
    return null;
  }

  const submitHandler = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      await updateProfile({ displayName, email });
      props.close();
    } catch (err) {
      setError('Profile update failed.');
    }
  };

  const avatarHandler = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];

    if (file) {
      try {
        setError('');
        await uploadAvatar(file);
      } catch (err) {
        setError('Avatar upload failed.');
      }
    }
  };

  const deleteAvatarHandler = async () => {
    setError('');

    try {
      await deleteAvatar();
    } catch (err) {
      setError('Avatar removal failed.');
    }
  };

  const setupMfa = async () => {
    const res = await axios.post<Response<{ qrCode: string; secret: string }>>(
      '/api/auth/me/mfa/setup'
    );
    setMfaQr(res.data.data.qrCode);
  };

  const enableMfa = async () => {
    await axios.post<Response<AuthUser>>('/api/auth/me/mfa/enable', {
      code: mfaCode
    });
    window.location.reload();
  };

  const disableMfa = async () => {
    await axios.post<Response<AuthUser>>('/api/auth/me/mfa/disable');
    window.location.reload();
  };

  return (
    <div className='profile-backdrop' role='dialog' aria-modal='true'>
      <div className='profile-modal'>
        <div className='profile-modal-header'>
          <div>
            <p className='eyebrow'>Profile</p>
            <h2>{user.displayName}</h2>
            <p>Manage your account identity and profile picture.</p>
          </div>
          <button type='button' className='profile-close' onClick={props.close}>
            Close
          </button>
        </div>
        {error && <div className='alert alert-danger'>{error}</div>}
        <div className='profile-modal-body'>
          <aside className='profile-avatar-panel'>
            <img src={user.avatarUrl} alt='' />
            <div>
              <h3>{user.displayName}</h3>
              <p>{user.email}</p>
            </div>
            <div className='profile-avatar-actions'>
              <label className='btn btn-outline-secondary'>
                Upload picture
                <input
                  type='file'
                  accept='image/png,image/jpeg'
                  hidden
                  onChange={avatarHandler}
                />
              </label>
              <button
                type='button'
                className='btn btn-outline-danger'
                onClick={deleteAvatarHandler}
              >
                Remove picture
              </button>
            </div>
            <p className='profile-hint'>
              If no image is uploaded, SnippyCode will use your Gravatar when
              one is available.
            </p>
          </aside>
          <form className='profile-form' onSubmit={submitHandler}>
            <label className='form-label' htmlFor='profile-name'>
              Display name
            </label>
            <input
              id='profile-name'
              className='form-control mb-3'
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
            />
            <label className='form-label' htmlFor='profile-email'>
              Email
            </label>
            <input
              id='profile-email'
              className='form-control mb-3'
              type='email'
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
            <div className='profile-meta'>
              <span>Role</span>
              <strong>{user.isOwner ? 'Owner' : 'Member'}</strong>
            </div>
            <div className='profile-meta'>
              <span>MFA</span>
              <strong>{user.mfaEnabled ? 'Enabled' : 'Disabled'}</strong>
            </div>
            <section className='profile-theme-panel'>
              <div>
                <p className='eyebrow'>Appearance</p>
                <h3>Primary colour</h3>
              </div>
              <div className='profile-color-row'>
                <label
                  className='profile-color-swatch'
                  style={{ backgroundColor: primaryColor }}
                  htmlFor='profile-primary-color'
                >
                  <span className='visually-hidden'>Primary colour</span>
                  <input
                    id='profile-primary-color'
                    type='color'
                    value={primaryColor}
                    onChange={e => {
                      setPrimaryDraft(e.target.value);
                      setPrimaryColor(e.target.value);
                    }}
                  />
                </label>
                <input
                  className='form-control'
                  value={primaryDraft}
                  maxLength={7}
                  onChange={e => {
                    setPrimaryDraft(e.target.value);
                    setPrimaryColor(e.target.value);
                  }}
                />
                <button
                  type='button'
                  className='btn btn-outline-secondary'
                  onClick={() => {
                    setPrimaryDraft('#66d9c2');
                    resetPrimaryColor();
                  }}
                >
                  Reset
                </button>
              </div>
            </section>
            <div className='mfa-box'>
              {mfaQr && <img src={mfaQr} alt='' />}
              {mfaQr ? (
                <>
                  <input
                    className='form-control'
                    placeholder='6-digit code'
                    value={mfaCode}
                    onChange={e => setMfaCode(e.target.value)}
                  />
                  <button type='button' className='btn btn-primary' onClick={enableMfa}>
                    Enable MFA
                  </button>
                </>
              ) : (
                <button
                  type='button'
                  className='btn btn-outline-secondary'
                  onClick={user.mfaEnabled ? disableMfa : setupMfa}
                >
                  {user.mfaEnabled ? 'Disable MFA' : 'Set up MFA'}
                </button>
              )}
            </div>
            <div className='profile-actions'>
              <button
                type='button'
                className='btn btn-outline-danger'
                onClick={logout}
              >
                Sign out
              </button>
              <button type='submit' className='btn btn-primary'>
                Save profile
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
