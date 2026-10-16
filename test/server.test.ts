import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent, UPDATE_CHECK_INTERVAL_MS } from '../src/agent/agent.ts';
import { PulseClient } from '../src/agent/client.ts';
import { MockSystemCollector, MockUpdateChecker } from '../src/agent/collectors/mock.ts';
import { MOCK_GPU_CASES, MockGpuCollector } from '../src/agent/gpu/mock.ts';
import { ConfigError } from '../src/server/config.ts';
import { openDatabase } from '../src/server/db.ts';
import { EventHub } from '../src/server/events.ts';
import { startServer } from '../src/server/main.ts';
import { Monitor } from '../src/server/monitor.ts';
import { Store } from '../src/server/store.ts';
import type { ListHostsResponse, PulseEvent, RegisterRequest, ReportRequest, SystemMetrics } from '../src/shared/types.ts';
import { testConfig } from './helpers.ts';

const registration: RegisterRequest = {
  hostname: 'web-01',
  osFamily: 'macos',
  osVersion: 'macOS 15.0',
  arch: 'arm64',
  cpuModel: 'Apple M5',
  gpuCount: 3,
  agentVersion: 'test',
};

const healthy: SystemMetrics = {
  cpuLoadPercent: 10,
  memUsedMB: 1000,
  memTotalMB: 16000,
  diskUsedGB: 100,
  diskTotalGB: 500,
  netRxKbps: 5,
  netTxKbps: 5,
};

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (running.length) await running.pop()?.();
});

async function boot(patch?: Parameters<typeof testConfig>[0]) {
  const srv = await startServer(testConfig(patch));
  running.push(srv.close);
  const { port } = srv.server.address() as AddressInfo; // listen() on TCP always yields AddressInfo
  const base = `http://127.0.0.1:${port}`;
  const json = async (path: string, init?: RequestInit) => {
    const res = await fetch(base + path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return { srv, port, base, json };
}

describe('Gate 1 flow with a Mock Agent (examples 1–2)', () => {
  it('registers, reports, crosses the disk threshold and shows up as alert', async () => {
    const { base, json } = await boot((raw) => {
      raw.agent.minReportIntervalSec = 0;
    });
    const system = new MockSystemCollector();
    const agent = new Agent({
      client: new PulseClient(new URL(base), 'Bearer zero-trust-only'),
      system,
      gpu: new MockGpuCollector(MOCK_GPU_CASES.dual.map((g) => ({ ...g, utilPercent: 10 }))),
      updates: new MockUpdateChecker(),
      registration,
      log: () => {},
    });

    expect(await agent.tick()).toEqual({ kind: 'reported', status: 'ok' });
    let list: ListHostsResponse = (await json('/api/hosts')).body;
    expect(list.hosts).toHaveLength(1);
    expect(list.hosts[0]).toMatchObject({ hostname: 'web-01', osFamily: 'macos', status: 'ok', alerts: [] });
    expect(list.hosts[0]?.latest?.gpus).toHaveLength(2);

    // Example 2: disk at 92 % (> crit 90) → alert.
    system.override = { diskUsedGB: 460, diskTotalGB: 500 };
    expect(await agent.tick()).toEqual({ kind: 'reported', status: 'alert' });
    list = (await json('/api/hosts')).body;
    expect(list.hosts[0]?.status).toBe('alert');
    expect(list.hosts[0]?.alerts).toEqual([{ metric: 'diskUsedPercent', level: 'crit', value: 92, threshold: 90 }]);

    // Recovery clears the alert.
    system.override = {};
    expect(await agent.tick()).toEqual({ kind: 'reported', status: 'ok' });
  });

  it('places the host in its system group and returns a detail series', async () => {
    const { json } = await boot();
    const reg = await json('/api/agent/register', { method: 'POST', body: JSON.stringify(registration) });
    expect(reg.status).toBe(201);
    const again = await json('/api/agent/register', { method: 'POST', body: JSON.stringify(registration) });
    expect(again).toMatchObject({ status: 200, body: { hostId: reg.body.hostId } });

    const groups = (await json('/api/groups')).body.groups;
    expect(groups.find((g: { osFamily: string }) => g.osFamily === 'macos').hostIds).toEqual([reg.body.hostId]);

    const report: ReportRequest = { hostId: reg.body.hostId, ts: Date.now(), metrics: healthy, gpus: MOCK_GPU_CASES.crossVendor.map((g) => ({ ...g })), updates: null };
    expect((await json('/api/agent/report', { method: 'POST', body: JSON.stringify(report) })).status).toBe(200);
    const detail = (await json(`/api/hosts/${reg.body.hostId}?minutes=5`)).body;
    expect(detail.series).toHaveLength(1);
    expect(detail.gpuSeries.map((s: { vendor: string }) => s.vendor).sort()).toEqual(['amd', 'apple', 'nvidia']);
    expect((await json(`/api/hosts/${reg.body.hostId}?minutes=43200`)).body.series).toHaveLength(1);
    expect((await json(`/api/hosts/${reg.body.hostId}?minutes=43201`)).status).toBe(400);
  });

  it('checks OS updates in the background once per interval and keeps the last good result', async () => {
    const { base, json } = await boot((raw) => {
      raw.agent.minReportIntervalSec = 0;
    });
    let now = Date.now() - UPDATE_CHECK_INTERVAL_MS - 60_000;
    const updates = new MockUpdateChecker({ pending: 12, security: 3 });
    const logs: string[] = [];
    const agent = new Agent({
      client: new PulseClient(new URL(base), 'x'),
      system: new MockSystemCollector(),
      gpu: new MockGpuCollector([]),
      updates,
      registration,
      log: (m) => logs.push(m),
      now: () => now,
    });
    const hostUpdates = async () => ((await json('/api/hosts')).body as ListHostsResponse).hosts[0]?.updates;

    await agent.tick();
    await agent.tick();
    const firstCheck = now;
    expect(await hostUpdates()).toEqual({ checkedAt: firstCheck, pending: 12, security: 3 });
    expect(updates.calls).toBe(1);

    now += UPDATE_CHECK_INTERVAL_MS;
    updates.result = new Error('apt-get failed');
    await agent.tick();
    await agent.tick();
    expect(updates.calls).toBe(2);
    expect(logs).toContain('warning: os update check failed: apt-get failed');
    expect(await hostUpdates()).toEqual({ checkedAt: firstCheck, pending: 12, security: 3 });
  });
});

describe('report endpoint', () => {
  it('rate-limits per host with 429 and Retry-After', async () => {
    const { json } = await boot();
    const { body } = await json('/api/agent/register', { method: 'POST', body: JSON.stringify(registration) });
    const send = () =>
      json('/api/agent/report', { method: 'POST', body: JSON.stringify({ hostId: body.hostId, ts: Date.now(), metrics: healthy, gpus: [], updates: null }) });
    expect((await send()).status).toBe(200);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('answers 404 for unknown hosts; the agent then re-registers (e.g. after a database reset)', async () => {
    const first = await boot((raw) => {
      raw.agent.minReportIntervalSec = 0;
    });
    const agent = new Agent({
      client: new PulseClient(new URL(first.base), 'x'),
      system: new MockSystemCollector(),
      gpu: new MockGpuCollector([]),
      updates: new MockUpdateChecker(),
      registration,
      log: () => {},
    });
    await agent.tick();
    // Same port, empty database: the agent's hostId is now unknown.
    await running.pop()?.();
    await boot((raw) => {
      raw.agent.minReportIntervalSec = 0;
      raw.server.port = first.port;
    });
    // A pooled keep-alive socket to the old server may reset once; the run loop retries the same way.
    const afterRestart = await agent.tick().catch(() => agent.tick());
    expect(afterRestart).toEqual({ kind: 'skipped', reason: 'host unknown to server, re-registering' });
    expect(await agent.tick()).toEqual({ kind: 'reported', status: 'ok' });
  });

  it('rejects oversized payloads (413) and invalid bodies (400) with generic errors', async () => {
    const { json } = await boot();
    const big = await json('/api/agent/report', { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(70_000) }) });
    expect(big).toMatchObject({ status: 413, body: { error: 'payload_too_large' } });
    const bad = await json('/api/agent/report', { method: 'POST', body: '{nope' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.ts|SyntaxError/);
  });

  it('never compares the Authorization header (Zero Trust is the only check)', async () => {
    const { json } = await boot();
    const statuses = [];
    for (const headers of [{}, { authorization: 'wrong' }, { authorization: 'Bearer right' }]) {
      statuses.push((await json('/api/agent/register', { method: 'POST', headers, body: JSON.stringify(registration) })).status);
    }
    expect(statuses).toEqual([201, 200, 200]);
  });
});

describe('status transitions (Monitor with a fake clock)', () => {
  function setup() {
    let now = 1_000_000;
    const db = openDatabase(':memory:', 1000);
    const events = new EventHub();
    const seen: PulseEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const config = testConfig((raw) => {
      raw.agent.minReportIntervalSec = 0;
    });
    const monitor = new Monitor(new Store(db), events, config, () => now);
    const { hostId } = monitor.register(registration);
    return { monitor, hostId, seen, advance: (ms: number) => (now += ms), at: () => now, close: () => db.close() };
  }

  it('goes offline after offlineAfterSec without reports and back online on the next report', () => {
    const t = setup();
    t.monitor.report({ hostId: t.hostId, ts: t.at(), metrics: healthy, gpus: [], updates: null });
    t.advance(90_000);
    t.monitor.sweepOffline();
    expect(t.monitor.listHosts().hosts[0]?.status).toBe('ok'); // exactly at the limit: still online
    t.advance(1);
    t.monitor.sweepOffline();
    const offline = t.monitor.listHosts().hosts[0];
    expect(offline).toMatchObject({ status: 'offline', statusSince: t.at(), alerts: [] });
    expect(t.seen).toContainEqual({ type: 'status', hostId: t.hostId, status: 'offline', prevStatus: 'ok', ts: t.at() });

    t.monitor.report({ hostId: t.hostId, ts: t.at(), metrics: healthy, gpus: [], updates: null });
    expect(t.monitor.listHosts().hosts[0]?.status).toBe('ok');
    t.close();
  });

  it('keeps status on the newest sample when an older report arrives late', () => {
    const t = setup();
    const hot = { ...healthy, cpuLoadPercent: 99 };
    t.monitor.report({ hostId: t.hostId, ts: t.at(), metrics: hot, gpus: [], updates: null });
    t.advance(1000);
    // Late, older, healthy report must not clear the newer alert.
    expect(t.monitor.report({ hostId: t.hostId, ts: t.at() - 5000, metrics: healthy, gpus: [], updates: null })).toEqual({ kind: 'ok', status: 'alert' });
    t.close();
  });

  it('keeps statusSince while staying in alert so the duration keeps counting', () => {
    const t = setup();
    const start = t.at();
    t.monitor.report({ hostId: t.hostId, ts: t.at(), metrics: { ...healthy, cpuLoadPercent: 90 }, gpus: [], updates: null });
    t.advance(30_000);
    t.monitor.report({ hostId: t.hostId, ts: t.at(), metrics: { ...healthy, cpuLoadPercent: 99 }, gpus: [], updates: null });
    expect(t.monitor.listHosts().hosts[0]).toMatchObject({ status: 'alert', statusSince: start });
    t.close();
  });

  it('purges samples older than the retention window', () => {
    const t = setup();
    t.monitor.report({ hostId: t.hostId, ts: t.at(), metrics: healthy, gpus: MOCK_GPU_CASES.single.map((g) => ({ ...g })), updates: null });
    t.advance(31 * 86_400_000);
    expect(t.monitor.purgeExpired()).toEqual({ metrics: 1, gpus: 1 });
    t.close();
  });

  it('averages long ranges into buckets while short ranges keep every sample', () => {
    const t = setup();
    t.advance(3_600_000 - (t.at() % 3_600_000)); // align to a 30-day-range bucket (1 h)
    for (const cpu of [10, 20, 30, 40]) {
      const gpus = MOCK_GPU_CASES.single.map((g) => ({ ...g, utilPercent: cpu }));
      t.monitor.report({ hostId: t.hostId, ts: t.at(), metrics: { ...healthy, cpuLoadPercent: cpu }, gpus, updates: null });
      t.advance(60_000);
    }
    const lastTs = t.at() - 60_000;
    expect(t.monitor.hostDetail(t.hostId, 60)?.series.map((p) => p.cpuLoadPercent)).toEqual([10, 20, 30, 40]);
    const month = t.monitor.hostDetail(t.hostId, 43_200);
    expect(month?.series).toEqual([expect.objectContaining({ ts: lastTs, cpuLoadPercent: 25 })]);
    expect(month?.gpuSeries[0]?.points).toEqual([expect.objectContaining({ ts: lastTs, utilPercent: 25 })]);
    t.close();
  });

  it('keeps the newest OS update check when an older one or none arrives later', () => {
    const t = setup();
    const send = (updates: ReportRequest['updates']) =>
      t.monitor.report({ hostId: t.hostId, ts: t.at(), metrics: healthy, gpus: [], updates });
    expect(t.monitor.listHosts().hosts[0]?.updates).toBeNull();
    const checkedAt = t.at();
    send({ checkedAt, pending: 5, security: 1 });
    t.advance(1000);
    send({ checkedAt: checkedAt - 60_000, pending: 9, security: 9 });
    send(null);
    expect(t.monitor.listHosts().hosts[0]?.updates).toEqual({ checkedAt, pending: 5, security: 1 });
    t.advance(1000);
    send({ checkedAt: t.at(), pending: 0, security: null });
    expect(t.monitor.hostDetail(t.hostId, 5)?.host.updates).toEqual({ checkedAt: t.at(), pending: 0, security: null });
    t.close();
  });
});

describe('custom groups', () => {
  it('creates, renames, assigns, removes and deletes; system groups are immutable', async () => {
    const { json } = await boot();
    const host = (await json('/api/agent/register', { method: 'POST', body: JSON.stringify(registration) })).body.hostId;
    const created = await json('/api/groups', { method: 'POST', body: JSON.stringify({ name: ' 生產環境 ' }) });
    expect(created).toMatchObject({ status: 201, body: { name: '生產環境', kind: 'custom', hostIds: [] } });
    const id = created.body.id;

    expect((await json('/api/groups', { method: 'POST', body: JSON.stringify({ name: '生產環境' }) })).status).toBe(409);
    expect((await json('/api/groups', { method: 'POST', body: JSON.stringify({ name: '' }) })).status).toBe(400);
    expect((await json(`/api/groups/${id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Prod' }) })).body.name).toBe('Prod');

    expect((await json(`/api/groups/${id}/hosts/${host}`, { method: 'PUT' })).status).toBe(204);
    expect((await json('/api/hosts')).body.hosts[0].customGroupIds).toEqual([id]);
    expect((await json(`/api/groups/${id}/hosts/9999`, { method: 'PUT' })).status).toBe(404);
    expect((await json(`/api/groups/${id}/hosts/${host}`, { method: 'DELETE' })).status).toBe(204);
    expect((await json('/api/hosts')).body.hosts[0].customGroupIds).toEqual([]);

    const system = (await json('/api/groups')).body.groups.find((g: { kind: string }) => g.kind === 'system');
    expect((await json(`/api/groups/${system.id}`, { method: 'DELETE' })).status).toBe(400);
    expect((await json(`/api/groups/${system.id}/hosts/${host}`, { method: 'DELETE' })).status).toBe(400);

    expect((await json(`/api/groups/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await json(`/api/groups/${id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('host deletion', () => {
  it('deletes a host with its samples, GPU rows, update check and group membership', () => {
    const db = openDatabase(':memory:', 1000);
    const events = new EventHub();
    const seen: PulseEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const store = new Store(db);
    const monitor = new Monitor(store, events, testConfig());
    const { hostId } = monitor.register(registration);
    const other = monitor.register({ ...registration, hostname: 'web-02' }).hostId;
    const group = store.createGroup('Prod');
    store.addMember(group, hostId);
    const ts = Date.now();
    const gpus = MOCK_GPU_CASES.single.map((g) => ({ ...g }));
    monitor.report({ hostId, ts, metrics: healthy, gpus, updates: { checkedAt: ts, pending: 3, security: 1 } });
    monitor.report({ hostId: other, ts, metrics: healthy, gpus, updates: null });

    expect(monitor.deleteHost(hostId)).toBe(true);
    expect(seen).toContainEqual({ type: 'hostDeleted', hostId });
    const count = (table: string) =>
      db.prepare(`SELECT COUNT(*) FROM ${table} WHERE host_id = ?`).pluck().get(hostId) as number;
    expect(['metric_samples', 'gpu_samples', 'host_updates', 'host_group_members'].map(count)).toEqual([0, 0, 0, 0]);
    expect(monitor.listHosts().hosts.map((h) => h.id)).toEqual([other]);
    expect(store.getGroup(group)?.hostIds).toEqual([]);
    expect(monitor.deleteHost(hostId)).toBe(false);
    db.close();
  });

  it('DELETE /api/hosts/:id answers 204 / 404 / 400; a still-running agent registers again', async () => {
    const { base, json } = await boot((raw) => {
      raw.agent.minReportIntervalSec = 0;
    });
    const agent = new Agent({
      client: new PulseClient(new URL(base), 'x'),
      system: new MockSystemCollector(),
      gpu: new MockGpuCollector([]),
      updates: new MockUpdateChecker(),
      registration,
      log: () => {},
    });
    await agent.tick();
    const id = agent.registeredHostId;
    expect((await json(`/api/hosts/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await json(`/api/hosts/${id}`)).status).toBe(404);
    expect((await json(`/api/hosts/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await json('/api/hosts/abc', { method: 'DELETE' })).status).toBe(400);
    expect((await json('/api/hosts')).body.hosts).toEqual([]);

    expect(await agent.tick()).toEqual({ kind: 'skipped', reason: 'host unknown to server, re-registering' });
    expect(await agent.tick()).toEqual({ kind: 'reported', status: 'ok' });
    expect(agent.registeredHostId).not.toBe(id);
  });
});

describe('no bypass of the Zero Trust layer', () => {
  it('refuses a non-loopback bind unless explicitly allowed', () => {
    expect(() => testConfig((raw) => (raw.server.host = '0.0.0.0'))).toThrow(ConfigError);
    expect(() => testConfig((raw) => (raw.server.host = '0.0.0.0', raw.server.allowExternalBind = true))).not.toThrow();
  });

  const external = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && !a.internal && a.family === 'IPv4')?.address;

  it.skipIf(!external)('is unreachable through a non-loopback address of this machine', async () => {
    const { port } = await boot();
    const outcome = await new Promise<string>((resolve) => {
      const socket = connect({ host: external, port, timeout: 2000 });
      socket.once('connect', () => (socket.destroy(), resolve('connected')));
      socket.once('timeout', () => (socket.destroy(), resolve('timeout')));
      socket.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
    });
    expect(outcome).not.toBe('connected');
  });
});
