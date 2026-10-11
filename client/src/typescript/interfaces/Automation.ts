import { SnippetRunRecord } from './Site';

export interface Device {
  id: number;
  siteId: number;
  name: string;
  hostname: string;
  os: string;
  arch: string;
  agentVersion: string;
  capabilities: string[];
  lastSeenAt: string | null;
  lastIp: string | null;
  online: boolean;
  createdAt: string;
  facts: DeviceFacts;
  factsAt: string | null;
  latestAgentVersion: string;
  updateAvailable: boolean;
  /** Stable agent ID (UUID) sent by the agent; null for older agents */
  agentId?: string | null;
  /** Hint only: shares hostname/OS/arch or machine ID with other devices */
  possibleDuplicate?: boolean;
  /** Self-enrolled clone waiting for an admin; it gets no jobs until approved */
  clonePendingApproval?: boolean;
  status?: 'active' | 'pending_approval' | 'revoked';
  clonedFrom?: number | null;
  fingerprintPendingReview?: boolean;
  duplicateOf?: number[];
  lastRun: { id: number; snippetTitle: string; ok: boolean; createdAt: string } | null;
  tags?: string[];
}

export interface DeviceFacts {
  osName?: string;
  kernel?: string;
  cpus?: number;
  memTotalMb?: number;
  memAvailableMb?: number;
  diskTotalGb?: number;
  diskUsedGb?: number;
  uptimeSeconds?: number;
  ip?: string;
  timezone?: string;
}

export type EnrollmentStatus = 'active' | 'expired' | 'used' | 'revoked';

/** An enrolment token as listed (the token itself is never listed) */
export interface EnrollmentToken {
  id: number;
  siteId: number;
  site: { id: number; name: string } | null;
  label: string;
  allowReenrol: boolean;
  tokenPrefix: string;
  /** null = unlimited until it expires or is revoked */
  maxUses: number | null;
  uses: number;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: EnrollmentStatus;
}

/** Returned once, when a token is created */
export interface Enrollment extends EnrollmentToken {
  token: string;
  linux: string;
  windows: string;
}

export type AgentJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'expired';

export interface AgentJobState {
  id: number;
  status: AgentJobStatus;
  deviceId: number;
  deviceName: string | null;
  createdAt: string;
  startedAt: string | null;
  run: SnippetRunRecord | null;
}

export type ScheduleSiteMode = 'none' | 'sites' | 'tag' | 'all' | 'policy' | 'devices';

export interface Schedule {
  id: number;
  name: string;
  targetType: 'snippet' | 'runbook';
  snippetId: number | null;
  runbookId: number | null;
  target: { id: number; title: string; language?: string } | null;
  cron: string;
  timezone: string;
  siteMode: ScheduleSiteMode;
  siteIds: number[];
  siteNames: string[];
  siteTag: string;
  deviceIds: number[];
  deviceTag: string;
  variables?: Record<string, string>;
  deviceTagIds?: number[];
  deviceTags?: Array<{ id: number; name: string; color: string | null }>;
  policyId: number | null;
  policyName: string | null;
  runOn: 'server' | 'devices';
  notifyOn: 'failure' | 'always' | 'never';
  enabled: boolean;
  createdBy: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  nextRunAt: string | null;
}

export interface ScheduleRunSummary {
  id: number;
  status: 'running' | 'succeeded' | 'failed' | 'attention' | 'missed';
  trigger: 'schedule' | 'manual';
  createdAt: string;
  finishedAt: string | null;
  pendingJobs: number;
  results: SnippetRunRecord[];
  runbookRuns: { id: number; status: string; site: string | null }[];
}

export interface ScheduleDeviceResult {
  deviceId: number;
  deviceName: string;
  site: string | null;
  kind: 'snippet' | 'runbook';
  status: string;
  ok: boolean | null;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  snippetRunId?: number | null;
  runbookRunId?: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ScheduleRunDevices {
  id: number;
  status: string;
  devices: ScheduleDeviceResult[];
}

export interface ScheduleDetail extends Schedule {
  runs: ScheduleRunSummary[];
}

export type WebhookType = 'slack' | 'teams' | 'discord' | 'webhook';

export interface NotificationChannel {
  id: number;
  name: string;
  type: WebhookType;
  host: string;
  hasSigningSecret: boolean;
  events: string[];
  siteIds: number[];
  enabled: boolean;
  lastStatus: string | null;
  lastError: string | null;
  lastDeliveredAt: string | null;
}

export interface StoredBackup {
  name: string;
  size: number;
  createdAt: string;
  encrypted: boolean;
}

export interface BackupScheduleSettings {
  enabled: boolean;
  everyHours: number;
  keep: number;
  includeHistory: boolean;
  hasPassphrase: boolean;
  lastBackupAt: string | null;
  lastError: string | null;
}

export interface LintDiagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

export interface LintResult {
  tool: string | null;
  available: boolean;
  diagnostics: LintDiagnostic[];
  error?: string;
}

// Device page and tools -------------------------------------------------------

export type ReadToolId = 'system' | 'services' | 'tasks' | 'processes' | 'software' | 'updates' | 'logs';

export interface ServiceInfo {
  name: string;
  displayName: string;
  status: 'running' | 'stopped' | 'failed' | 'other';
  state: string;
  startup: string;
  account?: string;
}

export interface TaskInfo {
  id: string;
  kind: 'cron' | 'timer' | 'periodic' | 'windows';
  name: string;
  schedule: string;
  user?: string;
  command: string;
  source: string;
  nextRun?: string;
  lastRun?: string;
  lastResult?: string;
  enabled: boolean;
  state?: string;
  /** Cron: the line as written in the file, and which crontab/file it lives in */
  raw?: string;
  target?: string;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  user?: string;
  cpu: number;
  cpuUnit: 'percent' | 'seconds';
  memMb: number;
  elapsedSeconds?: number;
}

export interface SoftwareInfo {
  name: string;
  version: string;
  publisher?: string;
  installed?: string;
}

export interface UpdateInfo {
  name: string;
  version?: string;
  from?: string;
  source?: string;
  security: boolean;
}

export interface LogEntry {
  time: string;
  level: string;
  source: string;
  message: string;
}

export interface SystemAudit {
  os?: string;
  kernel?: string;
  arch?: string;
  hostname?: string;
  manufacturer?: string;
  model?: string;
  serial?: string;
  cpu?: string;
  cores?: number;
  load?: string;
  boot?: string;
  users?: string;
  memTotalMb?: number;
  disks: { mount: string; device: string; type: string; totalGb: number; usedGb: number }[];
  networks: { name: string; address: string }[];
}

export interface InventoryEntry<T> {
  at: string;
  data?: T;
  error?: string | null;
}

export interface DeviceInventory {
  system?: InventoryEntry<SystemAudit>;
  services?: InventoryEntry<ServiceInfo[]>;
  tasks?: InventoryEntry<TaskInfo[]>;
  processes?: InventoryEntry<ProcessInfo[]>;
  software?: InventoryEntry<SoftwareInfo[]>;
  updates?: InventoryEntry<{ reboot: boolean; updates: UpdateInfo[] }>;
  logs?: InventoryEntry<LogEntry[]>;
}

export interface ToolJob {
  id: number;
  status: AgentJobStatus;
  tool: string | null;
  title: string;
  createdAt: string;
}

export interface DeviceDetail extends Device {
  site: { id: number; name: string; slug: string };
  toolOs: 'linux' | 'windows' | null;
  tools: { id: ReadToolId; label: string }[];
  inventory: DeviceInventory;
  pendingJobs: ToolJob[];
  canAct: boolean;
  fields: DeviceFields;
  remote: DeviceRemote;
}

export interface DeviceFields {
  assetTag?: string;
  owner?: string;
  location?: string;
  warranty?: string;
  notes?: string;
  custom?: { [name: string]: string };
}

export type RemoteType = 'rustdesk' | 'vnc' | 'rdp' | 'ssh' | 'url';

export interface DeviceRemote {
  type?: RemoteType;
  address?: string;
  port?: number;
  username?: string;
  remoteId?: string;
  hasPassword?: boolean;
}

export interface MetricPoint {
  at: string;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  online: number | null;
}

export interface DeviceMetrics {
  range: '24h' | '7d' | '30d';
  points: MetricPoint[];
  availability: number | null;
}

export interface FileEntry {
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size: number;
  modified: string | null;
  mode: string;
  owner: string;
}

export type AlertStatus = 'open' | 'acknowledged' | 'resolved';

export interface AlertItem {
  id: number;
  type: string;
  severity: 'warning' | 'critical';
  title: string;
  detail: string;
  status: AlertStatus;
  snoozed: boolean;
  snoozedUntil: string | null;
  device: { id: number; name: string; os: string; online: boolean } | null;
  site: { id: number; name: string } | null;
  policy: string | null;
  createdAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface AlertCounts {
  active: number;
  critical: number;
  unacknowledged: number;
  snoozed: number;
}

export type MonitorType = 'offline' | 'disk' | 'memory' | 'cpu' | 'service' | 'process' | 'failed_units' | 'reboot' | 'updates';

export interface PolicyMonitor {
  id?: number;
  type: MonitorType;
  params: { [key: string]: any };
  severity: 'warning' | 'critical';
  enabled: boolean;
}

export interface PolicyScope {
  all?: boolean;
  siteIds?: number[];
  tags?: string[];
  deviceIds?: number[];
  os?: 'any' | 'linux' | 'windows';
}

export interface PatchSettings {
  enabled?: boolean;
  cron?: string;
  timezone?: string;
  mode?: 'security' | 'all';
  reboot?: 'never' | 'if-required' | 'always';
}

export interface Policy {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  scope: PolicyScope;
  settings: { patch?: PatchSettings };
  monitors: PolicyMonitor[];
  schedules: { id: number; name: string; cron: string; enabled: boolean }[];
  deviceCount: number;
  openAlerts: number;
  lastPatchAt: string | null;
  nextPatchAt: string | null;
  updatedAt: string;
}

export interface SiteHealth {
  devices: number;
  online: number;
  alerts: number;
  critical: number;
  compliance: number | null;
  runs30d: number;
  lastActivityAt: string | null;
}

export interface PatchRow {
  id: number;
  name: string;
  os: string;
  toolOs: 'linux' | 'windows' | null;
  online: boolean;
  checkedAt: string | null;
  pending: number;
  security: number;
  reboot: boolean;
  compliant: boolean | null;
  lastPatch: { id: number; status: AgentJobStatus; at: string; runId: number | null } | null;
  window: { policy: string; nextAt: string | null } | null;
}

export interface DeviceListItem extends Device {
  site: { id: number; name: string; slug: string } | null;
}
