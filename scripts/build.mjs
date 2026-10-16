// Bundles the server (dependencies left external) and the agent (single self-contained file).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  logLevel: 'info',
  define: { __PULSE_VERSION__: JSON.stringify(version) },
};

const targets = {
  server: { entryPoints: ['src/server/main.ts'], outfile: 'dist/server/main.mjs', packages: 'external' },
  // Zero third-party runtime dependencies: everything (incl. shared code) is inlined so
  // install.sh can download and run one file.
  agent: {
    entryPoints: ['src/agent/main.ts'],
    outfile: 'dist/agent/pulse-agent.mjs',
    banner: { js: '#!/usr/bin/env node' },
  },
};

const which = process.argv[2];
const selected = which ? [which] : Object.keys(targets);
for (const name of selected) {
  const target = targets[name];
  if (!target) throw new Error(`unknown build target: ${name}`);
  await build({ ...common, ...target });
}
