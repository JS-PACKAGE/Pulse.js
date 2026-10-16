import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { THRESHOLD_METRICS, type Thresholds } from '../shared/types.ts';

export interface ServerConfig {
  server: { host: string; port: number; allowExternalBind: boolean };
  tls: { enabled: boolean; certFile: string; keyFile: string };
  database: { path: string; busyTimeoutMs: number };
  agent: { reportIntervalSec: number; offlineAfterSec: number; minReportIntervalSec: number };
  retention: { days: number; cleanupIntervalHours: number };
  limits: { maxPayloadBytes: number };
  thresholds: Thresholds;
}

export class ConfigError extends Error {}

/** True for addresses only reachable from this machine. */
export function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  return host === '::1';
}

function section(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = raw[key];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ConfigError(`config: "${key}" section is required`);
  return v as Record<string, unknown>;
}

function num(sec: Record<string, unknown>, path: string, key: string, min: number, max: number, integer = true): number {
  const v = sec[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
    throw new ConfigError(`config: ${path}.${key} must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}]`);
  }
  return v;
}

function bool(sec: Record<string, unknown>, path: string, key: string): boolean {
  const v = sec[key];
  if (typeof v !== 'boolean') throw new ConfigError(`config: ${path}.${key} must be true or false`);
  return v;
}

function str(sec: Record<string, unknown>, path: string, key: string): string {
  const v = sec[key];
  if (typeof v !== 'string') throw new ConfigError(`config: ${path}.${key} must be a string`);
  return v;
}

/** Validate a parsed YAML document. Every key is required: nothing is silently defaulted. */
export function parseConfig(raw: unknown, baseDir: string): ServerConfig {
  if (typeof raw !== 'object' || raw === null) throw new ConfigError('config: document must be a mapping');
  const doc = raw as Record<string, unknown>;

  const s = section(doc, 'server');
  const host = str(s, 'server', 'host');
  if (host !== 'localhost' && isIP(host) === 0) throw new ConfigError('config: server.host must be an IP address or "localhost"');
  const server = { host, port: num(s, 'server', 'port', 0, 65535), allowExternalBind: bool(s, 'server', 'allowExternalBind') };
  if (!isLoopbackHost(host) && !server.allowExternalBind) {
    throw new ConfigError(
      `config: server.host "${host}" is not loopback; the app must only be reachable through Cloudflare Tunnel. ` +
        'Set server.allowExternalBind: true only when a firewall restricts the port to the Tunnel source.',
    );
  }

  const t = section(doc, 'tls');
  const tls = { enabled: bool(t, 'tls', 'enabled'), certFile: str(t, 'tls', 'certFile'), keyFile: str(t, 'tls', 'keyFile') };
  if (tls.enabled) {
    if (!tls.certFile || !tls.keyFile) throw new ConfigError('config: tls.certFile and tls.keyFile are required when tls.enabled');
    tls.certFile = resolve(baseDir, tls.certFile);
    tls.keyFile = resolve(baseDir, tls.keyFile);
  }

  const d = section(doc, 'database');
  const dbPath = str(d, 'database', 'path');
  if (!dbPath) throw new ConfigError('config: database.path must not be empty');
  const database = {
    path: dbPath === ':memory:' ? dbPath : resolve(baseDir, dbPath),
    busyTimeoutMs: num(d, 'database', 'busyTimeoutMs', 0, 600_000),
  };

  const a = section(doc, 'agent');
  const agent = {
    reportIntervalSec: num(a, 'agent', 'reportIntervalSec', 1, 3600),
    offlineAfterSec: num(a, 'agent', 'offlineAfterSec', 1, 86_400),
    minReportIntervalSec: num(a, 'agent', 'minReportIntervalSec', 0, 3600),
  };
  if (agent.minReportIntervalSec > agent.reportIntervalSec) {
    throw new ConfigError('config: agent.minReportIntervalSec must not exceed agent.reportIntervalSec');
  }
  if (agent.offlineAfterSec <= agent.reportIntervalSec) {
    throw new ConfigError('config: agent.offlineAfterSec must be greater than agent.reportIntervalSec');
  }

  const r = section(doc, 'retention');
  const retention = {
    days: num(r, 'retention', 'days', 1, 3650),
    cleanupIntervalHours: num(r, 'retention', 'cleanupIntervalHours', 1, 24 * 30),
  };

  const l = section(doc, 'limits');
  const limits = { maxPayloadBytes: num(l, 'limits', 'maxPayloadBytes', 1024, 64 * 1024) };

  const th = section(doc, 'thresholds');
  const thresholds = {} as Thresholds;
  for (const metric of THRESHOLD_METRICS) {
    const m = section(th, metric);
    const warn = num(m, `thresholds.${metric}`, 'warn', 0, 1e12, false);
    const crit = num(m, `thresholds.${metric}`, 'crit', 0, 1e12, false);
    if (crit < warn) throw new ConfigError(`config: thresholds.${metric}.crit must be >= warn`);
    thresholds[metric] = { warn, crit };
  }

  return { server, tls, database, agent, retention, limits, thresholds };
}

export function loadConfig(path: string): ServerConfig {
  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new ConfigError(`config: cannot read ${abs}: ${(err as Error).message}`);
  }
  return parseConfig(parse(text), dirname(abs));
}
