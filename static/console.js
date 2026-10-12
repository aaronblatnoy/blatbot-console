// Config comes from config.js, served beside this page. Every request this client
// makes, including the live event stream, goes through these two values.
const CONFIG = window.CONSOLE_CONFIG || { apiBase: '/console/api', eventsUrl: '/console/events' };
const API = CONFIG.apiBase;

const state = {
  overview: null,
  home: null,
  streamState: 'connecting',
  people: [],
  unassigned: [],
  personDirty: false,
  editorPerson: null,
  ownEvents: [],
  roles: [],
  scopes: [],
  scopesBreakdown: [],
  requests: [],
  tasks: [],
  schedules: [],
  schedulesPaused: false,
  health: null,
  settings: [],
  settingStatus: {},
  selectedPerson: null,
  selectedWaiting: 0,
  requestFilter: 'all',
  search: '',
  eventSource: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  noticeTimer: null,
  activeView: 'home',
  taskId: null,
  loaded: Object.create(null),
  invalidated: Object.create(null),
  taskLedgers: new Map(),
};

const VIEW_PATHS = {
  home: '/console/',
  requests: '/console/requests',
  people: '/console/people',
  roles: '/console/roles',
  scopes: '/console/scopes',
  tasks: '/console/tasks',
  schedules: '/console/schedules',
  health: '/console/health',
  settings: '/console/settings',
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Accept': 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof payload === 'object'
      ? payload.error || payload.detail || payload.message || `Request failed (${response.status})`
      : payload || `Request failed (${response.status})`;
    throw new ApiError(message, response.status, payload);
  }
  return payload;
}

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

function escapeHTML(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function formatTime(value) {
  if (!value) return 'unknown';
  // The API stamps times as unix SECONDS; Date wants milliseconds. Without this every
  // timestamp in the console renders as January 1970, which is what it used to do.
  const number = Number(value);
  const date = new Date(Number.isFinite(number) && number > 0 && number < 1e12 ? number * 1000 : value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds))) return 'unknown';
  let remaining = Math.max(0, Number(seconds));
  const days = Math.floor(remaining / 86400); remaining %= 86400;
  const hours = Math.floor(remaining / 3600); remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  return [days && `${days}d`, (hours || days) && `${hours}h`, `${minutes}m`].filter(Boolean).join(' ');
}

function showNotice(message, type = 'info', timeout = 5000) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.className = `notice${type === 'error' ? ' is-error' : ''}`;
  notice.hidden = false;
  clearTimeout(state.noticeTimer);
  if (timeout) state.noticeTimer = setTimeout(() => { notice.hidden = true; }, timeout);
}

function setStarting(isStarting, detail = '') {
  $('#startup-banner').hidden = !isStarting;
  if (detail) $('#startup-detail').textContent = detail;
}

function scopeChips(scopes = []) {
  return scopes.length
    ? scopes.map(scope => `<span class="scope-chip">${escapeHTML(scope)}</span>`).join('')
    : '<span class="muted">no scopes</span>';
}

function routeFromPath(pathname = location.pathname) {
  const path = pathname.replace(/\/+$/, '') || '/console';
  if (path === '/console') return { view: 'home', taskId: null };
  if (path === '/console/requests') return { view: 'requests', taskId: null };
  if (path === '/console/permissions') return { view: 'people', taskId: null };
  if (path === '/console/people') return { view: 'people', taskId: null };
  if (path === '/console/roles') return { view: 'roles', taskId: null };
  if (path === '/console/scopes') return { view: 'scopes', taskId: null };
  if (path === '/console/tasks') return { view: 'tasks', taskId: null };
  if (path.startsWith('/console/tasks/')) {
    const encodedId = path.slice('/console/tasks/'.length);
    try { return { view: 'tasks', taskId: decodeURIComponent(encodedId) }; }
    catch { return { view: 'tasks', taskId: encodedId }; }
  }
  if (path === '/console/schedules') return { view: 'schedules', taskId: null };
  if (path === '/console/health') return { view: 'health', taskId: null };
  if (path === '/console/settings') return { view: 'settings', taskId: null };
  return { view: 'home', taskId: null, unknown: true };
}

function updateWaitingCount() {
  const count = pendingRequests().length;
  const navBadge = $('#nav-waiting-count');
  navBadge.hidden = !count;
  navBadge.textContent = count;
  $('#mobile-request-status').hidden = !count;
  $('#mobile-waiting-count').textContent = count;
  $('#waiting-count').textContent = count;
  // Amber means something needs you, so a zero is not amber.
  $('#waiting-count').classList.toggle('is-zero', !count);
  $('#waiting-summary').textContent = count ? `${count} request${count === 1 ? ' needs' : 's need'} a decision.` : 'No decisions are waiting.';
}

async function refreshWaitingCount() {
  const pending = await api('/requests?state=pending');
  state.requests = [...pending, ...state.requests.filter(request => request.state !== 'pending')]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  updateWaitingCount();
}

async function loadView(view = state.activeView, { force = false } = {}) {
  if (!force && state.loaded[view] && !state.invalidated[view]) {
    if (view === 'tasks' && state.taskId) await openTask(state.taskId);
    return;
  }
  try {
    if (view === 'home') await refreshHome({ throwOnError: true });
    if (view === 'requests') await refreshRequests({ throwOnError: true });
    if (view === 'people') await refreshPeople({ throwOnError: true });
    if (view === 'roles') await refreshRoles({ throwOnError: true });
    if (view === 'scopes') await refreshScopesBreakdown({ throwOnError: true });
    if (view === 'tasks') await refreshTasks({ throwOnError: true });
    if (view === 'schedules') await refreshSchedules({ throwOnError: true });
    if (view === 'health') await refreshHealth({ throwOnError: true });
    if (view === 'settings') await refreshSettings({ throwOnError: true });
    setStarting(false);
    if (view === 'tasks' && state.taskId) await openTask(state.taskId);
  } catch (error) {
    if (error.status === 503) {
      setStarting(true, error.message || 'The console will retry when the API is ready.');
      renderUnavailable();
      window.setTimeout(() => loadSnapshot({ quiet: true }), 4000);
      return;
    }
    setStarting(false);
    showNotice(`Could not load ${view}: ${error.message}`, 'error', 0);
    renderUnavailable();
  }
}

async function loadSnapshot({ quiet = false } = {}) {
  state.invalidated[state.activeView] = true;
  const loads = [loadView(state.activeView, { force: true })];
  if (state.activeView !== 'requests') loads.push(refreshWaitingCount());
  await Promise.all(loads);
  if (!quiet) showNotice('Console refreshed.');
}

function renderUnavailable() {
  for (const selector of ['#home-content', '#waiting-list', '#people-list', '#tasks-list', '#health-content', '#settings-list']) {
    const target = $(selector);
    if (target && !target.children.length) target.innerHTML = '<div class="empty-state">Data is not available yet.</div>';
  }
}

function pendingRequests() {
  return state.requests.filter(request => request.state === 'pending');
}

function relativeAge(value) {
  if (!value) return 'unknown';
  const number = Number(value);
  const ms = Number.isFinite(number) && number > 0
    ? (number < 1e12 ? number * 1000 : number)
    : Date.parse(value);
  if (!Number.isFinite(ms)) return 'unknown';
  let seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

async function refreshHome({ throwOnError = false } = {}) {
  try {
    state.home = await api('/home');
    state.loaded.home = true;
    state.invalidated.home = false;
    renderHome();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Home not refreshed: ${error.message}`, 'error');
  }
}

function homeNeedsYouBlock() {
  const needs = state.home?.needs_you || { count: 0, oldest: null };
  const quiet = !needs.count;
  const oldest = needs.oldest;
  return `<article class="home-card home-needs-you${quiet ? ' is-quiet' : ' is-urgent'}" aria-labelledby="home-needs-you-title">
    <div class="home-card-head">
      <h2 id="home-needs-you-title">Needs you</h2>
      <span class="home-needs-count">${needs.count}</span>
    </div>
    ${quiet
      ? '<p class="home-card-body muted">Nothing is waiting on you.</p>'
      : `<p class="home-card-body">${needs.count === 1 ? 'One request is' : `${needs.count} requests are`} waiting on you. The oldest, from <strong>${escapeHTML(oldest.sender || 'Unknown sender')}</strong> (${escapeHTML(relativeAge(oldest.created_at))}):</p>
         <blockquote class="home-oldest-summary">${escapeHTML(oldest.summary || 'No summary')}</blockquote>
         <a class="button button-primary" href="${VIEW_PATHS.requests}" data-home-link="requests">Open requests</a>`}
  </article>`;
}

function homeRightNowBlock() {
  const rightNow = state.home?.right_now || { running_count: 0, running: [], gateway_up: false, tunnel_connected: false };
  const streamLive = state.streamState === 'live';
  return `<article class="home-card home-right-now" aria-labelledby="home-right-now-title">
    <div class="home-card-head"><h2 id="home-right-now-title">Right now</h2></div>
    <dl class="home-status-grid">
      <div><dt>Gateway</dt><dd class="state state-${rightNow.gateway_up ? 'done' : 'failed'}">${rightNow.gateway_up ? 'up' : 'down'}</dd></div>
      <div><dt>Tunnel</dt><dd class="state state-${rightNow.tunnel_connected ? 'done' : 'failed'}">${rightNow.tunnel_connected ? 'connected' : 'disconnected'}</dd></div>
      <div><dt>Live updates</dt><dd class="state state-${streamLive ? 'done' : 'failed'}">${streamLive ? 'connected' : 'offline'}</dd></div>
      <div><dt>Running now</dt><dd class="home-running-count">${rightNow.running_count}</dd></div>
    </dl>
    ${rightNow.running.length
      ? `<ul class="home-mini-list">${rightNow.running.map(r => `<li><span class="state state-running">running</span><span class="home-mini-summary">${escapeHTML(r.summary || 'No summary')}</span><span class="muted">${escapeHTML(relativeAge(r.created_at))}</span></li>`).join('')}</ul>`
      : '<p class="home-card-body muted">Nothing is running right now.</p>'}
    <a class="home-card-link" href="${VIEW_PATHS.requests}" data-home-link="requests">See requests →</a>
  </article>`;
}

function homeRecentActivityBlock() {
  const recent = state.home?.recent_activity || [];
  return `<article class="home-card home-recent-activity" aria-labelledby="home-recent-title">
    <div class="home-card-head"><h2 id="home-recent-title">Recent activity</h2></div>
    ${recent.length
      ? `<ul class="home-mini-list">${recent.map(r => `<li><span class="state state-${escapeHTML(r.state)}">${escapeHTML(r.state)}</span><span class="home-mini-summary"><strong>${escapeHTML(r.sender || 'Unknown sender')}</strong> &middot; ${escapeHTML(r.summary || 'No summary')}</span><span class="muted">${escapeHTML(relativeAge(r.created_at))}</span></li>`).join('')}</ul>`
      : '<p class="home-card-body muted">No requests yet.</p>'}
    <a class="home-card-link" href="${VIEW_PATHS.requests}" data-home-link="requests">See all requests →</a>
  </article>`;
}

function homeComingUpBlock() {
  const comingUp = state.home?.coming_up || { schedules_paused: false, next: [] };
  return `<article class="home-card home-coming-up" aria-labelledby="home-coming-up-title">
    <div class="home-card-head">
      <h2 id="home-coming-up-title">Coming up</h2>
      ${comingUp.schedules_paused ? '<span class="home-pill is-waiting">Schedules paused</span>' : ''}
    </div>
    ${comingUp.next.length
      ? `<ul class="home-mini-list">${comingUp.next.map(s => `<li><span class="home-mini-summary"><strong>${escapeHTML(s.title)}</strong> &middot; ${escapeHTML(s.cadence)}</span><span class="muted">${escapeHTML(formatTime(s.next_run))}</span></li>`).join('')}</ul>`
      : '<p class="home-card-body muted">No scheduled runs are coming up.</p>'}
    <a class="home-card-link" href="${VIEW_PATHS.schedules}" data-home-link="schedules">See schedules →</a>
  </article>`;
}

function homePeopleBlock() {
  const people = state.home?.people || { total: 0, with_role: 0, roles: [], last_sync: {} };
  const lastSync = people.last_sync || {};
  const failed = lastSync.failed || [];
  return `<article class="home-card home-people" aria-labelledby="home-people-title">
    <div class="home-card-head">
      <h2 id="home-people-title">People &amp; roles</h2>
      <button id="home-sync-people" class="button button-quiet" type="button">Refresh from Inkbox</button>
    </div>
    <dl class="home-status-grid">
      <div><dt>People known</dt><dd>${people.total}</dd></div>
      <div><dt>Hold a role</dt><dd>${people.with_role}</dd></div>
    </dl>
    ${people.roles.length
      ? `<ul class="home-mini-list">${people.roles.map(r => `<li><span class="home-mini-summary mono">${escapeHTML(r.name)}</span><span class="muted">${r.members} member${r.members === 1 ? '' : 's'}</span></li>`).join('')}</ul>`
      : '<p class="home-card-body muted">No roles configured.</p>'}
    <p class="home-card-body muted">${lastSync.at ? `Last synced ${escapeHTML(relativeAge(lastSync.at))}` : 'Never synced from Inkbox.'}${failed.length ? ` — failed: ${escapeHTML(failed.join(', '))}` : ''}</p>
    <a class="home-card-link" href="${VIEW_PATHS.people}" data-home-link="people">See people →</a>
  </article>`;
}

function homeContactsBlock() {
  const contacts = state.home?.recent_contacts || [];
  return `<article class="home-card home-contacts" aria-labelledby="home-contacts-title">
    <div class="home-card-head"><h2 id="home-contacts-title">Who reached out recently</h2></div>
    ${contacts.length
      ? `<ul class="home-mini-list">${contacts.map(c => `<li><span class="home-mini-summary">${escapeHTML(c.person || c.key)}</span><span class="muted">${escapeHTML((c.channels || []).join(', ') || 'unknown channel')} &middot; ${escapeHTML(relativeAge(c.last_seen))}</span></li>`).join('')}</ul>`
      : '<p class="home-card-body muted">No one has reached out yet.</p>'}
    <a class="home-card-link" href="${VIEW_PATHS.people}" data-home-link="people">See people →</a>
  </article>`;
}

function renderHome() {
  const host = $('#home-content');
  host.setAttribute('aria-busy', 'false');
  if (!state.home) { host.innerHTML = '<div class="empty-state">Data is not available yet.</div>'; return; }
  host.innerHTML = homeNeedsYouBlock() + homeRightNowBlock() + homeRecentActivityBlock()
    + homeComingUpBlock() + homePeopleBlock() + homeContactsBlock();
}

function renderRequests() {
  const waiting = pendingRequests();
  state.selectedWaiting = Math.max(0, Math.min(state.selectedWaiting, waiting.length - 1));
  const count = waiting.length;
  updateWaitingCount();
  $('#waiting-list').setAttribute('aria-busy', 'false');
  $('#waiting-list').innerHTML = count
    ? waiting.map((request, index) => requestCard(request, index)).join('')
    : '<div class="waiting-empty"><strong>Nothing waiting.</strong>New requests will appear here as they arrive.</div>';

  const counts = ['running', 'done', 'failed'].map(name => `${state.requests.filter(r => r.state === name).length} ${name}`).join(' / ');
  $('#history-counts').textContent = counts;
  const history = state.requests.filter(request => request.state !== 'pending' && (state.requestFilter === 'all' || request.state === state.requestFilter));
  $('#request-history').innerHTML = history.length ? history.map(historyRow).join('') : '<div class="empty-state">No requests in this state.</div>';
}

function requestCard(request, index) {
  return `<article class="request-card${index === state.selectedWaiting ? ' is-selected' : ''}" data-request-id="${escapeHTML(request.id)}" data-waiting-index="${index}" tabindex="${index === state.selectedWaiting ? '0' : '-1'}" aria-label="Waiting request from ${escapeHTML(request.sender_name || request.sender)}">
    <div class="request-main">
      <div class="request-who">
        <div class="sender">${escapeHTML(request.sender_name || request.sender || 'Unknown sender')}</div>
        <div class="surface">${escapeHTML(request.surface || 'unknown surface')}</div>
        <div class="request-id">${escapeHTML(request.id)}</div>
      </div>
      <div>
        <p class="request-summary">${escapeHTML(request.summary || 'No summary')}</p>
        <div class="scope-line">${scopeChips(request.scopes)}</div>
      </div>
      <div class="request-actions">
        <button class="button button-approve" type="button" data-decision="yes">Approve</button>
        <button class="button button-reject" type="button" data-decision="no">Reject</button>
        <button class="button button-quiet" type="button" data-show-edit>Edit</button>
      </div>
    </div>
    <details class="original-message" open>
      <summary>Original message · ${escapeHTML(formatTime(request.created_at))}</summary>
      <blockquote>${escapeHTML(request.original_message || 'No original message recorded.')}</blockquote>
    </details>
    <div class="decision-note" hidden>
      <textarea aria-label="Edited instruction" placeholder="Required: enter the edited instruction"></textarea>
      <button class="button button-primary" type="button" data-decision="edit">Run edit</button>
    </div>
  </article>`;
}

function historyRow(request) {
  return `<div class="history-row">
    <span class="state state-${escapeHTML(request.state)}">${escapeHTML(request.state)}</span>
    <span>${escapeHTML(request.sender_name || request.sender || 'Unknown')}</span>
    <span class="summary">${escapeHTML(request.summary || request.original_message || 'No summary')}</span>
    <time datetime="${escapeHTML(request.created_at || '')}">${escapeHTML(formatTime(request.created_at))}</time>
  </div>`;
}

async function decide(requestId, decision, note) {
  const card = $(`[data-request-id="${CSS.escape(requestId)}"]`);
  if (!card) return;
  if (decision === 'edit' && !note?.trim()) {
    showNotice('An edited instruction is required.', 'error');
    card.querySelector('textarea')?.focus();
    return;
  }
  $$('button', card).forEach(button => { button.disabled = true; });
  try {
    const payload = { id: requestId, decision };
    if (note?.trim()) payload.note = note.trim();
    const result = await post('/requests/decide', payload);
    const actualState = result?.state || (decision === 'no' ? 'rejected' : 'approved');
    showNotice(`Request ${requestId} is ${actualState}.`);
  } catch (error) {
    const actual = error.payload?.state || error.payload?.current_state || error.payload?.request?.state;
    const detail = actual ? `${error.message} Current state: ${actual}.` : error.message;
    showNotice(`Decision not applied: ${detail}`, 'error', 8000);
  } finally {
    await refreshRequests();
  }
}

async function refreshRequests({ throwOnError = false } = {}) {
  try {
    const [overview, ...requests] = await Promise.all([
      api('/overview'),
      ...['pending', 'running', 'done', 'failed'].map(requestState => api(`/requests?state=${requestState}`)),
    ]);
    state.overview = overview;
    state.requests = requests.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    state.loaded.requests = true;
    state.invalidated.requests = false;
    renderRequests();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Request status could not be refreshed: ${error.message}`, 'error');
  }
}

function renderScopeGroups(selected = new Set()) {
  const groups = state.scopes.reduce((map, scope) =>
    map.set(scope.group || 'Other', [...(map.get(scope.group || 'Other') || []), scope]), new Map());
  return [...groups.entries()].map(([group, scopes]) => `<fieldset class="scope-group">
    <legend>${escapeHTML(group)}</legend><div class="scope-options">${scopes.map(scope => `<label class="scope-option">
      <input type="checkbox" name="scopes" value="${escapeHTML(scope.name)}" ${selected.has(scope.name) ? 'checked' : ''}>
      <span class="scope-option-text"><span class="scope-name">${escapeHTML(scope.name)}<span class="scope-detail-kind is-${escapeHTML(scope.kind || (scope.read ? 'read' : 'write'))}">${escapeHTML(scope.read ? 'read' : (scope.kind || 'write'))}</span></span><span class="scope-purpose">${escapeHTML(scope.description || scope.purpose || `${scope.tools_count || 0} tools`)}</span></span>
    </label>`).join('')}</div></fieldset>`).join('');
}

async function refreshRoles({ throwOnError = false } = {}) {
  try {
    const [roles, scopes] = await Promise.all([api('/roles'), api('/scopes')]);
    state.roles = roles; state.scopes = scopes;
    state.loaded.roles = true;
    state.invalidated.roles = false;
    renderRolesPage();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Roles not refreshed: ${error.message}`, 'error');
  }
}

function heldRoles(value) { return String(value || '').split(',').map(n => n.trim()).filter(Boolean); }
function rolePicker(p, inputName) {
  const have = new Set(heldRoles(p?.role));
  const items = state.roles.map(role => {
    if (role.locked) {
      // A locked role is never offered as a choice for anyone -- it cannot be
      // granted or removed here. The one person who holds it (flagged by the
      // API, never by matching the role's name) sees it as a fixed fact about
      // their own entry; nobody else sees it at all.
      if (!p?.commander) return '';
      return `<label class="person-role-choice person-role-locked"><input type="checkbox" name="${inputName}" value="${escapeHTML(role.name)}" checked disabled><span>${escapeHTML(role.name)}</span><span class="muted person-role-locked-hint">cannot be changed here</span></label>`;
    }
    return `<label class="person-role-choice"><input type="checkbox" name="${inputName}" value="${escapeHTML(role.name)}" ${have.has(role.name) ? 'checked' : ''}><span>${escapeHTML(role.name)}</span></label>`;
  }).filter(Boolean);
  return items.join('') || '<span class="muted">No roles configured.</span>';
}
const personName = p => p?.display || '(unnamed)';
const contactsOf = p => (p?.contacts || []).filter(c => c.kind !== 'name');
const contactKind = kind => (state.contactKinds || []).find(k => k.kind === kind) || {kind, label: kind, hint: ''};
function kindOptions(kind) { return (state.contactKinds || []).filter(k => k.kind !== 'name' && (k.addable || k.kind === kind)).map(k => `<option value="${escapeHTML(k.kind)}" ${k.kind === kind ? 'selected' : ''}>${escapeHTML(k.label)}</option>`).join(''); }
function personOptions(exclude) { return state.people.filter(p => p.id !== exclude).map(p => `<option value="${escapeHTML(p.id)}">${escapeHTML(personName(p))}</option>`).join(''); }
function filteredPeople() {
  const term = state.search.trim().toLowerCase();
  return state.people.filter(p => [p.display, p.role, ...(p.effective_scopes || []), ...(p.scopes || []), ...(p.contacts || []).flatMap(c => [c.value, c.raw_value])].some(v => String(v || '').toLowerCase().includes(term)));
}
function renderPeople() {
  state.people.sort((a,b) => personName(a).localeCompare(personName(b)));
  if (state.selectedPerson && !state.people.some(p => p.id === state.selectedPerson) && !state.personDirty) state.selectedPerson = null;
  const people = filteredPeople();
  $('#people-count').textContent = `${people.length}/${state.people.length}`;
  $('#people-list').innerHTML = people.length ? people.map(p => `<button type="button" class="person-row${p.id === state.selectedPerson ? ' is-selected' : ''}" role="option" aria-selected="${p.id === state.selectedPerson}" data-person-key="${escapeHTML(p.id)}"><span class="person-name">${escapeHTML(personName(p))}</span><span class="person-role">${escapeHTML(p.role || 'No roles')}</span><span class="person-impact">${contactsOf(p).length} contact${contactsOf(p).length === 1 ? '' : 's'}</span></button>`).join('') : `<div class="empty-state">${state.people.length ? 'No people match this search.' : 'No people yet'}</div>`;
  const selected = state.people.find(p => p.id === state.selectedPerson);
  const unassigned = state.unassigned.filter(c => c.kind !== 'name');
  $('#unassigned-count').textContent = unassigned.length;
  $('#switch-unassigned-count').textContent = unassigned.length;
  $('#unassigned-list').innerHTML = unassigned.filter(c => !state.search || `${c.value} ${c.raw_value || ''} ${contactKind(c.kind).label}`.toLowerCase().includes(state.search.toLowerCase())).map(c => `<div class="unassigned-row" data-contact-id="${escapeHTML(c.id)}"><strong>${escapeHTML(c.raw_value || c.value)}</strong><span class="muted">${escapeHTML(contactKind(c.kind).label)} · ${escapeHTML(c.source || 'unknown source')} · ${escapeHTML(formatTime(c.last_seen))}</span><div class="unassigned-actions"><button type="button" class="button button-quiet" data-assign ${selected ? '' : 'disabled'}>Assign to ${escapeHTML(selected ? personName(selected) : 'selected person')}</button><button type="button" class="button button-quiet" data-new-contact-person>New person</button><button type="button" class="button button-quiet" data-delete-unassigned>Delete</button></div></div>`).join('') || '<p class="muted">No unassigned contacts.</p>';
  $(`[data-person-key="${CSS.escape(state.selectedPerson || '')}"]`)?.scrollIntoView({block:'nearest'});
}
function renderPersonEditor() {
  const p = state.people.find(p => p.id === state.selectedPerson);
  state.editorPerson = p ? structuredClone(p) : null;
  state.personDirty = false;
  if (!p) { $('#person-editor').innerHTML = '<div class="empty-state">Select a person</div>'; return; }
  const contacts = contactsOf(p);
  $('#person-editor').innerHTML = `<h3>Person</h3><p id="person-external-change" hidden>Changed elsewhere, <button type="button" class="button button-quiet" data-reload-person>reload</button></p>
    <form id="person-form"><label class="field">Name<input name="display" value="${escapeHTML(p.display || '')}"></label><fieldset class="person-role-group"><legend>Roles</legend><div class="person-role-choices">${rolePicker(p, 'role')}</div></fieldset><label class="field">Note<textarea name="note" rows="3">${escapeHTML(p.note || '')}</textarea></label><div class="person-save-actions"><button class="button button-primary" type="submit" disabled>Save</button><span id="person-dirty-label" hidden>Unsaved changes</span><button class="button button-quiet" type="button" data-discard-person disabled>Discard</button></div></form>
    <h3>Contacts</h3><div id="person-contacts">${contacts.length ? contacts.map(c => `<div class="person-contact" data-contact-id="${escapeHTML(c.id)}"><select aria-label="Contact type" data-contact-kind>${kindOptions(c.kind)}</select><input aria-label="Contact value" data-contact-value value="${escapeHTML(c.raw_value || c.value)}" placeholder="${escapeHTML(contactKind(c.kind).hint)}"><button class="button button-quiet" type="button" data-remove-contact>Remove</button><div class="contact-status" role="status"></div></div>`).join('') : '<p class="muted">No contacts. Add one below or assign one from the unassigned list.</p>'}</div>
    <form id="contact-add-form" class="person-contact"><select aria-label="New contact type" name="kind">${kindOptions()}</select><input name="value" aria-label="New contact value" required placeholder="${escapeHTML((state.contactKinds || []).find(k => k.addable)?.hint || '')}"><button class="button button-quiet" type="submit">Add</button><div class="contact-status" role="status"></div></form>
    <div class="person-access"><h3>Can act without asking</h3>${p.commander ? '<p class="person-commander-note">Everything, on verified channels only.</p>' : ((p.effective_scopes || []).length ? `<ul>${p.effective_scopes.map(s => `<li class="scope-name">${escapeHTML(s)}</li>`).join('')}</ul>` : '<p class="muted">No scopes granted.</p>')}${(!p.commander && p.scopes?.length) ? `<p class="muted">plus ${p.scopes.length} direct grants</p>` : ''}<a href="/console/roles" data-route="roles">Edit roles</a></div>
    ${p.commander ? '<p class="person-commander-note">This person cannot be deleted or merged into another person here.</p>' : `<details class="person-advanced"><summary>Move or merge</summary><form id="contact-move-form"><label class="field">Contact<select name="contact_id" required><option value="">Choose contact</option>${contacts.map(c => `<option value="${escapeHTML(c.id)}">${escapeHTML(contactKind(c.kind).label + ' ' + (c.raw_value || c.value))}</option>`).join('')}</select></label><label class="field">To person (or Unassigned)<select name="person_id"><option value="">Unassigned</option>${personOptions(p.id)}</select></label><button class="button button-quiet" type="submit">Move</button></form><form id="person-merge-form"><label class="field">This is the same person as<select name="keep_id" required><option value="">Choose person</option>${personOptions(p.id)}</select></label><p class="muted">Their contacts move to that person. Roles and note are not combined.</p><button class="button button-quiet" type="submit">Merge into them</button></form></details><button class="button button-danger" type="button" data-delete-person>Delete person</button>`}`;
}
function submittedRoles(data, p) {
  // The locked role's checkbox is disabled when it is checked (the commander
  // person), so the browser never includes it in FormData -- add it back so
  // dirty-checking and saving never mistake "the browser didn't submit it"
  // for "the person asked to remove it".
  const roles = data.getAll('role');
  const lockedRole = (state.roles.find(role => role.locked) || {}).name;
  if (p?.commander && lockedRole && !roles.includes(lockedRole)) roles.push(lockedRole);
  return roles;
}
function markPersonDirty() {
  const form = $('#person-form'); if (!form || !state.editorPerson) return;
  const data = new FormData(form), p = state.editorPerson;
  state.personDirty = data.get('display') !== (p.display || '') || data.get('note') !== (p.note || '') || submittedRoles(data, p).sort().join(',') !== heldRoles(p.role).sort().join(',');
  $('button[type="submit"]',form).disabled = !state.personDirty;
  $('[data-discard-person]',form).disabled = !state.personDirty;
  $('#person-dirty-label').hidden = !state.personDirty;
}
async function refreshPeople({throwOnError = false, external = false, localContacts = false} = {}) {
  try {
    const [directory,roles] = await Promise.all([api('/people/directory'),api('/roles')]);
    state.people = directory.people || []; state.unassigned = directory.unlinked || []; state.contactKinds = directory.contact_kinds || []; state.roles = roles;
    state.loaded.people = true; state.invalidated.people = false; renderPeople();
    if (state.personDirty) {
      if (localContacts) {
        const oldForm = $('#person-form'), draft = new FormData(oldForm), changed = !$('#person-external-change').hidden;
        renderPersonEditor();
        $('#person-form input[name="display"]').value = draft.get('display');
        $('#person-form textarea[name="note"]').value = draft.get('note');
        $$('#person-form input[name="role"]').forEach(b => {if (!b.disabled) b.checked = draft.getAll('role').includes(b.value);});
        markPersonDirty(); $('#person-external-change').hidden = !changed;
      } else if (external) $('#person-external-change').hidden = false;
    }
    else renderPersonEditor();
  } catch(error) { if(throwOnError) throw error; showNotice(`People not refreshed: ${error.message}`, 'error'); }
}
// Register expected events before the POST: the stream can beat the response.
async function peoplePost(path, body, matches) {
  const token = {matches, expires: Date.now()+10000}; state.ownEvents.push(token);
  try { const result = await post(path,body); if(result?.conflict) throw new ApiError('Contact conflict',409,result); state.invalidated.home = true; state.invalidated.roles = true; return result; }
  catch(error) { state.ownEvents = state.ownEvents.filter(t => t !== token); throw error; }
}
function handlePeopleEvent(event) {
  let payload; try { payload = JSON.parse(event.data); } catch { payload = {}; }
  state.ownEvents = state.ownEvents.filter(t => t.expires > Date.now());
  const index = state.ownEvents.findIndex(t => t.matches(payload));
  if(index >= 0) { state.ownEvents.splice(index,1); invalidateView('roles',refreshRoles); invalidateHome(); return; }
  state.invalidated.people = true;
  if(state.activeView === 'people') refreshPeople({external:true});
  invalidateView('roles',refreshRoles); invalidateHome();
}
async function savePerson(form) {
  if(!state.personDirty || form.dataset.saving) return;
  const id = state.selectedPerson, data = new FormData(form);
  const body = {id,display:data.get('display'),role:submittedRoles(data, state.editorPerson).join(', '),note:data.get('note'),scopes:state.people.find(p => p.id === id)?.scopes || state.editorPerson.scopes || []};
  form.dataset.saving = '1'; setFormBusy($('#person-editor'),true);
  try {
    const result = await peoplePost('/people/update',body,e => e.id === id && e.action === 'updated');
    const person = result.person || result;
    state.people = state.people.map(p => p.id === person.id ? person : p);
    renderPeople();
    if(state.selectedPerson === id) { state.personDirty = false; renderPersonEditor(); }
    state.invalidated.roles = true; showNotice('Saved.');
  } catch(error) { if(state.selectedPerson === id) { setFormBusy($('#person-editor'),false); markPersonDirty(); } showNotice(`Person not saved: ${error.message}`,'error'); }
  finally { delete form.dataset.saving; }
}
async function createPerson(display = '') {
  const p = await peoplePost('/people/create',{display},e => e.kind === 'person' && e.action === 'created');
  state.personDirty = false; state.selectedPerson = (p.person || p).id; await refreshPeople(); $('#person-form input')?.focus(); return state.selectedPerson;
}
async function immediatePeople(path,body,match) {
  const result = await peoplePost(path,body,match); await refreshPeople({localContacts:true}); state.invalidated.roles = true; return result;
}
function showContactClash(host,error) {
  const payload = error.payload || {};
  if(error.status !== 409 || !payload.conflict) { showNotice(error.message,'error'); return; }
  const contact = payload.contact || state.people.flatMap(p => p.contacts || []).find(c => c.value === $('[data-contact-value],input[name="value"]',host)?.value);
  const status = $('.contact-status',host);
  const owner = !payload.existing_person_id ? 'Unassigned' : payload.existing_person_display && payload.existing_person_display !== payload.existing_person_id ? payload.existing_person_display : personName(state.people.find(p => p.id === payload.existing_person_id));
  status.innerHTML = `Already belongs to ${escapeHTML(owner)} <button type="button" class="button button-quiet" data-clash-move="${escapeHTML(contact?.id || '')}">Move it here</button>`;
}
async function updateContact(row) {
  const personId = state.selectedPerson;
  const id = row.dataset.contactId, c = contactsOf(state.editorPerson).find(c => c.id === id); if(!c || row.dataset.saving) return;
  const kind = $('[data-contact-kind]',row).value, value = $('[data-contact-value]',row).value;
  if(kind === c.kind && value === (c.raw_value || c.value)) return;
  const attempt = JSON.stringify([kind,value]);
  if(row.dataset.lastAttempt === attempt) return;
  row.dataset.lastAttempt = attempt; row.dataset.saving = '1';
  try {
    const result = await peoplePost('/people/contact/update',{contact_id:id,...(kind !== c.kind ? {kind} : {}),value},e => e.contact_id === id && e.action === 'updated');
    const updated = result.contact;
    if(state.editorPerson?.id === personId) state.editorPerson.contacts = state.editorPerson.contacts.map(c => c.id === id ? updated : c);
    const p = state.people.find(p => p.id === personId);
    if(p) p.contacts = p.contacts.map(c => c.id === id ? updated : c);
    $('[data-contact-value]',row).value = updated.raw_value || updated.value;
    $('.contact-status',row).textContent = 'Saved'; setTimeout(() => { if(row.isConnected) $('.contact-status',row).textContent = ''; },2000); renderPeople();
  } catch(error) { showContactClash(row,error); }
  finally { delete row.dataset.saving; }
}
async function syncPeopleFromInkbox() {
  try { await post('/people/sync',{}); await refreshPeople({external:true}); invalidateHome(); showNotice('Refreshed from Inkbox.'); } catch(error) { showNotice(error.message,'error'); }
}


// -- Scopes page: every scope, grouped by system, read-only -------------------

async function refreshScopesBreakdown({ throwOnError = false } = {}) {
  try {
    state.scopesBreakdown = await api('/scopes/breakdown');
    state.loaded.scopes = true;
    state.invalidated.scopes = false;
    renderScopesBreakdown();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Scopes not refreshed: ${error.message}`, 'error');
  }
}

function treeNode(labelHTML, children = [], { collapsed = false, cls = '', title = '' } = {}) {
  const kids = children.filter(Boolean);
  return `<div class="h-node ${cls}${kids.length ? ' has-children' : ''}${collapsed && kids.length ? ' is-collapsed' : ''}">
    <${kids.length ? 'button type="button" data-tree-toggle' : 'div'} class="h-label"${title ? ` title="${escapeHTML(title)}"` : ''}>${labelHTML}</${kids.length ? 'button' : 'div'}>
    ${kids.length ? `<div class="h-children">${kids.join('')}</div>` : ''}
  </div>`;
}

function scopeTreeNode(scope) {
  if (!scope) return '';
  const tools = scope.tools || [];
  const roles = scope.roles || [];
  const label = `<span class="scope-name">${escapeHTML(scope.name)}</span>
    <span class="scope-detail-kind is-${escapeHTML(scope.kind)}">${escapeHTML(scope.read ? 'read' : scope.kind)}</span>
    <span class="h-count">${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}</span>
    ${roles.length ? `<span class="h-roles">${escapeHTML(roles.join(', '))}</span>` : ''}`;
  return treeNode(label, tools.map(tool => treeNode(escapeHTML(String(tool).split('__').slice(2).join('__') || tool), [], { cls: 'h-tool' })),
    { collapsed: true, cls: 'h-scope', title: scope.description || scope.purpose || '' });
}

function renderScopesBreakdown() {
  const host = $('#scopes-breakdown');
  host.setAttribute('aria-busy', 'false');
  if (!host.dataset.treeBound) {
    host.dataset.treeBound = '1';
    host.addEventListener('click', event => {
      const toggle = event.target.closest('[data-tree-toggle]');
      if (toggle) toggle.parentElement.classList.toggle('is-collapsed');
    });
  }
  const groups = state.scopesBreakdown || [];
  if (!groups.length) { host.innerHTML = '<div class="empty-state">No scopes in the registry.</div>'; return; }
  const systems = groups.map(group => {
    const byName = Object.fromEntries((group.scopes || []).map(scope => [scope.name, scope]));
    const always = (group.always || []).filter(name => byName[name]);
    const leaves = group.leaves || [];
    const placed = new Set([...always, ...leaves.flatMap(leaf => leaf.grants || [])]);
    const rest = (group.scopes || []).filter(scope => !placed.has(scope.name));
    const branches = [
      always.length ? treeNode('<span class="h-always">always</span>', always.map(name => scopeTreeNode(byName[name])), { cls: 'h-branch', title: 'Granted whenever this system is picked' }) : '',
      ...leaves.map(leaf => treeNode(escapeHTML(leaf.question || leaf.name), (leaf.grants || []).map(name => scopeTreeNode(byName[name])), { cls: 'h-branch' })),
      rest.length ? treeNode('not on a branch', rest.map(scopeTreeNode), { cls: 'h-branch' }) : '',
    ];
    return treeNode(escapeHTML(group.system), branches, { cls: 'h-system', title: group.description || '' });
  });
  host.innerHTML = `<div class="h-tree">${treeNode('Blatbot', systems, { cls: 'h-rootnode' })}</div>`;
}

function scopeList(scopes = []) {
  return scopes.length
    ? `<ul class="scope-kind-list">${scopes.map(s => `<li><span class="scope-name">${escapeHTML(s.name)}</span><span class="scope-purpose">${escapeHTML(s.purpose || '')}</span></li>`).join('')}</ul>`
    : '<p class="muted">None</p>';
}

function renderRolesPage() {
  $('#roles-count').textContent = `${state.roles.length} configured`;
  // The locked (built-in) role, if present, is shown first -- it is a fixed
  // fact about the system, not something this list can rearrange or edit.
  const ordered = [...state.roles].sort((a, b) => (b.locked ? 1 : 0) - (a.locked ? 1 : 0));
  $('#roles-list').innerHTML = ordered.length ? ordered.map(role => role.locked ? `<div class="role-card role-card-locked" data-role-name="${escapeHTML(role.name)}">
    <div class="role-card-head">
      <div><span class="role-name">${escapeHTML(role.name)}</span><div class="muted">${escapeHTML(role.note || 'No note')}</div></div>
      <div class="role-card-actions"><span class="role-locked-badge">Built in</span></div>
    </div>
    <p class="role-locked-description">${escapeHTML(role.description || 'Everything, on verified channels only.')}</p>
    <div class="role-members">
      <h4>Members (${role.members.length})</h4>
      <ul class="member-list">${role.members.length ? role.members.map(m => `<li><span class="person-name">${escapeHTML(m.person)}</span><span class="person-key">${escapeHTML(m.key)}</span></li>`).join('') : '<li class="muted">No members</li>'}</ul>
    </div>
  </div>` : `<div class="role-card" data-role-name="${escapeHTML(role.name)}">
    <div class="role-card-head">
      <div><span class="role-name">${escapeHTML(role.name)}</span><div class="muted">${escapeHTML(role.note || 'No note')}</div></div>
      <div class="role-card-actions">
        <button class="button button-quiet" type="button" data-edit-role>Edit</button>
        <button class="button button-danger" type="button" data-delete-role>Delete</button>
      </div>
    </div>
    ${role.warning ? `<p class="role-warning">${escapeHTML(role.warning)}</p>` : ''}
    <div class="role-scope-columns">
      <div><h4>Read</h4>${scopeList(role.read_scopes)}</div>
      <div><h4>Write${(role.write_scopes || []).length ? '<span class="write-mark">includes write access</span>' : ''}</h4>${scopeList(role.write_scopes)}</div>
    </div>
    <div class="role-members">
      <h4>Members (${role.members.length})</h4>
      <ul class="member-list">${role.members.length ? role.members.map(m => `<li><span class="person-name">${escapeHTML(m.person)}</span><span class="person-key">${escapeHTML(m.key)}</span><button class="button button-quiet" type="button" data-remove-member="${escapeHTML(m.key)}">Remove</button></li>`).join('') : '<li class="muted">No members</li>'}</ul>
      <form class="add-member-form" data-add-member autocomplete="off">
        <input name="key" class="mono" placeholder="Search people, or type a handle" data-member-input required>
        <div class="add-member-suggestions" data-member-suggestions></div>
        <button class="button button-quiet" type="submit">Add member</button>
      </form>
    </div>
  </div>`).join('') : '<div class="empty-state">No roles configured. People default to no permissions.</div>';
}

function openRoleEditor(role = { name: '', note: '', scopes: [], __new: true }) {
  const host = role.__new ? document.createElement('div') : $(`[data-role-name="${CSS.escape(role.name)}"]`);
  if (role.__new) { host.className = 'role-card'; $('#roles-list').prepend(host); }
  const selected = new Set(role.scopes || []);
  host.innerHTML = `<form class="role-editor" data-original-name="${escapeHTML(role.__new ? '' : role.name)}">
    <div class="editor-grid">
      <label class="field">Role name<input name="name" required value="${escapeHTML(role.name)}" ></label>
      <label class="field">Note<textarea name="note" placeholder="Who this role is for">${escapeHTML(role.note || '')}</textarea></label>
    </div>
    <div class="scope-groups">${renderScopeGroups(selected)}</div>
    <div class="editor-actions">
      ${role.__new ? '<span></span>' : '<button class="button button-danger" type="button" data-delete-role>Delete role</button>'}
      <div class="save-actions"><button class="button button-quiet" type="button" data-cancel-role>Cancel</button><button class="button button-primary" type="submit">Save role</button></div>
    </div>
  </form>`;
  $('input', host)?.focus();
}

async function saveRole(form) {
  const data = new FormData(form);
  const body = { name: data.get('name').trim(), scopes: data.getAll('scopes'), note: data.get('note').trim() };
  if (!body.name) return showNotice('A role name is required.', 'error');
  setFormBusy(form, true);
  try {
    const original = form.dataset.originalName;
    if (original && original !== body.name) await post('/roles/rename', { name: original, new_name: body.name });
    await post('/roles', body);
    await refreshRoles();
    showNotice(`Saved ${body.name}. Everyone with this role is now updated.`);
  } catch (error) { showNotice(`Role not saved: ${error.message}`, 'error'); setFormBusy(form, false); }
}

async function deleteRole(name) {
  const role = state.roles.find(item => item.name === name);
  const impact = role?.people_count ? ` ${role.people_count} ${role.people_count === 1 ? 'person' : 'people'} will lose its inherited scopes.` : '';
  if (!window.confirm(`Delete role ${name}?${impact}`)) return;
  try {
    await post('/roles/delete', { name });
    await refreshRoles();
    showNotice(`Deleted role ${name}.`);
  } catch (error) { showNotice(`Role not deleted: ${error.message}`, 'error'); }
}

async function addRoleMember(name, key) {
  try {
    await post('/roles/members/add', { name, key });
    await refreshRoles();
    showNotice(`Added ${key} to ${name}.`);
  } catch (error) { showNotice(`Could not add member: ${error.message}`, 'error'); }
}

async function removeRoleMember(name, key) {
  if (!window.confirm(`Remove ${key} from ${name}?`)) return;
  try {
    await post('/roles/members/remove', { name, key });
    await refreshRoles();
    showNotice(`Removed ${key} from ${name}.`);
  } catch (error) { showNotice(`Could not remove member: ${error.message}`, 'error'); }
}

function setFormBusy(form, busy) {
  $$('button, input, select, textarea', form).forEach(control => { control.disabled = busy; });
}

function renderTasks() {
  $('#tasks-list').setAttribute('aria-busy', 'false');
  $('#tasks-list').innerHTML = state.tasks.length ? state.tasks.map(task => `<button class="task-row" type="button" data-task-id="${escapeHTML(task.id)}">
    <span class="mono">${escapeHTML(task.id)}</span>
    <span class="summary">${escapeHTML(task.title || 'Untitled task')}</span>
    <span class="state state-${escapeHTML(task.state)}">${escapeHTML(task.state)}</span>
    <time datetime="${escapeHTML(task.updated_at || '')}">${escapeHTML(formatTime(task.updated_at))}</time>
    <span class="participant-list">${escapeHTML((task.participants || []).map(person =>
      typeof person === 'string' ? person : (person.display || person.key || '')).filter(Boolean).join(', '))}</span>
  </button>`).join('') : '<div class="empty-state">No recent tasks.</div>';
}

// A task's ledger is the list of events the API returns for it, oldest first. Each one
// is shown whole: when it happened, what kind of event it was, and its full text.
function renderLedger(task) {
  const events = Array.isArray(task.events) ? task.events : [];
  const host = $('#ledger-content');
  if (!events.length) { host.textContent = 'No ledger entries recorded.'; return; }
  host.innerHTML = events.map(event => {
    const when = event.created_at ? new Date(event.created_at * 1000).toISOString() : '';
    return `<article class="ledger-entry">
      <header class="ledger-meta">
        <span class="ledger-kind ledger-kind-${escapeHTML(event.kind || 'note')}">${escapeHTML(event.kind || 'note')}</span>
        <time datetime="${escapeHTML(when)}">${escapeHTML(formatTime(event.created_at))}</time>
        ${event.request_id ? `<span class="mono">request #${escapeHTML(event.request_id)}</span>` : ''}
      </header>
      <div class="ledger-text">${escapeHTML(event.text || '')}</div>
    </article>`;
  }).join('');
}

async function openTask(taskId) {
  const dialog = $('#task-dialog');
  $('#ledger-id').textContent = taskId;
  if (!dialog.open) dialog.showModal();
  const cached = state.taskLedgers.get(taskId);
  if (cached) {
    $('#ledger-title').textContent = cached.title || 'Task ledger';
    renderLedger(cached);
    return;
  }
  $('#ledger-title').textContent = 'Loading ledger…';
  $('#ledger-content').textContent = '';
  try {
    const task = await api(`/tasks/${encodeURIComponent(taskId)}`);
    state.taskLedgers.set(taskId, task);
    $('#ledger-title').textContent = task.title || 'Task ledger';
    renderLedger(task);
  } catch (error) {
    $('#ledger-title').textContent = 'Ledger unavailable';
    $('#ledger-content').textContent = error.message;
  }
}

function renderHealth() {
  $('#health-content').setAttribute('aria-busy', 'false');
  if (!state.health) return;
  // The API names these interrupted_runs / recent_errors / uptime_seconds, and reports the
  // tunnel as an object. Reading the wrong names is why this panel said [object Object].
  const interruptedRaw = state.health.interrupted ?? state.health.interrupted_runs ?? [];
  const interrupted = Array.isArray(interruptedRaw) ? interruptedRaw : [];
  const interruptedCount = Array.isArray(interruptedRaw) ? interruptedRaw.length : Number(interruptedRaw) || 0;
  const errors = state.health.errors || state.health.recent_errors || [];
  const tunnel = state.health.tunnel;
  const tunnelUp = tunnel === 'up' || tunnel === true || (tunnel && tunnel.connected === true);
  const tunnelWhere = tunnel && typeof tunnel === 'object' ? (tunnel.url || tunnel.mode || '') : '';
  $('#health-content').innerHTML = `<dl class="health-grid">
    <div class="health-stat"><dt>Tunnel</dt><dd class="state-${tunnelUp ? 'done' : 'failed'}">${tunnelUp ? 'up' : 'down'}${tunnelWhere ? `<span class="muted"> ${escapeHTML(tunnelWhere)}</span>` : ''}</dd></div>
    <div class="health-stat"><dt>Uptime</dt><dd>${escapeHTML(formatDuration(state.health.uptime_s ?? state.health.uptime_seconds))}</dd></div>
    <div class="health-stat"><dt>Last restart</dt><dd>${escapeHTML(formatTime(state.health.last_restart))}</dd></div>
  </dl>
  <div class="health-columns">
    <div><h3>Interrupted runs (${interruptedCount})</h3><ul class="health-list">${interrupted.length ? interrupted.map(item => `<li>${escapeHTML(typeof item === 'string' ? item : JSON.stringify(item))}</li>`).join('') : `<li>${interruptedCount ? `${interruptedCount === 1 ? '1 run was' : `${interruptedCount} runs were`} cut off by a restart.` : 'None'}</li>`}</ul></div>
    <div><h3>Recent errors (${errors.length})</h3><ul class="health-list">${errors.length ? errors.map(item => `<li>${escapeHTML(typeof item === 'string' ? item : JSON.stringify(item))}</li>`).join('') : '<li>None</li>'}</ul></div>
  </div>`;
}

async function refreshHealth({ throwOnError = false } = {}) {
  try {
    state.health = await api('/health');
    state.loaded.health = true; state.invalidated.health = false;
    renderHealth();
  }
  catch (error) {
    if (throwOnError) throw error;
    showNotice(`Health not refreshed: ${error.message}`, 'error');
  }
}

async function refreshTasks({ throwOnError = false } = {}) {
  try {
    state.tasks = await api('/tasks');
    state.loaded.tasks = true; state.invalidated.tasks = false;
    renderTasks();
  }
  catch (error) {
    if (throwOnError) throw error;
    showNotice(`Tasks not refreshed: ${error.message}`, 'error');
  }
}

// ---- Schedules (second version) -------------------------------------------------
// Every label, option list, state name and time string on this page comes from the
// console API (cadence_text, state_label, outcome_label, next_run_text, ...). The
// only strings owned by this file are interface chrome: button captions, headings,
// and the empty-state message.

const ACTION_LABELS = {
  pause: 'Pause', resume: 'Resume', run_now: 'Run now', stop: 'Stop',
  edit: 'Edit', approve: 'Approve', reject: 'Reject', start_again: 'Start again',
};

state.scheduleErrors = new Map();   // schedule id -> inline 409 message
state.scheduleHistory = new Map();  // schedule id -> loaded run history payload
state.scheduleKinds = [];
state.reportOptions = [];
state.capabilityOptions = [];
state.weekdayOptions = [];

function stateClassForSchedule(schedule) {
  if (schedule.needs_approval) return 'pending';
  if (schedule.state === 'active') return 'running';
  if (schedule.state === 'ended') return 'failed';
  if (schedule.state === 'proposed') return 'pending';
  return 'done'; // paused, or anything else: a quiet, non-alarming state
}

function relativeFromSeconds(seconds) {
  if (seconds == null) return '';
  const past = seconds < 0;
  let remaining = Math.round(Math.abs(seconds));
  const hours = Math.floor(remaining / 3600); remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const parts = [hours && `${hours} h`, (minutes || !hours) && `${minutes} m`].filter(Boolean);
  return `${past ? 'overdue by ' : 'in '}${parts.join(' ')}`;
}

function scheduleLastRunBlock(schedule) {
  const run = schedule.last_run;
  if (!run) return '<p class="schedule-last-run muted">No runs yet.</p>';
  const refused = (run.denied || []).map(d => escapeHTML(d.label)).join(', ');
  return `<div class="schedule-last-run">
    <dt>Last run</dt>
    <dd>${escapeHTML(run.started_text)} &middot; ${escapeHTML(run.outcome_label)}${run.result_line ? ` &middot; ${escapeHTML(run.result_line)}` : ''}
      ${run.outcome !== 'complete' && refused ? `<div class="schedule-refused">Refused: ${refused}</div>` : ''}
    </dd>
  </div>`;
}

function scheduleMissingBlock(schedule) {
  const missing = schedule.missing_capabilities || [];
  if (!missing.length) return '';
  const labels = missing.map(m => escapeHTML(m.label)).join(', ');
  return `<p class="schedule-missing">It is not allowed to ${labels}.
    <button class="button button-quiet" type="button" data-schedule-let-it>Let it ${labels}</button>
  </p>`;
}

function scheduleApprovalBlock(schedule) {
  if (!schedule.needs_approval) return '';
  return '<p class="schedule-approval">Needs your yes.</p>';
}

function scheduleActionButtons(schedule) {
  return (schedule.actions || []).map(action => {
    const danger = action === 'stop' || action === 'reject';
    return `<button class="button ${danger ? 'button-danger' : 'button-quiet'}" type="button" data-schedule-action="${escapeHTML(action)}">${escapeHTML(ACTION_LABELS[action] || action)}</button>`;
  }).join('');
}

function scheduleCapabilitiesBlock(schedule) {
  const labels = (schedule.capabilities || []).map(c => c.label);
  return scopeChips(labels);
}

function scheduleHistoryBlock(schedule) {
  const loaded = state.scheduleHistory.get(schedule.id);
  if (!loaded) return '<div class="schedule-history-body" aria-busy="true">Loading…</div>';
  if (!loaded.length) return '<div class="schedule-history-body"><p class="empty-state">No runs yet.</p></div>';
  return `<div class="schedule-history-body">
    <table class="schedule-history-table">
      <thead><tr><th>Time</th><th>Duration</th><th>Outcome</th><th>Result</th><th>Refused</th><th>Cost</th></tr></thead>
      <tbody>${loaded.map(run => {
        const refused = (run.denied || []).map(d => escapeHTML(d.label)).join(', ');
        const cost = run.cost_usd == null ? '' : `$${Number(run.cost_usd).toFixed(2)}`;
        return `<tr class="schedule-run-row" data-run-id="${escapeHTML(run.id)}" tabindex="0">
          <td>${escapeHTML(run.started_text)}</td>
          <td>${escapeHTML(formatDuration(run.duration_seconds))}</td>
          <td>${escapeHTML(run.outcome_label)}</td>
          <td>${escapeHTML(run.result_line)}</td>
          <td>${refused}</td>
          <td>${escapeHTML(cost)}</td>
        </tr>
        <tr class="schedule-run-detail" data-run-detail="${escapeHTML(run.id)}" hidden><td colspan="6"><pre class="schedule-run-full"></pre></td></tr>`;
      }).join('')}</tbody>
    </table>
  </div>`;
}

function renderSchedules() {
  const host = $('#schedules-list');
  host.setAttribute('aria-busy', 'false');
  host.innerHTML = state.schedules.length ? state.schedules.map(schedule => `<article class="schedule-card" data-schedule-id="${escapeHTML(schedule.id)}">
    <div class="schedule-head">
      <div><h3>${escapeHTML(schedule.title)}</h3></div>
      <span class="state state-${stateClassForSchedule(schedule)}">${escapeHTML(schedule.state_label)}</span>
    </div>
    <p class="schedule-cadence">${escapeHTML(schedule.cadence_text)}${schedule.next_run_text ? ` &middot; <span data-next-run-text>${escapeHTML(schedule.next_run_text)}</span> <span class="muted" data-next-run-rel="${escapeHTML(schedule.next_run_in_seconds ?? '')}" data-next-run-fetched="${Date.now()}"></span>` : ''}</p>
    ${scheduleLastRunBlock(schedule)}
    ${scheduleMissingBlock(schedule)}
    ${scheduleApprovalBlock(schedule)}
    <div class="scope-row">${scheduleCapabilitiesBlock(schedule)}</div>
    <div class="schedule-actions">${scheduleActionButtons(schedule)}</div>
    ${state.scheduleErrors.has(schedule.id) ? `<p class="schedule-inline-error">${escapeHTML(state.scheduleErrors.get(schedule.id))}</p>` : ''}
    <details class="schedule-history" data-schedule-history="${escapeHTML(schedule.id)}">
      <summary>Run history</summary>
      ${scheduleHistoryBlock(schedule)}
    </details>
  </article>`).join('') : '<div class="empty-state">No schedules.</div>';
  tickScheduleClocks();
}

// Updates only the relative "in 3 h 20 m" text on a timer, without re-rendering the
// whole list (which would collapse any open run-history <details>).
function tickScheduleClocks() {
  $$('[data-next-run-rel]').forEach(node => {
    const base = Number(node.dataset.nextRunRel);
    const fetchedAt = Number(node.dataset.nextRunFetched);
    if (!Number.isFinite(base) || !Number.isFinite(fetchedAt)) { node.textContent = ''; return; }
    const elapsed = (Date.now() - fetchedAt) / 1000;
    node.textContent = `(${relativeFromSeconds(base - elapsed)})`;
  });
}
setInterval(tickScheduleClocks, 30000);

async function refreshSchedules({ throwOnError = false } = {}) {
  try {
    const payload = await api('/schedules');
    state.schedules = payload.schedules || [];
    state.scheduleKinds = payload.cadence_kinds || [];
    state.capabilityOptions = payload.capability_options || [];
    state.reportOptions = payload.report_options || [];
    state.weekdayOptions = payload.weekdays || [];
    state.loaded.schedules = true; state.invalidated.schedules = false;
    renderSchedules();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Schedules not refreshed: ${error.message}`, 'error');
  }
}

async function loadScheduleHistory(id) {
  try {
    const payload = await api(`/schedules/${encodeURIComponent(id)}/runs`);
    state.scheduleHistory.set(id, payload.runs || []);
  } catch (error) {
    state.scheduleHistory.set(id, []);
    showNotice(`History not loaded: ${error.message}`, 'error');
  }
  renderSchedules();
  const details = $(`[data-schedule-history="${id}"]`);
  if (details) details.open = true;
}

function cadenceFieldsHTML(kind) {
  if (kind === 'once') return '<label>Date and time<input type="datetime-local" name="cadence_at"></label>';
  if (kind === 'every') return `<label>Every<span class="cadence-every"><input type="number" min="1" name="cadence_every_value" value="1"><select name="cadence_every_unit"><option value="minutes">minutes</option><option value="hours">hours</option></select></span></label>`;
  if (kind === 'daily' || kind === 'weekdays') return '<label>Time<input type="time" name="cadence_time"></label>';
  if (kind === 'weekly') return `<label>Day<select name="cadence_day">${state.weekdayOptions.map(w => `<option value="${escapeHTML(w.value)}">${escapeHTML(w.label)}</option>`).join('')}</select></label><label>Time<input type="time" name="cadence_weekly_time"></label>`;
  if (kind === 'cron') return '<label>Cron<input type="text" name="cadence_expr" placeholder="0 9 * * 1-5"></label>';
  return '';
}

function renderCadenceOptions(selectedKind) {
  const main = state.scheduleKinds.filter(k => k.kind !== 'cron');
  const cron = state.scheduleKinds.find(k => k.kind === 'cron');
  $('#schedule-cadence-options').innerHTML = main.map(k => `<div class="cadence-option">
    <label><input type="radio" name="cadence_kind" value="${escapeHTML(k.kind)}" ${selectedKind === k.kind ? 'checked' : ''}>${escapeHTML(k.label)}</label>
    <div class="cadence-fields" data-cadence-fields="${escapeHTML(k.kind)}" ${selectedKind === k.kind ? '' : 'hidden'}>${cadenceFieldsHTML(k.kind)}</div>
  </div>`).join('');
  $('#schedule-cadence-advanced').innerHTML = cron ? `<div class="cadence-option">
    <label><input type="radio" name="cadence_kind" value="cron" ${selectedKind === 'cron' ? 'checked' : ''}>${escapeHTML(cron.label)}</label>
    <div class="cadence-fields" data-cadence-fields="cron" ${selectedKind === 'cron' ? '' : 'hidden'}>${cadenceFieldsHTML('cron')}</div>
  </div>` : '';
  if (selectedKind === 'cron') $('.cadence-advanced').open = true;
}

function fillCadenceFields(form, kind, cadence = {}) {
  if (!cadence) return;
  if (kind === 'once' && cadence.at) form.cadence_at.value = String(cadence.at).slice(0, 16);
  if (kind === 'every' && cadence.minutes != null) {
    const minutes = Number(cadence.minutes);
    if (minutes % 60 === 0 && minutes >= 60) { form.cadence_every_value.value = minutes / 60; form.cadence_every_unit.value = 'hours'; }
    else { form.cadence_every_value.value = minutes; form.cadence_every_unit.value = 'minutes'; }
  }
  if ((kind === 'daily' || kind === 'weekdays') && cadence.time) form.cadence_time.value = cadence.time;
  if (kind === 'weekly') { if (cadence.day) form.cadence_day.value = cadence.day; if (cadence.time) form.cadence_weekly_time.value = cadence.time; }
  if (kind === 'cron' && cadence.expr) form.cadence_expr.value = cadence.expr;
}

function openScheduleEditor(schedule = null) {
  $('#schedule-dialog-title').textContent = schedule ? `Edit ${schedule.title}` : 'New schedule';
  $('#schedule-id').value = schedule?.id || '';
  $('#schedule-title').value = schedule?.title || '';
  $('#schedule-prompt').value = schedule?.prompt || '';
  renderCadenceOptions(schedule?.cadence_kind || state.scheduleKinds[0]?.kind || 'once');
  const form = $('#schedule-form');
  fillCadenceFields(form, schedule?.cadence_kind, schedule?.cadence);
  $('#schedule-report-options').innerHTML = state.reportOptions.map((opt, index) => `<label class="radio-option"><input type="radio" name="report_every_time" value="${escapeHTML(opt.value)}" ${(schedule ? String(schedule.report_every_time) === String(opt.value) : index === 0) ? 'checked' : ''}>${escapeHTML(opt.label)}</label>`).join('');
  $('#schedule-until').value = schedule?.until ? new Date(Number(schedule.until) * 1000).toISOString().slice(0, 10) : '';
  const selected = new Set((schedule?.capabilities || []).map(c => c.scope));
  $('#schedule-scopes').innerHTML = state.capabilityOptions.map(opt => `<label class="scope-option" title="${escapeHTML((opt.tools || []).join(', '))}"><input type="checkbox" name="capabilities" value="${escapeHTML(opt.scope)}" ${selected.has(opt.scope) ? 'checked' : ''}><span class="scope-option-text"><span class="scope-name">${escapeHTML(opt.label)}</span></span></label>`).join('');
  $('#schedule-dialog').showModal();
}

function cadencePayload(form) {
  const kind = form.cadence_kind.value;
  if (kind === 'once') return { at: form.cadence_at.value ? new Date(form.cadence_at.value).toISOString() : null };
  if (kind === 'every') {
    let minutes = Number(form.cadence_every_value.value || 0);
    if (form.cadence_every_unit.value === 'hours') minutes *= 60;
    return { minutes };
  }
  if (kind === 'daily' || kind === 'weekdays') return { time: form.cadence_time.value };
  if (kind === 'weekly') return { day: form.cadence_day.value, time: form.cadence_weekly_time.value };
  if (kind === 'cron') return { expr: form.cadence_expr.value };
  return {};
}

async function saveSchedule(form) {
  const data = new FormData(form);
  const cadenceKind = data.get('cadence_kind');
  const reportValue = data.get('report_every_time');
  const payload = {
    title: data.get('title'),
    prompt: data.get('prompt'),
    cadence_kind: cadenceKind,
    cadence: cadencePayload(form),
    report_every_time: reportValue === 'true' ? true : reportValue === 'false' ? false : reportValue,
    until: data.get('until') ? new Date(data.get('until')).toISOString() : null,
    scopes: data.getAll('capabilities'),
  };
  const id = $('#schedule-id').value;
  if (id) payload.id = Number(id);
  setFormBusy(form, true);
  try {
    const result = await post(id ? '/schedules/edit' : '/schedules', payload);
    $('#schedule-dialog').close();
    showNotice(result.message || 'Schedule saved.');
    await refreshSchedules({ throwOnError: false });
  } catch (error) { showNotice(`Schedule not saved: ${error.message}`, 'error'); }
  finally { setFormBusy(form, false); }
}

async function scheduleAction(id, action) {
  state.scheduleErrors.delete(id);
  try {
    if (action === 'approve' || action === 'reject') {
      await post('/schedules/approve', { id: Number(id), approve: action === 'approve' });
    } else {
      await post('/schedules/action', { id: Number(id), action });
    }
    await refreshSchedules({ throwOnError: false });
  } catch (error) {
    if (error.status === 409) {
      state.scheduleErrors.set(id, error.message);
      renderSchedules();
    } else {
      showNotice(`Schedule not changed: ${error.message}`, 'error');
    }
  }
}

async function letItAddCapabilities(id) {
  const schedule = state.schedules.find(s => s.id === id);
  if (!schedule) return;
  const scopes = [...new Set([...(schedule.capabilities || []).map(c => c.scope), ...(schedule.missing_capabilities || []).map(c => c.scope)])];
  try {
    const result = await post('/schedules/edit', { id: Number(id), title: schedule.title, prompt: schedule.prompt, cadence_kind: schedule.cadence_kind, cadence: schedule.cadence, report_every_time: schedule.report_every_time, until: schedule.until || null, scopes });
    showNotice(result.message || 'Updated.');
    await refreshSchedules({ throwOnError: false });
  } catch (error) { showNotice(`Could not change capabilities: ${error.message}`, 'error'); }
}

const settingSaveTimers = new Map();

function isSeriousSetting(setting) {
  const description = `${setting.name} ${setting.label} ${setting.help}`.toLowerCase();
  return setting.kind === 'bool' && setting.group === 'Safety'
    && /outbound|send|message/.test(description) && /preview|review|approval|confirm|before|shown/.test(description);
}

function settingControl(setting) {
  const value = setting.value;
  if (setting.kind === 'bool') {
    return `<label class="setting-toggle"><input type="checkbox" data-setting-control data-setting-kind="bool" ${value ? 'checked' : ''}><span class="toggle-track" aria-hidden="true"><span></span></span><span>${value ? 'On' : 'Off'}</span></label>`;
  }
  if (setting.kind === 'number') {
    const bounds = `${setting.min == null ? '' : ` min="${escapeHTML(setting.min)}"`}${setting.max == null ? '' : ` max="${escapeHTML(setting.max)}"`} step="${escapeHTML(setting.step ?? 1)}"`;
    return `<div class="number-control"><input type="range" data-setting-control data-setting-kind="number"${bounds} value="${escapeHTML(value)}" aria-label="${escapeHTML(setting.label)} slider"><input type="number" data-setting-control data-setting-kind="number"${bounds} value="${escapeHTML(value)}" aria-label="${escapeHTML(setting.label)} value"></div>`;
  }
  if (setting.kind === 'choice') {
    return `<select data-setting-control data-setting-kind="choice" aria-label="${escapeHTML(setting.label)}">${(setting.choices || []).map(choice => `<option value="${escapeHTML(choice)}" ${choice === value ? 'selected' : ''}>${escapeHTML(choice)}</option>`).join('')}</select>`;
  }
  return `<textarea data-setting-control data-setting-kind="text" rows="1" aria-label="${escapeHTML(setting.label)}">${escapeHTML(value ?? '')}</textarea>`;
}

function renderSettings() {
  const host = $('#settings-list');
  host.setAttribute('aria-busy', 'false');
  if (!state.settings.length) {
    host.innerHTML = '<div class="empty-state">No settings are available.</div>';
    return;
  }
  const groups = state.settings.reduce((map, setting) => {
    const group = setting.group || 'Other';
    if (!map.has(group)) map.set(group, []);
    map.get(group).push(setting);
    return map;
  }, new Map());
  host.innerHTML = [...groups.entries()].map(([group, settings], groupIndex) => `<section class="settings-group" aria-labelledby="settings-group-${groupIndex}">
    <h3 id="settings-group-${groupIndex}">${escapeHTML(group)}</h3>
    <div class="settings-panel">${settings.map(setting => {
      const serious = isSeriousSetting(setting);
      const status = state.settingStatus[setting.name];
      return `<div class="setting-row${serious ? ' is-serious' : ''}" data-setting-name="${escapeHTML(setting.name)}">
        <div class="setting-copy">
          <div class="setting-label">${escapeHTML(setting.label)}${serious ? '<span class="serious-mark">Serious</span>' : ''}</div>
          <div class="setting-help">${escapeHTML(setting.help || '')}</div>
          <code class="setting-name">${escapeHTML(setting.name)}</code>
        </div>
        <div class="setting-value">
          ${settingControl(setting)}
          <div class="setting-meta">
            <span class="setting-source source-${escapeHTML(setting.source)}">${escapeHTML(setting.source)}</span>
            ${setting.source === 'console' || setting.value !== setting.default ? '<button class="button button-danger setting-reset" type="button" data-reset-setting>Reset</button>' : ''}
            <span class="setting-save-state${status?.type === 'error' ? ' is-error' : ''}" role="status">${escapeHTML(status?.text || '')}</span>
          </div>
        </div>
      </div>`;
    }).join('')}</div>
  </section>`).join('');
  $$('textarea[data-setting-control]', host).forEach(growSettingTextarea);
}

function growSettingTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

function scheduleSettingSave(setting, value, delay) {
  clearTimeout(settingSaveTimers.get(setting.name));
  state.settingStatus[setting.name] = { type: 'saving', text: 'Saving…' };
  const row = $(`[data-setting-name="${CSS.escape(setting.name)}"]`);
  const status = $('.setting-save-state', row);
  if (status) { status.textContent = 'Saving…'; status.classList.remove('is-error'); }
  settingSaveTimers.set(setting.name, setTimeout(() => saveSetting(setting, value), delay));
}

async function saveSetting(setting, value) {
  clearTimeout(settingSaveTimers.get(setting.name));
  settingSaveTimers.delete(setting.name);
  try {
    const result = await post('/settings', { name: setting.name, value });
    state.settings = result.settings || state.settings;
    state.settingStatus[setting.name] = { type: 'saved', text: 'Saved' };
    renderSettings();
    showNotice(`Saved ${setting.label}.`);
  } catch (error) {
    state.settingStatus[setting.name] = { type: 'error', text: error.message };
    renderSettings();
    showNotice(`${setting.label} not saved: ${error.message}`, 'error', 8000);
  }
}

async function refreshSettings({ throwOnError = false } = {}) {
  try {
    state.settings = await api('/settings');
    state.loaded.settings = true; state.invalidated.settings = false;
    renderSettings();
  }
  catch (error) {
    if (throwOnError) throw error;
    showNotice(`Settings not refreshed: ${error.message}`, 'error');
  }
}

function connectEvents() {
  clearTimeout(state.reconnectTimer);
  state.eventSource?.close();
  setStreamState('connecting');
  const source = new EventSource(CONFIG.eventsUrl);
  state.eventSource = source;
  source.onopen = () => { state.reconnectAttempt = 0; setStreamState('live'); };
  source.addEventListener('ping', () => setStreamState('live'));
  source.addEventListener('request.created', handleRequestEvent);
  source.addEventListener('request.state_changed', handleRequestEvent);
  source.addEventListener('permissions.changed', () => {
    invalidateView('roles', refreshRoles);
    invalidateView('people', () => refreshPeople({external:true}));
    invalidateView('scopes', refreshScopesBreakdown);
    invalidateHome();
  });
  source.addEventListener('people.synced', () => {
    invalidateView('people', () => refreshPeople({external:true}));
    invalidateHome();
  });
  source.addEventListener('people.changed', handlePeopleEvent);
  source.addEventListener('health.changed', () => { invalidateView('health', refreshHealth); invalidateHome(); });
  source.addEventListener('settings.changed', () => invalidateView('settings', refreshSettings));
  source.addEventListener('schedules.changed', () => invalidateHome());
  source.onerror = async () => {
    source.close();
    if (state.eventSource !== source) return;
    setStreamState('offline');
    Object.keys(VIEW_PATHS).forEach(view => { state.invalidated[view] = true; });
    await loadSnapshot({ quiet: true });
    const delay = Math.min(30000, 1000 * (2 ** state.reconnectAttempt++)) + Math.floor(Math.random() * 500);
    state.reconnectTimer = setTimeout(connectEvents, delay);
  };
}

function invalidateView(view, refresh) {
  state.invalidated[view] = true;
  if (state.activeView === view) refresh();
}

function invalidateHome() {
  invalidateView('home', refreshHome);
}

function handleRequestEvent() {
  state.invalidated.requests = true;
  invalidateHome();
  if (state.activeView === 'requests') refreshRequests();
  else refreshWaitingCount().catch(error => showNotice(`Waiting count not refreshed: ${error.message}`, 'error'));
}

function setStreamState(streamState) {
  state.streamState = streamState;
  const dot = $('#stream-dot');
  dot.className = `stream-dot${streamState === 'live' ? ' is-live' : streamState === 'connecting' ? ' is-connecting' : ''}`;
  $('#stream-label').textContent = streamState;
  if (state.activeView === 'home' && state.home) renderHome();
}

function applyRoute({ replaceUnknown = false } = {}) {
  const route = routeFromPath();
  if (route.unknown && replaceUnknown) history.replaceState(null, '', VIEW_PATHS.home);
  state.activeView = route.view;
  state.taskId = route.taskId;
  $$('[data-view]').forEach(section => { section.hidden = section.dataset.view !== route.view; });
  $$('nav [data-route]').forEach(link => {
    if (link.dataset.route === route.view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('#mobile-route').value = VIEW_PATHS[route.view];
  document.title = `${route.view[0].toUpperCase()}${route.view.slice(1)} · Blatbot console`;
  const taskDialog = $('#task-dialog');
  if (!route.taskId && taskDialog.open) taskDialog.close();
  window.scrollTo({ top: 0, behavior: 'auto' });
  loadView(route.view);
}

function navigate(path, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  applyRoute();
}

function moveWaiting(direction) {
  const waiting = pendingRequests();
  if (!waiting.length) return;
  state.selectedWaiting = (state.selectedWaiting + direction + waiting.length) % waiting.length;
  renderRequests();
  const selected = $(`[data-waiting-index="${state.selectedWaiting}"]`);
  selected?.focus({ preventScroll: true });
  selected?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function isTypingTarget(target) {
  return target.matches('input, textarea, select, [contenteditable="true"]');
}

document.addEventListener('click', event => {
  const routeLink = event.target.closest('nav a[data-route]');
  if (routeLink && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    navigate(routeLink.pathname);
    return;
  }
  const waitingCard = event.target.closest('[data-waiting-index]');
  if (waitingCard) {
    state.selectedWaiting = Number(waitingCard.dataset.waitingIndex);
    $$('.request-card').forEach((card, index) => card.classList.toggle('is-selected', index === state.selectedWaiting));
  }
  const decisionButton = event.target.closest('[data-decision]');
  if (decisionButton) {
    const card = decisionButton.closest('[data-request-id]');
    decide(card.dataset.requestId, decisionButton.dataset.decision, card.querySelector('textarea')?.value);
  }
  const editButton = event.target.closest('[data-show-edit]');
  if (editButton) {
    const note = editButton.closest('.request-card').querySelector('.decision-note');
    note.hidden = !note.hidden;
    if (!note.hidden) $('textarea', note).focus();
  }
  const personButton = event.target.closest('[data-person-key]');
  if (personButton) { state.selectedPerson = personButton.dataset.personKey; state.personDirty = false; renderPeople(); renderPersonEditor(); }
  const editRole = event.target.closest('[data-edit-role]');
  if (editRole) openRoleEditor(state.roles.find(role => role.name === editRole.closest('[data-role-name]').dataset.roleName));
  const cancelRole = event.target.closest('[data-cancel-role]');
  if (cancelRole) renderRolesPage();
  const deleteRoleButton = event.target.closest('[data-delete-role]');
  if (deleteRoleButton) deleteRole(deleteRoleButton.closest('[data-role-name]').dataset.roleName);
  const removeMemberButton = event.target.closest('[data-remove-member]');
  if (removeMemberButton) removeRoleMember(removeMemberButton.closest('[data-role-name]').dataset.roleName, removeMemberButton.dataset.removeMember);
  const taskButton = event.target.closest('[data-task-id]');
  if (taskButton) navigate(`/console/tasks/${encodeURIComponent(taskButton.dataset.taskId)}`);
  const scheduleActionButton = event.target.closest('[data-schedule-action]');
  if (scheduleActionButton) {
    const id = Number(scheduleActionButton.closest('[data-schedule-id]').dataset.scheduleId);
    if (scheduleActionButton.dataset.scheduleAction === 'edit') openScheduleEditor(state.schedules.find(schedule => schedule.id === id));
    else scheduleAction(id, scheduleActionButton.dataset.scheduleAction);
  }
  const letItButton = event.target.closest('[data-schedule-let-it]');
  if (letItButton) {
    const id = Number(letItButton.closest('[data-schedule-id]').dataset.scheduleId);
    letItAddCapabilities(id);
  }
  const runRow = event.target.closest('.schedule-run-row');
  if (runRow) {
    const runId = runRow.dataset.runId;
    const scheduleId = Number(runRow.closest('[data-schedule-id]').dataset.scheduleId);
    const detail = runRow.parentElement.querySelector(`[data-run-detail="${runId}"]`);
    if (detail) {
      detail.hidden = !detail.hidden;
      if (!detail.hidden) {
        const run = (state.scheduleHistory.get(scheduleId) || []).find(r => String(r.id) === runId);
        detail.querySelector('.schedule-run-full').textContent = `${run?.final_status || ''}${run?.note ? `\n\nNOTE: ${run.note}` : ''}`;
      }
    }
  }
  const closeButton = event.target.closest('[data-close-dialog]');
  if (closeButton) $(`#${closeButton.dataset.closeDialog}`).close();
  if (event.target.closest('[data-open-shortcuts]')) $('#shortcuts-dialog').showModal();
  if (event.target.closest('#home-sync-people')) syncPeopleFromInkbox();
  const resetSetting = event.target.closest('[data-reset-setting]');
  if (resetSetting) {
    const setting = state.settings.find(item => item.name === resetSetting.closest('[data-setting-name]').dataset.settingName);
    if (setting) saveSetting(setting, null);
  }
});

async function peopleForSearch() {
  try { return (await api('/people')).people || []; }
  catch { return []; }
}

document.addEventListener('input', event => {
  if (!event.target.matches('[data-member-input]')) return;
  const input = event.target;
  const box = input.closest('.add-member-form').querySelector('[data-member-suggestions]');
  const term = input.value.trim().toLowerCase();
  if (!term) { box.innerHTML = ''; return; }
  peopleForSearch().then(people => {
    if (input.value.trim().toLowerCase() !== term) return; // stale response, typed on
    const matches = people
      .filter(person => String(person.person || '').toLowerCase().includes(term) || String(person.key || '').toLowerCase().includes(term))
      .slice(0, 8);
    box.innerHTML = matches.map(person => `<button type="button" class="add-member-suggestion" data-member-pick="${escapeHTML(person.key)}">${escapeHTML(person.person || person.key)}<span class="person-key">${escapeHTML(person.key)}</span></button>`).join('');
  });
});

document.addEventListener('click', event => {
  const pick = event.target.closest('[data-member-pick]');
  if (!pick) return;
  const form = pick.closest('.add-member-form');
  const input = form.querySelector('[data-member-input]');
  input.value = pick.dataset.memberPick;
  form.querySelector('[data-member-suggestions]').innerHTML = '';
  input.focus();
});

document.addEventListener('focusout', event => {
  if (!event.target.matches('[data-member-input]')) return;
  const box = event.target.closest('.add-member-form').querySelector('[data-member-suggestions]');
  setTimeout(() => { box.innerHTML = ''; }, 150);
});

document.addEventListener('submit', event => {
  event.preventDefault();
  if (event.target.id === 'person-form') savePerson(event.target);
  if (event.target.matches('.role-editor')) saveRole(event.target);
  if (event.target.id === 'schedule-form') saveSchedule(event.target);
  if (event.target.matches('[data-add-member]')) {
    const name = event.target.closest('[data-role-name]')?.dataset.roleName;
    const key = new FormData(event.target).get('key')?.trim();
    if (name && key) { addRoleMember(name, key); event.target.reset(); }
  }
});

document.addEventListener('change', event => {
  if (event.target.matches('[data-setting-control]')) {
    const row = event.target.closest('[data-setting-name]');
    const setting = state.settings.find(item => item.name === row.dataset.settingName);
    if (!setting) return;
    if (setting.kind === 'number' || setting.kind === 'text') return;
    const value = setting.kind === 'bool' ? event.target.checked : setting.kind === 'number' ? Number(event.target.value) : event.target.value;
    if (isSeriousSetting(setting) && setting.value === true && value === false
      && !window.confirm('Turn this off? Outbound messages will be sent without being shown to you first.')) {
      event.target.checked = true;
      const label = event.target.closest('.setting-toggle')?.querySelector('span:last-child');
      if (label) label.textContent = 'On';
      return;
    }
    if (setting.kind === 'bool') event.target.closest('.setting-toggle').querySelector('span:last-child').textContent = value ? 'On' : 'Off';
    saveSetting(setting, value);
  }

});

document.addEventListener('input', event => {
  if (!event.target.matches('[data-setting-control]')) return;
  const row = event.target.closest('[data-setting-name]');
  const setting = state.settings.find(item => item.name === row.dataset.settingName);
  if (!setting) return;
  if (setting.kind === 'number') {
    $$('input', row).forEach(input => { if (input !== event.target) input.value = event.target.value; });
    scheduleSettingSave(setting, Number(event.target.value), 350);
  }
  if (setting.kind === 'text') {
    growSettingTextarea(event.target);
    scheduleSettingSave(setting, event.target.value, 600);
  }
});

document.addEventListener('keydown', event => {
  if (event.key === '?' && !isTypingTarget(event.target)) { event.preventDefault(); $('#shortcuts-dialog').showModal(); return; }
  if (event.key === '/' && state.activeView === 'people' && !isTypingTarget(event.target)) { event.preventDefault(); $('#people-search').focus(); return; }
  if (isTypingTarget(event.target) || $('dialog[open]')) return;
  if (state.activeView !== 'requests') return;
  if (event.key === 'j') { event.preventDefault(); moveWaiting(1); }
  if (event.key === 'k') { event.preventDefault(); moveWaiting(-1); }
  if ((event.key === 'y' || event.key === 'n') && pendingRequests().length) {
    event.preventDefault();
    const request = pendingRequests()[state.selectedWaiting];
    decide(request.id, event.key === 'y' ? 'yes' : 'no');
  }
});

$('#people-search').addEventListener('input',event => {state.search = event.target.value; renderPeople();});
$('#add-person').addEventListener('click',() => createPerson().catch(e => showNotice(e.message,'error')));
document.addEventListener('input',event => { if(event.target.closest('#person-form')) markPersonDirty(); });
document.addEventListener('change',event => {
  if(event.target.closest('#person-form')) markPersonDirty();
  if(event.target.matches('[data-contact-kind], #contact-add-form select')) {
    const row = event.target.closest('.person-contact'); $('input',row).placeholder = contactKind(event.target.value).hint;
  }
});
document.addEventListener('focusout',event => { if(event.target.matches('[data-contact-value], [data-contact-kind]')) updateContact(event.target.closest('.person-contact')); });
document.addEventListener('keydown',event => {
  if(state.activeView !== 'people') return;
  if((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if($('#person-form')) savePerson($('#person-form')); }
  if(event.target.matches('[data-contact-value], [data-contact-kind]')) {
    const row = event.target.closest('.person-contact');
    if(event.key === 'Enter') {event.preventDefault(); updateContact(row);}
    if(event.key === 'Escape') {event.preventDefault(); const c = contactsOf(state.editorPerson).find(c => c.id === row.dataset.contactId); $('[data-contact-value]',row).value = c.raw_value || c.value; $('[data-contact-kind]',row).value = c.kind; $('.contact-status',row).textContent = ''; delete row.dataset.lastAttempt;}
  } else if(event.key === 'Escape' && state.personDirty) {event.preventDefault(); renderPersonEditor();}
});
document.addEventListener('submit',async event => {
  const form = event.target; if(!['contact-add-form','contact-move-form','person-merge-form'].includes(form.id)) return;
  event.preventDefault(); const data = new FormData(form), id = state.selectedPerson;
  try {
    if(form.id === 'contact-add-form') await immediatePeople('/people/contact/add',{person_id:id,kind:data.get('kind'),value:data.get('value')},e => (e.person_id === id && e.action === 'added') || e.action === 'conflict');
    if(form.id === 'contact-move-form') {const contact_id = data.get('contact_id'); await immediatePeople('/people/contact/move',{contact_id,person_id:data.get('person_id') || null},e => e.contact_id === contact_id && e.action === 'moved');}
    if(form.id === 'person-merge-form') { const keep_id = data.get('keep_id'); if(!keep_id) return; await peoplePost('/people/link',{keep_id,merge_id:id},e => e.merge_id === id && e.action === 'linked'); state.personDirty = false; state.selectedPerson = keep_id; await refreshPeople(); }
  } catch(error) { if(form.id === 'contact-add-form') showContactClash(form,error); else showNotice(error.message,'error'); }
});
document.addEventListener('click',async event => {
  const button = event.target.closest('button'); if(!button) return;
  const row = button.closest('[data-contact-id]'), contact_id = row?.dataset.contactId;
  try {
    if(button.matches('[data-list-mode]')) {
      const unassigned = button.dataset.listMode === 'unassigned'; $('.people-pane').dataset.mode = button.dataset.listMode;
      $$('[data-list-mode]').forEach(b => b.setAttribute('aria-pressed',String(b === button))); if(unassigned) $('#unassigned-block').open = true;
    }
    if(button.matches('[data-discard-person],[data-reload-person]')) {state.personDirty = false; renderPersonEditor();}
    if(button.matches('[data-assign]')) await immediatePeople('/people/contact/move',{contact_id,person_id:state.selectedPerson},e => e.contact_id === contact_id && e.action === 'moved');
    if(button.matches('[data-new-contact-person]')) { const c = state.unassigned.find(c => c.id === contact_id); const id = await createPerson(c.raw_value || c.value); await immediatePeople('/people/contact/move',{contact_id,person_id:id},e => e.contact_id === contact_id && e.action === 'moved'); }
    if(button.matches('[data-remove-contact],[data-delete-unassigned]')) {
      if(button.matches('[data-delete-unassigned]') && !confirm('Delete this contact? It will reappear on the next sync if seen again.')) return;
      await immediatePeople('/people/contact/remove',{contact_id},e => e.contact_id === contact_id && e.action === 'removed');
    }
    if(button.matches('[data-clash-move]')) {const cid = button.dataset.clashMove; if(!cid) return showNotice('Refresh the page to find this contact.','error'); await immediatePeople('/people/contact/move',{contact_id:cid,person_id:state.selectedPerson},e => e.contact_id === cid && e.action === 'moved');}
    if(button.matches('[data-delete-person]')) { const id = state.selectedPerson; if(!confirm('Delete person? Their contacts become unassigned.')) return; await peoplePost('/people/remove',{id},e => e.id === id && e.action === 'deleted'); state.selectedPerson = null; state.personDirty = false; await refreshPeople(); }
  } catch(error) {showNotice(error.message,'error');}
});

$('#sync-people')?.addEventListener('click', syncPeopleFromInkbox);
$('#add-role')?.addEventListener('click', () => openRoleEditor());
$('#add-schedule')?.addEventListener('click', () => openScheduleEditor());
// <details> toggle events do not bubble, so this listens in the capture phase instead.
document.addEventListener('toggle', event => {
  const details = event.target.closest?.('[data-schedule-history]');
  if (!details || !details.open) return;
  const id = Number(details.dataset.scheduleHistory);
  if (!state.scheduleHistory.has(id)) loadScheduleHistory(id);
}, true);
document.addEventListener('change', event => {
  if (!event.target.matches('#schedule-form [name=cadence_kind]')) return;
  $$('#schedule-form .cadence-fields').forEach(el => { el.hidden = el.dataset.cadenceFields !== event.target.value; });
});
$$('[data-request-filter]').forEach(button => button.addEventListener('click', () => {
  state.requestFilter = button.dataset.requestFilter;
  $$('[data-request-filter]').forEach(item => item.classList.toggle('is-active', item === button));
  renderRequests();
}));
$('#mobile-route').addEventListener('change', event => navigate(event.target.value));
$('#retry-all').addEventListener('click', () => loadSnapshot());
$('#refresh-tasks').addEventListener('click', refreshTasks);
$('#refresh-health').addEventListener('click', refreshHealth);
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close();
}));
$('#task-dialog').addEventListener('close', () => {
  if (state.taskId) navigate(VIEW_PATHS.tasks, { replace: true });
});
window.addEventListener('popstate', applyRoute);

applyRoute({ replaceUnknown: true });
if (state.activeView !== 'requests') refreshWaitingCount().catch(error => showNotice(`Waiting count not loaded: ${error.message}`, 'error'));
connectEvents();

// Blatbot's picture comes from the backend, which fetches it from its Inkbox identity.
document.querySelectorAll('.brand-avatar').forEach(img => { img.src = `${API}/avatar`; });
