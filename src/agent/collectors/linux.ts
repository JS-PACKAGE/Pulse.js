// Linux metrics from /proc (PLAN.md §3.2). Parsers are exported for contract tests.
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { createRateTracker, diskUsage, type ByteCounters, type MetricProbes } from './system.ts';

export type ReadText = (path: string) => Promise<string>;
const readText: ReadText = (path) => readFile(path, 'utf8');

/** Load average (1 min) from /proc/loadavg content. */
export function parseLoadavg(text: string): number {
  const v = Number(text.trim().split(/\s+/)[0]);
  if (!Number.isFinite(v) || v < 0) throw new Error('unexpected /proc/loadavg format');
  return v;
}

/** Used = MemTotal − MemAvailable (what `free` calls "used" incl. non-reclaimable cache). */
export function parseMeminfo(text: string): { usedMB: number; totalMB: number } {
  const kb = (key: string): number => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm').exec(text);
    if (!m?.[1]) throw new Error(`/proc/meminfo lacks ${key}`);
    return Number(m[1]);
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  return { usedMB: (total - available) / 1024, totalMB: total / 1024 };
}

/** Byte counters of one interface from /proc/net/dev content. */
export function parseNetDev(text: string, iface: string): ByteCounters {
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0 || line.slice(0, idx).trim() !== iface) continue;
    const f = line.slice(idx + 1).trim().split(/\s+/).map(Number);
    const rx = f[0];
    const tx = f[8];
    if (f.length < 16 || rx === undefined || tx === undefined || !Number.isFinite(rx) || !Number.isFinite(tx)) {
      throw new Error(`unexpected /proc/net/dev format for ${iface}`);
    }
    return { rx, tx };
  }
  throw new Error(`interface ${iface} not found in /proc/net/dev`);
}

/** Interface carrying the default route (lowest metric) from /proc/net/route content. */
export function parseDefaultRoute(text: string): string {
  let best: { iface: string; metric: number } | null = null;
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    const [iface, dest, , flags, , , metric] = f;
    if (!iface || dest !== '00000000' || !flags || metric === undefined) continue;
    if ((parseInt(flags, 16) & 0x1) === 0) continue; // RTF_UP
    const m = Number(metric);
    if (!best || m < best.metric) best = { iface, metric: m };
  }
  if (!best) throw new Error('no default route found in /proc/net/route');
  return best.iface;
}

export function createLinuxProbes(opts: { diskPath: string; netInterface: string; read?: ReadText }): MetricProbes {
  const read = opts.read ?? readText;
  const cpus = availableParallelism();
  const network = createRateTracker(async () => {
    const iface = opts.netInterface || parseDefaultRoute(await read('/proc/net/route'));
    return parseNetDev(await read('/proc/net/dev'), iface);
  });
  return {
    cpuLoadPercent: async () => (parseLoadavg(await read('/proc/loadavg')) / cpus) * 100,
    memory: async () => parseMeminfo(await read('/proc/meminfo')),
    disk: () => diskUsage(opts.diskPath),
    network,
  };
}
