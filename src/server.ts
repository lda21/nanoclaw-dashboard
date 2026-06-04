/**
 * Dashboard HTTP server.
 * Receives JSON snapshots via POST /api/ingest.
 * Serves dashboard UI and API endpoints.
 *
 * Principles embodied here:
 *  - Structured logging: every notable event is a single-line JSON record via
 *    `logEvent`. Secrets and raw approval payloads are NEVER logged.
 *  - Input validation: request bodies are size-capped and shape-checked before
 *    they reach the store or a host callback.
 *  - Authz: every /api/* route except the self-authed ingest/logs endpoints must
 *    present the Bearer secret. The Bearer check is timing-safe.
 *  - Idempotency: the decision route delegates to the host callback and maps
 *    `result.ok` to 200, a non-ok (e.g. already-resolved) to 409 — so replaying
 *    a decision on an already-settled approval is safe and observable.
 */
import http from 'http';
import { timingSafeEqual } from 'crypto';

import type { DashboardConfig, DashboardSnapshot, ApprovalInfo } from './types.js';
import { setSnapshot, setApprovals, addLogClient, removeLogClient, pushLogLines } from './store.js';
import { dispatch } from './router.js';

const DEFAULT_PORT = 3100;
const DEFAULT_HOST = '0.0.0.0';

/** Max request body we will buffer for any JSON endpoint. Guards against an
 *  unbounded-body memory-exhaustion DoS. 4 MiB comfortably fits a full
 *  snapshot while bounding worst-case allocation. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

let server: http.Server | null = null;
let dashboardSecret: string | null = null;
let approvalDecisionCb: DashboardConfig['onApprovalDecision'] = undefined;
let channelSyncCb: DashboardConfig['onChannelSync'] = undefined;

export function getDashboardSecret(): string | null {
  return dashboardSecret;
}

/**
 * Single-line structured log record. Only safe, non-sensitive fields should be
 * passed in `fields` — never the Bearer secret, an Authorization header, or the
 * contents of an approval payload.
 */
function logEvent(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  const record = { ts: new Date().toISOString(), level, scope: 'dashboard', event, ...fields };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Timing-safe Bearer check. Returns true iff `authHeader` is exactly
 * `Bearer <dashboardSecret>`. Never logs or returns the supplied token.
 */
function bearerOk(authHeader: string | undefined): boolean {
  if (!dashboardSecret) return true; // no secret configured -> open (warned at startup)
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const provided = authHeader.slice('Bearer '.length);
  const a = Buffer.from(provided);
  const b = Buffer.from(dashboardSecret);
  // timingSafeEqual requires equal-length buffers; length mismatch is itself a
  // safe-to-reveal non-match, so compare lengths first.
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Reject with 401 when the Bearer secret is configured and the request lacks it. */
function requireBearer(req: http.IncomingMessage, res: http.ServerResponse, route: string): boolean {
  if (!dashboardSecret) return true;
  if (bearerOk(req.headers.authorization)) return true;
  logEvent('warn', 'auth_rejected', { route, method: req.method, remote: remoteAddr(req) });
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

function remoteAddr(req: http.IncomingMessage): string {
  // Best-effort, for audit only. Not used for any trust decision.
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Read a request body with a hard size cap. Resolves with the buffered string,
 * or rejects with a tagged error when the limit is exceeded so callers can
 * respond 413.
 */
async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error('payload too large') as Error & { code?: string };
      err.code = 'BODY_TOO_LARGE';
      req.destroy();
      throw err;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isBodyTooLarge(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'BODY_TOO_LARGE';
}

export function startDashboard(config: DashboardConfig = {}): void {
  const port = config.port || DEFAULT_PORT;
  const host = config.host || DEFAULT_HOST;
  dashboardSecret = config.secret || null;
  approvalDecisionCb = config.onApprovalDecision;
  channelSyncCb = config.onChannelSync;

  if (!dashboardSecret) {
    logEvent('warn', 'starting_without_secret', { detail: 'API endpoints are unauthenticated' });
  }

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth gate for /api/* routes. Endpoints with their own self-auth (ingest,
    // log push, and the SSE log stream which auths via query token) are excluded
    // here and enforce Bearer internally. Everything else — including the
    // approvals push and the approval-decision write-back — must present the
    // Bearer secret. The decision route owns no identity of its own: the host
    // records a synthetic approver, so the Bearer secret IS the authorization.
    const selfAuthed = ['/api/ingest', '/api/logs', '/api/logs/push'];
    if (path.startsWith('/api/') && !selfAuthed.includes(path)) {
      if (!requireBearer(req, res, path)) return;
    }

    // Ingest endpoint — receives JSON snapshots from NanoClaw
    if (path === '/api/ingest' && method === 'POST') {
      await handleIngest(req, res);
      return;
    }

    // Log push — receives log lines from NanoClaw pusher
    if (path === '/api/logs/push' && method === 'POST') {
      await handleLogPush(req, res);
      return;
    }

    // Log SSE stream — browser connects here
    if (path === '/api/logs' && method === 'GET') {
      handleLogStream(req, res);
      return;
    }

    // Fast-path approvals refresh — POST /api/approvals/push { approvals: [...] }.
    // Merges just the approvals slice (decoupled from the 60s full snapshot).
    if (path === '/api/approvals/push' && method === 'POST') {
      await handleApprovalsPush(req, res);
      return;
    }

    // Channel sync — POST /api/admin/channel-sync { channelType }. Delegated to
    // the host-supplied callback (registers newly discovered groups in the DB).
    if (path === '/api/admin/channel-sync' && method === 'POST') {
      await handleChannelSync(req, res);
      return;
    }

    // Approval decision — POST /api/approvals/<id> { decision: 'approve'|'reject' }.
    // Delegated to the host-supplied callback; the host owns policy + identity.
    if (path.startsWith('/api/approvals/') && method === 'POST') {
      await handleApprovalDecision(req, res, decodeURIComponent(path.slice('/api/approvals/'.length)));
      return;
    }

    try {
      await dispatch(method, path, url.searchParams, res);
    } catch (err) {
      logEvent('error', 'dispatch_error', { path, method, error: errMessage(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  });

  server.listen(port, host, () => {
    logEvent('info', 'started', { port, host, secured: !!dashboardSecret });
    console.log(`[dashboard] Started on http://localhost:${port}/dashboard (bound ${host})`);
  });
}

export async function stopDashboard(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    logEvent('info', 'stopped');
  }
}

async function handleIngest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireBearer(req, res, '/api/ingest')) return;

  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    return respondBodyError(res, err, '/api/ingest');
  }

  try {
    const data = JSON.parse(body) as DashboardSnapshot;
    if (typeof data !== 'object' || data === null || typeof data.timestamp !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'snapshot must be an object with a timestamp' }));
      logEvent('warn', 'ingest_invalid_shape', {});
      return;
    }
    setSnapshot(data);
    // Log only structural counts — never the snapshot contents.
    logEvent('info', 'ingest_ok', {
      agentGroups: data.agent_groups?.length ?? 0,
      sessions: data.sessions?.length ?? 0,
      approvals: data.approvals?.length ?? 0,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, timestamp: data.timestamp }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    logEvent('warn', 'ingest_invalid_json', {});
  }
}

async function handleLogPush(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireBearer(req, res, '/api/logs/push')) return;

  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    return respondBodyError(res, err, '/api/logs/push');
  }

  try {
    const parsed = JSON.parse(body) as { lines?: unknown };
    if (!Array.isArray(parsed.lines) || !parsed.lines.every((l) => typeof l === 'string')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'lines must be an array of strings' }));
      return;
    }
    const lines = parsed.lines as string[];
    pushLogLines(lines);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: lines.length }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
  }
}

async function handleApprovalsPush(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Bearer already enforced by the /api/* gate (this route is not self-authed).
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    return respondBodyError(res, err, '/api/approvals/push');
  }

  let parsed: { approvals?: unknown };
  try {
    parsed = JSON.parse(body) as { approvals?: unknown };
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  if (!Array.isArray(parsed.approvals)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'approvals must be an array' }));
    logEvent('warn', 'approvals_push_invalid_shape', {});
    return;
  }

  const approvals = parsed.approvals as ApprovalInfo[];
  // Idempotent by construction: setApprovals replaces the slice wholesale, so a
  // re-push of the same set is a no-op in effect.
  setApprovals(approvals);
  // Log counts only — approval titles/details may contain sensitive context.
  logEvent('info', 'approvals_push_ok', { count: approvals.length });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, count: approvals.length }));
}

async function handleApprovalDecision(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): Promise<void> {
  // Bearer already enforced by the /api/* gate. This route carries no identity
  // of its own — the host records a synthetic approver — so the Bearer secret is
  // the authorization boundary.
  if (!approvalDecisionCb) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Approval actions are not enabled on this dashboard' }));
    logEvent('warn', 'approval_decision_disabled', { approvalId: id });
    return;
  }

  // Validate the id path segment before doing anything else.
  if (!id || id.length > 256) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid approval id' }));
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    return respondBodyError(res, err, '/api/approvals/:id');
  }

  let decision: string;
  try {
    decision = (JSON.parse(body) as { decision?: string }).decision ?? '';
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  if (decision !== 'approve' && decision !== 'reject') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: "decision must be 'approve' or 'reject'" }));
    logEvent('warn', 'approval_decision_invalid_value', { approvalId: id });
    return;
  }

  try {
    const result = await approvalDecisionCb(id, decision);
    // result.ok === true -> 200; false (e.g. already resolved / not found) -> 409.
    // This makes replaying a decision on a settled approval safe and visible.
    const status = result.ok ? 200 : 409;
    logEvent(result.ok ? 'info' : 'warn', 'approval_decision', {
      approvalId: id,
      decision,
      ok: result.ok,
      status,
      // result.error is host-authored and safe to surface; never log the body.
      ...(result.error ? { reason: result.error } : {}),
    });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    logEvent('error', 'approval_decision_error', { approvalId: id, decision, error: errMessage(err) });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: errMessage(err) }));
  }
}

async function handleChannelSync(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // Bearer already enforced by the /api/* gate; the secret IS the authorization.
  if (!channelSyncCb) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Channel sync is not enabled on this dashboard' }));
    logEvent('warn', 'channel_sync_disabled', {});
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    return respondBodyError(res, err, '/api/admin/channel-sync');
  }

  let channelType: string;
  try {
    channelType = (JSON.parse(body) as { channelType?: string }).channelType ?? '';
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
    return;
  }

  if (!channelType || channelType.length > 64 || !/^[a-z0-9_-]+$/i.test(channelType)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'channelType required' }));
    logEvent('warn', 'channel_sync_invalid_value', {});
    return;
  }

  try {
    const result = await channelSyncCb(channelType);
    // ok:false (adapter offline / unsupported) -> 409 so callers can branch.
    const status = result.ok ? 200 : 409;
    logEvent(result.ok ? 'info' : 'warn', 'channel_sync', {
      channelType,
      ok: result.ok,
      status,
      ...(result.registered != null ? { registered: result.registered } : {}),
      ...(result.updated != null ? { updated: result.updated } : {}),
      ...(result.error ? { reason: result.error } : {}),
    });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    logEvent('error', 'channel_sync_error', { channelType, error: errMessage(err) });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: errMessage(err) }));
  }
}

function handleLogStream(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Auth check — read token from query param since SSE can't set headers.
  // Compared timing-safely; the token is never logged.
  if (dashboardSecret) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const qToken = url.searchParams.get('token');
    const headerOk = bearerOk(req.headers.authorization);
    const queryOk =
      !!qToken &&
      Buffer.from(qToken).length === Buffer.from(dashboardSecret).length &&
      timingSafeEqual(Buffer.from(qToken), Buffer.from(dashboardSecret));
    if (!headerOk && !queryOk) {
      logEvent('warn', 'auth_rejected', { route: '/api/logs', method: 'GET', remote: remoteAddr(req) });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('event: ping\ndata: connected\n\n');

  addLogClient(res);
  req.on('close', () => removeLogClient(res));
}

function respondBodyError(res: http.ServerResponse, err: unknown, route: string): void {
  if (isBodyTooLarge(err)) {
    logEvent('warn', 'body_too_large', { route });
    if (!res.headersSent) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
    }
    return;
  }
  logEvent('error', 'body_read_error', { route, error: errMessage(err) });
  if (!res.headersSent) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
