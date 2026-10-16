// macOS metrics via sysctl / netstat / route (PLAN.md §3.2). Parsers exported for tests.
import { availableParallelism } from 'node:os';
import type { RunCommand } from '../exec.ts';
import { createRateTracker, diskUsage, type ByteCounters, type MetricProbes } from './system.ts';

/** `sysctl -n vm.loadavg` → "{ 1.23 1.10 0.98 }" → 1-minute value. */
export function parseSysctlLoadavg(text: string): number {
  const m = /\{\s*([\d.]+)\s/.exec(text);
  const v = Number(m?.[1]);
  if (!m || !Number.isFinite(v)) throw new Error('unexpected vm.loadavg format');
  return v;
}

export const MEMORY_SYSCTL_ARGS = ['-n', 'kern.memorystatus_level', 'hw.memsize'] as const;

/**
 * `sysctl -n kern.memorystatus_level hw.memsize` → two lines: the kernel's available-memory
 * percentage (the "free percentage" `memory_pressure` prints) and physical memory in bytes.
 * Used = total × (100 − level) %, so everything the kernel can reclaim — file cache, purgeable,
 * speculative and inactive pages — is excluded, like Linux `MemTotal − MemAvailable`.
 * Resolution is 1 % of physical memory.
 */
export function parseMemoryStatus(text: string): { usedMB: number; totalMB: number } {
  const [levelLine, memsizeLine] = text.trim().split('\n');
  const level = Number(levelLine?.trim());
  const totalBytes = Number(memsizeLine?.trim());
  if (!Number.isInteger(level) || level < 0 || level > 100) throw new Error('unexpected kern.memorystatus_level');
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) throw new Error('unexpected hw.memsize');
  const totalMB = totalBytes / 1024 ** 2;
  return { usedMB: (totalMB * (100 - level)) / 100, totalMB };
}

/**
 * Interface totals from `netstat -ibn`. Link rows (`<Link#n>`) carry the per-interface totals;
 * the Address column is blank for some interfaces, so columns are located from the right.
 */
export function parseNetstat(text: string, iface: string): ByteCounters {
  const lines = text.split('\n').filter((l) => l.trim());
  const header = lines[0]?.trim().split(/\s+/) ?? [];
  const ibytes = header.indexOf('Ibytes');
  const obytes = header.indexOf('Obytes');
  if (ibytes < 0 || obytes < 0) throw new Error('unexpected netstat -ibn header');
  for (const line of lines.slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== iface || !f[2]?.startsWith('<Link#')) continue;
    const fromRight = (col: number): number => Number(f[f.length - (header.length - col)]);
    const rx = fromRight(ibytes);
    const tx = fromRight(obytes);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) throw new Error(`unexpected netstat row for ${iface}`);
    return { rx, tx };
  }
  throw new Error(`interface ${iface} not found in netstat -ibn`);
}

/** `route -n get default` → interface name. */
export function parseRouteGetDefault(text: string): string {
  const iface = /^\s*interface:\s*(\S+)/m.exec(text)?.[1];
  if (!iface) throw new Error('no default route interface');
  return iface;
}

export function createMacosProbes(opts: { diskPath: string; netInterface: string; run: RunCommand }): MetricProbes {
  const { run } = opts;
  const cpus = availableParallelism();
  const network = createRateTracker(async () => {
    const iface = opts.netInterface || parseRouteGetDefault(await run('route', ['-n', 'get', 'default']));
    return parseNetstat(await run('netstat', ['-ibn']), iface);
  });
  return {
    cpuLoadPercent: async () => (parseSysctlLoadavg(await run('sysctl', ['-n', 'vm.loadavg'])) / cpus) * 100,
    memory: async () => parseMemoryStatus(await run('sysctl', MEMORY_SYSCTL_ARGS)),
    disk: () => diskUsage(opts.diskPath),
    network,
  };
}
