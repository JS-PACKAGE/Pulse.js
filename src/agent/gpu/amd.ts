import type { GpuInfo } from '../../shared/types.ts';
import type { RunCommand } from '../exec.ts';
import { numOrNull, runIfInstalled, type GpuCollector } from './gpu.ts';

export const ROCM_SMI_ARGS = ['--showuse', '--showmeminfo', 'vram', '--showproductname', '--json'] as const;

/** Case-insensitive field lookup: key spelling ("Card Series" vs "Card series") varies by ROCm release. */
function field(card: Record<string, unknown>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(card)) {
    if (k.toLowerCase() === want && (typeof v === 'string' || typeof v === 'number')) return String(v);
  }
  return undefined;
}

/**
 * `rocm-smi … --json` → `{ "card0": { "GPU use (%)": "14", "VRAM Total Memory (B)": "…",
 * "VRAM Total Used Memory (B)": "…", "Card Series": "…" }, … }`. Non-card keys (e.g. "system")
 * are ignored; warnings printed before the JSON document are skipped.
 */
export function parseRocmSmi(text: string): GpuInfo[] {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('rocm-smi produced no JSON');
  let doc: unknown;
  try {
    doc = JSON.parse(text.slice(start));
  } catch {
    throw new Error('rocm-smi produced malformed JSON');
  }
  if (typeof doc !== 'object' || doc === null) throw new Error('rocm-smi JSON is not an object');

  const gpus: GpuInfo[] = [];
  for (const [key, value] of Object.entries(doc)) {
    const m = /^card(\d+)$/.exec(key);
    if (!m || typeof value !== 'object' || value === null) continue;
    const card = value as Record<string, unknown>; // object checked above; fields read via `field()`
    const bytes = (name: string): number | null => {
      const v = numOrNull(field(card, name));
      return v === null ? null : v / 1024 ** 2;
    };
    const index = Number(m[1]);
    gpus.push({
      index,
      name: field(card, 'Card Series') ?? field(card, 'Card Model') ?? `AMD GPU ${index}`,
      vendor: 'amd',
      utilPercent: numOrNull(field(card, 'GPU use (%)')),
      memUsedMB: bytes('VRAM Total Used Memory (B)'),
      memTotalMB: bytes('VRAM Total Memory (B)'),
    });
  }
  return gpus.sort((a, b) => a.index - b.index);
}

export class AmdRocmSmiGpuCollector implements GpuCollector {
  constructor(private readonly run: RunCommand) {}

  async list(): Promise<GpuInfo[]> {
    const out = await runIfInstalled(this.run, 'rocm-smi', ROCM_SMI_ARGS);
    return out === null ? [] : parseRocmSmi(out);
  }
}
