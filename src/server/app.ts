import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiError, ApiErrorCode, Group, ReportResponse } from '../shared/types.ts';
import { normalizeDisplayName, parseRegister, parseReport } from '../shared/validate.ts';
import { PULSE_VERSION } from '../shared/version.ts';
import type { ServerConfig } from './config.ts';
import type { EventHub } from './events.ts';
import { MAX_DETAIL_MINUTES, type Monitor } from './monitor.ts';
import type { Store } from './store.ts';

export interface AppDeps {
  config: ServerConfig;
  store: Store;
  monitor: Monitor;
  events: EventHub;
  /** Directory holding the built panel (dist/web); skipped when absent. */
  webDir?: string;
  /** Built agent bundle served to install.sh (dist/agent/pulse-agent.mjs). */
  agentBundle?: string;
  log?: (msg: string) => void;
  /** SSE keep-alive period; Cloudflare drops idle connections after ~100 s. */
  sseKeepAliveMs?: number;
}

const ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal_error: 500,
};

function fail(res: Response, error: ApiErrorCode, details?: string[]): void {
  const body: ApiError = details ? { error, details } : { error };
  res.status(ERROR_STATUS[error]).json(body);
}

/** Strict positive integer path parameter; `undefined` when malformed. */
function idParam(req: Request, name: string): number | undefined {
  const raw = req.params[name];
  if (typeof raw !== 'string' || !/^[1-9]\d{0,15}$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function createApp(deps: AppDeps): express.Express {
  const { config, store, monitor, events } = deps;
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    next();
  });

  const api = express.Router();
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Authentication happens entirely in Cloudflare Zero Trust before requests reach us
  // (AGENTS.md rules 2 and 4): the CF-Access-* / Authorization headers are deliberately never read here.
  api.use(express.json({ limit: config.limits.maxPayloadBytes, type: 'application/json' }));

  api.get('/health', (_req, res) => {
    res.json({ ok: true, version: PULSE_VERSION });
  });

  api.post('/agent/register', (req, res) => {
    const parsed = parseRegister(req.body);
    if (!parsed.ok) return fail(res, 'bad_request', parsed.errors);
    const { created, ...body } = monitor.register(parsed.value);
    res.status(created ? 201 : 200).json(body);
  });

  api.post('/agent/report', (req, res) => {
    const parsed = parseReport(req.body, Date.now(), config.retention.days * 86_400_000);
    if (!parsed.ok) return fail(res, 'bad_request', parsed.errors);
    const outcome = monitor.report(parsed.value);
    if (outcome.kind === 'unknown_host') return fail(res, 'not_found');
    if (outcome.kind === 'rate_limited') {
      res.setHeader('Retry-After', String(outcome.retryAfterSec));
      return fail(res, 'rate_limited');
    }
    const body: ReportResponse = { status: outcome.status };
    res.json(body);
  });

  api.get('/hosts', (_req, res) => {
    res.json(monitor.listHosts());
  });

  api.get('/hosts/:id', (req, res) => {
    const id = idParam(req, 'id');
    if (id === undefined) return fail(res, 'bad_request', ['id must be a positive integer']);
    const rawMinutes = req.query.minutes ?? '60';
    const minutes = typeof rawMinutes === 'string' && /^\d{1,5}$/.test(rawMinutes) ? Number(rawMinutes) : NaN;
    if (!(minutes >= 1 && minutes <= MAX_DETAIL_MINUTES)) {
      return fail(res, 'bad_request', [`minutes must be an integer in [1, ${MAX_DETAIL_MINUTES}]`]);
    }
    const detail = monitor.hostDetail(id, minutes);
    if (!detail) return fail(res, 'not_found');
    res.json(detail);
  });

  api.patch('/hosts/:id', (req, res) => {
    const id = idParam(req, 'id');
    if (id === undefined) return fail(res, 'bad_request', ['id must be a positive integer']);
    const raw: unknown = req.body?.alias;
    const alias = raw === null ? null : normalizeDisplayName(raw);
    if (raw !== null && alias === null) {
      return fail(res, 'bad_request', ['alias must be null or 1-64 characters without control characters']);
    }
    if (!monitor.setAlias(id, alias)) return fail(res, 'not_found');
    res.status(204).end();
  });

  api.delete('/hosts/:id', (req, res) => {
    const id = idParam(req, 'id');
    if (id === undefined) return fail(res, 'bad_request', ['id must be a positive integer']);
    if (!monitor.deleteHost(id)) return fail(res, 'not_found');
    res.status(204).end();
  });

  api.get('/groups', (_req, res) => {
    res.json({ groups: store.listGroups() });
  });

  api.post('/groups', (req, res) => {
    const name = normalizeDisplayName(req.body?.name);
    if (name === null) return fail(res, 'bad_request', ['name must be 1-64 characters without control characters']);
    if (store.customGroupNameTaken(name)) return fail(res, 'conflict');
    const id = store.createGroup(name);
    events.publish({ type: 'groups' });
    res.status(201).json(store.getGroup(id));
  });

  /** Resolve a custom group or answer 400/404 for malformed ids, unknown or system groups. */
  const customGroup = (req: Request, res: Response): Group | undefined => {
    const id = idParam(req, 'id');
    if (id === undefined) {
      fail(res, 'bad_request', ['id must be a positive integer']);
      return undefined;
    }
    const group = store.getGroup(id);
    if (!group) {
      fail(res, 'not_found');
      return undefined;
    }
    if (group.kind !== 'custom') {
      fail(res, 'bad_request', ['system groups are derived from the host OS and cannot be edited']);
      return undefined;
    }
    return group;
  };

  api.patch('/groups/:id', (req, res) => {
    const group = customGroup(req, res);
    if (!group) return;
    const name = normalizeDisplayName(req.body?.name);
    if (name === null) return fail(res, 'bad_request', ['name must be 1-64 characters without control characters']);
    if (store.customGroupNameTaken(name, group.id)) return fail(res, 'conflict');
    store.renameGroup(group.id, name);
    events.publish({ type: 'groups' });
    res.json(store.getGroup(group.id));
  });

  api.delete('/groups/:id', (req, res) => {
    const group = customGroup(req, res);
    if (!group) return;
    store.deleteGroup(group.id);
    events.publish({ type: 'groups' });
    res.status(204).end();
  });

  const membership = (assign: boolean) => (req: Request, res: Response) => {
    const group = customGroup(req, res);
    if (!group) return;
    const hostId = idParam(req, 'hostId');
    if (hostId === undefined) return fail(res, 'bad_request', ['hostId must be a positive integer']);
    if (!store.getHost(hostId)) return fail(res, 'not_found');
    if (assign) store.addMember(group.id, hostId);
    else store.removeMember(group.id, hostId);
    events.publish({ type: 'groups' });
    res.status(204).end();
  };
  api.put('/groups/:id/hosts/:hostId', membership(true));
  api.delete('/groups/:id/hosts/:hostId', membership(false));

  api.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Stop intermediaries (and cloudflared) from buffering the stream.
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const unsubscribe = events.subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), deps.sseKeepAliveMs ?? 25_000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  api.use((_req, res) => fail(res, 'not_found'));
  app.use('/api', api);

  if (deps.agentBundle && existsSync(deps.agentBundle)) {
    const bundle = deps.agentBundle;
    app.get('/agent/pulse-agent.mjs', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.type('text/javascript').sendFile(bundle);
    });
  }

  if (deps.webDir && existsSync(join(deps.webDir, 'index.html'))) {
    const webDir = deps.webDir;
    app.use(express.static(webDir, { index: 'index.html', maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(webDir, 'index.html'));
    });
  }

  app.use((_req, res) => fail(res, 'not_found'));

  // Generic error bodies only; internals go to the server log, never to clients (rule 8).
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === 'number' ? err.status : 500;
    if (res.headersSent) {
      res.end();
      return;
    }
    if (status === 413) return fail(res, 'payload_too_large');
    if (status === 400 && err?.type === 'entity.parse.failed') return fail(res, 'bad_request', ['body is not valid JSON']);
    if (status >= 400 && status < 500) return fail(res, 'bad_request');
    log(`[pulse] internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    fail(res, 'internal_error');
  };
  app.use(onError);

  return app;
}
