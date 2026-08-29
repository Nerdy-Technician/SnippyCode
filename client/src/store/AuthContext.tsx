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
  oidcProviderName: string;
  user: AuthUser | null;
  snippetRun: {
    enabled: boolean;
    languages: string[];
    timeoutMs: number;
  };
  snippetAssist: {
    enabled: boolean;
    providers: { id: 'openai' | 'anthropic'; label: string }[];
  };
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
  oidcProviderName: 'Keycloak',
  user: null,
  snippetRun: {
    enabled: false,
    languages: [],
    timeoutMs: 15000
  },
  snippetAssist: {
    enabled: false,
    providers: []
  },
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
  const [oidcProviderName, setOidcProviderName] = useState('Keycloak');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [snippetRun, setSnippetRun] = useState({
    enabled: false,
    languages: [] as string[],
    timeoutMs: 15000
  });
  const [snippetAssist, setSnippetAssist] = useState({
    enabled: false,
    providers: [] as { id: 'openai' | 'anthropic'; label: string }[]
  });

  const applyStatus = (status: AuthStatus) => {
    setNeedsSetup(status.needsSetup);
    setOidcEnabled(status.oidcEnabled);
    setLocalLoginEnabled(status.localLoginEnabled);
    setOidcProviderName(status.oidcProviderName || 'Keycloak');
    setUser(status.user);
    setSnippetRun(
      status.snippetRun || {
        enabled: false,
        languages: [],
        timeoutMs: 15000
      }
    );
    setSnippetAssist(
      status.snippetAssist || {
        enabled: false,
        providers: []
      }
    );
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
    const res = await axios.post<Response<AuthUser | { pendingOidc: boolean }>>(
      '/api/auth/setup',
      payload
    );

    if ('pendingOidc' in res.data.data && res.data.data.pendingOidc) {
      window.location.assign('/api/auth/oidc/start');
      return;
    }

    setNeedsSetup(false);
    setUser(res.data.data as AuthUser);
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
        oidcProviderName,
        user,
        snippetRun,
        snippetAssist,
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
