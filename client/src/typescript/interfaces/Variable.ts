/** Global (admin-only), Site and User. Pre-1.3 servers said team/personal. */
export type VariableScope = 'global' | 'site' | 'user';

export interface Variable {
  id: number;
  name: string;
  /** Always empty for secrets; use the reveal endpoint */
  value: string;
  description: string;
  scope: VariableScope;
  siteId: number | null;
  isSecret: boolean;
  hasValue: boolean;
  updatedAt: string;
}

export interface VariableList {
  global: Variable[];
  user: Variable[];
  canEditGlobal: boolean;
  canEditSite: boolean;
  /** Pre-1.3 names for global and user */
  team: Variable[];
  personal: Variable[];
  site: Variable[];
  canEditTeam: boolean;
}

export type VariableSourceName = 'prompt' | 'user' | 'device' | 'site' | 'global' | 'default' | 'missing';

export interface ResolvedVariable {
  name: string;
  value: string;
  source: VariableSourceName;
  isSecret: boolean;
  ref?: string;
}

export interface VariableUsage {
  snippets: Array<{ id: number; title: string }>;
  runbooks: Array<{ id: number; title: string }>;
  schedules: Array<{ id: number; name: string }>;
}
