(function () {
  'use strict';

  const KINDS = [
    { id: 'bug', label: 'Bug', icon: '<rect x="7" y="7" width="10" height="13" rx="5"/><path d="M9 7a3 3 0 0 1 6 0M12 11v9M4 10l3 1.5M20 10l-3 1.5M3 15h4M17 15h4M5 20l2.5-2M19 20l-2.5-2"/>' },
    { id: 'improvement', label: 'Improvement', icon: '<path d="M12 19V5M6 11l6-6 6 6"/>' },
    { id: 'test', label: 'Test', icon: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>' },
    { id: 'feature', label: 'New sub-feature', icon: '<path d="M12 5v14M5 12h14"/>' },
    { id: 'manual', label: 'Manual test', icon: '<rect x="6" y="4.5" width="12" height="16" rx="2"/><path d="M9.5 4.5h5v3h-5zM9 12h6M9 16h4"/>' },
  ];
  const STATUSES = [
    { id: 'backlog', label: 'Backlog', cls: '' },
    { id: 'scheduled', label: 'Scheduled', cls: 'scheduled' },
    { id: 'progress', label: 'In progress', cls: 'progress' },
    { id: 'review', label: 'In review', cls: 'review' },
    { id: 'blocked', label: 'Blocked', cls: 'blocked' },
    { id: 'done', label: 'Done', cls: 'done' },
  ];
  const PRIOS = [
    { id: 'P0', label: 'P0 · data loss or security' },
    { id: 'P1', label: 'P1 · breaks a feature' },
    { id: 'P2', label: 'P2 · normal' },
    { id: 'P3', label: 'P3 · when there is time' },
  ];
  const RESULTS = [
    { id: '', label: 'Not run', cls: '' },
    { id: 'pass', label: 'Pass', cls: 'done' },
    { id: 'partial', label: 'Partial', cls: 'progress' },
    { id: 'fail', label: 'Fail', cls: 'blocked' },
  ];
  // The copy kept in the repo (docs/feature-map.html) has no shared board.
  const STATIC = Boolean(window.FOX_MAP_STATIC);
  const TABS = STATIC ? ['features', 'workflows', 'schema', 'engines', 'coverage'] : ['plan', 'features', 'workflows', 'schema', 'engines', 'coverage'];
  const FEATURE_BY_ID = Object.fromEntries(FEATURES.map((f) => [f.id, f]));
  const KIND_BY_ID = Object.fromEntries(KINDS.map((k) => [k.id, k]));
  const STATUS_BY_ID = Object.fromEntries(STATUSES.map((s) => [s.id, s]));

  const S = { tab: 'plan', view: 'board', q: '', feature: '', kind: '', owner: '', status: '', area: '' };
  let db = null;
  let user = null;
  let meId = null;
  let readOnly = false;
  let dbState = 'loading';
  let items = [];
  let profiles = {};

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** Build an element. Strings become text nodes, so stored text never becomes markup. */
  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'class') node.className = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }
  function svgIcon(markup) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = markup; // constant icon markup from this file
    return s;
  }
  function kindChip(id) {
    const k = KIND_BY_ID[id] || KINDS[1];
    return h('span', { class: 'kind' }, svgIcon(k.icon), k.label);
  }
  function stateChip(statusId) {
    const s = STATUS_BY_ID[statusId] || STATUSES[0];
    return h('span', { class: 'state ' + s.cls }, h('i'), s.label);
  }
  function resultChip(resultId) {
    const r = RESULTS.find((x) => x.id === (resultId || '')) || RESULTS[0];
    return h('span', { class: 'state ' + r.cls }, h('i'), r.label);
  }
  function prioPill(p) {
    return h('span', { class: 'prio ' + (p || 'P2'), title: (PRIOS.find((x) => x.id === p) || PRIOS[2]).label }, p || 'P2');
  }

  const store = {
    get(k) { try { return localStorage.getItem('foxmap:' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('foxmap:' + k, v); } catch { /* private window */ } },
  };

  function toast(text) {
    const root = $('#toast-root');
    root.textContent = '';
    const t = h('div', { class: 'toast', role: 'status' }, text);
    root.append(t);
    setTimeout(() => { if (t.parentNode) t.remove(); }, 3200);
  }

  // ---- dates ---------------------------------------------------------------
  function parseDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function today() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function fmtDay(s) {
    const d = parseDay(s);
    if (!d) return '';
    const opts = d.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
    return new Intl.DateTimeFormat(undefined, opts).format(d);
  }
  function isOpen(it) { return it.status !== 'done'; }
  function isOverdue(it) { const d = parseDay(it.target); return Boolean(d && isOpen(it) && d < today()); }

  // ---- tabs ----------------------------------------------------------------
  function showTab(tab, push) {
    if (!TABS.includes(tab)) tab = TABS[0];
    S.tab = tab;
    for (const b of $$('nav.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const p of $$('.panel')) p.classList.toggle('active', p.id === 'panel-' + tab);
    store.set('tab', tab);
    if (push && location.hash !== '#' + tab) {
      try { history.replaceState(null, '', '#' + tab); } catch { /* sandbox */ }
    }
  }

  // ---- plan: filters -------------------------------------------------------
  function fillSelects() {
    const fsel = $('#f-feature');
    fsel.textContent = '';
    fsel.append(h('option', { value: '' }, 'All features'));
    for (const a of AREAS) {
      const g = h('optgroup', { label: a.name });
      for (const f of FEATURES.filter((x) => x.area === a.id)) g.append(h('option', { value: f.id }, f.id + ' — ' + f.name));
      fsel.append(g);
    }
    const ksel = $('#f-kind');
    ksel.textContent = '';
    ksel.append(h('option', { value: '' }, 'All kinds'));
    for (const k of KINDS) ksel.append(h('option', { value: k.id }, k.label));
  }

  function matches(it, ignoreStatus) {
    if (S.feature && it.feature !== S.feature) return false;
    if (S.kind && it.kind !== S.kind) return false;
    if (S.owner === 'me' && (!meId || it.owner !== meId)) return false;
    if (S.owner === 'none' && it.owner) return false;
    if (!ignoreStatus && S.status && it.status !== S.status) return false;
    if (S.q) {
      const hay = [it.title, it.detail, it.links, it.feature, it.sub, it.sprint].join(' ').toLowerCase();
      if (!hay.includes(S.q.toLowerCase())) return false;
    }
    return true;
  }
  const PRIO_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
  function byPriority(a, b) {
    const p = (PRIO_RANK[a.priority] ?? 2) - (PRIO_RANK[b.priority] ?? 2);
    if (p) return p;
    const da = a.target || '9999', dbb = b.target || '9999';
    if (da !== dbb) return da < dbb ? -1 : 1;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  }

  // ---- plan: rendering -----------------------------------------------------
  function renderSummary() {
    const root = $('#summary');
    root.textContent = '';
    const visible = items.filter((it) => matches(it, true));
    const open = visible.filter(isOpen).length;
    root.append(
      h('button', { type: 'button', 'aria-pressed': String(!S.status), onclick: () => { S.status = ''; renderPlan(); } }, h('b', {}, String(open)), 'open of ' + visible.length)
    );
    for (const s of STATUSES) {
      const n = visible.filter((it) => it.status === s.id).length;
      root.append(
        h('button', { type: 'button', 'aria-pressed': String(S.status === s.id), onclick: () => { S.status = S.status === s.id ? '' : s.id; renderPlan(); } }, stateChip(s.id), h('b', {}, String(n)))
      );
    }
  }

  function ownerNode(id) {
    const n = h('span', { class: 'owner', 'data-owner': id || '' });
    paintOwner(n, id);
    return n;
  }
  function paintOwner(node, id) {
    node.textContent = '';
    if (!id) { node.textContent = 'Unassigned'; return; }
    const p = profiles[id];
    if (p) node.append(h('img', { src: p.avatarUrl, alt: '' }), p.name || 'Someone');
    else node.textContent = id === meId ? 'You' : 'Someone';
  }
  async function resolveOwners() {
    if (!user) return;
    const ids = [...new Set(items.map((i) => i.owner).filter(Boolean))];
    if (!ids.length) return;
    try { profiles = await user.profiles(ids); } catch { return; }
    for (const n of $$('[data-owner]')) paintOwner(n, n.getAttribute('data-owner'));
  }

  function card(it) {
    const canDrag = dbState === 'ready' && !readOnly;
    const c = h('article', {
      class: 'card', tabindex: '0', role: 'button', draggable: canDrag ? 'true' : 'false',
      'data-id': it.id, 'aria-label': (it.title || 'Untitled') + ' — open',
      onclick: () => openEditor(it),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(it); } },
      ondragstart: (e) => { e.dataTransfer.setData('text/plain', it.id); e.dataTransfer.effectAllowed = 'move'; },
    },
      h('div', { class: 'r1' }, kindChip(it.kind), prioPill(it.priority)),
      h('div', { class: 't' }, it.title || 'Untitled'),
      h('div', { class: 'r3' },
        h('span', { class: 'fid' }, it.feature || '—'),
        ownerNode(it.owner),
        it.target ? h('span', { class: isOverdue(it) ? 'overdue' : '' }, (isOverdue(it) ? 'Overdue · ' : '') + fmtDay(it.target)) : null
      )
    );
    return c;
  }

  function renderBoard(body, list) {
    const cols = S.status ? STATUSES.filter((s) => s.id === S.status) : STATUSES;
    const board = h('div', { class: 'board', role: 'list' });
    for (const s of cols) {
      const inCol = list.filter((it) => it.status === s.id).sort(byPriority);
      const col = h('div', { class: 'col', role: 'listitem', 'data-status': s.id, 'aria-label': s.label },
        h('div', { class: 'colhead' }, stateChip(s.id), h('span', { class: 'n' }, String(inCol.length))),
        inCol.length ? inCol.map(card) : h('div', { class: 'colempty' }, dbState === 'ready' ? 'Nothing here.' : '')
      );
      col.addEventListener('dragover', (e) => { if (readOnly || dbState !== 'ready') return; e.preventDefault(); col.classList.add('drop'); });
      col.addEventListener('dragleave', () => col.classList.remove('drop'));
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('drop');
        const id = e.dataTransfer.getData('text/plain');
        if (id) void moveTo(id, s.id);
      });
      board.append(col);
    }
    body.append(board);
  }

  function weekStart(d) { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x; }
  function renderSchedule(body, list) {
    const shown = list.filter((it) => (S.status ? true : isOpen(it)));
    const groups = new Map();
    const overdue = [];
    const nodate = [];
    for (const it of shown) {
      if (isOverdue(it)) { overdue.push(it); continue; }
      const d = parseDay(it.target);
      if (!d) { nodate.push(it); continue; }
      const k = weekStart(d).toISOString().slice(0, 10);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    const wrap = h('div', { class: 'sched' });
    const fmtWeek = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    const section = (title, rows, extraCls) => {
      if (!rows.length) return;
      rows.sort((a, b) => (a.target || '').localeCompare(b.target || '') || byPriority(a, b));
      wrap.append(h('div', { class: 'section' },
        h('h3', { class: extraCls || '' }, title, h('span', { class: 'n' }, rows.length + (rows.length === 1 ? ' item' : ' items'))),
        h('div', { class: 'rows' }, rows.map(row))
      ));
    };
    section('Overdue', overdue, 'overdue');
    for (const k of [...groups.keys()].sort()) section('Week of ' + fmtWeek.format(new Date(k + 'T00:00:00')), groups.get(k));
    section('No target date', nodate);
    if (!wrap.childNodes.length) wrap.append(emptyState());
    body.append(wrap);
  }
  function row(it) {
    return h('article', {
      class: 'row', tabindex: '0', role: 'button', onclick: () => openEditor(it),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(it); } },
    },
      h('span', { class: isOverdue(it) ? 'overdue mono' : 'mono' }, it.target ? fmtDay(it.target) : '—'),
      h('span', { class: 't' }, it.title || 'Untitled', ' ', h('span', { class: 'fid' }, it.feature || '—')),
      h('span', { class: 'meta' }, kindChip(it.kind), stateChip(it.status), prioPill(it.priority), ownerNode(it.owner))
    );
  }

  function renderManual(body) {
    const feats = S.feature ? FEATURES.filter((f) => f.id === S.feature) : FEATURES;
    const tbody = h('tbody');
    for (const f of feats) {
      const mine = items.filter((it) => it.feature === f.id && it.kind === 'manual');
      const ran = mine.filter((it) => it.manual && it.manual.lastRun).sort((a, b) => String(b.manual.lastRun).localeCompare(String(a.manual.lastRun)));
      const last = ran[0];
      const openPasses = mine.filter(isOpen);
      const next = openPasses.map((it) => it.target).filter(Boolean).sort()[0];
      tbody.append(h('tr', {},
        h('td', {}, h('span', { class: 'fid' }, f.id), ' ', f.name),
        h('td', { class: 'num' }, last ? fmtDay(last.manual.lastRun) : '—'),
        h('td', {}, resultChip(last ? last.manual.result : '')),
        h('td', { class: 'num' }, String(openPasses.length)),
        h('td', { class: 'num' }, next ? fmtDay(next) : '—'),
        h('td', {}, canWrite() ? h('button', { class: 'btn', type: 'button', onclick: () => openEditor(null, { feature: f.id, kind: 'manual', status: 'scheduled' }) }, 'Plan a pass') : '')
      ));
    }
    body.append(h('div', { class: 'tablebox' },
      h('table', {}, h('thead', {}, h('tr', {},
        h('th', {}, 'Feature'), h('th', { class: 'num' }, 'Last manual run'), h('th', {}, 'Result'),
        h('th', { class: 'num' }, 'Open passes'), h('th', { class: 'num' }, 'Next'), h('th', {}, '')
      )), tbody)
    ));
  }

  function emptyState() {
    if (dbState === 'loading') return h('div', { class: 'empty' }, 'Loading the shared board…');
    if (dbState === 'absent') return h('div', { class: 'empty' }, 'Work items appear here once the shared board is available.');
    if (!items.length) return h('div', { class: 'empty' }, 'No work items yet. Use “Add work item” to plan the first bug fix, test or manual-test pass.');
    return h('div', { class: 'empty' }, 'No work items match these filters.');
  }

  function renderPlan() {
    $('#ro-note').hidden = !(readOnly && dbState === 'ready');
    $('#offline-note').hidden = dbState !== 'absent';
    $('#add-item').hidden = !canWrite();
    for (const b of $$('.seg [data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === S.view));
    $('#f-feature').value = S.feature;
    $('#f-kind').value = S.kind;
    $('#f-owner').value = S.owner;
    renderSummary();
    const body = $('#plan-body');
    body.textContent = '';
    const list = items.filter((it) => matches(it, false));
    if (S.view === 'manual') renderManual(body);
    else if (dbState !== 'ready' || !list.length) {
      if (S.view === 'board' && dbState === 'ready' && items.length) renderBoard(body, list);
      else body.append(emptyState());
    } else if (S.view === 'schedule') renderSchedule(body, list);
    else renderBoard(body, list);
    void resolveOwners();
  }

  // ---- writes ----------------------------------------------------------------
  function canWrite() { return dbState === 'ready' && !readOnly; }
  function bodyOf(it) { const { id, ...rest } = it; return rest; }

  function handleWriteError(e) {
    const code = e && e.code;
    if (code === 'invalid_argument') {
      readOnly = true;
      toast('You can read this board but not change it.');
      renderAll();
    } else if (code === 'quota_exceeded') {
      toast('The board is full. Delete finished items to make room.');
    } else if (code === 'revoked' || code === 'not_granted') {
      dbState = 'absent';
      renderAll();
    } else {
      toast('Could not save. Check your connection and try again.');
    }
  }
  async function save(id, body) {
    if (!canWrite()) return false;
    const now = new Date().toISOString();
    try {
      if (id) await db.doc('items/' + id).set({ ...body, updatedAt: now });
      else await db.collection('items').doc().set({ ...body, createdAt: now, updatedAt: now, createdBy: meId || null });
      return true;
    } catch (e) {
      handleWriteError(e);
      return false;
    }
  }
  async function moveTo(id, status) {
    const it = items.find((x) => x.id === id);
    if (!it || it.status === status) return;
    if (await save(id, { ...bodyOf(it), status })) toast('Moved to ' + STATUS_BY_ID[status].label);
  }
  async function remove(id) {
    if (!canWrite()) return false;
    try { await db.doc('items/' + id).delete(); return true; } catch (e) { handleWriteError(e); return false; }
  }

  // ---- editor dialog ---------------------------------------------------------
  let lastFocus = null;
  function closeDialog() {
    $('#dialog-root').textContent = '';
    document.removeEventListener('keydown', onDialogKey);
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  function onDialogKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeDialog(); } }

  function openEditor(it, preset) {
    lastFocus = document.activeElement;
    const editing = Boolean(it);
    const ro = !canWrite();
    const v = it ? { ...bodyOf(it) } : {
      title: '', feature: S.feature || '', sub: '', kind: S.kind || 'bug', status: 'backlog', priority: 'P2',
      owner: null, target: '', sprint: '', links: '', detail: '', manual: { lastRun: '', result: '', notes: '' }, ...(preset || {}),
    };
    v.manual = { lastRun: '', result: '', notes: '', ...(v.manual || {}) };
    let owner = v.owner || null;

    const opt = (value, label, sel) => h('option', { value, selected: sel ? 'selected' : null }, label);
    const fTitle = h('input', { type: 'text', id: 'ed-title', value: v.title || '', required: true, disabled: ro, maxlength: '200' });
    const fFeature = h('select', { id: 'ed-feature', disabled: ro });
    fFeature.append(opt('', 'Choose a feature…', !v.feature));
    for (const a of AREAS) {
      const g = h('optgroup', { label: a.name });
      for (const f of FEATURES.filter((x) => x.area === a.id)) g.append(opt(f.id, f.id + ' — ' + f.name, f.id === v.feature));
      fFeature.append(g);
    }
    const fSub = h('select', { id: 'ed-sub', disabled: ro });
    const fillSubs = () => {
      fSub.textContent = '';
      fSub.append(opt('', 'The whole feature', !v.sub));
      const f = FEATURE_BY_ID[fFeature.value];
      for (const s of (f ? f.subs : [])) fSub.append(opt(s, s, s === v.sub));
    };
    fillSubs();
    fFeature.addEventListener('change', () => { v.sub = ''; fillSubs(); });
    const fKind = h('select', { id: 'ed-kind', disabled: ro }, KINDS.map((k) => opt(k.id, k.label, k.id === v.kind)));
    const fStatus = h('select', { id: 'ed-status', disabled: ro }, STATUSES.map((s) => opt(s.id, s.label, s.id === v.status)));
    const fPrio = h('select', { id: 'ed-prio', disabled: ro }, PRIOS.map((p) => opt(p.id, p.label, p.id === v.priority)));
    const fTarget = h('input', { type: 'date', id: 'ed-target', value: v.target || '', disabled: ro });
    const fSprint = h('input', { type: 'text', id: 'ed-sprint', value: v.sprint || '', disabled: ro, placeholder: 'e.g. 0.2.36x, November', maxlength: '80' });
    const fLinks = h('input', { type: 'text', id: 'ed-links', value: v.links || '', disabled: ro, placeholder: 'PR, branch, issue or plan', maxlength: '400' });
    const fDetail = h('textarea', { id: 'ed-detail', disabled: ro, maxlength: '4000', placeholder: 'What and why. For a bug: what happens, and what should.' });
    fDetail.value = v.detail || '';
    const fRun = h('input', { type: 'date', id: 'ed-run', value: v.manual.lastRun || '', disabled: ro });
    const fResult = h('select', { id: 'ed-result', disabled: ro }, RESULTS.map((r) => opt(r.id, r.label, r.id === (v.manual.result || ''))));
    const fNotes = h('textarea', { id: 'ed-notes', disabled: ro, maxlength: '2000', placeholder: 'Steps walked, what failed, environment' });
    fNotes.value = v.manual.notes || '';

    // Owner: stored as an id, shown by name.
    const ownerShown = h('span', { class: 'owner' });
    const paintChosen = () => paintOwner(ownerShown, owner);
    paintChosen();
    const fOwnerSearch = h('input', { type: 'search', id: 'ed-owner', placeholder: user ? 'Search people…' : 'Names need sign-in', disabled: ro || !user, autocomplete: 'off' });
    const hits = h('div', { class: 'hits', hidden: true });
    const showHits = async (q) => {
      if (!user) return;
      let list = [];
      try { list = await user.search(q); } catch { list = []; }
      hits.textContent = '';
      for (const p of list) {
        hits.append(h('button', { type: 'button', onclick: () => { owner = p.id; profiles[p.id] = p; paintChosen(); hits.hidden = true; fOwnerSearch.value = ''; } }, h('img', { src: p.avatarUrl, alt: '' }), p.name || 'Someone'));
      }
      hits.hidden = !list.length;
    };
    fOwnerSearch.addEventListener('focus', () => void showHits(''));
    fOwnerSearch.addEventListener('input', () => void showHits(fOwnerSearch.value));
    fOwnerSearch.addEventListener('blur', () => setTimeout(() => { hits.hidden = true; }, 180));
    const meBtn = h('button', { class: 'btn ghost', type: 'button', disabled: ro || !meId, onclick: () => { owner = meId; paintChosen(); } }, 'Assign to me');
    const clearBtn = h('button', { class: 'btn ghost', type: 'button', disabled: ro, onclick: () => { owner = null; paintChosen(); } }, 'Clear');

    const err = h('p', { class: 'overdue', hidden: true });
    const confirmRow = h('div', { class: 'confirm', hidden: true },
      'Delete this item for everyone?',
      h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (await remove(it.id)) { closeDialog(); toast('Deleted'); } } }, 'Delete'),
      h('button', { class: 'btn', type: 'button', onclick: () => { confirmRow.hidden = true; } }, 'Keep it')
    );

    const onSave = async (e) => {
      e.preventDefault();
      const title = fTitle.value.trim();
      if (!title || !fFeature.value) {
        err.hidden = false;
        err.textContent = !title ? 'Give the item a title.' : 'Choose the feature it belongs to.';
        (title ? fFeature : fTitle).focus();
        return;
      }
      const body = {
        ...(it ? bodyOf(it) : {}),
        title, feature: fFeature.value, sub: fSub.value, kind: fKind.value, status: fStatus.value, priority: fPrio.value,
        owner: owner || null, target: fTarget.value, sprint: fSprint.value.trim(), links: fLinks.value.trim(), detail: fDetail.value,
        manual: { lastRun: fRun.value, result: fResult.value, notes: fNotes.value },
      };
      if (await save(editing ? it.id : null, body)) { closeDialog(); toast(editing ? 'Saved' : 'Added'); }
    };

    const field = (label, control, id) => h('div', { class: 'field' }, h('label', { for: id }, label), control);
    const form = h('form', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ed-h', onsubmit: onSave },
      h('div', { class: 'sechead' },
        h('h2', { id: 'ed-h' }, ro ? 'Work item' : editing ? 'Edit work item' : 'New work item'),
        editing && it.createdAt ? h('span', { class: 'stamp' }, 'Updated ' + fmtDay(String(it.updatedAt || it.createdAt).slice(0, 10))) : null
      ),
      field('Title', fTitle, 'ed-title'),
      h('div', { class: 'grid2' }, field('Feature', fFeature, 'ed-feature'), field('Sub-feature', fSub, 'ed-sub')),
      h('div', { class: 'grid2' }, field('Kind', fKind, 'ed-kind'), field('Status', fStatus, 'ed-status'), field('Priority', fPrio, 'ed-prio')),
      h('div', { class: 'field' }, h('label', { for: 'ed-owner' }, 'Owner'),
        h('div', { class: 'toolbar' }, ownerShown, meBtn, clearBtn),
        h('div', { class: 'picker' }, fOwnerSearch, hits)
      ),
      h('div', { class: 'grid2' }, field('Target date', fTarget, 'ed-target'), field('Sprint or milestone', fSprint, 'ed-sprint')),
      field('Links', fLinks, 'ed-links'),
      field('Detail', fDetail, 'ed-detail'),
      h('fieldset', {}, h('legend', {}, 'Manual test — last run'),
        h('div', { class: 'grid2' }, field('Run on', fRun, 'ed-run'), field('Result', fResult, 'ed-result')),
        field('Notes', fNotes, 'ed-notes')
      ),
      err,
      confirmRow,
      h('div', { class: 'actions' },
        editing && !ro ? h('button', { class: 'btn danger', type: 'button', onclick: () => { confirmRow.hidden = false; } }, 'Delete') : h('span'),
        h('div', { class: 'toolbar' },
          h('button', { class: 'btn', type: 'button', onclick: closeDialog }, ro ? 'Close' : 'Cancel'),
          ro ? null : h('button', { class: 'btn primary', type: 'submit' }, editing ? 'Save' : 'Add item')
        )
      )
    );
    const scrim = h('div', { class: 'scrim', onclick: (e) => { if (e.target === scrim) closeDialog(); } }, form);
    $('#dialog-root').textContent = '';
    $('#dialog-root').append(scrim);
    document.addEventListener('keydown', onDialogKey);
    (ro ? form.querySelector('button') : fTitle).focus();
  }

  // ---- features --------------------------------------------------------------
  function renderAreas() {
    const root = $('#areas');
    root.textContent = '';
    const mk = (id, label) => h('button', { type: 'button', 'aria-pressed': String(S.area === id), onclick: () => { S.area = id; renderAreas(); renderFeatures(); } }, label);
    root.append(mk('', 'All'));
    for (const a of AREAS) root.append(mk(a.id, a.name));
  }
  function renderFeatures() {
    const grid = $('#fgrid');
    grid.textContent = '';
    for (const f of FEATURES.filter((x) => !S.area || x.area === S.area)) {
      const open = items.filter((it) => it.feature === f.id && isOpen(it)).length;
      const dl = h('dl', {});
      for (const [k, val] of [['Opens in', f.ui], ['API', f.api], ['Code', f.code], ['Perms', f.perms], ['Tables', f.tables], ['Tests', f.tests], ['Watch', f.watch]]) {
        if (!val) continue;
        dl.append(h('dt', {}, k), h('dd', {}, val));
      }
      grid.append(h('article', { class: 'fcard' },
        h('div', { class: 'h' }, h('h3', {}, f.name), h('span', { class: 'fid' }, f.id)),
        h('div', { class: 'subs' }, f.subs.map((s) => h('span', { class: 'tag' }, s))),
        dl,
        h('div', { class: 'foot' },
          h('button', { class: 'btn ghost openlink', type: 'button', onclick: () => { S.feature = f.id; S.status = ''; showTab('plan', true); renderPlan(); } },
            dbState === 'ready' ? (open ? open + ' open work item' + (open === 1 ? '' : 's') + ' →' : 'No open work →') : 'Work items →'),
          canWrite() ? h('button', { class: 'btn', type: 'button', onclick: () => openEditor(null, { feature: f.id }) }, 'Plan work') : null
        )
      ));
    }
  }

  // ---- schema, engines, coverage ---------------------------------------------
  function renderOwners() {
    const tb = $('#owners tbody');
    for (const [t, f, n] of TABLES) tb.append(h('tr', {}, h('td', {}, h('code', {}, t)), h('td', {}, h('span', { class: 'fid' }, f), ' ', (FEATURE_BY_ID[f] || {}).name || ''), h('td', { class: 'num' }, String(n))));
  }
  function renderMatrix() {
    const t = $('#matrix');
    t.append(h('thead', {}, h('tr', {}, h('th', {}, 'Engine'), ENGINES.cols.map((c) => h('th', {}, c)))));
    const tb = h('tbody');
    for (const [name, ...caps] of ENGINES.rows) {
      tb.append(h('tr', {}, h('td', {}, name), caps.map((c) => h('td', { class: c ? 'yes' : 'no' }, c ? '✓ Yes' : '— No'))));
    }
    t.append(tb);
  }
  function niceStep(max) {
    for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200]) if (max / s <= 5) return s;
    return 500;
  }
  function barChart(rootId, title, note, rows, labelHead) {
    const root = $('#' + rootId);
    const max = Math.max(...rows.map((r) => r[1]));
    const step = niceStep(max);
    const top = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);
    const tip = h('div', { class: 'tip', hidden: true });
    const bars = h('div', { class: 'bars', style: '--n:' + (ticks.length - 1) });
    for (const [label, value] of rows) {
      const pct = (value / top) * 100;
      const r = h('div', { class: 'brow' },
        h('span', { class: 'blbl' }, label),
        h('span', { class: 'btrack' },
          h('span', { class: 'bfill', style: 'width:' + pct.toFixed(2) + '%' }),
          h('span', { class: 'bval', style: 'left:calc(' + pct.toFixed(2) + '% + 6px)' }, String(value))
        )
      );
      r.addEventListener('mousemove', (e) => {
        const box = root.getBoundingClientRect();
        tip.textContent = label + ': ' + value;
        tip.hidden = false;
        tip.style.left = Math.min(e.clientX - box.left + 12, box.width - 160) + 'px';
        tip.style.top = (e.clientY - box.top - 34) + 'px';
      });
      r.addEventListener('mouseleave', () => { tip.hidden = true; });
      bars.append(r);
    }
    const axis = h('div', { class: 'brow baxis', 'aria-hidden': 'true' }, h('span'),
      h('span', { class: 'bticks' }, ticks.map((v) => h('span', { style: 'left:' + ((v / top) * 100).toFixed(2) + '%' }, String(v)))));
    bars.append(axis);
    const table = h('div', { class: 'tablebox', hidden: true },
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, labelHead), h('th', { class: 'num' }, 'Count'))),
        h('tbody', {}, rows.map(([l, v]) => h('tr', {}, h('td', {}, l), h('td', { class: 'num' }, String(v)))))));
    const toggle = h('button', { class: 'btn ghost', type: 'button', onclick: () => {
      table.hidden = !table.hidden; bars.hidden = !table.hidden;
      toggle.textContent = table.hidden ? 'Show as table' : 'Show as chart';
    } }, 'Show as table');
    root.append(
      h('div', { class: 'sechead' }, h('div', {}, h('h3', {}, title), h('div', { class: 'stamp' }, note)), toggle),
      bars, table, tip
    );
  }
  function renderCoverage() {
    barChart('chart-routes', 'HTTP routes by feature', '153 routes pinned by http-contract.test.ts', ROUTES, 'Feature');
    barChart('chart-tests', 'Unit-test files by package', 'Files named *.test.ts(x), excluding e2e', TESTS, 'Package');
    const g = $('#e2e-groups');
    for (const name of E2E_GROUPS) g.append(h('span', { class: 'tag' }, name));
  }

  function renderAll() { renderPlan(); renderFeatures(); }

  // ---- store connection ------------------------------------------------------
  async function connect() {
    let cl = window.claude;
    if (!cl || typeof cl.use !== 'function') {
      await new Promise((r) => setTimeout(r, 1200));
      cl = window.claude;
    }
    if (!cl || typeof cl.use !== 'function') { dbState = 'absent'; renderAll(); return; }
    try { user = await cl.use('user'); } catch { user = null; }
    try { db = await cl.use('db'); } catch { db = null; }
    if (!db) { dbState = 'absent'; renderAll(); return; }
    if (user) {
      try { meId = await user.id(); } catch { meId = null; }
      try { if ((await user.can('data.write')) === false) readOnly = true; } catch { /* keep controls */ }
    }
    db.collection('items').onSnapshot(
      (snap) => {
        items = snap.docs.filter((d) => d.exists).map((d) => ({ id: d.id, ...d.data() }));
        dbState = 'ready';
        renderAll();
      },
      (e) => {
        if (e && ['revoked', 'not_granted', 'capability_disabled', 'capability_removed'].includes(e.code)) dbState = 'absent';
        else toast('The board stopped updating. Reload the page to reconnect.');
        renderAll();
      }
    );
  }

  // ---- boot ------------------------------------------------------------------
  function boot() {
    fillSelects();
    renderAreas();
    renderOwners();
    renderMatrix();
    renderCoverage();
    const savedView = store.get('view');
    if (savedView && ['board', 'schedule', 'manual'].includes(savedView)) S.view = savedView;
    for (const b of $$('nav.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab, true));
    for (const b of $$('.seg [data-view]')) b.addEventListener('click', () => { S.view = b.dataset.view; store.set('view', S.view); renderPlan(); });
    $('#q').addEventListener('input', (e) => { S.q = e.target.value; renderPlan(); });
    $('#f-feature').addEventListener('change', (e) => { S.feature = e.target.value; renderPlan(); });
    $('#f-kind').addEventListener('change', (e) => { S.kind = e.target.value; renderPlan(); });
    $('#f-owner').addEventListener('change', (e) => { S.owner = e.target.value; renderPlan(); });
    $('#add-item').addEventListener('click', () => openEditor(null));
    if (STATIC) {
      $('#tab-plan').hidden = true;
      $('#panel-plan').hidden = true;
      dbState = 'absent';
    }
    const hash = (location.hash || '').replace('#', '');
    const saved = store.get('tab');
    showTab(TABS.includes(hash) ? hash : TABS.includes(saved) ? saved : TABS[0], false);
    renderAll();
    if (!STATIC) void connect();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
