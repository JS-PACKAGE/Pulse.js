// Platform detection (same rules as install.sh) and adapter wiring per platform.
import { readFile } from 'node:fs/promises';
import { arch, cpus, hostname, platform } from 'node:os';
import type { OsFamily, RegisterRequest } from '../shared/types.ts';
import { normalizeHostname } from '../shared/validate.ts';
import { PULSE_VERSION } from '../shared/version.ts';
import { createLinuxProbes } from './collectors/linux.ts';
import { createMacosProbes } from './collectors/macos.ts';
import { createSystemCollector, type SystemCollector, type Warn } from './collectors/system.ts';
import type { RunCommand } from './exec.ts';
import { AmdRocmSmiGpuCollector } from './gpu/amd.ts';
import { AppleGpuCollector } from './gpu/apple.ts';
import { CompositeGpuCollector, type GpuCollector } from './gpu/gpu.ts';
import { NvidiaSmiGpuCollector } from './gpu/nvidia.ts';

export function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

/** Debian/Ubuntu family vs RHEL family by ID / ID_LIKE (PLAN.md assumption 2). */
export function linuxFamily(release: Record<string, string>): OsFamily | null {
  const ids = `${release.ID ?? ''} ${release.ID_LIKE ?? ''}`.toLowerCase().split(/\s+/);
  if (ids.some((id) => id === 'debian' || id === 'ubuntu')) return 'linux-deb';
  if (ids.some((id) => ['rhel', 'fedora', 'centos', 'rocky', 'almalinux', 'amzn'].includes(id))) return 'linux-rpm';
  return null;
}

export interface Platform {
  osFamily: OsFamily;
  osVersion: string;
}

export async function detectPlatform(run: RunCommand): Promise<Platform> {
  const os = platform();
  if (os === 'darwin') {
    const version = (await run('sw_vers', ['-productVersion'])).trim();
    return { osFamily: 'macos', osVersion: `macOS ${version}` };
  }
  if (os === 'linux') {
    const release = parseOsRelease(await readFile('/etc/os-release', 'utf8'));
    const osFamily = linuxFamily(release);
    if (!osFamily) throw new Error(`unsupported Linux distribution: ${release.ID ?? 'unknown'}`);
    const osVersion = release.PRETTY_NAME || `${release.NAME ?? release.ID ?? 'Linux'} ${release.VERSION_ID ?? ''}`.trim();
    return { osFamily, osVersion };
  }
  throw new Error(`unsupported platform: ${os} (Windows is out of scope for v1)`);
}

export function createCollectors(
  osFamily: OsFamily,
  opts: { diskPath: string; netInterface: string; run: RunCommand; warn: Warn },
): { system: SystemCollector; gpu: GpuCollector } {
  if (osFamily === 'macos') {
    return {
      system: createSystemCollector(createMacosProbes(opts), opts.warn),
      // Apple Silicon only; Intel Macs are not in the GPU vendor scope.
      gpu: arch() === 'arm64' ? new AppleGpuCollector(opts.run) : new CompositeGpuCollector([]),
    };
  }
  return {
    system: createSystemCollector(createLinuxProbes(opts), opts.warn),
    gpu: new CompositeGpuCollector([new NvidiaSmiGpuCollector(opts.run), new AmdRocmSmiGpuCollector(opts.run)]),
  };
}

export function buildRegistration(platformInfo: Platform, gpuCount: number): RegisterRequest {
  const name = normalizeHostname(hostname());
  if (name === null) throw new Error(`hostname "${hostname()}" cannot be normalised to [a-z0-9._-]`);
  return {
    hostname: name,
    osFamily: platformInfo.osFamily,
    osVersion: platformInfo.osVersion.slice(0, 200),
    arch: arch(),
    cpuModel: (cpus()[0]?.model ?? 'unknown').trim().slice(0, 200),
    gpuCount,
    agentVersion: PULSE_VERSION,
  };
}
