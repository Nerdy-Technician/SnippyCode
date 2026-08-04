import axios from 'axios';
import { createContext, useCallback, useEffect, useState } from 'react';
import {
  AuthStatus,
  AuthUser,
  Response,
  SetupPayload
} from '../typescript/interfaces';

interface AuthContextValue {
  loading: boolean;
  needsSetup: boolean;
  oidcEnabled: boolean;
  localLoginEnabled: boolean;
  user: AuthUser | null;
  refreshAuth: () => void;
  setup: (payload: SetupPayload) => Promise<void>;
  login: (email: string, password: string, mfaCode?: string, mfaToken?: string) => Promise<string | null>;
  logout: () => Promise<void>;
  updateProfile: (profile: { email: string; displayName: string }) => Promise<void>;
  uploadAvatar: (file: File) => Promise<void>;
  deleteAvatar: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  loading: true,
  needsSetup: false,
  oidcEnabled: false,
  localLoginEnabled: true,
  user: null,
  refreshAuth: () => {},
  setup: async () => {},
  login: async () => null,
  logout: async () => {},
  updateProfile: async () => {},
  uploadAvatar: async () => {},
  deleteAvatar: async () => {}
});

interface Props {
  children: JSX.Element | JSX.Element[];
}

axios.defaults.withCredentials = true;

export const AuthContextProvider = (props: Props): JSX.Element => {
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [localLoginEnabled, setLocalLoginEnabled] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);

  const applyStatus = (status: AuthStatus) => {
    setNeedsSetup(status.needsSetup);
    setOidcEnabled(status.oidcEnabled);
    setLocalLoginEnabled(status.localLoginEnabled);
    setUser(status.user);
  };

  const refreshAuth = useCallback((): void => {
    axios
      .get<Response<AuthStatus>>('/api/auth/status')
      .then(res => applyStatus(res.data.data))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  const setup = async (payload: SetupPayload): Promise<void> => {
    const res = await axios.post<Response<AuthUser>>('/api/auth/setup', payload);
    setNeedsSetup(false);
    setUser(res.data.data);
  };

  const login = async (
    email: string,
    password: string,
    mfaCode?: string,
    mfaToken?: string
  ): Promise<string | null> => {
    const res = await axios.post<Response<AuthUser | { mfaRequired: boolean; mfaToken: string }>>('/api/auth/login', {
      email,
      password,
      mfaCode,
      mfaToken
    });

    if ('mfaRequired' in res.data.data) {
      return res.data.data.mfaToken;
    }

    setUser(res.data.data);
    setNeedsSetup(false);
    return null;
  };

  const logout = async (): Promise<void> => {
    await axios.post('/api/auth/logout');
    setUser(null);
  };

  const updateProfile = async (profile: {
    email: string;
    displayName: string;
  }): Promise<void> => {
    const res = await axios.put<Response<AuthUser>>('/api/auth/me', profile);
    setUser(res.data.data);
  };

  const uploadAvatar = async (file: File): Promise<void> => {
    const data = new FormData();
    data.append('avatar', file);
    const res = await axios.post<Response<AuthUser>>('/api/auth/me/avatar', data);
    setUser(res.data.data);
  };

  const deleteAvatar = async (): Promise<void> => {
    const res = await axios.delete<Response<AuthUser>>('/api/auth/me/avatar');
    setUser(res.data.data);
  };

  return (
    <AuthContext.Provider
      value={{
        loading,
        needsSetup,
        oidcEnabled,
        localLoginEnabled,
        user,
        refreshAuth,
        setup,
        login,
        logout,
        updateProfile,
        uploadAvatar,
        deleteAvatar
      }}
    >
      {props.children}
    </AuthContext.Provider>
  );
};
