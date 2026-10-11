import type { VariableDefinition } from '../../utils/snippetVariables';
import { SiteRef, SnippetRunRecord } from './Site';

export interface RunbookStep {
  id?: number;
  position?: number;
  snippetId: number | null;
  title: string;
  note: string;
  values?: Record<string, string>;
  snippet?: { id: number; title: string; language: string; variables?: VariableDefinition[] } | null;
}

export interface Runbook {
  id: number;
  title: string;
  description: string;
  steps: RunbookStep[];
  updatedAt: string;
  dangerous?: boolean;
}

export type RunbookRunStatus = 'in_progress' | 'completed' | 'cancelled' | 'failed' | 'attention';
export type RunbookStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface RunbookRunSummary {
  id: number;
  runbookId: number | null;
  runbookTitle: string;
  site: SiteRef | null;
  user: { id: number; displayName: string } | null;
  device?: { id: number; name: string } | null;
  scheduled?: boolean;
  status: RunbookRunStatus;
  createdAt: string;
  completedAt: string | null;
  progress: { total: number; finished: number; failed: number };
}

export interface RunbookListItem {
  id: number;
  title: string;
  description: string;
  stepCount: number;
  dangerous?: boolean;
  updatedAt: string;
  lastRun: RunbookRunSummary | null;
}

export interface RunbookRunStepState extends RunbookStep {
  id: number;
  status: RunbookStepStatus;
  completedAt: string | null;
  completedBy: string | null;
  lastRun: SnippetRunRecord | null;
}

export interface RunbookRunDetail extends RunbookRunSummary {
  steps: RunbookRunStepState[];
}
