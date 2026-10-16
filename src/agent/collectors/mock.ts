import type { SystemMetrics } from '../../shared/types.ts';
import type { SystemCollector } from './system.ts';
import type { UpdateChecker, UpdateCount } from './updates.ts';

export const MOCK_SYSTEM_METRICS: SystemMetrics = {
  cpuLoadPercent: 23.5,
  memUsedMB: 6144,
  memTotalMB: 16384,
  diskUsedGB: 120,
  diskTotalGB: 500,
  netRxKbps: 1500,
  netTxKbps: 320,
};

/** Fixed sample for contract tests; `override` lets a test push a metric over a threshold. */
export class MockSystemCollector implements SystemCollector {
  constructor(public override: Partial<SystemMetrics> = {}) {}

  async snapshot(): Promise<SystemMetrics> {
    return { ...MOCK_SYSTEM_METRICS, ...this.override };
  }
}

/** Fixed update count; set `result` to an Error to simulate a failing check. */
export class MockUpdateChecker implements UpdateChecker {
  calls = 0;
  constructor(public result: UpdateCount | Error = { pending: 0, security: 0 }) {}

  async check(): Promise<UpdateCount> {
    this.calls++;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}
