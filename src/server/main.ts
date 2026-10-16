import { once } from 'node:events';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PULSE_VERSION } from '../shared/version.ts';
import { createApp } from './app.ts';
import { ConfigError, isLoopbackHost, loadConfig, type ServerConfig } from './config.ts';
import { openDatabase } from './db.ts';
import { EventHub } from './events.ts';
import { Monitor } from './monitor.ts';
import { Store } from './store.ts';

const log = (msg: string): void => console.log(`${new Date().toISOString()} ${msg}`);

export interface RunningServer {
  server: Server;
  monitor: Monitor;
  close: () => Promise<void>;
}

export async function startServer(config: ServerConfig, paths: { webDir?: string; agentBundle?: string } = {}) {
  const db = openDatabase(config.database.path, config.database.busyTimeoutMs);
  const store = new Store(db);
  const events = new EventHub();
  const monitor = new Monitor(store, events, config);
  monitor.reevaluateAll();
  const purge = (): void => {
    const removed = monitor.purgeExpired();
    if (removed.metrics || removed.gpus) log(`[pulse] retention: removed ${removed.metrics} metric / ${removed.gpus} gpu samples`);
  };
  purge();

  const app = createApp({ config, store, monitor, events, log, ...paths });
  const server = config.tls.enabled
    ? createHttpsServer({ cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile) }, app)
    : createHttpServer(app);

  // `once` rejects if 'error' (e.g. EADDRINUSE) fires first.
  server.listen(config.server.port, config.server.host);
  await once(server, 'listening');

  const sweepMs = Math.max(500, Math.min(5000, (config.agent.offlineAfterSec * 1000) / 3));
  const timers = [
    setInterval(() => monitor.sweepOffline(), sweepMs),
    setInterval(purge, config.retention.cleanupIntervalHours * 3_600_000),
  ];

  const close = async (): Promise<void> => {
    for (const t of timers) clearInterval(t);
    // SSE responses never end on their own.
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
    db.close();
  };
  return { server, monitor, close } satisfies RunningServer;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string', short: 'c' } } });
  const configPath = values.config ?? process.env.PULSE_CONFIG ?? 'config.yaml';
  const config = loadConfig(configPath);
  const running = await startServer(config, {
    webDir: fileURLToPath(new URL('../web/', import.meta.url)),
    agentBundle: fileURLToPath(new URL('../agent/pulse-agent.mjs', import.meta.url)),
  });

  const { host, port } = config.server;
  const scheme = config.tls.enabled ? 'https' : 'http';
  log(`[pulse] Pulse.js ${PULSE_VERSION} listening on ${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}`);
  if (!isLoopbackHost(host)) {
    log('[pulse] WARNING: bound to a non-loopback address; ensure a firewall only admits the Cloudflare Tunnel source.');
  }

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`[pulse] ${signal} received, shutting down`);
    running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

// Run only as the entry point (tests import startServer); realpath handles symlinked installs.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().catch((err: unknown) => {
    if (err instanceof ConfigError) console.error(err.message);
    else console.error(`[pulse] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
