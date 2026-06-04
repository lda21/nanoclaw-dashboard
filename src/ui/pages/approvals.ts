import { layout } from '../layout.js';

/**
 * Approvals page (T4).
 *
 * Renders the host-side approval queue: summary cards (pending count, distinct
 * action types, oldest pending age) and a table
 * (Title / Action / Detail / Origin / Age / Status / Actions).
 *
 * Action buttons (Approve / Reject) render ONLY for rows that are both
 * `status === 'pending'` AND `actionable` (host-set policy hint from T1's
 * ApprovalInfo). Everything else — resolved rows, or pending rows the host
 * marked view-only (e.g. OneCLI credential approvals) — shows a "chat only"
 * badge and is not actionable from the dashboard.
 *
 * decide() POSTs to T3's `POST /api/approvals/<id>` with the Bearer token,
 * confirms before an approve, shows inline working/approved/rejected feedback,
 * and sets a busy guard so the 5s auto-refresh (GET /api/approvals) cannot
 * re-render mid-decision and clobber the in-flight row.
 *
 * Principles embodied in the client:
 *  - Input validation: only the two known decisions are ever sent; ids are
 *    carried in data-attributes (not interpolated into inline JS), so an id
 *    containing quotes/backslashes can never break out into executable markup.
 *  - Per-action authz: buttons exist only when the host says the row is
 *    actionable; the server still owns final policy/identity via the callback.
 *  - Idempotency: a single in-flight decision is allowed at a time, and a row
 *    already being decided cannot be re-submitted (double-click guard). Repeat
 *    POSTs for an already-resolved id are surfaced as the server's error.
 *  - No secrets in logs: the only thing rendered/echoed is the server's own
 *    error string or HTTP status; the Bearer token is read from the page meta
 *    and never written into the DOM or any message.
 */
export function approvalsPage(): string {
  return layout(
    'Approvals',
    '/dashboard/approvals',
    `
    <h2 class="page-title">Pending Approvals <span id="refresh-dot" style="font-size:11px;color:#555;font-weight:400">· auto-refresh 5s</span></h2>
    <div id="summary" class="cards"><div class="loading">Loading...</div></div>
    <h3 class="section-title">Approval Queue</h3>
    <div id="content"><div class="loading">Loading...</div></div>
    <script>
    const BTN = 'cursor:pointer;background:#161616;border:1px solid #2a2a2a;border-radius:4px;padding:4px 12px;font-size:12px;font-weight:600;';
    // busy: a decision is in flight (or just resolved) — suppress re-render so the
    // auto-refresh poll can't clobber the row mid-decision. inFlight: ids currently
    // being decided — a per-row guard so a double-click can't double-submit.
    let busy = false;
    const inFlight = new Set();

    async function load() {
      if (busy) return; // don't re-render while a decision is in flight
      let approvals;
      try {
        approvals = await api('/api/approvals');
      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="loading">Error: ' + esc(e.message) + '</div>';
        return;
      }
      if (busy) return; // re-check: a decision may have started during the await
      if (!Array.isArray(approvals)) approvals = [];
      render(approvals);
    }

    function render(approvals) {
      const pending = approvals.filter(a => a && a.status === 'pending');
      const actions = {};
      for (const a of pending) actions[a.action] = (actions[a.action] || 0) + 1;
      const oldest = pending.reduce((m, a) => (!m || a.created_at < m.created_at) ? a : m, null);
      document.getElementById('summary').innerHTML = [
        cardHtml('Pending', pending.length),
        cardHtml('Action Types', Object.keys(actions).length),
        cardHtml('Oldest', oldest ? timeAgo(oldest.created_at) : '-'),
      ].join('');

      if (approvals.length === 0) {
        document.getElementById('content').innerHTML = '<div class="loading">No approvals in the queue</div>';
        return;
      }

      const sorted = approvals.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      let html = '<table><tr><th>Title</th><th>Action</th><th>Detail</th><th>Origin</th><th>Age</th><th>Status</th><th>Actions</th></tr>';
      for (const a of sorted) {
        const statusColor = a.status === 'pending' ? 'yellow' :
          a.status === 'approved' ? 'green' : a.status === 'rejected' ? 'red' : 'gray';
        const origin = a.agent_group_name
          ? '<a href="/dashboard/agent-groups?id=' + esc(a.agent_group_id) + '">' + esc(a.agent_group_name) + '</a>'
          : (a.session_id ? '<span style="font-size:11px;color:#888">' + esc(truncId(a.session_id, 18)) + '</span>' : '<span style="color:#555">-</span>');

        // Actions cell: buttons ONLY for pending + actionable rows. Resolved rows
        // show a dash; pending-but-view-only rows (e.g. OneCLI) show "chat only".
        let act;
        if (a.status !== 'pending') {
          act = '<span style="color:#555">-</span>';
        } else if (a.actionable) {
          // id is carried in a data-attribute (esc'd as an HTML attr value) and
          // read back in the delegated click handler — never interpolated into
          // executable JS, so quotes/backslashes in an id are inert.
          const idAttr = 'data-id="' + esc(a.approval_id) + '"';
          act = '<button type="button" data-decide="approve" ' + idAttr + ' style="' + BTN + 'color:#4ade80;border-color:#2a5a2a">Approve</button> ' +
                '<button type="button" data-decide="reject" ' + idAttr + ' style="' + BTN + 'color:#f87171;border-color:#5a2a2a">Reject</button>';
        } else {
          act = '<span class="badge badge-gray" title="Resolve from chat">chat only</span>';
        }

        html += '<tr>' +
          '<td><span style="font-weight:500">' + esc(a.title || a.action) + '</span></td>' +
          '<td>' + badge(a.action, 'blue') + '</td>' +
          '<td><span style="font-size:12px;color:#bbb">' + esc(truncId(a.detail || '', 70)) + '</span></td>' +
          '<td>' + origin + '</td>' +
          '<td>' + esc(timeAgo(a.created_at)) + '</td>' +
          '<td>' + badge(a.status, statusColor) + '</td>' +
          '<td style="white-space:nowrap">' + act + '</td>' +
          '</tr>';
      }
      html += '</table>';
      html += '<div style="margin-top:12px;font-size:12px;color:#666">OneCLI credential approvals are <strong>chat only</strong> by policy. Approving applies the request immediately.</div>';
      document.getElementById('content').innerHTML = html;
    }

    async function decide(id, decision, btn) {
      // Input validation: only the two known decisions are ever sent.
      if (decision !== 'approve' && decision !== 'reject') return;
      // Idempotency / double-submit guard: refuse a second decision for the same
      // row while one is already in flight.
      if (!id || inFlight.has(id)) return;
      if (decision === 'approve' && !confirm('Approve this request? It will be applied immediately.')) return;

      busy = true;
      inFlight.add(id);
      const cell = btn.closest('td');
      const tr = btn.closest('tr');
      if (cell) cell.innerHTML = '<span style="color:#888;font-size:12px">working...</span>';
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
        const res = await fetch('/api/approvals/' + encodeURIComponent(id), {
          method: 'POST', headers, body: JSON.stringify({ decision }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) {
          // Surface only the server's own error string / HTTP status — no token,
          // no request body echoed back.
          if (cell) cell.innerHTML = '<span style="color:#f87171;font-size:12px">' + esc(data.error || ('HTTP ' + res.status)) + '</span>';
          return;
        }
        if (cell) cell.innerHTML = '<span style="color:' + (decision === 'approve' ? '#4ade80' : '#f87171') +
          ';font-size:12px">' + (decision === 'approve' ? 'approved' : 'rejected') + '</span>';
        if (tr) tr.style.opacity = '0.45';
      } catch (e) {
        if (cell) cell.innerHTML = '<span style="color:#f87171;font-size:12px">' + esc(e.message) + '</span>';
      } finally {
        inFlight.delete(id);
        // Hold the re-render briefly so the resolved row stays visible, then
        // let the next poll reconcile against the (5s-fresh) snapshot.
        setTimeout(() => { busy = false; }, 1500);
      }
    }

    function cardHtml(label, value) {
      return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(String(value)) + '</div></div>';
    }

    // Event delegation: one listener on the content container reads the row id
    // from the button's data-attributes, so ids never touch inline-JS string
    // interpolation. Survives re-renders since it's bound once to the container.
    document.getElementById('content').addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-decide]') : null;
      if (!btn) return;
      decide(btn.getAttribute('data-id'), btn.getAttribute('data-decide'), btn);
    });

    load();
    setInterval(load, 5000);
    </script>
  `,
  );
}
