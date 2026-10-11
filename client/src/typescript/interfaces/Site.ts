export type SiteAccess = 'everyone' | 'members';

export interface Site {
  id: number;
  name: string;
  slug: string;
  description: string;
  tags: string[];
  access: SiteAccess;
  memberIds?: number[];
  /** Members who may manage this site's enrolment tokens */
  adminIds?: number[];
  variableCount?: number;
  lastRunAt?: string | null;
  deviceCount?: number;
  devicesOnline?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SiteRef {
  id: number;
  name: string;
  slug: string;
}

export interface SnippetRunRecord {
  id: number;
  snippetId: number | null;
  snippetTitle: string;
  site: SiteRef | null;
  user: { id: number; displayName: string } | null;
  runbookRunId: number | null;
  scheduleRunId?: number | null;
  deviceId?: number | null;
  deviceName?: string | null;
  sandbox?: string | null;
  language: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  createdAt: string;
  stdout: string;
  stderr: string;
  truncated?: boolean;
}
