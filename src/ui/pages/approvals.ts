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

        let html = '<table><tr><th>Title</th><th>Action</th><th>Detail</th><th>Origin</th><th>Age</th><th>Status</th><th>Expires</th></tr>';
        for (const a of sorted) {
          const statusColor = a.status === 'pending' ? 'yellow' :
            a.status === 'approved' ? 'green' :
            a.status === 'rejected' ? 'red' : 'gray';

          const origin = a.agent_group_name
            ? '<a href="/dashboard/agent-groups?id=' + esc(a.agent_group_id) + '">' + esc(a.agent_group_name) + '</a>'
            : (a.session_id ? '<span style="font-size:11px;color:#888">' + esc(truncId(a.session_id, 18)) + '</span>' : '<span style="color:#555">-</span>');

          html += '<tr>' +
            '<td><span style="font-weight:500">' + esc(a.title || a.action) + '</span></td>' +
            '<td>' + badge(a.action, 'blue') + '</td>' +
            '<td><span style="font-size:12px;color:#bbb">' + esc(truncId(a.detail || '', 80)) + '</span></td>' +
            '<td>' + origin + '</td>' +
            '<td>' + esc(timeAgo(a.created_at)) + '</td>' +
            '<td>' + badge(a.status, statusColor) + '</td>' +
            '<td>' + (a.expires_at ? esc(timeAgo(a.expires_at)) : '<span style="color:#555">-</span>') + '</td>' +
            '</tr>';
        }
        html += '</table>';
        html += '<div style="margin-top:12px;font-size:12px;color:#666">Read-only view. Resolve with <code>ncl approvals</code> or the approval card in chat.</div>';
        document.getElementById('content').innerHTML = html;
      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="loading">Error: ' + esc(e.message) + '</div>';
      }
    })();

    function cardHtml(label, value) {
      return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(String(value)) + '</div></div>';
    }
    </script>
  `,
  );
}
