import type { ApiErrorCode } from '../../src/shared/types.ts';
import type { MessageKey } from './i18n';

export class RequestError extends Error {
  constructor(public readonly code: ApiErrorCode | 'networkError') {
    super(code);
  }
}
const errorCodes: Record<string, true | undefined> = {
  bad_request: true,
  not_found: true,
  conflict: true,
  payload_too_large: true,
  rate_limited: true,
  internal_error: true,
};
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new RequestError('networkError');
  }
  if (!response.ok) {
    let code: ApiErrorCode | 'networkError' =
      response.status === 400
        ? 'bad_request'
        : response.status === 404
          ? 'not_found'
          : response.status === 409
            ? 'conflict'
            : 'networkError';
    try {
      const body: unknown = await response.json();
      if (
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        typeof body.error === 'string' &&
        Object.hasOwn(errorCodes, body.error)
      )
        code = body.error as ApiErrorCode;
    } catch {
      /* Access gateways may return HTML instead of API JSON. */
    }
    throw new RequestError(code);
  }
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new RequestError('internal_error');
  }
}
export function errorKey(error: unknown): MessageKey {
  return error instanceof RequestError ? error.code : 'networkError';
}
export function percent(used: number | null | undefined, total: number | null | undefined): number | null {
  return used == null || total == null || total <= 0 ? null : (used / total) * 100;
}
export function number(value: number | null | undefined, unit = ''): string {
  return value == null ? 'N/A' : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit}`;
}
export function rate(value: number | null | undefined): string {
  if (value == null) return 'N/A';
  return value >= 1_000_000
    ? number(value / 1_000_000, ' Gbps')
    : value >= 1_000
      ? number(value / 1_000, ' Mbps')
      : number(value, ' kbps');
}
export function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
export const osNames = { 'linux-deb': 'Linux-Deb', 'linux-rpm': 'Linux-RPM', macos: 'macOS' } as const;
