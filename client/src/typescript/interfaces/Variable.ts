export type VariableScope = 'team' | 'personal' | 'site';

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
  team: Variable[];
  personal: Variable[];
  site: Variable[];
  canEditTeam: boolean;
}
