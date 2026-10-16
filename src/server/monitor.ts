// Host lifecycle: registration, reports, alert/offline status and retention.
import type {
  HostDetailResponse,
  HostStatus,
  HostSummary,
  ListHostsResponse,
  RegisterRequest,
  RegisterResponse,
  ReportRequest,
} from '../shared/types.ts';
import { evaluateAlerts } from './alerts.ts';
import type { ServerConfig } from './config.ts';
import type { EventHub } from './events.ts';
import type { HostRow, Store } from './store.ts';

export type ReportOutcome =
  | { kind: 'ok'; status: HostStatus }
  | { kind: 'unknown_host' }
  | { kind: 'rate_limited'; retryAfterSec: number };

/** Longest selectable history range: 30 days. */
export const MAX_DETAIL_MINUTES = 30 * 24 * 60;
/** Upper bound on points per series; longer ranges are averaged into wider buckets. */
const MAX_SERIES_POINTS = 720;

export class Monitor {
  /** hostId → server time of the last accepted report (per-host rate limit, rule 6). */
  private readonly lastAccepted = new Map<number, number>();

  constructor(
    private readonly store: Store,
    private readonly events: EventHub,
    private readonly config: ServerConfig,
    private readonly clock: () => number = Date.now,
  ) {}

  register(req: RegisterRequest): RegisterResponse & { created: boolean } {
    const { hostId, created } = this.store.registerHost(req, this.clock());
    if (created) this.events.publish({ type: 'host', hostId });
    return { hostId, created, reportIntervalSec: this.config.agent.reportIntervalSec };
  }

  report(report: ReportRequest): ReportOutcome {
    const now = this.clock();
    const host = this.store.getHost(report.hostId);
    if (!host) return { kind: 'unknown_host' };

    const minGapMs = this.config.agent.minReportIntervalSec * 1000;
    const last = this.lastAccepted.get(host.id);
    if (last !== undefined && now - last < minGapMs) {
      return { kind: 'rate_limited', retryAfterSec: Math.ceil((minGapMs - (now - last)) / 1000) };
    }
    this.lastAccepted.set(host.id, now);

    this.store.insertReport(report, now);
    // Out-of-order reports are stored but status always follows the newest sample by ts.
    const status = this.refreshStatus(host.id, now);
    this.events.publish({ type: 'report', hostId: host.id, ts: report.ts });
    return { kind: 'ok', status };
  }

  /**
   * Remove a host with all its samples, group memberships and update checks. An agent that is
   * still running gets 404 on its next report and registers again as a new host.
   */
  deleteHost(id: number): boolean {
    if (!this.store.deleteHost(id)) return false;
    this.lastAccepted.delete(id);
    this.events.publish({ type: 'hostDeleted', hostId: id });
    return true;
  }

  /** Mark hosts offline once their heartbeat is older than `offlineAfterSec`. */
  sweepOffline(): void {
    const now = this.clock();
    for (const id of this.store.staleHostIds(now - this.config.agent.offlineAfterSec * 1000)) {
      const host = this.store.getHost(id);
      if (host) this.transition(host, 'offline', now);
    }
  }

  /** Re-evaluate online hosts, e.g. after thresholds changed across a restart. */
  reevaluateAll(): void {
    this.sweepOffline();
    const now = this.clock();
    for (const host of this.store.listHosts()) {
      if (host.status !== 'offline') this.refreshStatus(host.id, now);
    }
  }

  purgeExpired(): { metrics: number; gpus: number } {
    return this.store.purgeOlderThan(this.clock() - this.config.retention.days * 86_400_000);
  }

  listHosts(): ListHostsResponse {
    const groups = this.store.customGroupIdsByHost();
    return {
      now: this.clock(),
      thresholds: this.config.thresholds,
      offlineAfterSec: this.config.agent.offlineAfterSec,
      hosts: this.store.listHosts().map((h) => this.summarize(h, groups.get(h.id) ?? [])),
    };
  }

  hostDetail(id: number, minutes: number): HostDetailResponse | undefined {
    const host = this.store.getHost(id);
    if (!host) return undefined;
    const now = this.clock();
    const since = now - minutes * 60_000;
    const groups = this.store.customGroupIdsByHost();
    return {
      now,
      thresholds: this.config.thresholds,
      host: this.summarize(host, groups.get(id) ?? []),
      since,
      ...this.store.series(id, since, Math.max(1, Math.floor((minutes * 60_000) / MAX_SERIES_POINTS))),
    };
  }

  private summarize(host: HostRow, customGroupIds: number[]): HostSummary {
    const { lastSampleTs: _omit, updatesCheckedAt, updatesPending, updatesSecurity, ...rest } = host;
    const latest = this.store.latestSample(host);
    const alerts =
      host.status === 'offline' || !latest ? [] : evaluateAlerts(latest.metrics, latest.gpus, this.config.thresholds);
    const updates =
      updatesCheckedAt === null || updatesPending === null
        ? null
        : { checkedAt: updatesCheckedAt, pending: updatesPending, security: updatesSecurity };
    return { ...rest, alerts, latest, updates, customGroupIds };
  }

  private refreshStatus(hostId: number, now: number): HostStatus {
    const host = this.store.getHost(hostId);
    if (!host) throw new Error(`host ${hostId} vanished`);
    const latest = this.store.latestSample(host);
    const alerting = latest !== null && evaluateAlerts(latest.metrics, latest.gpus, this.config.thresholds).length > 0;
    const next: HostStatus = alerting ? 'alert' : 'ok';
    this.transition(host, next, now);
    return next;
  }

  private transition(host: HostRow, next: HostStatus, now: number): void {
    if (host.status === next) return;
    this.store.setStatus(host.id, next, now);
    this.events.publish({ type: 'status', hostId: host.id, status: next, prevStatus: host.status, ts: now });
  }
}
