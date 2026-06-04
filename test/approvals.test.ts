/**
 * T9 — Dashboard package: approvals endpoints + store merge.
 *
 * Exercises the T2 (store: setApprovals / normalize / merge) and T3 (server:
 * /api/approvals, /api/approvals/push, /api/approvals/<id>) implementations.
 *
 * Why dynamic imports + vi.resetModules(): the store is a module-level
 * singleton (one `snapshot` per module instance). Tests that assert behaviour
 * across the "no snapshot yet" -> "snapshot present" transition would
 * contaminate each other through shared state. Re-importing inside each
 * scenario gives every test its own clean store + server module graph, so the
 * assertions are order-independent and deterministic.
 *
 * Principles under test (mirrors the implementation's own contract):
 *  - input validation: malformed approval rows are dropped, not stored;
 *  - per-action authz: /api/approvals/push and decisions require the Bearer
 *    secret when one is configured (401 without);
 *  - idempotency: re-pushing the same rows yields an equivalent slice;
 *  - no secrets in logs: the decision callback receives only (id, decision),
 *    never the bearer secret, and is the sole authority on the result code.
 */
import { createServer } from 'node:http';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ApprovalInfo,
  DashboardConfig,
  DashboardSnapshot,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function approval(over: Partial<ApprovalInfo> = {}): ApprovalInfo {
  return {
    approval_id: 'apr_1',
    action: 'install_packages',
    title: 'Install ripgrep',
    status: 'pending',
    detail: 'apt-get install ripgrep',
    actionable: true,
    session_id: 'sess_1',
    agent_group_id: 'ag_1',
    agent_group_name: 'Keeper',
    created_at: '2026-06-03T00:00:00.000Z',
    expires_at: null,
    ...over,
  };
}

/** A minimal-but-complete snapshot so setSnapshot() establishes a base the
 *  approvals slice can be merged into. Fields not exercised here are filled
 *  with empty defaults. */
function snapshot(over: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    timestamp: '2026-06-03T00:00:00.000Z',
    assistant_name: 'NanoClaw',
    uptime: 123,
    agent_groups: [],
    sessions: [],
    channels: [],
    users: [],
    tokens: {
      totals: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      byModel: {},
      byGroup: {},
    },
    context_windows: [],
    activity: [],
    approvals: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Store: setApprovals (T2)
// ---------------------------------------------------------------------------

describe('store.setApprovals', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is a no-op before any snapshot has arrived', async () => {
    const store = await import('../src/store.js');

    // No snapshot pushed yet.
    expect(store.getSnapshot()).toBeNull();

    store.setApprovals([approval()]);

    // The merge must not synthesize a snapshot out of an approvals push.
    expect(store.getSnapshot()).toBeNull();
    expect(store.getLastUpdated()).toBeNull();
  });

  it('merges only the approvals slice once a snapshot exists', async () => {
    const store = await import('../src/store.js');

    const base = snapshot({ assistant_name: 'Keeper', uptime: 999 });
    store.setSnapshot(base);

    const rows = [approval({ approval_id: 'a' }), approval({ approval_id: 'b' })];
    store.setApprovals(rows);

    const merged = store.getSnapshot();
    expect(merged).not.toBeNull();
    // Approvals slice is replaced...
    expect(merged!.approvals?.map((a) => a.approval_id)).toEqual(['a', 'b']);
    // ...and every other field is carried over untouched.
    expect(merged!.assistant_name).toBe('Keeper');
    expect(merged!.uptime).toBe(999);
  });

  it('copies rows so the caller cannot mutate stored state by reference', async () => {
    const store = await import('../src/store.js');
    store.setSnapshot(snapshot());

    const row = approval({ approval_id: 'x', status: 'pending' });
    store.setApprovals([row]);

    // Mutate the source object the caller still holds.
    row.status = 'tampered';

    expect(store.getSnapshot()!.approvals![0].status).toBe('pending');
  });

  it('drops malformed rows but keeps valid ones (input validation)', async () => {
    const store = await import('../src/store.js');
    store.setSnapshot(snapshot());

    const dirty = [
      approval({ approval_id: 'ok' }),
      null,
      undefined,
      'not-an-object',
      { action: 'x', status: 'pending' }, // missing approval_id
      { approval_id: 1, action: 'x', status: 'pending' }, // wrong type
      { approval_id: 'y', action: 'z', status: 'pending', title: 't', detail: 'd', created_at: 'c' },
    ] as unknown as DashboardSnapshot['approvals'];

    store.setApprovals(dirty);

    expect(store.getSnapshot()!.approvals?.map((a) => a.approval_id)).toEqual(['ok', 'y']);
  });

  it('clears the slice when given a non-array / empty push', async () => {
    const store = await import('../src/store.js');
    store.setSnapshot(snapshot({ approvals: [approval()] }));

    store.setApprovals(undefined as unknown as DashboardSnapshot['approvals']);
    expect(store.getSnapshot()!.approvals).toEqual([]);

    store.setSnapshot(snapshot({ approvals: [approval()] }));
    store.setApprovals([]);
    expect(store.getSnapshot()!.approvals).toEqual([]);
  });

  it('is idempotent: re-pushing the same rows yields an equivalent slice', async () => {
    const store = await import('../src/store.js');
    store.setSnapshot(snapshot());

    const rows = [approval({ approval_id: 'a' }), approval({ approval_id: 'b' })];
    store.setApprovals(rows);
    const first = store.getSnapshot()!.approvals;

    store.setApprovals(rows);
    const second = store.getSnapshot()!.approvals;

    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// Server: HTTP approvals endpoints (T3)
// ---------------------------------------------------------------------------

/** Reserve a free TCP port. startDashboard does `config.port || DEFAULT_PORT`,
 *  so passing 0 would fall back to the fixed default (3100) and collide across
 *  tests. Instead we briefly bind an ephemeral listener, read the OS-assigned
 *  port, release it, and hand that concrete number to startDashboard. There is
 *  a tiny TOCTOU window between release and re-bind, but on loopback in a
 *  single-threaded test it is effectively never hit. */
async function reserveFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const a = probe.address();
      const port = a && typeof a === 'object' ? a.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

/** Wait until the dashboard answers on the given port. startDashboard binds
 *  asynchronously and exposes no server handle, so we poll a cheap route. */
async function waitForReady(base: string): Promise<void> {
  const deadline = Date.now() + 2000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/api/status`);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  throw new Error(`dashboard did not become ready: ${String(lastErr)}`);
}

/** Spins up the dashboard on a freshly-reserved port with a fresh module graph
 *  so store state never leaks between server tests. Returns the base URL, the
 *  freshly-imported store (same instance the server uses), and a teardown. */
async function startServer(config: Partial<DashboardConfig> = {}) {
  vi.resetModules();
  const server = await import('../src/server.js');
  const store = await import('../src/store.js');

  const port = await reserveFreePort();
  server.startDashboard({ port, host: '127.0.0.1', ...config } as DashboardConfig);

  const base = `http://127.0.0.1:${port}`;
  await waitForReady(base);
  return {
    base,
    store,
    server,
    stop: () => server.stopDashboard(),
  };
}

describe('GET /api/approvals', () => {
  it('returns [] when the snapshot carries no approvals', async () => {
    const { base, store, stop } = await startServer();
    try {
      store.setSnapshot(snapshot({ approvals: [] }));

      const res = await fetch(`${base}/api/approvals`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await stop();
    }
  });

  it('returns [] (200) before any snapshot has arrived', async () => {
    // The approvals route always yields an array — even pre-snapshot — so the
    // T4 UI and the fast-path pusher both consume a plain list, never an error
    // envelope.
    const { base, store, stop } = await startServer();
    try {
      expect(store.getSnapshot()).toBeNull();
      const res = await fetch(`${base}/api/approvals`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await stop();
    }
  });

  it('returns the merged slice after a fast-path push', async () => {
    const { base, store, stop } = await startServer();
    try {
      store.setSnapshot(snapshot());

      const pushRes = await fetch(`${base}/api/approvals/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvals: [approval({ approval_id: 'm1' }), approval({ approval_id: 'm2' })] }),
      });
      expect(pushRes.status).toBe(200);
      expect(await pushRes.json()).toEqual({ ok: true, count: 2 });

      const res = await fetch(`${base}/api/approvals`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApprovalInfo[];
      expect(body.map((a) => a.approval_id)).toEqual(['m1', 'm2']);
    } finally {
      await stop();
    }
  });
});

describe('POST /api/approvals/push auth', () => {
  it('rejects with 401 when a secret is configured and no Bearer is sent', async () => {
    const { base, store, stop } = await startServer({ secret: 's3cr3t' });
    try {
      store.setSnapshot(snapshot());

      const res = await fetch(`${base}/api/approvals/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvals: [approval()] }),
      });
      expect(res.status).toBe(401);
      // The slice must not have changed on an unauthorized push.
      expect(store.getSnapshot()!.approvals).toEqual([]);
    } finally {
      await stop();
    }
  });

  it('accepts the push when the correct Bearer is sent', async () => {
    const { base, store, stop } = await startServer({ secret: 's3cr3t' });
    try {
      store.setSnapshot(snapshot());

      const res = await fetch(`${base}/api/approvals/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s3cr3t' },
        body: JSON.stringify({ approvals: [approval({ approval_id: 'auth_ok' })] }),
      });
      expect(res.status).toBe(200);
      expect(store.getSnapshot()!.approvals?.map((a) => a.approval_id)).toEqual(['auth_ok']);
    } finally {
      await stop();
    }
  });
});

describe('POST /api/approvals/<id> decision result-code mapping', () => {
  it('returns 501 when no onApprovalDecision callback is wired', async () => {
    // No secret -> the decision endpoint is reachable unauthenticated, isolating
    // the "feature disabled" path from auth.
    const { base, stop } = await startServer();
    try {
      const res = await fetch(`${base}/api/approvals/apr_1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(res.status).toBe(501);
    } finally {
      await stop();
    }
  });

  it('returns 400 on an invalid decision value', async () => {
    const onApprovalDecision = vi.fn(async () => ({ ok: true }));
    const { base, stop } = await startServer({ onApprovalDecision });
    try {
      const res = await fetch(`${base}/api/approvals/apr_1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'maybe' }),
      });
      expect(res.status).toBe(400);
      // Invalid input must never reach the host callback.
      expect(onApprovalDecision).not.toHaveBeenCalled();
    } finally {
      await stop();
    }
  });

  it('returns 400 on a malformed JSON body', async () => {
    const onApprovalDecision = vi.fn(async () => ({ ok: true }));
    const { base, stop } = await startServer({ onApprovalDecision });
    try {
      const res = await fetch(`${base}/api/approvals/apr_1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ not json',
      });
      expect(res.status).toBe(400);
      expect(onApprovalDecision).not.toHaveBeenCalled();
    } finally {
      await stop();
    }
  });

  it('returns 200 when the callback resolves ok:true', async () => {
    const onApprovalDecision = vi.fn(async () => ({ ok: true }));
    const { base, stop } = await startServer({ onApprovalDecision });
    try {
      const res = await fetch(`${base}/api/approvals/apr_42`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      // The callback is the sole authority on identity + result; it must receive
      // only the decoded id and the validated decision — never the secret.
      expect(onApprovalDecision).toHaveBeenCalledWith('apr_42', 'approve');
    } finally {
      await stop();
    }
  });

  it('returns 409 when the callback resolves ok:false', async () => {
    const onApprovalDecision = vi.fn(async () => ({ ok: false, error: 'already resolved' }));
    const { base, stop } = await startServer({ onApprovalDecision });
    try {
      const res = await fetch(`${base}/api/approvals/apr_1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'reject' }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, error: 'already resolved' });
      expect(onApprovalDecision).toHaveBeenCalledWith('apr_1', 'reject');
    } finally {
      await stop();
    }
  });

  it('returns 500 when the callback throws', async () => {
    const onApprovalDecision = vi.fn(async () => {
      throw new Error('host exploded');
    });
    const { base, stop } = await startServer({ onApprovalDecision });
    try {
      const res = await fetch(`${base}/api/approvals/apr_1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ ok: false, error: 'host exploded' });
    } finally {
      await stop();
    }
  });

  it('url-decodes the approval id before handing it to the callback', async () => {
    const onApprovalDecision = vi.fn(async () => ({ ok: true }));
    const { base, stop } = await startServer({ onApprovalDecision });
    try {
      const res = await fetch(`${base}/api/approvals/apr%2Fwith%2Fslashes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(res.status).toBe(200);
      expect(onApprovalDecision).toHaveBeenCalledWith('apr/with/slashes', 'approve');
    } finally {
      await stop();
    }
  });
});
