import type { GpuInfo } from '../../shared/types.ts';
import type { GpuCollector } from './gpu.ts';

/** The four contract cases of PLAN.md §3.1: single card, dual card, none, cross-vendor. */
export const MOCK_GPU_CASES = {
  single: [{ index: 0, name: 'NVIDIA RTX A4000', vendor: 'nvidia', utilPercent: 37, memUsedMB: 4096, memTotalMB: 16376 }],
  dual: [
    { index: 0, name: 'NVIDIA A100-SXM4-80GB', vendor: 'nvidia', utilPercent: 91, memUsedMB: 70000, memTotalMB: 81920 },
    { index: 1, name: 'NVIDIA A100-SXM4-80GB', vendor: 'nvidia', utilPercent: 12, memUsedMB: 2048, memTotalMB: 81920 },
  ],
  empty: [],
  crossVendor: [
    { index: 0, name: 'NVIDIA GeForce RTX 4090', vendor: 'nvidia', utilPercent: 55, memUsedMB: 8192, memTotalMB: 24564 },
    { index: 0, name: 'AMD Radeon RX 7900 XT', vendor: 'amd', utilPercent: 20, memUsedMB: 2048, memTotalMB: 20464 },
    { index: 0, name: 'Apple M5', vendor: 'apple', utilPercent: null, memUsedMB: null, memTotalMB: 24576 },
  ],
} as const satisfies Record<string, readonly GpuInfo[]>;

export class MockGpuCollector implements GpuCollector {
  constructor(private readonly gpus: readonly GpuInfo[] = MOCK_GPU_CASES.crossVendor) {}

  async list(): Promise<GpuInfo[]> {
    return this.gpus.map((g) => ({ ...g }));
  }
}
