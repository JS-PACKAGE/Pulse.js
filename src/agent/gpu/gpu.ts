import type { GpuInfo } from '../../shared/types.ts';
import { CommandMissingError, type RunCommand } from '../exec.ts';

/**
 * PLAN.md §3.1 contract: one entry per card; `[]` when there is no GPU or the vendor tool is not
 * installed. Malformed tool output or a failing tool throws (fail-closed, never guessed values).
 */
export interface GpuCollector {
  list(): Promise<GpuInfo[]>;
}

/** Runs a vendor tool and maps "tool not installed" to `null` (→ caller returns `[]`). */
export async function runIfInstalled(run: RunCommand, command: string, args: readonly string[]): Promise<string | null> {
  try {
    return await run(command, args);
  } catch (err) {
    if (err instanceof CommandMissingError) return null;
    throw err;
  }
}

/** Parses a numeric field; vendor placeholders like "[N/A]" or "Not Supported" become null. */
export function numOrNull(raw: string | number | undefined): number | null {
  if (raw === undefined) return null;
  const v = typeof raw === 'number' ? raw : Number(raw.trim());
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/** Concatenates several vendor collectors (e.g. NVIDIA + AMD in one Linux box). */
export class CompositeGpuCollector implements GpuCollector {
  constructor(private readonly collectors: readonly GpuCollector[]) {}

  async list(): Promise<GpuInfo[]> {
    const lists = await Promise.all(this.collectors.map((c) => c.list()));
    return lists.flat();
  }
}
