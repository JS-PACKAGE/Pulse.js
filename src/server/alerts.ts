import type { AlertItem, GpuInfo, SystemMetrics, ThresholdMetric, Thresholds } from '../shared/types.ts';

function percent(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return (used / total) * 100;
}

/**
 * Compare one sample against the configured thresholds. A metric is alerting once it reaches
 * `warn`; `crit` only raises the severity. N/A (null) values never alert.
 */
export function evaluateAlerts(metrics: SystemMetrics, gpus: readonly GpuInfo[], thresholds: Thresholds): AlertItem[] {
  const alerts: AlertItem[] = [];
  const check = (metric: ThresholdMetric, value: number | null, gpu?: GpuInfo): void => {
    if (value === null) return;
    const { warn, crit } = thresholds[metric];
    if (value < warn) return;
    const level = value >= crit ? 'crit' : 'warn';
    const item: AlertItem = { metric, level, value, threshold: level === 'crit' ? crit : warn };
    if (gpu) item.gpu = { vendor: gpu.vendor, index: gpu.index, name: gpu.name };
    alerts.push(item);
  };

  check('cpuLoadPercent', metrics.cpuLoadPercent);
  check('memUsedPercent', percent(metrics.memUsedMB, metrics.memTotalMB));
  check('diskUsedPercent', percent(metrics.diskUsedGB, metrics.diskTotalGB));
  check('netRxKbps', metrics.netRxKbps);
  check('netTxKbps', metrics.netTxKbps);
  for (const gpu of gpus) {
    check('gpuUtilPercent', gpu.utilPercent, gpu);
    check('gpuMemUsedPercent', percent(gpu.memUsedMB, gpu.memTotalMB), gpu);
  }
  return alerts;
}
