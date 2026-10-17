// All SQL lives here, always as prepared statements (AGENTS.md security rule 7).
import type {
  GpuInfo,
  GpuSeries,
  GpuVendor,
  Group,
  GroupKind,
  HostStatus,
  LatestSample,
  MetricPoint,
  OsFamily,
  RegisterRequest,
  ReportRequest,
} from '../shared/types.ts';
import type { Db } from './db.ts';

export interface HostRow {
  id: number;
  hostname: string;
  alias: string | null;
  osFamily: OsFamily;
  osVersion: string;
  arch: string;
  cpuModel: string;
  gpuCount: number;
  agentVersion: string;
  firstSeen: number;
  lastSeen: number;
  status: HostStatus;
  statusSince: number;
  lastSampleTs: number | null;
  updatesCheckedAt: number | null;
  updatesPending: number | null;
  updatesSecurity: number | null;
}

const HOST_COLUMNS = `id, hostname, alias, os_family AS osFamily, os_version AS osVersion, arch, cpu_model AS cpuModel,
  gpu_count AS gpuCount, agent_version AS agentVersion, first_seen AS firstSeen, last_seen AS lastSeen,
  status, status_since AS statusSince, last_sample_ts AS lastSampleTs,
  checked_at AS updatesCheckedAt, pending AS updatesPending, security AS updatesSecurity`;

const HOSTS_FROM = `hosts LEFT JOIN host_updates ON host_updates.host_id = hosts.id
  LEFT JOIN host_aliases ON host_aliases.host_id = hosts.id`;

const METRIC_COLUMNS = `ts, cpu_load_percent AS cpuLoadPercent, mem_used_mb AS memUsedMB, mem_total_mb AS memTotalMB,
  disk_used_gb AS diskUsedGB, disk_total_gb AS diskTotalGB, net_rx_kbps AS netRxKbps, net_tx_kbps AS netTxKbps`;

const GPU_COLUMNS = `gpu_index AS "index", name, vendor, util_percent AS utilPercent, mem_used_mb AS memUsedMB,
  mem_total_mb AS memTotalMB`;

interface GroupRow {
  id: number;
  name: string;
  kind: GroupKind;
  osFamily: OsFamily | null;
}

export class Store {
  private readonly stmt;
  readonly registerHost: (req: RegisterRequest, now: number) => { hostId: number; created: boolean };
  readonly insertReport: (report: ReportRequest, now: number) => void;

  constructor(private readonly db: Db) {
    this.stmt = {
      findHost: db.prepare(`SELECT id FROM hosts WHERE hostname = ? AND os_family = ?`).pluck(),
      insertHost: db.prepare(
        `INSERT INTO hosts (hostname, os_family, os_version, arch, cpu_model, gpu_count, agent_version,
           first_seen, last_seen, status, status_since)
         VALUES (@hostname, @osFamily, @osVersion, @arch, @cpuModel, @gpuCount, @agentVersion, @now, @now, 'ok', @now)`,
      ),
      updateHostMeta: db.prepare(
        `UPDATE hosts SET os_version = @osVersion, arch = @arch, cpu_model = @cpuModel, gpu_count = @gpuCount,
           agent_version = @agentVersion, last_seen = @now WHERE id = @id`,
      ),
      joinSystemGroup: db.prepare(
        `INSERT OR IGNORE INTO host_group_members (host_id, group_id)
         SELECT ?, id FROM host_groups WHERE kind = 'system' AND os_family = ?`,
      ),
      getHost: db.prepare(`SELECT ${HOST_COLUMNS} FROM ${HOSTS_FROM} WHERE id = ?`),
      // Sorted by what the panel shows: the alias when set, otherwise the hostname.
      listHosts: db.prepare(
        `SELECT ${HOST_COLUMNS} FROM ${HOSTS_FROM} ORDER BY COALESCE(alias, hostname) COLLATE NOCASE, hostname, os_family`,
      ),
      // metric_samples, gpu_samples, host_group_members, host_updates and host_aliases go with it (ON DELETE CASCADE).
      deleteHost: db.prepare(`DELETE FROM hosts WHERE id = ?`),
      setAlias: db.prepare(
        `INSERT INTO host_aliases (host_id, alias) VALUES (?, ?) ON CONFLICT (host_id) DO UPDATE SET alias = excluded.alias`,
      ),
      clearAlias: db.prepare(`DELETE FROM host_aliases WHERE host_id = ?`),
      insertMetric: db.prepare(
        `INSERT INTO metric_samples (host_id, ts, cpu_load_percent, mem_used_mb, mem_total_mb, disk_used_gb,
           disk_total_gb, net_rx_kbps, net_tx_kbps)
         VALUES (@hostId, @ts, @cpuLoadPercent, @memUsedMB, @memTotalMB, @diskUsedGB, @diskTotalGB, @netRxKbps, @netTxKbps)`,
      ),
      insertGpu: db.prepare(
        `INSERT INTO gpu_samples (host_id, ts, gpu_index, name, vendor, util_percent, mem_used_mb, mem_total_mb)
         VALUES (@hostId, @ts, @index, @name, @vendor, @utilPercent, @memUsedMB, @memTotalMB)`,
      ),
      touchHost: db.prepare(
        `UPDATE hosts SET last_seen = @now, last_sample_ts = MAX(COALESCE(last_sample_ts, @ts), @ts) WHERE id = @hostId`,
      ),
      // Reports can arrive out of order: never replace a newer check with an older one.
      upsertUpdates: db.prepare(
        `INSERT INTO host_updates (host_id, checked_at, pending, security)
         VALUES (@hostId, @checkedAt, @pending, @security)
         ON CONFLICT (host_id) DO UPDATE SET checked_at = excluded.checked_at, pending = excluded.pending,
           security = excluded.security
         WHERE excluded.checked_at > host_updates.checked_at`,
      ),
      latestMetric: db.prepare(
        `SELECT ${METRIC_COLUMNS} FROM metric_samples WHERE host_id = ? AND ts = ? ORDER BY id DESC LIMIT 1`,
      ),
      // Newest rows first so a duplicated ts resolves to the most recent report per card.
      latestGpus: db.prepare(`SELECT ${GPU_COLUMNS} FROM gpu_samples WHERE host_id = ? AND ts = ? ORDER BY id DESC`),
      setStatus: db.prepare(`UPDATE hosts SET status = ?, status_since = ? WHERE id = ?`),
      staleHosts: db.prepare(`SELECT id FROM hosts WHERE status != 'offline' AND last_seen < ?`).pluck(),
      // Bucketed averages keep long ranges (up to 30 days) to a bounded number of points. MAX(ts) makes the
      // bare `name` column come from the newest row in each bucket (SQLite min/max bare-column rule). JS numbers
      // bind as REAL, so the bucket width is cast to keep the division integral.
      series: db.prepare(
        `SELECT MAX(ts) AS ts, AVG(cpu_load_percent) AS cpuLoadPercent, AVG(mem_used_mb) AS memUsedMB,
           AVG(mem_total_mb) AS memTotalMB, AVG(disk_used_gb) AS diskUsedGB, AVG(disk_total_gb) AS diskTotalGB,
           AVG(net_rx_kbps) AS netRxKbps, AVG(net_tx_kbps) AS netTxKbps
         FROM metric_samples WHERE host_id = ? AND ts >= ? GROUP BY ts / CAST(? AS INTEGER) ORDER BY ts`,
      ),
      gpuSeries: db.prepare(
        `SELECT MAX(ts) AS ts, gpu_index AS "index", name, vendor, AVG(util_percent) AS utilPercent,
           AVG(mem_used_mb) AS memUsedMB, AVG(mem_total_mb) AS memTotalMB
         FROM gpu_samples WHERE host_id = ? AND ts >= ? GROUP BY vendor, gpu_index, ts / CAST(? AS INTEGER)
         ORDER BY vendor, gpu_index, ts`,
      ),
      purgeMetrics: db.prepare(`DELETE FROM metric_samples WHERE ts < ?`),
      purgeGpus: db.prepare(`DELETE FROM gpu_samples WHERE ts < ?`),
      listGroups: db.prepare(
        `SELECT id, name, kind, os_family AS osFamily FROM host_groups ORDER BY kind DESC, name COLLATE NOCASE, id`,
      ),
      getGroup: db.prepare(`SELECT id, name, kind, os_family AS osFamily FROM host_groups WHERE id = ?`),
      groupMembers: db.prepare(`SELECT host_id AS hostId, group_id AS groupId FROM host_group_members ORDER BY host_id`),
      groupHostIds: db.prepare(`SELECT host_id FROM host_group_members WHERE group_id = ? ORDER BY host_id`).pluck(),
      customGroupName: db.prepare(
        `SELECT id FROM host_groups WHERE kind = 'custom' AND name = ? COLLATE NOCASE AND id != ?`,
      ).pluck(),
      insertGroup: db.prepare(`INSERT INTO host_groups (name, kind) VALUES (?, 'custom')`),
      renameGroup: db.prepare(`UPDATE host_groups SET name = ? WHERE id = ? AND kind = 'custom'`),
      deleteGroup: db.prepare(`DELETE FROM host_groups WHERE id = ? AND kind = 'custom'`),
      addMember: db.prepare(`INSERT OR IGNORE INTO host_group_members (host_id, group_id) VALUES (?, ?)`),
      removeMember: db.prepare(`DELETE FROM host_group_members WHERE host_id = ? AND group_id = ?`),
    };

    this.registerHost = db.transaction((req: RegisterRequest, now: number) => {
      const existing = this.stmt.findHost.get(req.hostname, req.osFamily) as number | undefined;
      if (existing !== undefined) {
        this.stmt.updateHostMeta.run({ ...req, now, id: existing });
        return { hostId: existing, created: false };
      }
      const hostId = Number(this.stmt.insertHost.run({ ...req, now }).lastInsertRowid);
      this.stmt.joinSystemGroup.run(hostId, req.osFamily);
      return { hostId, created: true };
    });

    // One transaction per report: the metric row, every GPU row and the update check land together.
    this.insertReport = db.transaction((report: ReportRequest, now: number) => {
      const base = { hostId: report.hostId, ts: report.ts };
      this.stmt.insertMetric.run({ ...base, ...report.metrics });
      for (const gpu of report.gpus ?? []) this.stmt.insertGpu.run({ ...base, ...gpu });
      if (report.updates) this.stmt.upsertUpdates.run({ hostId: report.hostId, ...report.updates });
      this.stmt.touchHost.run({ ...base, now });
    });
  }

  getHost(id: number): HostRow | undefined {
    return this.stmt.getHost.get(id) as HostRow | undefined;
  }

  listHosts(): HostRow[] {
    return this.stmt.listHosts.all() as HostRow[];
  }

  /** False when no such host exists. */
  deleteHost(id: number): boolean {
    return this.stmt.deleteHost.run(id).changes > 0;
  }

  /** `null` removes the alias so the panel falls back to the hostname. The host must exist. */
  setAlias(id: number, alias: string | null): void {
    if (alias === null) this.stmt.clearAlias.run(id);
    else this.stmt.setAlias.run(id, alias);
  }

  /** Newest sample by `ts` (reports may arrive out of order). */
  latestSample(host: HostRow): LatestSample | null {
    if (host.lastSampleTs === null) return null;
    const row = this.stmt.latestMetric.get(host.id, host.lastSampleTs) as MetricPoint | undefined;
    if (!row) return null;
    const { ts, ...metrics } = row;
    const seen = new Set<string>();
    const gpus: GpuInfo[] = [];
    for (const gpu of this.stmt.latestGpus.all(host.id, ts) as GpuInfo[]) {
      const key = `${gpu.vendor}:${gpu.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      gpus.push(gpu);
    }
    gpus.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.index - b.index);
    return { ts, metrics, gpus };
  }

  setStatus(id: number, status: HostStatus, since: number): void {
    this.stmt.setStatus.run(status, since, id);
  }

  /** Ids of non-offline hosts whose last report is older than `cutoff`. */
  staleHostIds(cutoff: number): number[] {
    return this.stmt.staleHosts.all(cutoff) as number[];
  }

  /** Samples since `since`, averaged into buckets of `bucketMs` (integer ≥ 1). */
  series(hostId: number, since: number, bucketMs: number): { series: MetricPoint[]; gpuSeries: GpuSeries[] } {
    const series = this.stmt.series.all(hostId, since, bucketMs) as MetricPoint[];
    const rows = this.stmt.gpuSeries.all(hostId, since, bucketMs) as (GpuInfo & { ts: number })[];
    const byCard = new Map<string, GpuSeries>();
    for (const r of rows) {
      const key = `${r.vendor}:${r.index}`;
      let s = byCard.get(key);
      if (!s) {
        s = { vendor: r.vendor as GpuVendor, index: r.index, name: r.name, points: [] };
        byCard.set(key, s);
      }
      s.name = r.name;
      s.points.push({ ts: r.ts, utilPercent: r.utilPercent, memUsedMB: r.memUsedMB, memTotalMB: r.memTotalMB });
    }
    return { series, gpuSeries: [...byCard.values()] };
  }

  purgeOlderThan(cutoff: number): { metrics: number; gpus: number } {
    return this.db.transaction(() => ({
      metrics: this.stmt.purgeMetrics.run(cutoff).changes,
      gpus: this.stmt.purgeGpus.run(cutoff).changes,
    }))();
  }

  /** host id → custom group ids. */
  customGroupIdsByHost(): Map<number, number[]> {
    const custom = new Set(this.listGroupRows().filter((g) => g.kind === 'custom').map((g) => g.id));
    const map = new Map<number, number[]>();
    for (const { hostId, groupId } of this.stmt.groupMembers.all() as { hostId: number; groupId: number }[]) {
      if (!custom.has(groupId)) continue;
      const list = map.get(hostId);
      if (list) list.push(groupId);
      else map.set(hostId, [groupId]);
    }
    return map;
  }

  private listGroupRows(): GroupRow[] {
    return this.stmt.listGroups.all() as GroupRow[];
  }

  listGroups(): Group[] {
    const members = new Map<number, number[]>();
    for (const { hostId, groupId } of this.stmt.groupMembers.all() as { hostId: number; groupId: number }[]) {
      const list = members.get(groupId);
      if (list) list.push(hostId);
      else members.set(groupId, [hostId]);
    }
    return this.listGroupRows().map((g) => ({ ...g, hostIds: members.get(g.id) ?? [] }));
  }

  getGroup(id: number): Group | undefined {
    const row = this.stmt.getGroup.get(id) as GroupRow | undefined;
    if (!row) return undefined;
    return { ...row, hostIds: this.stmt.groupHostIds.all(id) as number[] };
  }

  /** True when another custom group (other than `exceptId`) already uses `name` (case-insensitive). */
  customGroupNameTaken(name: string, exceptId = 0): boolean {
    return this.stmt.customGroupName.get(name, exceptId) !== undefined;
  }

  createGroup(name: string): number {
    return Number(this.stmt.insertGroup.run(name).lastInsertRowid);
  }

  renameGroup(id: number, name: string): void {
    this.stmt.renameGroup.run(name, id);
  }

  deleteGroup(id: number): void {
    this.stmt.deleteGroup.run(id);
  }

  addMember(groupId: number, hostId: number): void {
    this.stmt.addMember.run(hostId, groupId);
  }

  removeMember(groupId: number, hostId: number): void {
    this.stmt.removeMember.run(hostId, groupId);
  }
}
