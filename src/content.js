// Decorates flow lists on make.powerautomate.com and make.powerapps.com with
// run details: a badge per flow row, a popover with the latest runs, and a
// floating panel that lists every flow found on the page.
(function () {
  'use strict';

  const L = globalThis.FlowRunLens;
  const BADGE_CLASS = 'frl-badge';
  const AUTH_RETRY_MS = 15 * 1000;
  const SCAN_DEBOUNCE_MS = 400;
  const NAV_EXCLUDE = 'nav, header, [role="navigation"], [role="banner"], .frl-root';

  let env = null;
  const summaries = new Map(); // flowId -> { state, summary?, error?, at }
  const names = new Map(); // flowId -> display name seen on the page
  let flowsByName = null; // Map(name -> [ids]) for rows without links
  let flowListRequested = false;
  let listPath = null;

  // ---------- messaging ----------

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          resolve(chrome.runtime.lastError ? { error: 'extension' } : res || { error: 'extension' });
        });
      } catch (_) {
        // Extension was reloaded; this content script is orphaned.
        resolve({ error: 'extension' });
      }
    });
  }

  function loadSummary(flowId) {
    const existing = summaries.get(flowId);
    if (existing) {
      const staleAuth = existing.error === 'auth' && Date.now() - existing.at > AUTH_RETRY_MS;
      if (!staleAuth) return;
    }
    summaries.set(flowId, { state: 'loading', at: Date.now() });
    send({ type: 'getRuns', env, flowId }).then((res) => {
      if (res.error) {
        summaries.set(flowId, { state: 'error', error: res.error, status: res.status, at: Date.now() });
      } else {
        summaries.set(flowId, { state: 'ready', summary: res.summary, at: Date.now() });
      }
      renderFlow(flowId);
      renderPanel();
    });
  }

  function requestFlowList() {
    if (flowListRequested) return;
    flowListRequested = true;
    send({ type: 'listFlows', env }).then((res) => {
      if (res.error) {
        // Allow another try later (e.g. after the token shows up).
        setTimeout(() => { flowListRequested = false; }, AUTH_RETRY_MS);
        return;
      }
      flowsByName = new Map();
      for (const f of res.flows) {
        const key = f.displayName.trim();
        if (!key) continue;
        flowsByName.set(key, (flowsByName.get(key) || []).concat(f.id));
      }
      scheduleScan();
    });
  }

  // ---------- page scanning ----------

  function resetForEnvironment(next) {
    env = next;
    summaries.clear();
    names.clear();
    flowsByName = null;
    flowListRequested = false;
  }

  function scan() {
    const url = location.href;
    const nextEnv = L.parseEnvironmentId(url);
    const onList = nextEnv && !L.isFlowDetailUrl(url);
    if (!onList) {
      toggleRoot(false);
      return;
    }
    if (nextEnv !== env) resetForEnvironment(nextEnv);
    // Another list in the same environment (My flows -> Shared with me):
    // keep the run cache, but list only the flows this page shows.
    if (location.pathname !== listPath) {
      listPath = location.pathname;
      names.clear();
    }

    // 1. Rows that link to a flow carry its id in the href (make.powerautomate.com).
    //    A row has several links to the same flow (name, edit); badge the named one.
    for (const a of document.querySelectorAll('a[href*="/flows/"], a[href*="/cloudflows/"]')) {
      if (a.closest(NAV_EXCLUDE) || !a.textContent.trim()) continue;
      const id = L.flowIdFromHref(a.getAttribute('href'));
      if (id) attach(a, id, a.textContent);
    }

    // 2. Grid rows without a link: match the flow's display name.
    const unlinkedRows = [...document.querySelectorAll('[role="row"]')].filter(
      (row) => !row.closest(NAV_EXCLUDE) && !row.querySelector('.' + BADGE_CLASS) && !row.querySelector('[role="columnheader"]')
    );
    if (unlinkedRows.length && looksLikeFlowList(url)) {
      if (!flowsByName) requestFlowList();
      else for (const row of unlinkedRows) matchRowByName(row);
    }
    // The floating button only appears once the page shows flows, so a
    // portal page that merely hosts the list in an iframe stays clean.
    toggleRoot(names.size > 0);
    renderPanel();
  }

  function looksLikeFlowList(url) {
    const u = new URL(url);
    return /flows|solutions/i.test(u.pathname + u.hash);
  }

  function matchRowByName(row) {
    // Fluent grids on make.powerapps.com mark the name column.
    const scope = row.querySelector('[data-automation-key="displayName"]') || row;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const ids = flowsByName.get(node.nodeValue.trim());
      // A duplicate display name cannot be told apart; leave it alone.
      if (ids && ids.length === 1) {
        attach(node.parentElement, ids[0], node.nodeValue);
        return;
      }
    }
  }

  function attach(host, flowId, label) {
    const name = (label || '').trim();
    if (!names.has(flowId) || (name && names.get(flowId) === flowId)) names.set(flowId, name || flowId);
    const row = host.closest('[role="row"], tr') || host.parentElement;
    if (row.querySelector('.' + BADGE_CLASS + '[data-flow-id="' + flowId + '"]')) return;
    const badge = document.createElement('span');
    badge.className = BADGE_CLASS;
    badge.dataset.flowId = flowId;
    badge.setAttribute('role', 'button');
    badge.tabIndex = 0;
    // Before the name: name cells truncate with an ellipsis, which would clip
    // a badge placed after a long name.
    host.insertAdjacentElement('beforebegin', badge);
    loadSummary(flowId);
    paintBadge(badge, flowId);
  }

  // ---------- rendering ----------

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function errorText(entry) {
    if (entry.error === 'auth') return 'Open make.powerautomate.com in this browser to sign the extension in';
    if (entry.status === 403) return 'No access to this flow\'s run history';
    if (entry.status === 404) return 'Flow not found in the Power Automate API';
    return 'Could not load runs' + (entry.status ? ' (HTTP ' + entry.status + ')' : '');
  }

  function dots(summary, cls) {
    const strip = el('span', cls);
    // Oldest left, newest right, like a timeline.
    for (const r of summary.recent.slice().reverse()) {
      const d = el('span', 'frl-dot frl-' + L.statusTone(r.status));
      d.title = r.status + ' · ' + new Date(r.startTime).toLocaleString();
      strip.appendChild(d);
    }
    return strip;
  }

  function paintBadge(badge, flowId) {
    const entry = summaries.get(flowId);
    badge.replaceChildren();
    badge.className = BADGE_CLASS;
    if (!entry || entry.state === 'loading') {
      badge.classList.add('frl-loading');
      badge.appendChild(el('span', 'frl-dot frl-other'));
      badge.title = 'Loading run history…';
      return;
    }
    if (entry.state === 'error') {
      badge.classList.add('frl-muted');
      badge.appendChild(el('span', null, entry.error === 'auth' ? 'runs: sign in' : 'runs: n/a'));
      badge.title = errorText(entry);
      return;
    }
    const s = entry.summary;
    if (!s.total) {
      badge.classList.add('frl-muted');
      badge.appendChild(el('span', null, 'no runs (28 d)'));
      badge.title = 'No runs in the retained run history';
      return;
    }
    badge.classList.add('frl-tone-' + L.statusTone(s.last.status));
    badge.appendChild(dots(s, 'frl-strip'));
    badge.appendChild(el('span', 'frl-when', L.formatRelative(s.last.startTime)));
    if (s.fail) badge.appendChild(el('span', 'frl-failcount', s.fail + ' failed'));
    badge.title = 'Last run ' + s.last.status + ' · ' + s.ok + '/' + s.total + ' succeeded of the last ' + s.total + ' runs. Click for details.';
  }

  function renderFlow(flowId) {
    for (const badge of document.querySelectorAll('.' + BADGE_CLASS + '[data-flow-id="' + flowId + '"]')) paintBadge(badge, flowId);
    if (popover && popover.dataset.flowId === flowId) openPopover(flowId, null);
  }

  // ---------- popover ----------

  let popover = null;

  function closePopover() {
    if (popover) popover.remove();
    popover = null;
  }

  function openPopover(flowId, anchor) {
    const rect = anchor ? anchor.getBoundingClientRect() : popover && popover.getBoundingClientRect();
    closePopover();
    popover = el('div', 'frl-root frl-pop');
    popover.dataset.flowId = flowId;
    popover.setAttribute('role', 'dialog');

    const head = el('div', 'frl-pop-head');
    head.appendChild(el('strong', null, names.get(flowId) || 'Flow'));
    const close = el('button', 'frl-x', '×');
    close.title = 'Close';
    close.addEventListener('click', closePopover);
    head.appendChild(close);
    popover.appendChild(head);
    popover.appendChild(runTable(flowId));

    const link = el('a', 'frl-link', 'Open full run history ↗');
    link.href = L.runHistoryUrl(env, flowId);
    link.target = '_blank';
    link.rel = 'noopener';
    popover.appendChild(link);

    document.body.appendChild(popover);
    if (rect) {
      const top = Math.min(rect.bottom + 6, window.innerHeight - popover.offsetHeight - 8);
      const left = Math.min(rect.left, window.innerWidth - popover.offsetWidth - 8);
      popover.style.top = Math.max(8, top) + 'px';
      popover.style.left = Math.max(8, left) + 'px';
    }
  }

  function runTable(flowId) {
    const entry = summaries.get(flowId);
    if (!entry || entry.state === 'loading') return el('p', 'frl-note', 'Loading…');
    if (entry.state === 'error') return el('p', 'frl-note', errorText(entry));
    const s = entry.summary;
    if (!s.total) return el('p', 'frl-note', 'No runs in the retained run history (28 days).');

    const wrap = el('div');
    wrap.appendChild(el('p', 'frl-note',
      'Last ' + s.total + ' runs: ' + s.ok + ' succeeded, ' + s.fail + ' failed' +
      (s.run ? ', ' + s.run + ' running' : '') + (s.cancel ? ', ' + s.cancel + ' cancelled' : '') + '.'));

    const table = el('table', 'frl-table');
    const hr = el('tr');
    for (const h of ['Status', 'Started', 'Duration', '']) hr.appendChild(el('th', null, h));
    table.appendChild(hr);
    for (const r of s.recent) {
      const tr = el('tr');
      const status = el('td');
      status.appendChild(el('span', 'frl-dot frl-' + L.statusTone(r.status)));
      status.appendChild(document.createTextNode(' ' + r.status));
      tr.appendChild(status);
      const started = el('td', null, L.formatRelative(r.startTime));
      started.title = new Date(r.startTime).toLocaleString();
      tr.appendChild(started);
      tr.appendChild(el('td', null, L.formatDuration(r.durationMs)));
      const open = el('td');
      const a = el('a', 'frl-link', 'open');
      a.href = L.runUrl(env, flowId, r.name);
      a.target = '_blank';
      a.rel = 'noopener';
      open.appendChild(a);
      tr.appendChild(open);
      table.appendChild(tr);
      if (r.errorCode || r.errorMessage) {
        const er = el('tr', 'frl-err');
        const td = el('td', null, [r.errorCode, r.errorMessage].filter(Boolean).join(': '));
        td.colSpan = 4;
        er.appendChild(td);
        table.appendChild(er);
      }
    }
    wrap.appendChild(table);
    return wrap;
  }

  // ---------- floating panel ----------

  let root = null;
  let panelOpen = false;

  function toggleRoot(show) {
    if (show && !root) {
      root = el('div', 'frl-root frl-fab-wrap');
      const fab = el('button', 'frl-fab', 'Flow runs');
      fab.title = 'Run details for the flows on this page';
      fab.addEventListener('click', () => { panelOpen = !panelOpen; renderPanel(); });
      root.appendChild(fab);
      root.appendChild(el('div', 'frl-panel'));
      document.body.appendChild(root);
    }
    if (root) root.hidden = !show;
    if (!show) closePopover();
  }

  function sortKey(flowId) {
    const e = summaries.get(flowId);
    if (!e || e.state !== 'ready' || !e.summary.total) return 3;
    const tone = L.statusTone(e.summary.last.status);
    return tone === 'fail' ? 0 : e.summary.fail ? 1 : 2;
  }

  function renderPanel() {
    if (!root) return;
    const panel = root.querySelector('.frl-panel');
    panel.hidden = !panelOpen;
    const ids = [...names.keys()];
    const failing = ids.filter((id) => sortKey(id) === 0).length;
    root.querySelector('.frl-fab').textContent = 'Flow runs' + (failing ? ' · ' + failing + ' failing' : '');
    root.querySelector('.frl-fab').classList.toggle('frl-fab-alert', failing > 0);
    if (!panelOpen) return;

    panel.replaceChildren();
    const head = el('div', 'frl-pop-head');
    head.appendChild(el('strong', null, ids.length + ' flows on this page'));
    const refresh = el('button', 'frl-btn', 'Refresh');
    refresh.addEventListener('click', () => {
      send({ type: 'clearCache' }).then(() => {
        summaries.clear();
        flowsByName = null;
        flowListRequested = false;
        for (const b of document.querySelectorAll('.' + BADGE_CLASS)) b.remove();
        scan();
      });
    });
    head.appendChild(refresh);
    panel.appendChild(head);

    const needsAuth = [...summaries.values()].some((e) => e.error === 'auth');
    if (needsAuth) panel.appendChild(el('p', 'frl-note frl-warn', errorText({ error: 'auth' })));
    if (!ids.length) panel.appendChild(el('p', 'frl-note', 'No flows found on this page yet. Scroll the list or open a flow list.'));

    const list = el('div', 'frl-list');
    for (const id of ids.sort((a, b) => sortKey(a) - sortKey(b) || names.get(a).localeCompare(names.get(b)))) {
      const row = el('button', 'frl-item');
      row.appendChild(el('span', 'frl-name', names.get(id)));
      const e = summaries.get(id);
      if (e && e.state === 'ready' && e.summary.total) {
        row.appendChild(dots(e.summary, 'frl-strip'));
        row.appendChild(el('span', 'frl-when', L.formatRelative(e.summary.last.startTime)));
      } else {
        row.appendChild(el('span', 'frl-when', !e || e.state === 'loading' ? '…' : e.state === 'error' ? 'n/a' : 'no runs'));
      }
      row.addEventListener('click', (ev) => openPopover(id, ev.currentTarget));
      list.appendChild(row);
    }
    panel.appendChild(list);
  }

  // ---------- events ----------

  function onBadgeActivate(ev) {
    const badge = ev.target.closest && ev.target.closest('.' + BADGE_CLASS);
    if (!badge) return;
    if (ev.type === 'keydown' && ev.key !== 'Enter' && ev.key !== ' ') return;
    // The badge sits inside a row link or a clickable row; keep the click ours.
    ev.preventDefault();
    ev.stopPropagation();
    if (popover && popover.dataset.flowId === badge.dataset.flowId) closePopover();
    else openPopover(badge.dataset.flowId, badge);
  }
  // Capture phase, so the portal's own row handlers never see the click.
  document.addEventListener('click', onBadgeActivate, true);
  document.addEventListener('keydown', onBadgeActivate, true);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closePopover(); });
  document.addEventListener('mousedown', (ev) => {
    if (popover && !popover.contains(ev.target) && !(ev.target.closest && ev.target.closest('.' + BADGE_CLASS + ', .frl-item'))) closePopover();
  }, true);

  let timer = null;
  function scheduleScan() {
    clearTimeout(timer);
    timer = setTimeout(scan, SCAN_DEBOUNCE_MS);
  }

  const OURS = '.frl-root, .' + BADGE_CLASS;
  const isOurs = (n) => n.nodeType === 1 && (n.matches(OURS) || n.closest(OURS));
  new MutationObserver((records) => {
    // Our own DOM writes should not trigger another scan.
    const foreign = records.some((r) => !isOurs(r.target) &&
      ([...r.addedNodes, ...r.removedNodes].some((n) => !isOurs(n)) || (!r.addedNodes.length && !r.removedNodes.length)));
    if (foreign) scheduleScan();
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Keep the "12m ago" labels honest while the page stays open.
  setInterval(() => {
    for (const b of document.querySelectorAll('.' + BADGE_CLASS)) paintBadge(b, b.dataset.flowId);
    renderPanel();
  }, 60 * 1000);

  scheduleScan();
})();
