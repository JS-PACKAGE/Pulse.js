// Pending OS update checks (apt / dnf / softwareupdate). Read-only: never refreshes indexes or installs.
// Linux relies on the distro's own index refresh (apt-daily.timer, dnf-makecache.timer). Parsers exported for tests.
import type { OsFamily, OsUpdates } from '../../shared/types.ts';
import type { RunCommand } from '../exec.ts';

export type UpdateCount = Omit<OsUpdates, 'checkedAt'>;

export interface UpdateChecker {
  /** Throws when the tool fails or its output is unusable (fail-closed). */
  check(): Promise<UpdateCount>;
}

/** `softwareupdate -l` contacts Apple and can take minutes on a slow link. */
export const UPDATE_CHECK_TIMEOUT_MS = 5 * 60_000;

/**
 * `apt-get -s dist-upgrade`: one `Inst` line per package the upgrade would install. Security
 * updates carry a `*-security` origin inside the parentheses, e.g.
 * `Inst libssl3 [3.0.13-0ubuntu3.4] (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])`.
 * `Inst` lines are not translated, so the service locale does not matter.
 */
export function parseAptSimulation(text: string): { pending: number; security: number } {
  let pending = 0;
  let security = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('Inst ')) continue;
    pending++;
    const paren = line.indexOf('(');
    if (paren >= 0 && /-security\b/.test(line.slice(paren))) security++;
  }
  return { pending, security };
}

/**
 * `dnf -q check-update` rows are `name.arch  version  repo`; dnf 4 wraps long names onto an
 * indented continuation line, so only unindented `name.arch` rows are counted. The trailing
 * "Obsoleting packages" section repeats upgrades and is skipped.
 */
export function parseDnfCheckUpdate(text: string): number {
  let count = 0;
  for (const line of text.split('\n')) {
    if (/^Obsoleting packages/i.test(line)) break;
    if (/^[^\s.]\S*\.[A-Za-z0-9_]+(?:\s|$)/.test(line)) count++;
  }
  return count;
}

/** `softwareupdate -l` lists one `* Label: …` line per available update. */
export function parseSoftwareUpdateList(text: string): number {
  return text.split('\n').filter((line) => /^\s*\* Label: /.test(line)).length;
}

export function createUpdateChecker(osFamily: OsFamily, run: RunCommand): UpdateChecker {
  const timeoutMs = UPDATE_CHECK_TIMEOUT_MS;
  switch (osFamily) {
    case 'linux-deb':
      return { check: async () => parseAptSimulation(await run('apt-get', ['-s', 'dist-upgrade'], { timeoutMs })) };
    case 'linux-rpm': {
      // `-C`: cached metadata only (the agent runs unprivileged on a read-only filesystem); exit 100 = updates exist.
      const checkUpdate = async (extra: string[]) =>
        parseDnfCheckUpdate(await run('dnf', ['-q', '-C', 'check-update', ...extra], { timeoutMs, okExitCodes: [100] }));
      return {
        check: async () => ({ pending: await checkUpdate([]), security: await checkUpdate(['--security']) }),
      };
    }
    case 'macos':
      // Apple does not flag security content in this list.
      return { check: async () => ({ pending: parseSoftwareUpdateList(await run('softwareupdate', ['-l'], { timeoutMs })), security: null }) };
  }
}
