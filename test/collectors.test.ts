import { describe, expect, it } from 'vitest';
import { parseDefaultRoute, parseMeminfo, parseNetDev } from '../src/agent/collectors/linux.ts';
import { parseMemoryStatus, parseNetstat, parseRouteGetDefault, parseSysctlLoadavg } from '../src/agent/collectors/macos.ts';
import { MOCK_SYSTEM_METRICS, MockSystemCollector } from '../src/agent/collectors/mock.ts';
import { createRateTracker, createSystemCollector, type MetricProbes } from '../src/agent/collectors/system.ts';
import { createUpdateChecker, parseAptSimulation, parseDnfCheckUpdate, parseSoftwareUpdateList } from '../src/agent/collectors/updates.ts';
import { CommandMissingError, createRunCommand, type RunCommand, type RunOptions } from '../src/agent/exec.ts';
import { AmdRocmSmiGpuCollector, parseRocmSmi } from '../src/agent/gpu/amd.ts';
import { parseIoregAccelerators } from '../src/agent/gpu/apple.ts';
import { CompositeGpuCollector } from '../src/agent/gpu/gpu.ts';
import { MOCK_GPU_CASES, MockGpuCollector } from '../src/agent/gpu/mock.ts';
import { NvidiaSmiGpuCollector, parseNvidiaSmi } from '../src/agent/gpu/nvidia.ts';
import { linuxFamily, parseOsRelease } from '../src/agent/detect.ts';
import { METRIC_KEYS } from '../src/shared/types.ts';

const missing: RunCommand = async (cmd) => {
  throw new CommandMissingError(cmd);
};
const failing: RunCommand = async (cmd) => {
  throw new Error(`${cmd} failed: exit 9`);
};
const replying = (out: string): RunCommand => async () => out;

describe('SystemCollector contract', () => {
  it('mock returns every metric key', async () => {
    const snap = await new MockSystemCollector().snapshot();
    expect(Object.keys(snap).sort()).toEqual([...METRIC_KEYS].sort());
    expect(snap).toEqual(MOCK_SYSTEM_METRICS);
  });

  it('a failing probe blanks only its own fields and is logged (fail-closed)', async () => {
    const warnings: string[] = [];
    const probes: MetricProbes = {
      cpuLoadPercent: async () => 12.3456,
      memory: async () => {
        throw new Error('sysctl timed out');
      },
      disk: async () => ({ usedGB: 10, totalGB: 100 }),
      network: async () => ({ rxKbps: 1, txKbps: 2 }),
    };
    const snap = await createSystemCollector(probes, (m) => warnings.push(m)).snapshot();
    expect(snap).toEqual({
      cpuLoadPercent: 12.35,
      memUsedMB: null,
      memTotalMB: null,
      diskUsedGB: 10,
      diskTotalGB: 100,
      netRxKbps: 1,
      netTxKbps: 2,
    });
    expect(warnings).toEqual(['memory collection failed: sysctl timed out']);
  });
});

describe('network rate tracker', () => {
  it('primes with two samples, then reports kbps from counter deltas', async () => {
    let t = 0;
    const counters = [
      { rx: 0, tx: 0 },
      { rx: 125_000, tx: 12_500 }, // +1 s: 1000 kbps rx, 100 kbps tx
      { rx: 125_000 + 30 * 125_000, tx: 12_500 }, // +30 s
    ];
    let i = 0;
    const rate = createRateTracker(
      async () => counters[i++]!,
      1000,
      () => t,
      async (ms) => {
        t += ms;
      },
    );
    expect(await rate()).toEqual({ rxKbps: 1000, txKbps: 100 });
    t += 30_000;
    expect(await rate()).toEqual({ rxKbps: 1000, txKbps: 0 });
  });

  it('throws on counter reset and re-primes on the next call', async () => {
    let t = 0;
    const counters = [{ rx: 1000, tx: 1000 }, { rx: 2000, tx: 2000 }, { rx: 5, tx: 5 }, { rx: 5, tx: 5 }, { rx: 130, tx: 5 }];
    let i = 0;
    const rate = createRateTracker(async () => counters[i++]!, 1000, () => t, async (ms) => void (t += ms));
    await rate();
    t += 1000;
    await expect(rate()).rejects.toThrow(/backwards/);
    expect(await rate()).toEqual({ rxKbps: 1, txKbps: 0 });
  });
});

describe('Linux /proc parsers', () => {
  it('meminfo: used = MemTotal − MemAvailable', () => {
    const text = 'MemTotal:       16384000 kB\nMemFree:          100000 kB\nMemAvailable:    8192000 kB\n';
    expect(parseMeminfo(text)).toEqual({ usedMB: 8000, totalMB: 16000 });
    expect(() => parseMeminfo('MemTotal: 1 kB\n')).toThrow(/MemAvailable/);
  });

  it('net/dev: rx = field 0, tx = field 8 of the interface row', () => {
    const text = [
      'Inter-|   Receive                                                |  Transmit',
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
      '    lo: 999 9 0 0 0 0 0 0 999 9 0 0 0 0 0 0',
      '  eth0: 123456 100 0 0 0 0 0 0 654321 200 0 0 0 0 0 0',
    ].join('\n');
    expect(parseNetDev(text, 'eth0')).toEqual({ rx: 123456, tx: 654321 });
    expect(() => parseNetDev(text, 'wlan0')).toThrow(/not found/);
  });

  it('net/route: picks the up default route with the lowest metric', () => {
    const text = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
      'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
      'eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0',
    ].join('\n');
    expect(parseDefaultRoute(text)).toBe('eth0');
    expect(() => parseDefaultRoute(text.split('\n').slice(0, 1).join('\n'))).toThrow(/no default route/);
  });

  it('os-release: Debian and RHEL families via ID / ID_LIKE', () => {
    expect(linuxFamily(parseOsRelease('ID=ubuntu\nID_LIKE=debian\n'))).toBe('linux-deb');
    expect(linuxFamily(parseOsRelease('ID="rocky"\nID_LIKE="rhel centos fedora"\n'))).toBe('linux-rpm');
    expect(linuxFamily(parseOsRelease('ID=amzn\n'))).toBe('linux-rpm');
    expect(linuxFamily(parseOsRelease('ID=arch\n'))).toBeNull();
  });
});

describe('macOS tool parsers', () => {
  it('vm.loadavg', () => {
    expect(parseSysctlLoadavg('{ 3.74 4.01 3.90 }\n')).toBe(3.74);
    expect(() => parseSysctlLoadavg('garbage')).toThrow();
  });

  it('memory: used = total × (100 − kern.memorystatus_level) %', () => {
    expect(parseMemoryStatus('46\n25769803776\n')).toEqual({ usedMB: 24576 * 0.54, totalMB: 24576 });
    expect(() => parseMemoryStatus('101\n25769803776\n')).toThrow(/memorystatus_level/);
    expect(() => parseMemoryStatus('46\n')).toThrow(/hw.memsize/);
  });

  it('netstat -ibn: link row totals even when the Address column is blank', () => {
    const text = [
      'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
      'lo0        16384 <Link#1>                      128522570     0 80815095471 128522570     0 80815095471     0',
      'en0        1500  <Link#11>   a4:fc:14:00:00:01  5000     0    9000000     4000     0    3000000     0',
      'en0        1500  192.168.1     192.168.1.20       5000     -    9000000     4000     -    3000000     -',
    ].join('\n');
    expect(parseNetstat(text, 'en0')).toEqual({ rx: 9_000_000, tx: 3_000_000 });
    expect(parseNetstat(text, 'lo0')).toEqual({ rx: 80815095471, tx: 80815095471 });
    expect(() => parseNetstat(text, 'en9')).toThrow(/not found/);
  });

  it('route -n get default', () => {
    expect(parseRouteGetDefault('   route to: default\n  interface: en0\n')).toBe('en0');
    expect(() => parseRouteGetDefault('route: writing to routing socket: not in table')).toThrow();
  });
});

describe('GpuCollector contract (§3.1)', () => {
  it.each(Object.entries(MOCK_GPU_CASES))('mock case %s returns its cards', async (_name, gpus) => {
    expect(await new MockGpuCollector(gpus).list()).toEqual(gpus);
  });

  it('missing vendor tools mean no GPU ([]), a failing tool throws', async () => {
    expect(await new NvidiaSmiGpuCollector(missing).list()).toEqual([]);
    expect(await new AmdRocmSmiGpuCollector(missing).list()).toEqual([]);
    await expect(new NvidiaSmiGpuCollector(failing).list()).rejects.toThrow(/exit 9/);
  });

  it('composite concatenates vendors (multi-vendor host)', async () => {
    const composite = new CompositeGpuCollector([
      new MockGpuCollector(MOCK_GPU_CASES.dual),
      new MockGpuCollector(MOCK_GPU_CASES.empty),
      new MockGpuCollector(MOCK_GPU_CASES.crossVendor.filter((g) => g.vendor === 'amd')),
    ]);
    expect((await composite.list()).map((g) => `${g.vendor}:${g.index}`)).toEqual(['nvidia:0', 'nvidia:1', 'amd:0']);
  });

  it('nvidia-smi: one row per card, N/A → null, commas inside names survive', async () => {
    const out = '0, NVIDIA A100-SXM4-80GB, 91, 70000, 81920\n1, Tesla K80, [N/A], [Not Supported], 11441\n2, Quadro, Inc, 5, 1, 2\n';
    expect(await new NvidiaSmiGpuCollector(replying(out)).list()).toEqual([
      { index: 0, name: 'NVIDIA A100-SXM4-80GB', vendor: 'nvidia', utilPercent: 91, memUsedMB: 70000, memTotalMB: 81920 },
      { index: 1, name: 'Tesla K80', vendor: 'nvidia', utilPercent: null, memUsedMB: null, memTotalMB: 11441 },
      { index: 2, name: 'Quadro, Inc', vendor: 'nvidia', utilPercent: 5, memUsedMB: 1, memTotalMB: 2 },
    ]);
    expect(() => parseNvidiaSmi('No devices were found\n')).toThrow(/unexpected/);
  });

  it('rocm-smi JSON: per card, bytes → MB, case-insensitive keys, leading warnings skipped', () => {
    const out = `WARNING: something\n${JSON.stringify({
      card1: { 'GPU use (%)': '5', 'VRAM Total Memory (B)': '2097152', 'VRAM Total Used Memory (B)': '1048576', 'Card series': 'Radeon Pro W7800' },
      card0: { 'GPU use (%)': '14', 'VRAM Total Memory (B)': '17163091968', 'VRAM Total Used Memory (B)': '2147483648', 'Card Series': 'AMD Radeon RX 7900 XT' },
      system: { 'Driver version': '6.8' },
    })}`;
    expect(parseRocmSmi(out)).toEqual([
      { index: 0, name: 'AMD Radeon RX 7900 XT', vendor: 'amd', utilPercent: 14, memUsedMB: 2048, memTotalMB: 16368 },
      { index: 1, name: 'Radeon Pro W7800', vendor: 'amd', utilPercent: 5, memUsedMB: 1, memTotalMB: 2 },
    ]);
    expect(() => parseRocmSmi('ERROR: no GPU found')).toThrow();
  });

  it('ioreg IOAccelerator: Apple GPU utilisation and memory; missing stats are N/A', () => {
    const out = [
      '+-o AGXAcceleratorG17X  <class AGXAcceleratorG17X, id 0x100000a1e, registered, matched, active, busy 0 (0 ms), retain 30>',
      '    {',
      '      "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=5539086336,"Device Utilization %"=34,"In use system memory"=1073741824}',
      '      "model" = "Apple M5"',
      '    }',
      '+-o AGXAcceleratorG99  <class AGXAcceleratorG99>',
      '    {',
      '      "model" = "Apple M9"',
      '    }',
    ].join('\n');
    expect(parseIoregAccelerators(out, 24 * 1024 ** 3)).toEqual([
      { index: 0, name: 'Apple M5', vendor: 'apple', utilPercent: 34, memUsedMB: 1024, memTotalMB: 24576 },
      { index: 1, name: 'Apple M9', vendor: 'apple', utilPercent: null, memUsedMB: null, memTotalMB: 24576 },
    ]);
    expect(parseIoregAccelerators('', 1)).toEqual([]);
  });
});

describe('OS update checks (read-only)', () => {
  it('apt-get -s: counts Inst lines; security only from a *-security origin, not the package name', () => {
    const out = [
      'NOTE: This is only a simulation!',
      '      apt-get needs root privileges for real execution.',
      'Reading package lists...',
      'Calculating upgrade...',
      'The following packages will be upgraded:',
      '  libmodsecurity-security libssl3t64 openssl tzdata',
      '4 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.',
      'Inst libssl3t64 [3.0.13-0ubuntu3.4] (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])',
      'Inst libc6 [2.36-9+deb12u7] (2.36-9+deb12u8 Debian-Security:12/stable-security [amd64])',
      'Inst tzdata [2024a-3ubuntu1.1] (2025b-0ubuntu0.24.04 Ubuntu:24.04/noble-updates [all])',
      'Inst libmodsecurity-security [1.0] (1.1 Ubuntu:24.04/noble-updates [amd64])',
      'Inst linux-image-6.8.0-60-generic (6.8.0-60.63 Ubuntu:24.04/noble-updates [amd64])',
      'Conf libssl3t64 (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])',
    ].join('\n');
    expect(parseAptSimulation(out)).toEqual({ pending: 5, security: 2 });
    expect(parseAptSimulation('0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n')).toEqual({ pending: 0, security: 0 });
  });

  it('dnf check-update: counts unindented name.arch rows, wrapped names once, stops at Obsoleting', () => {
    const out = [
      '',
      'kernel.x86_64                     5.14.0-427.22.1.el9_4           baseos',
      'openssl-libs.x86_64               1:3.0.7-27.el9_4.1              baseos',
      'python3-some-really-long-package-name.noarch',
      '                                  1.2.3-4.el9                     appstream',
      'Security: kernel-core-5.14.0-427.20.1.el9_4.x86_64 is an installed security update',
      'Obsoleting Packages',
      'grub2-tools.x86_64                1:2.06-80.el9                   baseos',
      '    grub2-tools.x86_64            1:2.06-77.el9                   @baseos',
    ].join('\n');
    expect(parseDnfCheckUpdate(out)).toBe(3);
    expect(parseDnfCheckUpdate('')).toBe(0);
  });

  it('softwareupdate -l: one per "* Label:" line', () => {
    const out = [
      'Software Update Tool',
      '',
      'Finding available software',
      'Software Update found the following new or updated software:',
      '* Label: macOS Tahoe 26.0.1-25A362',
      '\tTitle: macOS Tahoe 26.0.1, Version: 26.0.1, Size: 1524000KiB, Recommended: YES, Action: restart, ',
      '* Label: Command Line Tools for Xcode-26.0',
      '\tTitle: Command Line Tools for Xcode, Version: 26.0, Size: 900000KiB, Recommended: YES, ',
    ].join('\n');
    expect(parseSoftwareUpdateList(out)).toBe(2);
    expect(parseSoftwareUpdateList('Software Update Tool\n\nFinding available software\n')).toBe(0);
  });

  it('dnf runs cache-only, accepts exit 100 and asks separately for security updates', async () => {
    const calls: { args: readonly string[]; options?: RunOptions }[] = [];
    const run: RunCommand = async (_cmd, args, options) => {
      calls.push({ args, options });
      return args.includes('--security') ? 'openssl-libs.x86_64  1:3.0.7-27.el9_4.1  baseos\n' : 'kernel.x86_64  5.14.0  baseos\nopenssl-libs.x86_64  1:3.0.7  baseos\n';
    };
    expect(await createUpdateChecker('linux-rpm', run).check()).toEqual({ pending: 2, security: 1 });
    expect(calls.map((c) => c.args)).toEqual([
      ['-q', '-C', 'check-update'],
      ['-q', '-C', 'check-update', '--security'],
    ]);
    expect(calls.every((c) => c.options?.okExitCodes?.includes(100))).toBe(true);
  });

  it('macOS reports security as unknown; a failing tool throws (fail-closed)', async () => {
    expect(await createUpdateChecker('macos', replying('* Label: X-1\n')).check()).toEqual({ pending: 1, security: null });
    await expect(createUpdateChecker('linux-deb', failing).check()).rejects.toThrow(/exit 9/);
    await expect(createUpdateChecker('linux-deb', missing).check()).rejects.toBeInstanceOf(CommandMissingError);
  });
});

describe('createRunCommand exit codes', () => {
  const exit100 = ['-e', 'process.stdout.write("rows"); process.exit(100)'];
  it('treats listed exit codes as success and keeps stdout; others still throw', async () => {
    const run = createRunCommand();
    await expect(run(process.execPath, exit100, { okExitCodes: [100] })).resolves.toBe('rows');
    await expect(run(process.execPath, exit100)).rejects.toThrow(/failed/);
  });
});
