import { statfs } from 'node:fs/promises';
import { setTimeout as sleepMs } from 'node:timers/promises';
import type { SystemMetrics } from '../../shared/types.ts';

/** PLAN.md §3.2 contract. Fields are `null` when that metric could not be collected this cycle. */
export interface SystemCollector {
  snapshot(): Promise<SystemMetrics>;
}

/** Per-metric platform probes. Each throws on failure; it never returns a guessed value. */
export interface MetricProbes {
  cpuLoadPercent(): Promise<number>;
  memory(): Promise<{ usedMB: number; totalMB: number }>;
  disk(): Promise<{ usedGB: number; totalGB: number }>;
  network(): Promise<{ rxKbps: number; txKbps: number }>;
}

export type Warn = (message: string) => void;

const round = (v: number): number => Math.round(v * 100) / 100;

/**
 * Wrap platform probes so a failing probe only blanks its own fields and is logged
 * (fail-closed: no fallback source, no invented numbers).
 */
export function createSystemCollector(probes: MetricProbes, warn: Warn): SystemCollector {
  const attempt = async <T>(name: string, probe: () => Promise<T>): Promise<T | null> => {
    try {
      return await probe();
    } catch (err) {
      warn(`${name} collection failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
  return {
    async snapshot() {
      const [cpu, mem, disk, net] = await Promise.all([
        attempt('cpu', () => probes.cpuLoadPercent()),
        attempt('memory', () => probes.memory()),
        attempt('disk', () => probes.disk()),
        attempt('network', () => probes.network()),
      ]);
      return {
        cpuLoadPercent: cpu === null ? null : round(cpu),
        memUsedMB: mem && round(mem.usedMB),
        memTotalMB: mem && round(mem.totalMB),
        diskUsedGB: disk && round(disk.usedGB),
        diskTotalGB: disk && round(disk.totalGB),
        netRxKbps: net && round(net.rxKbps),
        netTxKbps: net && round(net.txKbps),
      };
    },
  };
}

/** Disk space of the filesystem holding `path`, matching `df` (used / (used + available)). */
export async function diskUsage(path: string): Promise<{ usedGB: number; totalGB: number }> {
  const s = await statfs(path);
  const GiB = 1024 ** 3;
  const used = (s.blocks - s.bfree) * s.bsize;
  const usable = used + s.bavail * s.bsize;
  if (!(usable > 0)) throw new Error(`statfs(${path}) reported an empty filesystem`);
  return { usedGB: used / GiB, totalGB: usable / GiB };
}

export interface ByteCounters {
  rx: number;
  tx: number;
}

/**
 * Turns monotonically increasing interface byte counters into kbps. The first call (or one
 * after a counter reset) samples twice, `primeMs` apart, so every snapshot has a real rate.
 */
export function createRateTracker(
  read: () => Promise<ByteCounters>,
  primeMs = 1000,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<unknown> = sleepMs,
): () => Promise<{ rxKbps: number; txKbps: number }> {
  let prev: { at: number; c: ByteCounters } | null = null;
  return async () => {
    if (!prev) {
      prev = { at: now(), c: await read() };
      await sleep(primeMs);
    }
    const cur = { at: now(), c: await read() };
    const last = prev;
    prev = cur;
    const seconds = (cur.at - last.at) / 1000;
    const drx = cur.c.rx - last.c.rx;
    const dtx = cur.c.tx - last.c.tx;
    if (seconds <= 0) throw new Error('network sample interval is not positive');
    if (drx < 0 || dtx < 0) {
      // Interface reset or counter wrap: re-prime next cycle instead of reporting garbage.
      prev = null;
      throw new Error('network byte counters went backwards (interface reset)');
    }
    return { rxKbps: (drx * 8) / 1000 / seconds, txKbps: (dtx * 8) / 1000 / seconds };
  };
}
