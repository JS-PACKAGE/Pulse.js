import type { GpuInfo } from '../../shared/types.ts';
import type { RunCommand } from '../exec.ts';
import { numOrNull, runIfInstalled, type GpuCollector } from './gpu.ts';

export const NVIDIA_SMI_ARGS = [
  '--query-gpu=index,name,utilization.gpu,memory.used,memory.total',
  '--format=csv,noheader,nounits',
] as const;

/**
 * One CSV row per card: `index, name, util, memUsed, memTotal`. The name is everything between
 * the first and the last three fields, so a comma inside a product name still parses.
 */
export function parseNvidiaSmi(text: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const f = line.split(',').map((s) => s.trim());
    if (f.length < 5) throw new Error(`unexpected nvidia-smi row: ${line.slice(0, 120)}`);
    const index = Number(f[0]);
    if (!Number.isInteger(index) || index < 0) throw new Error(`unexpected nvidia-smi index: ${f[0]}`);
    const [util, used, total] = f.slice(-3);
    gpus.push({
      index,
      name: f.slice(1, -3).join(', '),
      vendor: 'nvidia',
      utilPercent: numOrNull(util),
      memUsedMB: numOrNull(used),
      memTotalMB: numOrNull(total),
    });
  }
  return gpus;
}

export class NvidiaSmiGpuCollector implements GpuCollector {
  constructor(private readonly run: RunCommand) {}

  async list(): Promise<GpuInfo[]> {
    const out = await runIfInstalled(this.run, 'nvidia-smi', NVIDIA_SMI_ARGS);
    return out === null ? [] : parseNvidiaSmi(out);
  }
}
