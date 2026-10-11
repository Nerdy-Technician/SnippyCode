export interface RunApproval {
  id: number;
  kind: 'snippet' | 'runbook' | 'schedule';
  title: string;
  why: string[];
  trigger: 'manual' | 'schedule';
  reason: string;
  snippetId: number | null;
  runbookId: number | null;
  scheduleId: number | null;
  siteId: number | null;
  targets: Array<{ type: string; id: number | null; name: string }>;
  targetCount: number;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'failed' | 'stale';
  /** The code / steps that were requested (never variable values) */
  contentPreview?: string;
  siteIds?: number[];
  requestedBy: number | null;
  requestedByName: string | null;
  decidedBy: number | null;
  decidedByName: string | null;
  decisionComment: string;
  decidedAt: string | null;
  expiresAt: string;
  result: string;
  createdAt: string;
  canDecide?: boolean;
}

/** A run response that was held for approval instead of starting */
export const heldApproval = (data: unknown): RunApproval | null =>
  data && typeof data === 'object' && (data as { approval?: RunApproval }).approval
    ? (data as { approval: RunApproval }).approval
    : null;

export const describeWhy = (why: string[]): string =>
  why
    .map(item => (item === 'dangerous' ? 'flagged dangerous' : item === 'large' ? 'many devices' : item))
    .join(' and ');

export const approvalMessage = (approval: RunApproval): string =>
  `This run is ${describeWhy(approval.why)}, so it is waiting for an admin to approve it (request #${approval.id}). It starts as soon as it is approved.`;
