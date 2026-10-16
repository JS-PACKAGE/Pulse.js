import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { parseConfig, type ServerConfig } from '../src/server/config.ts';

/** The shipped config.yaml template, re-pointed at an in-memory DB and an ephemeral port. */
export function testConfig(patch: (raw: Record<string, any>) => void = () => {}): ServerConfig {
  const raw = parse(readFileSync(new URL('../config.yaml', import.meta.url), 'utf8'));
  raw.server.port = 0;
  raw.database.path = ':memory:';
  patch(raw);
  return parseConfig(raw, process.cwd());
}
