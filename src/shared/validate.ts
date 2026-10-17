// Hand-written schema validation for every inbound payload (AGENTS.md security rule 5).
// Kept dependency-free so the agent bundle can share it.

import {
  GPU_VENDORS,
  METRIC_KEYS,
  OS_FAMILIES,
  type GpuInfo,
  type GpuVendor,
  type OsFamily,
  type OsUpdates,
  type RegisterRequest,
  type ReportRequest,
  type SystemMetrics,
} from './types.ts';

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export const MAX_GPUS = 64;
const MAX_TEXT = 200;
/** Upper bound for any metric value; rejects garbage like 1e308 that would poison charts. */
const MAX_METRIC = 1e12;

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62})(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}))*$/;

/**
 * Normalise a hostname to lowercase ASCII labels; returns null when it cannot be made safe.
 * Only `[a-z0-9_-]` labels separated by dots survive, so the value is safe in HTML, logs and SQL.
 */
export function normalizeHostname(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const h = input.trim().toLowerCase().replace(/\.$/, '');
  if (h.length === 0 || h.length > 253) return null;
  return HOSTNAME_RE.test(h) ? h : null;
}

/** Display names (group names, host aliases): 1–64 chars after trim, no control characters. */
export function normalizeDisplayName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.trim();
  if (name.length === 0 || name.length > 64) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown, field: string, errors: string[], max = MAX_TEXT): string {
  if (typeof v !== 'string') {
    errors.push(`${field} must be a string`);
    return '';
  }
  const s = v.trim();
  if (s.length > max) errors.push(`${field} exceeds ${max} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) errors.push(`${field} contains control characters`);
  return s;
}

function int(v: unknown, field: string, errors: string[], min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    errors.push(`${field} must be an integer in [${min}, ${max}]`);
    return 0;
  }
  return v;
}

function metric(v: unknown, field: string, errors: string[]): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_METRIC) {
    errors.push(`${field} must be null or a finite number in [0, ${MAX_METRIC}]`);
    return null;
  }
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string, errors: string[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    errors.push(`${field} must be one of ${allowed.join('|')}`);
    return allowed[0] as T;
  }
  return v as T;
}

export function parseRegister(body: unknown): Parsed<RegisterRequest> {
  const errors: string[] = [];
  if (!isObject(body)) return { ok: false, errors: ['body must be a JSON object'] };
  const hostname = normalizeHostname(body.hostname);
  if (hostname === null) errors.push('hostname is invalid');
  const value: RegisterRequest = {
    hostname: hostname ?? '',
    osFamily: oneOf<OsFamily>(body.osFamily, OS_FAMILIES, 'osFamily', errors),
    osVersion: text(body.osVersion, 'osVersion', errors),
    arch: text(body.arch, 'arch', errors, 32),
    cpuModel: text(body.cpuModel, 'cpuModel', errors),
    gpuCount: int(body.gpuCount, 'gpuCount', errors, 0, MAX_GPUS),
    agentVersion: text(body.agentVersion, 'agentVersion', errors, 32),
  };
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

function parseGpu(v: unknown, i: number, errors: string[]): GpuInfo {
  const f = `gpus[${i}]`;
  if (!isObject(v)) {
    errors.push(`${f} must be an object`);
    return { index: 0, name: '', vendor: 'nvidia', utilPercent: null, memUsedMB: null, memTotalMB: null };
  }
  return {
    index: int(v.index, `${f}.index`, errors, 0, 1023),
    name: text(v.name, `${f}.name`, errors),
    vendor: oneOf<GpuVendor>(v.vendor, GPU_VENDORS, `${f}.vendor`, errors),
    utilPercent: metric(v.utilPercent, `${f}.utilPercent`, errors),
    memUsedMB: metric(v.memUsedMB, `${f}.memUsedMB`, errors),
    memTotalMB: metric(v.memTotalMB, `${f}.memTotalMB`, errors),
  };
}

/** Upper bound on pending updates; a full distro upgrade stays far below this. */
const MAX_PENDING_UPDATES = 100_000;

function parseUpdates(v: unknown, now: number, maxAgeMs: number, errors: string[]): OsUpdates | null {
  // Missing = an agent from before update checks existed; same meaning as null.
  if (v === undefined || v === null) return null;
  if (!isObject(v)) {
    errors.push('updates must be an object or null');
    return null;
  }
  const checkedAt = int(v.checkedAt, 'updates.checkedAt', errors, 1, Number.MAX_SAFE_INTEGER);
  if (checkedAt > now + 5 * 60_000) errors.push('updates.checkedAt is in the future');
  if (checkedAt !== 0 && checkedAt < now - maxAgeMs) errors.push('updates.checkedAt is older than the retention window');
  const pending = int(v.pending, 'updates.pending', errors, 0, MAX_PENDING_UPDATES);
  const security = v.security === null ? null : int(v.security, 'updates.security', errors, 0, MAX_PENDING_UPDATES);
  if (security !== null && security > pending) errors.push('updates.security exceeds updates.pending');
  return { checkedAt, pending, security };
}

/**
 * @param now epoch ms used to reject timestamps from the future (clock skew tolerance 5 min)
 *            or older than `maxAgeMs` (outside the retention window).
 */
export function parseReport(body: unknown, now: number, maxAgeMs: number): Parsed<ReportRequest> {
  const errors: string[] = [];
  if (!isObject(body)) return { ok: false, errors: ['body must be a JSON object'] };
  const hostId = int(body.hostId, 'hostId', errors, 1, Number.MAX_SAFE_INTEGER);
  const ts = int(body.ts, 'ts', errors, 1, Number.MAX_SAFE_INTEGER);
  if (ts > now + 5 * 60_000) errors.push('ts is in the future');
  // int() yields 0 after recording its own error; skip the age check then.
  if (ts !== 0 && ts < now - maxAgeMs) errors.push('ts is older than the retention window');

  const metrics = {} as SystemMetrics;
  if (!isObject(body.metrics)) {
    errors.push('metrics must be an object');
  } else {
    const m = body.metrics;
    for (const key of METRIC_KEYS) {
      if (!(key in m)) errors.push(`metrics.${key} is required (use null when unavailable)`);
      metrics[key] = metric(m[key], `metrics.${key}`, errors);
    }
  }

  let gpus: GpuInfo[] | null = null;
  if (body.gpus !== null) {
    if (!Array.isArray(body.gpus)) errors.push('gpus must be an array or null');
    else if (body.gpus.length > MAX_GPUS) errors.push(`gpus exceeds ${MAX_GPUS} entries`);
    else {
      gpus = body.gpus.map((g, i) => parseGpu(g, i, errors));
      const keys = new Set(gpus.map((g) => `${g.vendor}:${g.index}`));
      if (keys.size !== gpus.length) errors.push('gpus contains duplicate vendor/index pairs');
    }
  }

  const updates = parseUpdates(body.updates, now, maxAgeMs, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: { hostId, ts, metrics, gpus, updates } };
}
