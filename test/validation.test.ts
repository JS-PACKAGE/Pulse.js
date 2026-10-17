import { describe, expect, it } from 'vitest';
import { parseAgentConfig } from '../src/agent/config.ts';
import { evaluateAlerts } from '../src/server/alerts.ts';
import { ConfigError } from '../src/server/config.ts';
import type { SystemMetrics } from '../src/shared/types.ts';
import { normalizeDisplayName, normalizeHostname, parseRegister, parseReport } from '../src/shared/validate.ts';
import { testConfig } from './helpers.ts';

const metrics: SystemMetrics = {
  cpuLoadPercent: 1,
  memUsedMB: 1,
  memTotalMB: 2,
  diskUsedGB: 1,
  diskTotalGB: 2,
  netRxKbps: 0,
  netTxKbps: 0,
};

describe('hostname normalisation (injection guard)', () => {
  it.each([
    ['Web-01.Example.COM.', 'web-01.example.com'],
    ['  db_02 ', 'db_02'],
  ])('%s → %s', (input, out) => expect(normalizeHostname(input)).toBe(out));

  it.each(['', '<script>', "a'; DROP TABLE hosts;--", 'a b', '-lead', 'x'.repeat(64), 'a..b', 42])('rejects %s', (input) => {
    expect(normalizeHostname(input)).toBeNull();
  });
});

describe('payload validation', () => {
  const now = 1_800_000_000_000;
  const day = 86_400_000;

  it('register requires every field with valid enums', () => {
    const ok = parseRegister({ hostname: 'h', osFamily: 'linux-rpm', osVersion: 'Rocky 9', arch: 'x64', cpuModel: 'c', gpuCount: 0, agentVersion: '1' });
    expect(ok.ok).toBe(true);
    const bad = parseRegister({ hostname: 'h', osFamily: 'windows', gpuCount: -1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toEqual(expect.arrayContaining(['osFamily must be one of linux-deb|linux-rpm|macos']));
  });

  it('report accepts nulls (N/A) but not negatives, NaN-ish values or missing keys', () => {
    expect(parseReport({ hostId: 1, ts: now, metrics: { ...metrics, cpuLoadPercent: null }, gpus: null }, now, day).ok).toBe(true);
    expect(parseReport({ hostId: 1, ts: now, metrics: { ...metrics, memUsedMB: -1 }, gpus: [] }, now, day).ok).toBe(false);
    expect(parseReport({ hostId: 1, ts: now, metrics: { ...metrics, memUsedMB: '5' }, gpus: [] }, now, day).ok).toBe(false);
    const { netTxKbps: _drop, ...partial } = metrics;
    expect(parseReport({ hostId: 1, ts: now, metrics: partial, gpus: [] }, now, day).ok).toBe(false);
  });

  it('report ts must be within [now − retention, now + 5 min]', () => {
    const at = (ts: number) => parseReport({ hostId: 1, ts, metrics, gpus: [] }, now, day).ok;
    expect(at(now + 5 * 60_000)).toBe(true);
    expect(at(now + 5 * 60_000 + 1)).toBe(false);
    expect(at(now - day)).toBe(true);
    expect(at(now - day - 1)).toBe(false);
  });

  it('report rejects duplicate GPU cards', () => {
    const gpu = { index: 0, name: 'g', vendor: 'amd', utilPercent: 1, memUsedMB: 1, memTotalMB: 2 };
    expect(parseReport({ hostId: 1, ts: now, metrics, gpus: [gpu, gpu] }, now, day).ok).toBe(false);
    expect(parseReport({ hostId: 1, ts: now, metrics, gpus: [gpu, { ...gpu, vendor: 'nvidia' }] }, now, day).ok).toBe(true);
  });

  it('report updates: optional (older agents), integer counts, security ≤ pending, checkedAt in window', () => {
    const with_ = (updates: unknown) => parseReport({ hostId: 1, ts: now, metrics, gpus: [], updates }, now, day);
    const missing = parseReport({ hostId: 1, ts: now, metrics, gpus: [] }, now, day);
    expect(missing.ok && missing.value.updates).toBeNull();
    expect(with_({ checkedAt: now, pending: 3, security: 1 }).ok).toBe(true);
    expect(with_({ checkedAt: now, pending: 3, security: null }).ok).toBe(true);
    expect(with_({ checkedAt: now, pending: 3, security: 4 }).ok).toBe(false);
    expect(with_({ checkedAt: now, pending: 1.5, security: 0 }).ok).toBe(false);
    expect(with_({ checkedAt: now, pending: 1 }).ok).toBe(false);
    expect(with_({ checkedAt: now + 5 * 60_000 + 1, pending: 0, security: 0 }).ok).toBe(false);
    expect(with_({ checkedAt: now - day - 1, pending: 0, security: 0 }).ok).toBe(false);
    expect(with_('12').ok).toBe(false);
  });

  it('display names (groups, host aliases) are trimmed, 1–64 chars, no control characters', () => {
    expect(normalizeDisplayName('  生產環境 ')).toBe('生產環境');
    expect(normalizeDisplayName('a\nb')).toBeNull();
    expect(normalizeDisplayName('x'.repeat(65))).toBeNull();
  });
});

describe('threshold evaluation', () => {
  const thresholds = testConfig().thresholds; // disk warn 85 / crit 90

  it('alerts from warn, escalates at crit, ignores N/A', () => {
    const disk = (used: number) => evaluateAlerts({ ...metrics, diskUsedGB: used, diskTotalGB: 100 }, [], thresholds);
    expect(disk(84.9)).toEqual([]);
    expect(disk(85)).toEqual([{ metric: 'diskUsedPercent', level: 'warn', value: 85, threshold: 85 }]);
    expect(disk(90)[0]?.level).toBe('crit');
    expect(evaluateAlerts({ ...metrics, diskUsedGB: null }, [], thresholds)).toEqual([]);
  });

  it('evaluates every GPU card separately', () => {
    const alerts = evaluateAlerts(
      metrics,
      [
        { index: 0, name: 'A', vendor: 'nvidia', utilPercent: 10, memUsedMB: 95, memTotalMB: 100 },
        { index: 1, name: 'B', vendor: 'nvidia', utilPercent: 99, memUsedMB: null, memTotalMB: 100 },
      ],
      thresholds,
    );
    expect(alerts.map((a) => [a.metric, a.gpu?.index, a.level])).toEqual([
      ['gpuMemUsedPercent', 0, 'warn'],
      ['gpuUtilPercent', 1, 'crit'],
    ]);
  });
});

describe('server config', () => {
  it('requires every key instead of silently defaulting', () => {
    expect(() => testConfig((raw) => delete raw.thresholds.netTxKbps)).toThrow(/thresholds" section|netTxKbps/);
    expect(() => testConfig((raw) => delete raw.database.busyTimeoutMs)).toThrow(ConfigError);
  });

  it('caps the payload limit at 64 KB and checks threshold order', () => {
    expect(() => testConfig((raw) => (raw.limits.maxPayloadBytes = 65_537))).toThrow(/maxPayloadBytes/);
    expect(() => testConfig((raw) => (raw.thresholds.cpuLoadPercent = { warn: 90, crit: 80 }))).toThrow(/crit must be >= warn/);
  });
});

describe('agent config', () => {
  const base = { serverUrl: 'https://pulse.example.com', accessClientId: 'abc.access', accessClientSecret: 'secret' };

  it('allows https anywhere and http only on loopback', () => {
    expect(parseAgentConfig(base).serverUrl.href).toBe('https://pulse.example.com/');
    expect(parseAgentConfig({ ...base, serverUrl: 'http://127.0.0.1:8080' }).diskPath).toBe('/');
    expect(() => parseAgentConfig({ ...base, serverUrl: 'http://pulse.example.com' })).toThrow(/https/);
    expect(() => parseAgentConfig({ ...base, serverUrl: 'https://pulse.example.com/?token=x' })).toThrow(/query/);
  });

  it('requires both service token fields as single-line values', () => {
    expect(parseAgentConfig(base)).toMatchObject({ accessClientId: 'abc.access', accessClientSecret: 'secret' });
    expect(() => parseAgentConfig({ ...base, accessClientId: ' ' })).toThrow(/accessClientId/);
    expect(() => parseAgentConfig({ ...base, accessClientSecret: undefined })).toThrow(/accessClientSecret/);
    expect(() => parseAgentConfig({ ...base, accessClientSecret: 'a\r\nX-Injected: 1' })).toThrow(/single line/);
  });
});
