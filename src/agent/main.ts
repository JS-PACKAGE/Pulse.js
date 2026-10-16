import { parseArgs } from 'node:util';
import { PULSE_VERSION } from '../shared/version.ts';
import { Agent } from './agent.ts';
import { PulseClient } from './client.ts';
import { createUpdateChecker } from './collectors/updates.ts';
import { loadAgentConfig } from './config.ts';
import { buildRegistration, createCollectors, detectPlatform } from './detect.ts';
import { createRunCommand } from './exec.ts';

// Never log the Authorization value (AGENTS.md security rule 8).
const log = (msg: string): void => console.log(`${new Date().toISOString()} [pulse-agent] ${msg}`);

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string', short: 'c' } } });
  const config = await loadAgentConfig(values.config ?? process.env.PULSE_AGENT_CONFIG ?? '/etc/pulse-agent/agent.json');
  const run = createRunCommand();
  const platform = await detectPlatform(run);
  const { system, gpu } = createCollectors(platform.osFamily, {
    diskPath: config.diskPath,
    netInterface: config.netInterface,
    run,
    warn: (m) => log(`warning: ${m}`),
  });

  const gpus = await gpu.list().catch((err: unknown) => {
    log(`warning: gpu detection failed (reported as N/A): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });
  const registration = buildRegistration(platform, gpus.length);
  log(`Pulse.js agent ${PULSE_VERSION} on ${platform.osVersion} (${platform.osFamily}/${registration.arch}), ${gpus.length} GPU(s), server ${config.serverUrl.origin}`);

  const agent = new Agent({
    client: new PulseClient(config.serverUrl, config.authorization),
    system,
    gpu,
    updates: createUpdateChecker(platform.osFamily, run),
    registration,
    log,
  });
  const controller = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      log(`${sig} received, stopping`);
      controller.abort();
    });
  }
  await agent.run(controller.signal);
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
