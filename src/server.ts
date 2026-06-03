/**
 * Dashboard HTTP server.
 * Receives JSON snapshots via POST /api/ingest.
 * Serves dashboard UI and API endpoints.
 */
import http from 'http';

import type { DashboardConfig, DashboardSnapshot } from './types.js';
import { setSnapshot, addLogClient, removeLogClient, pushLogLines } from './store.js';
import { dispatch } from './router.js';

const DEFAULT_PORT = 3100;

let server: http.Server | null = null;
let dashboardSecret: string | null = null;
let approvalDecisionCb: DashboardConfig['onApprovalDecision'] = undefined;

export function getDashboardSecret(): string | null {
  return dashboardSecret;
}

export function startDashboard(config: DashboardConfig = {}): void {
  const port = config.port || DEFAULT_PORT;
  const host = config.host || '0.0.0.0';
  dashboardSecret = config.secret || null;
  approvalDecisionCb = config.onApprovalDecision;

  if (!dashboardSecret) {
    console.warn('[dashboard] Starting without secret — endpoints are unauthenticated');
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

    // Auth check for /api/* routes (endpoints with their own auth are excluded)
    const selfAuthed = ['/api/ingest', '/api/logs', '/api/logs/push'];
    if (path.startsWith('/api/') && !selfAuthed.includes(path) && dashboardSecret) {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${dashboardSecret}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
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

    // Approval decision — POST /api/approvals/<id> { decision: 'approve'|'reject' }.
    // Delegated to the host-supplied callback; the host owns policy + identity.
    if (path.startsWith('/api/approvals/') && method === 'POST') {
      await handleApprovalDecision(req, res, decodeURIComponent(path.slice('/api/approvals/'.length)));
      return;
    }

    try {
      await dispatch(method, path, url.searchParams, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  });

  server.listen(port, host, () => {
    console.log(`[dashboard] Started on http://localhost:${port}/dashboard (bound ${host})`);
  });
}

export async function stopDashboard(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
}

async function handleIngest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Auth check for ingest
  if (dashboardSecret) {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${dashboardSecret}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  try {
    const data = JSON.parse(Buffer.concat(chunks).toString()) as DashboardSnapshot;
    setSnapshot(data);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, timestamp: data.timestamp }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
  }
}

async function handleLogPush(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (dashboardSecret) {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${dashboardSecret}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  try {
    const { lines } = JSON.parse(Buffer.concat(chunks).toString()) as { lines: string[] };
    pushLogLines(lines);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: lines.length }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
  }
}

async function handleApprovalDecision(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): Promise<void> {
  if (!approvalDecisionCb) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Approval actions are not enabled on this dashboard' }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  let decision: string;
  try {
    decision = (JSON.parse(Buffer.concat(chunks).toString()) as { decision?: string }).decision ?? '';
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  if (decision !== 'approve' && decision !== 'reject') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: "decision must be 'approve' or 'reject'" }));
    return;
  }

  try {
    const result = await approvalDecisionCb(id, decision);
    res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  }
}

function handleLogStream(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Auth check — read token from query param since SSE can't set headers
  if (dashboardSecret) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token') || req.headers.authorization?.replace('Bearer ', '');
    if (!token || token !== dashboardSecret) {
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
