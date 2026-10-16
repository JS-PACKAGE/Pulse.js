import { setTimeout as sleep } from 'node:timers/promises';
import type { GpuInfo, HostStatus, OsUpdates, RegisterRequest } from '../shared/types.ts';
import { HttpError, type PulseClient } from './client.ts';
import type { SystemCollector } from './collectors/system.ts';
import type { UpdateChecker } from './collectors/updates.ts';
import type { GpuCollector } from './gpu/gpu.ts';

/** OS update checks are slow (macOS asks Apple) and change rarely. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 3_600_000;

export interface AgentDeps {
  client: PulseClient;
  system: SystemCollector;
  gpu: GpuCollector;
  updates: UpdateChecker;
  registration: RegisterRequest;
  log: (msg: string) => void;
  now?: () => number;
}

export type TickResult = { kind: 'reported'; status: HostStatus } | { kind: 'skipped'; reason: string };

/** Registers once, then reports every `reportIntervalSec` handed out by the server. */
export class Agent {
  private hostId: number | null = null;
  private intervalSec = 30;
  /** Last successful update check, resent with every report until a newer one replaces it. */
  private updates: OsUpdates | null = null;
  private nextUpdateCheckAt = 0;
  private updateCheckRunning = false;
  private readonly now: () => number;

  constructor(private readonly deps: AgentDeps) {
    this.now = deps.now ?? Date.now;
  }

  get registeredHostId(): number | null {
    return this.hostId;
  }

  async register(): Promise<number> {
    const res = await this.deps.client.register(this.deps.registration);
    this.hostId = res.hostId;
    this.intervalSec = res.reportIntervalSec;
    this.deps.log(`registered as host ${res.hostId} (${this.deps.registration.hostname}), reporting every ${res.reportIntervalSec}s`);
    return res.hostId;
  }

  /**
   * Collect and send one report. GPU failure → `gpus: null` (N/A) without dropping the report.
   * A due OS update check starts in the background; reports never wait for it.
   */
  async tick(): Promise<TickResult> {
    const hostId = this.hostId ?? (await this.register());
    this.startUpdateCheckIfDue();
    const ts = this.now();
    const [metrics, gpus] = await Promise.all([
      this.deps.system.snapshot(),
      this.deps.gpu.list().catch((err: unknown): GpuInfo[] | null => {
        this.deps.log(`warning: gpu collection failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }),
    ]);
    try {
      const status = await this.deps.client.report({ hostId, ts, metrics, gpus, updates: this.updates });
      return { kind: 'reported', status };
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        // Host row vanished server-side (e.g. fresh database): register again next cycle.
        this.hostId = null;
        return { kind: 'skipped', reason: 'host unknown to server, re-registering' };
      }
      if (err instanceof HttpError && err.status === 429) return { kind: 'skipped', reason: 'rate limited by server' };
      throw err;
    }
  }

  /** A failed check keeps the previous result (it carries its own `checkedAt`) and retries next interval. */
  private startUpdateCheckIfDue(): void {
    if (this.updateCheckRunning || this.now() < this.nextUpdateCheckAt) return;
    this.updateCheckRunning = true;
    this.nextUpdateCheckAt = this.now() + UPDATE_CHECK_INTERVAL_MS;
    this.deps.updates
      .check()
      .then(
        (count) => {
          this.updates = { checkedAt: this.now(), ...count };
        },
        (err: unknown) => {
          this.deps.log(`warning: os update check failed: ${err instanceof Error ? err.message : String(err)}`);
        },
      )
      .finally(() => {
        this.updateCheckRunning = false;
      });
  }

  /** Runs until `signal` aborts. Network errors are logged and retried with backoff. */
  async run(signal: AbortSignal): Promise<void> {
    let backoffSec = 5;
    while (!signal.aborted) {
      const started = this.now();
      let waitSec: number;
      try {
        const result = await this.tick();
        if (result.kind === 'skipped') this.deps.log(`report skipped: ${result.reason}`);
        backoffSec = 5;
        waitSec = this.intervalSec - (this.now() - started) / 1000;
      } catch (err) {
        this.deps.log(`error: ${err instanceof Error ? err.message : String(err)}; retrying in ${backoffSec}s`);
        waitSec = backoffSec;
        backoffSec = Math.min(backoffSec * 2, Math.max(60, this.intervalSec));
      }
      await sleep(Math.max(0, waitSec) * 1000, undefined, { signal }).catch(() => undefined);
    }
  }
}
