// Owed dashboard. Vanilla JS, no build step (only the Bryntum view is bundled).
// State comes from the JSON API; the live trace and "ledger changed" signals arrive over
// one Server-Sent Events stream.
(function () {
  'use strict';

  var $ = function (s, root) { return (root || document).querySelector(s); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var state = { mode: null, ledger: null, open: {}, filter: 'all', today: null };

  function money(v, cur) {
    try {
      var n = Number(v) || 0;
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD', maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
    } catch (e) {
      return (cur || '') + ' ' + v;
    }
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var p = iso.slice(0, 10).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function toast(text, isError) {
    var el = document.createElement('div');
    el.className = 'toast' + (isError ? ' is-error' : '');
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, isError ? 7000 : 4000);
  }
  async function api(method, url, body) {
    var res = await fetch(url, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    var data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) {
      var err = new Error(data.error || ('Request failed (' + res.status + ')'));
      err.data = data;
      throw err;
    }
    return data;
  }
  async function busy(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); }
    catch (e) { toast(e.message, true); }
    finally { if (btn) btn.disabled = false; }
  }

  // ---------- mode ----------
  function applyMode(mode) {
    state.mode = mode;
    var pp = $('#chip-paypal');
    pp.textContent = mode.paypal === 'sandbox' ? 'PayPal sandbox' : 'PayPal demo';
    pp.className = 'chip ' + (mode.paypal === 'sandbox' ? 'is-live' : 'is-demo');
    var ai = $('#chip-ai');
    ai.textContent = mode.llm === 'live' ? 'AI: ' + mode.model : 'AI: demo model';
    ai.className = 'chip ' + (mode.llm === 'live' ? 'is-live' : 'is-demo');
    var banner = $('#demo-banner');
    banner.hidden = !mode.demo;
    if (mode.demo) {
      var parts = [];
      if (mode.paypal !== 'sandbox') parts.push('no PayPal keys, so invoices go to a faithful in-memory copy of the PayPal Invoicing API (same requests, same responses, nothing is emailed)');
      if (mode.llm !== 'live') parts.push('no LLM configured, so a deterministic demo model reads briefs and writes reminders');
      $('#demo-detail').textContent = 'Running with ' + parts.join('; and ') + '. All clients are fictional.';
    }
  }

  // ---------- ledger ----------
  function statusBadge(inv) {
    return '<span class="badge st-' + esc(inv.display.code) + '">' + esc(inv.display.label) + '</span>';
  }
  function renderKpis(t) {
    var p = t.primary;
    $('#kpi-owed').textContent = money(p.owed, p.currency);
    $('#kpi-owed-sub').textContent = p.openCount ? p.openCount + ' open invoice' + (p.openCount === 1 ? '' : 's') : 'no open invoices';
    $('#kpi-overdue').textContent = money(p.overdue, p.currency);
    $('#kpi-overdue-sub').textContent = p.overdueCount ? p.overdueCount + ' late' : 'nothing late';
    $('#kpi-paid').textContent = money(p.paid, p.currency);
    $('#kpi-paid-sub').textContent = p.paidCount ? p.paidCount + ' paid' : 'no payments yet';
    $('#kpi-rem').textContent = String(t.remindersPlanned);
    $('#kpi-rem-sub').textContent = 'scheduled, ' + t.remindersSent + ' sent';
  }
  function rowActions(inv) {
    var open = ['PAID', 'MARKED_AS_PAID', 'CANCELLED'].indexOf(inv.status) < 0;
    if (!open) return '';
    var html = '';
    if (inv.next && inv.next.reminderId) html += '<button type="button" class="btn btn-sm" data-act="remind" data-id="' + esc(inv.id) + '" title="Send the next reminder now">Remind now</button>';
    html += '<button type="button" class="btn btn-sm" data-act="mark-paid" data-id="' + esc(inv.id) + '" title="Record a bank transfer, cheque or cash payment on PayPal">Mark paid</button>';
    if (state.mode && state.mode.paypal !== 'sandbox') html += '<button type="button" class="btn btn-sm btn-primary" data-act="simulate" data-id="' + esc(inv.id) + '" title="Demo: the client pays on the PayPal payer page">Client pays</button>';
    return html;
  }
  function detailHtml(inv) {
    var items = inv.items.map(function (it) {
      return '<li>' + esc(it.name) + (it.description ? ' <span class="muted">(' + esc(it.description) + ')</span>' : '') + ': ' + (it.unit === 'HOURS' ? esc(it.quantity) + ' h x ' + money(it.unitAmount, inv.currency) : money(it.unitAmount, inv.currency)) + '</li>';
    }).join('');
    var link = inv.payLink ? (state.mode && state.mode.paypal === 'sandbox' ? '<a href="' + esc(inv.payLink) + '" target="_blank" rel="noopener">payer page</a>' : '<span class="mono">' + esc(inv.payLink) + '</span> <span class="muted">(demo link)</span>') : '';
    var rems = inv.reminders.map(function (r) {
      var when = r.status === 'sent' && r.sentAt ? 'sent ' + fmtDate(r.sentAt) : fmtDate(r.scheduledAt);
      return '<details class="reminder"><summary><span class="stage stage-' + esc(r.stage) + '">' + esc(r.stage) + '</span><span>' + esc(when) + '</span><span class="rstatus rstatus-' + esc(r.status) + '">' + esc(r.status) + '</span>' + (r.moved ? '<span class="rstatus">moved</span>' : '') + '</summary>' +
        (r.subject ? '<pre><b>' + esc(r.subject) + '</b>\n\n' + esc(r.body || '') + '</pre>' : '<pre class="muted">' + esc(r.reason || '') + '</pre>') + '</details>';
    }).join('');
    var hist = (inv.history || []).slice(-6).map(function (h) { return '<li><span class="muted">' + esc(fmtDate(h.at)) + '</span> ' + esc(h.text) + '</li>'; }).join('');
    return '<div class="detail-grid">' +
      '<div><h3>Invoice</h3><dl class="kv"><dt>Number</dt><dd class="mono">' + esc(inv.number) + '</dd><dt>PayPal ID</dt><dd class="mono">' + esc(inv.paypalId) + '</dd><dt>Billed to</dt><dd>' + esc(inv.client.contact ? inv.client.contact + ', ' : '') + esc(inv.client.email) + '</dd><dt>Issued</dt><dd>' + esc(fmtDate(inv.issueDate)) + ' &middot; ' + esc(inv.terms.label) + '</dd><dt>Pay link</dt><dd>' + link + '</dd></dl><h3 style="margin-top:10px">Line items</h3><ul>' + items + '</ul></div>' +
      '<div><h3>Follow-up plan</h3><p class="rationale">' + esc(inv.rationale || '') + '</p>' + rems + '</div>' +
      '<div><h3>History</h3><ul>' + hist + '</ul></div></div>';
  }
  function renderLedger(data) {
    state.ledger = data;
    state.today = data.today;
    renderKpis(data.totals);
    $('#ledger-today').textContent = 'Today ' + fmtDate(data.today);
    var has = data.invoices.length > 0;
    $('#ledger-empty').hidden = has;
    $('#ledger-wrap').hidden = !has;
    var rows = data.invoices.map(function (inv) {
      var isOpen = !!state.open[inv.id];
      var next = inv.next.date ? '<span class="next">' + esc(inv.next.label) + '<small>' + esc(fmtDate(inv.next.date)) + '</small></span>' : '<span class="next muted">' + esc(inv.next.label) + '</span>';
      return '<tr class="row-main' + (isOpen ? ' is-open' : '') + '" data-row="' + esc(inv.id) + '" tabindex="0" aria-expanded="' + isOpen + '">' +
        '<td><div class="client-name"><span class="caret" aria-hidden="true"></span>' + esc(inv.client.name) + '</div><div class="client-meta">' + esc(inv.number) + '</div></td>' +
        '<td class="num">' + esc(money(inv.amount, inv.currency)) + '</td>' +
        '<td>' + esc(fmtDate(inv.dueDate)) + '</td>' +
        '<td>' + statusBadge(inv) + '</td>' +
        '<td>' + next + '</td>' +
        '<td><div class="row-actions">' + rowActions(inv) + '</div></td></tr>' +
        (isOpen ? '<tr class="row-detail"><td colspan="6">' + detailHtml(inv) + '</td></tr>' : '');
    }).join('');
    $('#ledger-body').innerHTML = rows;
  }

  // ---------- timeline ----------
  var timelineMounted = false;
  function renderTimeline(data) {
    var host = $('#timeline');
    var note = $('#timeline-note');
    if (!window.OwedTimeline) {
      if (note) note.textContent = 'The timeline bundle did not load. Run "npm run build" and reload.';
      return;
    }
    if (!data.resources.length) {
      if (timelineMounted) window.OwedTimeline.update(data);
      return;
    }
    if (note) note.remove();
    try {
      window.OwedTimeline.mount(host, data, { onReschedule: onReschedule });
      timelineMounted = true;
    } catch (e) {
      console.error(e);
      toast('Timeline error: ' + e.message, true);
    }
  }
  async function onReschedule(reminderId, date) {
    try {
      var inv = await api('PATCH', '/api/reminders/' + encodeURIComponent(reminderId), { date: date });
      var r = inv.reminders.filter(function (x) { return x.id === reminderId; })[0];
      toast('Moved to ' + fmtDate(date) + '. New subject: "' + (r ? r.subject : '') + '"');
    } catch (e) {
      toast(e.message, true);
    }
    refresh();
  }

  // ---------- refresh ----------
  var refreshTimer = null;
  async function refreshNow() {
    try {
      var both = await Promise.all([api('GET', '/api/ledger'), api('GET', '/api/timeline')]);
      renderLedger(both[0]);
      renderTimeline(both[1]);
    } catch (e) {
      toast(e.message, true);
    }
  }
  function refresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshNow, 120);
  }

  // ---------- trace ----------
  var steps = {};
  function traceKind(e) {
    if (e.kind === 'paypal') return 'paypal';
    if (e.kind === 'llm') return 'llm';
    return 'step';
  }
  function traceLine(e) {
    var t = e.ts ? new Date(e.ts).toLocaleTimeString('en-GB', { hour12: false }) : '';
    if (e.kind === 'run' || e.kind === 'demo' || e.kind === 'webhook') return '<span class="t"></span><span class="run">' + esc(e.title) + '</span>';
    if (e.kind === 'info') return '<span class="t">' + esc(t) + '</span><span class="info">' + esc(e.text) + '</span>';
    if (e.kind === 'step') {
      var mark = { start: '&hellip;', ok: '&#10003;', warn: '!', error: '&#10007;' }[e.status] || '';
      return '<span class="t">' + esc(t) + '</span><span><span class="k k-step">STEP</span><b class="s-' + esc(e.status) + '">' + mark + '</b> ' + esc(e.name) + (e.ms != null && e.status !== 'start' ? ' <span class="t">' + e.ms + ' ms</span>' : '') + (e.detail ? '<br><span class="' + (e.status === 'ok' ? '' : 's-' + esc(e.status)) + '">' + esc(e.detail) + '</span>' : '') + '</span>';
    }
    if (e.kind === 'paypal') {
      var ok = e.status >= 200 && e.status < 300;
      return '<span class="t">' + esc(t) + '</span><span><span class="k k-paypal">PayPal</span><b>' + esc(e.tool) + '</b> ' + esc(e.method) + ' ' + esc(e.path) + ' <b class="' + (ok ? 's-ok' : 's-error') + '">' + esc(e.status) + '</b> <span class="t">' + esc(e.ms) + ' ms</span>' + (e.summary ? '<br>' + esc(e.summary) : '') +
        (e.request ? '<details><summary>request body</summary><pre>' + esc(JSON.stringify(e.request, null, 2)) + '</pre></details>' : '') + '</span>';
    }
    if (e.kind === 'llm') {
      return '<span class="t">' + esc(t) + '</span><span><span class="k k-llm">AI</span><b>' + esc(e.task) + '</b> ' + esc(e.model) + ' <b class="' + (e.ok ? 's-ok' : 's-error') + '">' + (e.ok ? 'ok' : 'failed') + '</b> <span class="t">' + esc(e.ms) + ' ms</span>' + (e.error ? '<br><span class="s-error">' + esc(e.error) + '</span>' : '') + '</span>';
    }
    return '<span class="t">' + esc(t) + '</span><span>' + esc(JSON.stringify(e)) + '</span>';
  }
  function addTrace(e) {
    var list = $('#trace');
    var key = e.kind === 'step' ? e.runId + ':' + e.name : null;
    var li = key && steps[key] && e.status !== 'start' ? steps[key] : document.createElement('li');
    li.dataset.kind = traceKind(e);
    li.innerHTML = traceLine(e);
    li.hidden = state.filter !== 'all' && li.dataset.kind !== state.filter;
    if (key) steps[key] = li;
    if (!li.parentNode) {
      var atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
      list.appendChild(li);
      while (list.children.length > 400) list.removeChild(list.firstChild);
      if (atBottom) list.scrollTop = list.scrollHeight;
    }
  }
  function setFilter(f) {
    state.filter = f;
    document.querySelectorAll('.filter').forEach(function (b) {
      var on = b.dataset.filter === f;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('#trace li').forEach(function (li) { li.hidden = f !== 'all' && li.dataset.kind !== f; });
  }

  function connect() {
    var es = new EventSource('/api/stream');
    es.addEventListener('hello', function (ev) {
      var d = JSON.parse(ev.data);
      applyMode(d.mode);
      $('#trace').innerHTML = '';
      steps = {};
      d.recent.forEach(addTrace);
    });
    es.addEventListener('trace', function (ev) { addTrace(JSON.parse(ev.data)); });
    es.addEventListener('ledger', refresh);
    es.addEventListener('clear', function () { $('#trace').innerHTML = ''; steps = {}; });
    es.onerror = function () { /* EventSource reconnects by itself */ };
  }

  // ---------- chat ----------
  function addMsg(cls, html) {
    var log = $('#chat-log');
    var el = document.createElement('div');
    el.className = 'msg ' + cls;
    el.innerHTML = html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  function previewCard(p) {
    var x = p.extraction;
    var items = x.items.map(function (it) {
      return '<tr><td>' + esc(it.name) + (it.unit === 'HOURS' ? ' <span class="muted">(' + esc(it.quantity) + ' h x ' + esc(money(it.unitAmount, x.currency)) + ')</span>' : '') + '</td><td class="num">' + esc(money(it.quantity * it.unitAmount, x.currency)) + '</td></tr>';
    }).join('');
    var plan = p.plan ? '<div class="muted" style="margin-top:6px">Follow-ups (' + esc(p.plan.risk.level) + ' risk):</div><div class="plan">' + p.plan.reminders.filter(function (r) { return r.status === 'planned'; }).map(function (r) { return '<span>' + esc(r.stage) + ' ' + esc(fmtDate(r.scheduledAt)) + '</span>'; }).join('') + '</div>' : '';
    var notes = (p.problems || []).concat(x.warnings || []);
    return '<div class="card"><div><b>' + esc(x.client.name || 'Unknown client') + '</b> &middot; ' + esc(x.client.contact ? x.client.contact + ' ' : '') + '&lt;' + esc(x.client.email || 'no email') + '&gt;</div>' +
      '<table>' + items + '<tr class="total"><td>Total</td><td class="num">' + esc(money(x.total, x.currency)) + '</td></tr></table>' +
      '<div>' + esc(x.terms.label) + (p.dueDate ? ', due ' + esc(fmtDate(p.dueDate)) : '') + (x.terms.assumed ? ' <span class="muted">(assumed)</span>' : '') + '</div>' + plan +
      (notes.length ? '<p class="warn">' + notes.map(esc).join('<br>') + '</p>' : '') +
      (p.missing && p.missing.length ? '' : '<div class="card-actions"><button type="button" class="btn btn-primary btn-sm" data-act="confirm" data-preview="' + esc(p.previewId) + '">Create &amp; send via PayPal</button><button type="button" class="btn btn-sm" data-act="discard">Discard</button></div>') + '</div>';
  }
  function answerCard(rows) {
    if (!rows || !rows.length) return '';
    return '<div class="card"><table>' + rows.slice(0, 8).map(function (r) {
      return '<tr><td>' + esc(r.client) + ' <span class="muted">' + esc(r.status) + '</span></td><td class="num">' + esc(r.paid ? r.amount : r.outstanding) + '</td></tr>';
    }).join('') + '</table></div>';
  }
  async function sendChat(text) {
    addMsg('msg-user', esc(text));
    var thinking = addMsg('msg-thinking', 'Working&hellip; (watch the trace)');
    var btn = $('#chat-send');
    btn.disabled = true;
    try {
      var r = await api('POST', '/api/chat', { message: text, autoSend: $('#auto-send').checked });
      thinking.remove();
      var extra = '';
      if (r.type === 'preview' || r.type === 'needs_input') extra = r.data && r.data.extraction ? previewCard(r.data) : '';
      if (r.type === 'answer') extra = answerCard(r.data && r.data.rows);
      addMsg('msg-agent', esc(r.text) + extra);
    } catch (e) {
      thinking.remove();
      addMsg('msg-error', esc(e.message));
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- wiring ----------
  function bind() {
    $('#btn-demo').addEventListener('click', function (ev) {
      busy(ev.currentTarget, async function () {
        state.open = {};
        var r = await api('POST', '/api/demo/seed');
        toast('Demo loaded: ' + r.created + ' invoices sent, ' + r.tick.remindersSent.length + ' reminder sent, ' + r.tick.paid.length + ' payment detected.');
        addMsg('msg-agent', esc('I billed 4 clients through PayPal. Juniper & Rye paid, so I cancelled its reminders. Brightline Dental is 8 days late with a history of paying late, so the firm reminder went out today. Ask me "who owes me what?"'));
        refresh();
      });
    });
    $('#btn-tick').addEventListener('click', function (ev) {
      busy(ev.currentTarget, async function () {
        var r = await api('POST', '/api/agent/tick');
        if (r.busy) return toast('A check is already running.');
        toast('Checked ' + r.checked + ' open invoice' + (r.checked === 1 ? '' : 's') + ': ' + r.paid.length + ' newly paid, ' + r.remindersSent.length + ' reminder' + (r.remindersSent.length === 1 ? '' : 's') + ' sent.');
      });
    });
    $('#btn-reset').addEventListener('click', function (ev) {
      if (!confirm('Clear the ledger and start over?')) return;
      busy(ev.currentTarget, async function () {
        await api('POST', '/api/demo/reset');
        state.open = {};
        $('#chat-log').innerHTML = '';
        toast('Ledger cleared.');
      });
    });

    $('#ledger-body').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-act]');
      if (b) {
        ev.stopPropagation();
        var id = b.dataset.id;
        var act = b.dataset.act;
        busy(b, async function () {
          if (act === 'remind') {
            var inv = await api('POST', '/api/invoices/' + id + '/remind');
            var sent = inv.reminders.filter(function (r) { return r.status === 'sent'; }).pop();
            toast('Sent the ' + (sent ? sent.stage : '') + ' reminder to ' + inv.client.name + ' via PayPal.');
          } else if (act === 'mark-paid') {
            var inv2 = await api('POST', '/api/invoices/' + id + '/mark-paid', { method: 'BANK_TRANSFER' });
            toast(inv2.client.name + ' marked paid on PayPal; reminders stopped.');
          } else if (act === 'simulate') {
            var inv3 = await api('POST', '/api/invoices/' + id + '/simulate-payment');
            toast(inv3.client.name + ' paid via PayPal. The agent saw it and stopped the reminders.');
          }
        });
        return;
      }
      var row = ev.target.closest('tr[data-row]');
      if (row) {
        state.open[row.dataset.row] = !state.open[row.dataset.row];
        renderLedger(state.ledger);
      }
    });
    $('#ledger-body').addEventListener('keydown', function (ev) {
      var row = ev.target.closest('tr[data-row]');
      if (row && (ev.key === 'Enter' || ev.key === ' ') && ev.target === row) {
        ev.preventDefault();
        state.open[row.dataset.row] = !state.open[row.dataset.row];
        renderLedger(state.ledger);
        var again = document.querySelector('tr[data-row="' + row.dataset.row + '"]');
        if (again) again.focus();
      }
    });

    $('#chat-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var input = $('#chat-input');
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      sendChat(text);
    });
    $('#chat-input').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) $('#chat-form').requestSubmit();
    });
    $('#chat-log').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-act]');
      if (!b) return;
      if (b.dataset.act === 'discard') {
        b.closest('.card').querySelector('.card-actions').innerHTML = '<span class="muted">Discarded.</span>';
        return;
      }
      if (b.dataset.act === 'confirm') {
        busy(b, async function () {
          var inv = await api('POST', '/api/invoices', { previewId: b.dataset.preview });
          b.closest('.card-actions').innerHTML = '<span class="muted">Sent.</span>';
          addMsg('msg-agent', esc('Invoice ' + inv.number + ' for ' + money(inv.amount, inv.currency) + ' is on its way to ' + inv.client.email + ' via PayPal. ' + (inv.rationale || '')));
          state.open[inv.id] = true;
        });
      }
    });
    $('#samples').addEventListener('click', function (ev) {
      var b = ev.target.closest('.sample');
      if (b) sendChat(b.dataset.text);
    });
    document.querySelectorAll('.filter').forEach(function (b) {
      b.addEventListener('click', function () { setFilter(b.dataset.filter); });
    });
    $('#theme-toggle').addEventListener('click', function () {
      var root = document.documentElement;
      var cur = root.getAttribute('data-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      var next = cur === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('owed-theme', next); } catch (e) { /* private mode */ }
      $('#bryntum-theme').href = '/build/bryntum-' + next + '.css';
    });
  }

  async function init() {
    bind();
    try {
      var h = await api('GET', '/api/health');
      applyMode(h.mode);
      $('#samples').innerHTML = h.samples.map(function (s) { return '<button type="button" class="sample" data-text="' + esc(s) + '" title="' + esc(s) + '">' + esc(s) + '</button>'; }).join('');
    } catch (e) {
      toast('Cannot reach the Owed server: ' + e.message, true);
    }
    addMsg('msg-agent', esc('Hi! Paste a job brief or an email thread and I will bill the client through PayPal, plan the follow-ups and chase them for you. Or click Run demo.'));
    connect();
    refreshNow();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
