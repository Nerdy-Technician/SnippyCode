export interface AuthUser {
  id: number;
  email: string;
  displayName: string;
  avatarUrl: string;
  isOwner: boolean;
  role: 'owner' | 'admin' | 'editor' | 'viewer' | 'user';
  mfaEnabled: boolean;
}

export interface AuthStatus {
  needsSetup: boolean;
  oidcEnabled: boolean;
  localLoginEnabled: boolean;
  oidcProviderName?: string;
  user: AuthUser | null;
  snippetRun?: {
    enabled: boolean;
    languages: string[];
    timeoutMs: number;
  };
  snippetAssist?: {
    enabled: boolean;
    providers: { id: 'openai' | 'anthropic'; label: string }[];
  };
}

export interface SetupPayload {
  email?: string;
  displayName?: string;
  password?: string;
  oidc?: {
    enabled: boolean;
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes?: string;
    subjectClaim?: string;
    emailClaim?: string;
    nameClaim?: string;
    matchMode?: 'subject' | 'email' | 'subject_or_email';
    allowSignup?: boolean;
    provider?: string;
    providerName?: string;
  };
}
