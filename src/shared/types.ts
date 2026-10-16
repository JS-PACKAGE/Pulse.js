// Wire contract shared by agent, server and web panel (see PLAN.md §4, §5).

export const OS_FAMILIES = ['linux-deb', 'linux-rpm', 'macos'] as const;
export type OsFamily = (typeof OS_FAMILIES)[number];

export const GPU_VENDORS = ['nvidia', 'amd', 'apple'] as const;
export type GpuVendor = (typeof GPU_VENDORS)[number];

export const HOST_STATUSES = ['ok', 'alert', 'offline'] as const;
export type HostStatus = (typeof HOST_STATUSES)[number];

/** One GPU card. A `null` field means the value is N/A (tool lacks it or no permission). */
export interface GpuInfo {
  index: number;
  name: string;
  vendor: GpuVendor;
  utilPercent: number | null;
  memUsedMB: number | null;
  memTotalMB: number | null;
}

/** A `null` field means that collector failed this cycle (fail-closed, never guessed). */
export interface SystemMetrics {
  /** 1-minute load average normalised by logical CPU count, in percent (may exceed 100). */
  cpuLoadPercent: number | null;
  memUsedMB: number | null;
  memTotalMB: number | null;
  diskUsedGB: number | null;
  diskTotalGB: number | null;
  /** Kilobits per second (1 kbit = 1000 bit) on the primary interface. */
  netRxKbps: number | null;
  netTxKbps: number | null;
}

export const METRIC_KEYS = [
  'cpuLoadPercent',
  'memUsedMB',
  'memTotalMB',
  'diskUsedGB',
  'diskTotalGB',
  'netRxKbps',
  'netTxKbps',
] as const satisfies readonly (keyof SystemMetrics)[];

export interface RegisterRequest {
  hostname: string;
  osFamily: OsFamily;
  osVersion: string;
  arch: string;
  cpuModel: string;
  gpuCount: number;
  agentVersion: string;
}

export interface RegisterResponse {
  hostId: number;
  /** Report period the server wants (config.yaml `agent.reportIntervalSec`). */
  reportIntervalSec: number;
}

/** Result of the agent's last successful OS update check (it only checks, never installs). */
export interface OsUpdates {
  /** When the check finished, epoch milliseconds. */
  checkedAt: number;
  /** Packages (Linux) or software updates (macOS) waiting to be installed. */
  pending: number;
  /** How many of `pending` come from security sources; `null` when the platform does not say (macOS). */
  security: number | null;
}

export interface ReportRequest {
  hostId: number;
  /** Collection time, epoch milliseconds. */
  ts: number;
  metrics: SystemMetrics;
  /** `null` = GPU collection failed this cycle (N/A); `[]` = no GPU present. */
  gpus: GpuInfo[] | null;
  /** `null` = no successful update check yet; the server keeps what it already has. */
  updates: OsUpdates | null;
}

export interface ReportResponse {
  status: HostStatus;
}

export const THRESHOLD_METRICS = [
  'cpuLoadPercent',
  'memUsedPercent',
  'diskUsedPercent',
  'gpuUtilPercent',
  'gpuMemUsedPercent',
  'netRxKbps',
  'netTxKbps',
] as const;
export type ThresholdMetric = (typeof THRESHOLD_METRICS)[number];

export interface Threshold {
  warn: number;
  crit: number;
}
export type Thresholds = Record<ThresholdMetric, Threshold>;

export type AlertLevel = 'warn' | 'crit';

export interface AlertItem {
  metric: ThresholdMetric;
  level: AlertLevel;
  value: number;
  threshold: number;
  /** Present for GPU metrics. */
  gpu?: { vendor: GpuVendor; index: number; name: string };
}

export interface LatestSample {
  ts: number;
  metrics: SystemMetrics;
  gpus: GpuInfo[];
}

export interface HostSummary {
  id: number;
  hostname: string;
  osFamily: OsFamily;
  osVersion: string;
  arch: string;
  cpuModel: string;
  gpuCount: number;
  agentVersion: string;
  firstSeen: number;
  lastSeen: number;
  status: HostStatus;
  /** Epoch ms when the current status began (used for "duration"). */
  statusSince: number;
  alerts: AlertItem[];
  latest: LatestSample | null;
  /** `null` until the agent's first successful update check reaches the server. */
  updates: OsUpdates | null;
  /** Custom group ids this host belongs to. */
  customGroupIds: number[];
}

export interface ListHostsResponse {
  now: number;
  thresholds: Thresholds;
  offlineAfterSec: number;
  hosts: HostSummary[];
}

export interface MetricPoint extends SystemMetrics {
  ts: number;
}

export interface GpuPoint {
  ts: number;
  utilPercent: number | null;
  memUsedMB: number | null;
  memTotalMB: number | null;
}

export interface GpuSeries {
  vendor: GpuVendor;
  index: number;
  name: string;
  points: GpuPoint[];
}

export interface HostDetailResponse {
  now: number;
  thresholds: Thresholds;
  host: HostSummary;
  /** Inclusive lower bound of the series window, epoch ms. */
  since: number;
  series: MetricPoint[];
  gpuSeries: GpuSeries[];
}

export type GroupKind = 'system' | 'custom';

export interface Group {
  id: number;
  name: string;
  kind: GroupKind;
  /** Set for system groups only. */
  osFamily: OsFamily | null;
  hostIds: number[];
}

export interface ListGroupsResponse {
  groups: Group[];
}

export interface GroupNameRequest {
  name: string;
}

export type ApiErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'internal_error';

export interface ApiError {
  error: ApiErrorCode;
  /** Field-level validation messages (400 only). Never contains internals. */
  details?: string[];
}

/** Server-Sent Events pushed on `GET /api/events`. */
export type PulseEvent =
  | { type: 'status'; hostId: number; status: HostStatus; prevStatus: HostStatus; ts: number }
  | { type: 'report'; hostId: number; ts: number }
  | { type: 'hostDeleted'; hostId: number }
  | { type: 'host'; hostId: number }
  | { type: 'groups' };
