import { layout } from '../layout.js';

export function approvalsPage(): string {
  return layout(
    'Approvals',
    '/dashboard/approvals',
    `
    <h2 class="page-title">Pending Approvals</h2>
    <div id="summary" class="cards"><div class="loading">Loading...</div></div>
    <h3 class="section-title">Approval Queue</h3>
    <div id="content"><div class="loading">Loading...</div></div>
    <script>
    (async () => {
      try {
        const approvals = await api('/api/approvals');
        const pending = approvals.filter(a => a.status === 'pending');

        // Summary cards
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

        // Newest first
        const sorted = approvals.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

        let html = '<table><tr><th>Title</th><th>Action</th><th>Detail</th><th>Origin</th><th>Age</th><th>Status</th><th>Actions</th></tr>';
        for (const a of sorted) {
          const statusColor = a.status === 'pending' ? 'yellow' :
            a.status === 'approved' ? 'green' :
            a.status === 'rejected' ? 'red' : 'gray';

          const origin = a.agent_group_name
            ? '<a href="/dashboard/agent-groups?id=' + esc(a.agent_group_id) + '">' + esc(a.agent_group_name) + '</a>'
            : (a.session_id ? '<span style="font-size:11px;color:#888">' + esc(truncId(a.session_id, 18)) + '</span>' : '<span style="color:#555">-</span>');

          let act;
          if (a.status !== 'pending') {
            act = '<span style="color:#555">-</span>';
          } else if (a.actionable) {
            const id = esc(a.approval_id);
            act = '<button style="' + BTN + 'color:#4ade80;border-color:#2a5a2a" ' +
                    'onclick="decide(\\'' + id + '\\',\\'approve\\',this)">Approve</button> ' +
                  '<button style="' + BTN + 'color:#f87171;border-color:#5a2a2a" ' +
                    'onclick="decide(\\'' + id + '\\',\\'reject\\',this)">Reject</button>';
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
      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="loading">Error: ' + esc(e.message) + '</div>';
      }
    })();

    const BTN = 'cursor:pointer;background:#161616;border:1px solid #2a2a2a;border-radius:4px;padding:4px 12px;font-size:12px;font-weight:600;';

    async function decide(id, decision, btn) {
      if (decision === 'approve' && !confirm('Approve this request? It will be applied immediately.')) return;
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
          if (cell) cell.innerHTML = '<span style="color:#f87171;font-size:12px">' + esc(data.error || ('HTTP ' + res.status)) + '</span>';
          return;
        }
        // Resolve in place — the snapshot lags up to a push interval, so don't reload.
        if (cell) cell.innerHTML = '<span style="color:' + (decision === 'approve' ? '#4ade80' : '#f87171') +
          ';font-size:12px">' + (decision === 'approve' ? 'approved' : 'rejected') + '</span>';
        if (tr) tr.style.opacity = '0.45';
      } catch (e) {
        if (cell) cell.innerHTML = '<span style="color:#f87171;font-size:12px">' + esc(e.message) + '</span>';
      }
    }

    function cardHtml(label, value) {
      return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(String(value)) + '</div></div>';
    }
    </script>
  `,
  );
}
