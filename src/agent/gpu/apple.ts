import { totalmem } from 'node:os';
import type { GpuInfo } from '../../shared/types.ts';
import type { RunCommand } from '../exec.ts';
import { numOrNull, runIfInstalled, type GpuCollector } from './gpu.ts';

export const IOREG_ARGS = ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'] as const;

/**
 * Parses `ioreg -r -d 1 -w 0 -c IOAccelerator`: one `+-o` block per GPU with `"model"` and a
 * `"PerformanceStatistics"` dictionary ("Device Utilization %", "In use system memory").
 * Apple GPUs share unified memory, so `memTotalMB` is the machine's physical memory.
 * A missing statistic is reported as null (N/A) rather than guessed.
 */
export function parseIoregAccelerators(text: string, unifiedMemoryBytes: number): GpuInfo[] {
  const blocks = text.split(/^\+-o /m).slice(1);
  return blocks.map((block, index) => {
    const model = /"model"\s*=\s*"([^"]*)"/.exec(block)?.[1];
    const stats = /"PerformanceStatistics"\s*=\s*\{([^}]*)\}/.exec(block)?.[1] ?? '';
    const stat = (name: string): number | null => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&');
      return numOrNull(new RegExp(`"${escaped}"=(\\d+)`).exec(stats)?.[1]);
    };
    const inUse = stat('In use system memory');
    return {
      index,
      name: model ?? 'Apple GPU',
      vendor: 'apple' as const,
      utilPercent: stat('Device Utilization %'),
      memUsedMB: inUse === null ? null : inUse / 1024 ** 2,
      memTotalMB: unifiedMemoryBytes / 1024 ** 2,
    };
  });
}

/**
 * Apple Silicon GPU via IOKit's registry. PLAN.md assumption 3 budgets root for this; the
 * launchd daemon runs as root, and on current macOS `ioreg` already exposes the statistics.
 */
export class AppleGpuCollector implements GpuCollector {
  constructor(private readonly run: RunCommand) {}

  async list(): Promise<GpuInfo[]> {
    const out = await runIfInstalled(this.run, 'ioreg', IOREG_ARGS);
    return out === null ? [] : parseIoregAccelerators(out, totalmem());
  }
}
