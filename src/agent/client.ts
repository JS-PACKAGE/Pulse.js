import { HOST_STATUSES, type HostStatus, type RegisterRequest, type RegisterResponse, type ReportRequest } from '../shared/types.ts';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** POSTs to the Pulse server with the Zero Trust `Authorization` header. */
export class PulseClient {
  constructor(
    private readonly base: URL,
    private readonly authorization: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async register(body: RegisterRequest): Promise<RegisterResponse> {
    const res = await this.post('api/agent/register', body);
    if (
      typeof res !== 'object' || res === null ||
      !('hostId' in res) || !Number.isSafeInteger(res.hostId) ||
      !('reportIntervalSec' in res) || typeof res.reportIntervalSec !== 'number' || !(res.reportIntervalSec >= 1)
    ) {
      throw new Error('unexpected register response');
    }
    return { hostId: Number(res.hostId), reportIntervalSec: res.reportIntervalSec };
  }

  async report(body: ReportRequest): Promise<HostStatus> {
    const res = await this.post('api/agent/report', body);
    const status = typeof res === 'object' && res !== null && 'status' in res ? res.status : undefined;
    const known = HOST_STATUSES.find((s) => s === status);
    if (!known) throw new Error('unexpected report response');
    return known;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const url = new URL(path, this.base.href.endsWith('/') ? this.base : `${this.base.href}/`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: this.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Cloudflare Access answers unauthenticated requests with a redirect to its login page;
      // following it would turn a rejection into a misleading 200 HTML response.
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      throw new HttpError(res.status, `HTTP ${res.status}: redirected (Cloudflare Zero Trust rejected the Authorization header?)`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(res.status, `HTTP ${res.status}: rejected by Cloudflare Zero Trust (check the auth code)`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(res.status, `HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
  }
}
