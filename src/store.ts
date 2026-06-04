/**
 * In-memory data store.
 * Holds the latest snapshot pushed by NanoClaw.
 * Can be swapped for Vercel KV later.
 */
import type { DashboardSnapshot, ApprovalInfo } from './types.js';

let snapshot: DashboardSnapshot | null = null;
let lastUpdated: string | null = null;

/** Structured, single-line JSON log. No secrets: approval payloads carry
 *  only ids/titles/status, never credentials, so it is safe to log counts. */
function log(event: string, fields: Record<string, unknown> = {}): void {
  try {
    console.log(
      JSON.stringify({ ts: new Date().toISOString(), comp: 'dashboard.store', event, ...fields }),
    );
  } catch {
    /* logging must never throw into the request path */
  }
}

export function setSnapshot(data: DashboardSnapshot): void {
  snapshot = data;
  lastUpdated = new Date().toISOString();
}

export function getSnapshot(): DashboardSnapshot | null {
  return snapshot;
}

export function getLastUpdated(): string | null {
  return lastUpdated;
}

/**
 * Validate and normalize the approvals slice coming off the wire.
 *
 * Input is untrusted (HTTP body). We accept only an array of objects that
 * carry the load-bearing identity fields, drop anything malformed, and copy
 * each row so the caller can never mutate stored state by holding the source
 * reference. Returns a fresh array; `undefined`/non-array yields `[]` so an
 * explicit empty push reliably clears the slice.
 */
function normalizeApprovals(approvals: DashboardSnapshot['approvals']): ApprovalInfo[] {
  if (!Array.isArray(approvals)) return [];
  const out: ApprovalInfo[] = [];
  for (const a of approvals) {
    if (
      a &&
      typeof a === 'object' &&
      typeof (a as ApprovalInfo).approval_id === 'string' &&
      typeof (a as ApprovalInfo).action === 'string' &&
      typeof (a as ApprovalInfo).status === 'string'
    ) {
      out.push({ ...(a as ApprovalInfo) });
    }
  }
  return out;
}

/** Merge just the approvals slice into the current snapshot (cheap fast-path
 *  push, decoupled from the full 60s snapshot). No-op until a full snapshot
 *  has arrived.
 *
 *  Replaces the snapshot with a shallow copy that swaps only `approvals` — all
 *  other fields are carried over by reference, so they are provably never
 *  clobbered, and prior readers holding the old snapshot reference see an
 *  immutable view. Idempotent: pushing the same set of rows yields an
 *  equivalent `snapshot.approvals` every time and only bumps `lastUpdated`. */
export function setApprovals(approvals: DashboardSnapshot['approvals']): void {
  if (!snapshot) {
    log('approvals_merge_skipped', { reason: 'no_snapshot' });
    return;
  }
  const next = normalizeApprovals(approvals);
  const dropped = (Array.isArray(approvals) ? approvals.length : 0) - next.length;
  snapshot = { ...snapshot, approvals: next };
  lastUpdated = new Date().toISOString();
  log('approvals_merged', { count: next.length, dropped });
}

// --- Log streaming ---
import type http from 'http';

const logClients = new Set<http.ServerResponse>();
const LOG_BUFFER_MAX = 500;
const logBuffer: string[] = [];

export function getLogBuffer(): string[] {
  return logBuffer;
}

export function addLogClient(res: http.ServerResponse): void {
  // Send buffered history first
  for (const line of logBuffer) {
    try { res.write(`data: ${JSON.stringify({ line })}\n\n`); } catch { /* skip */ }
  }
  logClients.add(res);
}

export function removeLogClient(res: http.ServerResponse): void {
  logClients.delete(res);
}

export function pushLogLines(lines: string[]): void {
  // Buffer lines for new clients
  logBuffer.push(...lines);
  while (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();

  // Stream to connected clients
  for (const res of logClients) {
    for (const line of lines) {
      try {
        res.write(`data: ${JSON.stringify({ line })}\n\n`);
      } catch {
        logClients.delete(res);
      }
    }
  }
}
