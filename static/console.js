// Config comes from config.js, served beside this page. Every request this client
// makes, including the live event stream, goes through these two values.
const CONFIG = window.CONSOLE_CONFIG || { apiBase: '/console/api', eventsUrl: '/console/events' };
const API = CONFIG.apiBase;

const state = {
  overview: null,
  home: null,
  streamState: 'connecting',
  people: [],
  directoryPeople: [],
  directoryUnlinked: [],
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
  permissions: '/console/permissions',
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
  if (path === '/console/permissions') return { view: 'permissions', taskId: null };
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
    if (view === 'permissions') await refreshPermissions({ throwOnError: true });
    if (view === 'people') await refreshDirectory({ throwOnError: true });
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
    <a class="home-card-link" href="${VIEW_PATHS.permissions}" data-home-link="permissions">See people →</a>
  </article>`;
}

function homeContactsBlock() {
  const contacts = state.home?.recent_contacts || [];
  return `<article class="home-card home-contacts" aria-labelledby="home-contacts-title">
    <div class="home-card-head"><h2 id="home-contacts-title">Who reached out recently</h2></div>
    ${contacts.length
      ? `<ul class="home-mini-list">${contacts.map(c => `<li><span class="home-mini-summary">${escapeHTML(c.person || c.key)}</span><span class="muted">${escapeHTML((c.channels || []).join(', ') || 'unknown channel')} &middot; ${escapeHTML(relativeAge(c.last_seen))}</span></li>`).join('')}</ul>`
      : '<p class="home-card-body muted">No one has reached out yet.</p>'}
    <a class="home-card-link" href="${VIEW_PATHS.permissions}" data-home-link="permissions">See people →</a>
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

function filteredPeople() {
  const term = state.search.trim().toLowerCase();
  if (!term) return state.people;
  return state.people.filter(person => [person.person, person.key, person.role, person.note, ...(person.scopes || []), ...(person.effective_scopes || []), ...(person.channels || [])].some(value => String(value || '').toLowerCase().includes(term)));
}

function renderPeople() {
  // No cap: every person the search matches is rendered, not a page of them.
  const people = filteredPeople();
  $('#people-count').textContent = `${people.length}/${state.peopleTotal ?? state.people.length}`;
  const lastSync = state.peopleLastSync || {};
  const syncLabel = $('#people-last-sync');
  if (syncLabel) syncLabel.textContent = lastSync.at ? `last synced ${formatTime(new Date(lastSync.at * 1000).toISOString())}` : 'never synced from Inkbox';
  if (state.selectedPerson && !state.people.some(person => person.key === state.selectedPerson)) state.selectedPerson = null;
  if (!state.selectedPerson && people.length) state.selectedPerson = people[0].key;
  $('#people-list').innerHTML = people.length ? people.map(person => {
    const counts = person.scope_counts || { read: 0, write: 0, total: (person.effective_scopes || []).length };
    return `<button class="person-row${person.key === state.selectedPerson ? ' is-selected' : ''}" type="button" role="option" aria-selected="${person.key === state.selectedPerson}" data-person-key="${escapeHTML(person.key)}">
    <span class="person-role">${escapeHTML(person.role || 'no role')}</span>
    <span class="person-name">${escapeHTML(person.person || 'Unnamed')}</span>
    <span class="person-key">${escapeHTML(person.key)}</span>
    <span class="person-impact"><span class="auto">${counts.read} read</span> / <span class="ask">${counts.write} write</span>${person.has_send ? ' <span class="send-mark">send</span>' : ''}</span>
  </button>`;
  }).join('') : '<div class="empty-state">No people match this search.</div>';
  renderPersonEditor();
}

async function syncPeopleFromInkbox(event) {
  const buttons = [$('#sync-people'), $('#home-sync-people')].filter(Boolean);
  buttons.forEach(button => { button.disabled = true; button.textContent = 'Refreshing…'; });
  try {
    const result = await post('/people/sync', {});
    await Promise.all([refreshPermissions(), refreshHome({ throwOnError: false })]);
    showNotice(`Synced ${result.people} people from Inkbox.`);
  } catch (error) {
    showNotice(`Refresh from Inkbox failed: ${error.message}`, 'error', 8000);
  } finally {
    buttons.forEach(button => { button.disabled = false; button.textContent = 'Refresh from Inkbox'; });
  }
}

function renderPersonEditor(draft = null) {
  const person = draft || state.people.find(item => item.key === state.selectedPerson);
  if (!person) {
    $('#person-editor').innerHTML = '<div class="empty-state">No people configured. Add a handle to start with zero permissions.</div>';
    return;
  }
  const isNew = Boolean(person.__new);
  const held = new Set(heldRoles(person.role));
  const inherited = new Set(state.roles.filter(role => held.has(role.name)).flatMap(role => role.scopes || []));
  const extras = new Set(person.scopes || []);
  const effective = new Set([...inherited, ...extras]);
  const interrupted = state.scopes.map(scope => scope.name).filter(name => !effective.has(name));
  $('#person-editor').innerHTML = `<form id="person-form">
    <div class="editor-head">
      <div>
        <h3>${isNew ? 'New person' : escapeHTML(person.person || person.key)}</h3>
        <span class="person-key">${isNew ? 'Defaults to no permissions' : escapeHTML(person.key)}</span>
      </div>
    </div>
    <div class="editor-grid">
      <label class="field">Handle
        <input name="key" class="mono" required value="${escapeHTML(person.key || '')}" placeholder="email, phone, Telegram id, or name" ${isNew ? '' : 'readonly'}>
      </label>
      <label class="field">Display name
        <input name="person" value="${escapeHTML(person.person || '')}" placeholder="Name">
      </label>
      <label class="field">Role
        ${rolePicker(person.role, 'role')}
        <a class="roles-link" href="${VIEW_PATHS.roles}" data-link>Manage roles →</a>
      </label>
      <label class="field">Note
        <textarea name="note" placeholder="Why this access exists">${escapeHTML(person.note || '')}</textarea>
      </label>
    </div>
    <div class="consequence">
      <div><span class="consequence-label auto">Runs without asking (${effective.size})</span><div class="scope-plain-list">${effective.size ? [...effective].sort().map(escapeHTML).join('<br>') : 'Nothing'}</div></div>
      <div><span class="consequence-label ask">Still asks you (${interrupted.length})</span><div class="scope-plain-list">${interrupted.length ? interrupted.sort().map(escapeHTML).join('<br>') : 'Nothing'}</div></div>
    </div>
    <div class="scope-editor-title"><h3>Extra scopes</h3><p>Checked here in addition to the role.</p></div>
    <div class="scope-groups">${renderScopeGroups(extras, inherited)}</div>
    <div class="editor-actions">
      ${isNew ? '<button class="button button-quiet" type="button" data-cancel-person>Cancel</button>' : '<button class="button button-danger" type="button" data-delete-person>Delete person</button>'}
      <div class="save-actions"><button class="button button-primary" type="submit">Save person</button></div>
    </div>
  </form>`;
}

function renderScopeGroups(selected = new Set(), inherited = new Set()) {
  const term = state.search.trim().toLowerCase();
  const groups = Map.groupBy
    ? Map.groupBy(state.scopes, scope => scope.group || 'Other')
    : state.scopes.reduce((map, scope) => map.set(scope.group || 'Other', [...(map.get(scope.group || 'Other') || []), scope]), new Map());
  return [...groups.entries()].map(([group, scopes]) => {
    const matches = scope => !term || `${scope.name} ${scope.purpose || ''} ${group}`.toLowerCase().includes(term);
    const groupHidden = term && !scopes.some(matches);
    return `<fieldset class="scope-group" ${groupHidden ? 'hidden' : ''}><legend>${escapeHTML(group)}</legend><div class="scope-options">${scopes.map(scope => {
      const isInherited = inherited.has(scope.name);
      return `<label class="scope-option${isInherited ? ' is-inherited' : ''}" ${matches(scope) ? '' : 'hidden'}>
        <input type="checkbox" name="scopes" value="${escapeHTML(scope.name)}" ${selected.has(scope.name) ? 'checked' : ''} ${isInherited ? 'disabled' : ''}>
        <span class="scope-option-text"><span class="scope-name">${escapeHTML(scope.name)}<span class="scope-detail-kind is-${escapeHTML(scope.kind || (scope.read ? 'read' : 'write'))}">${escapeHTML(scope.read ? 'read' : (scope.kind || 'write'))}</span>${isInherited ? '<span class="inherited-mark">role</span>' : ''}</span><span class="scope-purpose">${escapeHTML(scope.description || scope.purpose || `${scope.tools_count || 0} tools`)}</span></span>
      </label>`;
    }).join('')}</div></fieldset>`;
  }).join('');
}

async function savePerson(form) {
  const data = new FormData(form);
  const body = {
    key: data.get('key').trim(),
    person: data.get('person').trim(),
    role: data.getAll('role').join(', '),
    scopes: data.getAll('scopes'),
    note: data.get('note').trim(),
  };
  if (!body.key) return showNotice('A handle is required.', 'error');
  setFormBusy(form, true);
  try {
    await post('/people', body);
    state.selectedPerson = body.key;
    await refreshPermissions();
    showNotice(`Saved ${body.person || body.key}.`);
  } catch (error) {
    showNotice(`Person not saved: ${error.message}`, 'error', 8000);
    setFormBusy(form, false);
  }
}

async function deletePerson(key) {
  if (!window.confirm(`Delete ${key}? Their permissions will be removed.`)) return;
  try {
    await post('/people/delete', { key });
    state.selectedPerson = null;
    await refreshPermissions();
    showNotice(`Deleted ${key}.`);
  } catch (error) { showNotice(`Person not deleted: ${error.message}`, 'error'); }
}

async function refreshPermissions({ throwOnError = false } = {}) {
  try {
    const [peopleResponse, roles, scopes] = await Promise.all([api('/people'), api('/roles'), api('/scopes')]);
    state.people = peopleResponse.people || [];
    state.peopleTotal = peopleResponse.count ?? state.people.length;
    state.peopleLastSync = peopleResponse.last_sync || {};
    state.roles = roles; state.scopes = scopes;
    state.loaded.permissions = true;
    state.invalidated.permissions = false;
    renderPeople();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Permissions not refreshed: ${error.message}`, 'error');
  }
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

// -- People page: one entry per person, contacts managed inside it ------------

function heldRoles(value) {
  return String(value || '').split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
}

// One checkbox per configured role: a person can hold several, so it is a pick list, not free text.
function rolePicker(held, inputName) {
  const have = new Set(heldRoles(held));
  const known = new Set(state.roles.map(role => role.name));
  const stale = [...have].filter(name => !known.has(name));
  if (!state.roles.length && !stale.length) return '<span class="muted">No roles configured.</span>';
  return `<span class="role-picker">${state.roles.map(role => `<label class="role-pick"><input type="checkbox" name="${inputName}" value="${escapeHTML(role.name)}" ${have.has(role.name) ? 'checked' : ''}>${escapeHTML(role.name)}</label>`).join('')}${stale.map(name => `<label class="role-pick is-stale" title="This role no longer exists"><input type="checkbox" name="${inputName}" value="${escapeHTML(name)}" checked>${escapeHTML(name)}</label>`).join('')}</span>`;
}

async function refreshDirectory({ throwOnError = false } = {}) {
  try {
    const [response, roles] = await Promise.all([api('/people/directory'), api('/roles')]);
    state.roles = roles;
    state.directoryPeople = response.people || [];
    state.directoryUnlinked = response.unlinked || [];
    state.contactKinds = response.contact_kinds || [];
    state.loaded.people = true;
    state.invalidated.people = false;
    renderDirectory();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`People not refreshed: ${error.message}`, 'error');
  }
}

// labels and hints for contact types come from the API (people directory), not from here
const contactKind = kind => (state.contactKinds || []).find(k => k.kind === kind) || { kind, label: kind, hint: '' };
const CONTACT_LABELS = new Proxy({}, { get: (_, kind) => contactKind(kind).label });
const CONTACT_PLACEHOLDERS = new Proxy({}, { get: (_, kind) => contactKind(kind).hint });

function _directoryPersonOptions(excludeId) {
  return (state.directoryPeople || [])
    .filter(person => person.id !== excludeId)
    .map(person => `<option value="${escapeHTML(person.id)}">${escapeHTML(person.display || person.id)}</option>`)
    .join('');
}


function _contactRow(contact) {
  const label = CONTACT_LABELS[contact.kind] || contact.kind;
  return `<li class="contact-row" data-contact-id="${escapeHTML(contact.id)}">
    <span class="contact-kind">${escapeHTML(label)}</span>
    <span class="contact-value">${escapeHTML(contact.raw_value || contact.value)}</span>
    <button class="button button-quiet contact-remove" type="button" data-contact-id="${escapeHTML(contact.id)}" aria-label="Remove this ${escapeHTML(label)} contact">Remove</button>
  </li>`;
}

function renderDirectory() {
  const term = ($('#directory-search')?.value || '').toLowerCase();
  const matches = value => String(value || '').toLowerCase().includes(term);
  const people = (state.directoryPeople || []).filter(person =>
    !term || matches(person.display) || matches(person.id) || matches(person.role) ||
    (person.contacts || []).some(c => matches(c.value)));
  const unlinked = (state.directoryUnlinked || []).filter(c => !term || matches(c.value) || matches(c.kind));

  const peopleHTML = people.length ? people.map(person => {
    const options = _directoryPersonOptions(person.id);
    // a name is the person's display name above, not a way of reaching them
    const reachable = (person.contacts || []).filter(c => c.kind !== 'name');
    const contacts = reachable.map(c => _contactRow(c)).join('')
      || '<li class="empty-state">No contacts yet.</li>';
    return `<article class="home-card person-card" data-person-id="${escapeHTML(person.id)}">
      <div class="person-card-head">
        <label class="person-field">Name
          <input class="person-display" data-person-id="${escapeHTML(person.id)}" value="${escapeHTML(person.display)}" placeholder="Name"></label>
        <fieldset class="person-roles"><legend>Roles</legend>${rolePicker(person.role, 'person-role')}</fieldset>
        <button class="button button-quiet person-save" type="button" data-person-id="${escapeHTML(person.id)}">Save</button>
        <button class="button button-danger person-delete" type="button" data-person-id="${escapeHTML(person.id)}">Delete</button>
      </div>
      ${person.effective_scopes && person.effective_scopes.length ? `<p class="muted">Can use without asking: ${person.effective_scopes.map(escapeHTML).join(', ')}</p>` : ''}
      <textarea class="person-note" data-person-id="${escapeHTML(person.id)}" placeholder="Note" aria-label="Note">${escapeHTML(person.note || '')}</textarea>
      <h4 class="contact-heading">Contacts</h4>
      <ul class="contact-list">${contacts}</ul>
      <form class="contact-add-form" data-person-id="${escapeHTML(person.id)}">
        <select class="contact-add-kind" aria-label="Type of contact">
          ${(state.contactKinds || []).filter(k => k.addable).map(k => `<option value="${escapeHTML(k.kind)}">${escapeHTML(k.label)}</option>`).join('')}
        </select>
        <input class="contact-add-value" placeholder="${escapeHTML(((state.contactKinds || []).find(k => k.addable) || {}).hint || '')}" aria-label="New contact" required>
        <button class="button button-quiet" type="submit">Add contact</button>
      </form>
      <details class="person-advanced"><summary>Move a contact or merge a duplicate</summary>
        ${reachable.length ? `<form class="contact-move-form">
          <span>Move</span>
          <select class="contact-move-which" aria-label="Contact to move">${reachable.map(c => `<option value="${escapeHTML(c.id)}">${escapeHTML((CONTACT_LABELS[c.kind] || c.kind) + ' ' + (c.raw_value || c.value))}</option>`).join('')}</select>
          <span>to</span>
          <select class="contact-move-target" aria-label="Person to move it to"><option value="">nobody (leave it unassigned)</option>${options}</select>
          <button class="button button-quiet" type="submit">Move</button>
        </form>` : ''}
        <form class="link-form" data-person-id="${escapeHTML(person.id)}">
          <span>This person is a duplicate of</span>
          <select class="link-target" aria-label="Person to merge into"><option value="">choose a person</option>${options}</select>
          <button class="button button-quiet" type="submit">Merge into them</button>
        </form>
      </details>
    </article>`;
  }).join('') : '<div class="empty-state">No people yet. Add one below.</div>';

  const unlinkedHTML = unlinked.length ? `<div class="unlinked-list"><h3>Contacts not assigned to anyone</h3><ul class="contact-list">
    ${unlinked.map(c => `<li class="contact-row" data-contact-id="${escapeHTML(c.id)}">
      <span class="contact-kind">${escapeHTML(CONTACT_LABELS[c.kind] || c.kind)}</span>
      <span class="contact-value">${escapeHTML(c.value)}</span>
      <select class="contact-assign" data-contact-id="${escapeHTML(c.id)}" aria-label="Assign to a person">
        <option value="">Assign to…</option>
        ${_directoryPersonOptions(null)}
      </select>
      <button class="button button-quiet contact-remove" type="button" data-contact-id="${escapeHTML(c.id)}">Delete</button>
    </li>`).join('')}
  </ul></div>` : '';

  $('#contact-directory').setAttribute('aria-busy', 'false');
  $('#contact-directory').innerHTML =
    `<form id="add-person-form" class="add-person-form"><input id="add-person-name" placeholder="New person's name" aria-label="New person's name" required>
       <button class="button button-primary" type="submit">Create person</button></form>` +
    peopleHTML + unlinkedHTML;
}

async function createPersonFromDirectory(event) {
  event.preventDefault();
  const input = $('#add-person-name');
  const display = input.value.trim();
  if (!display) return;
  await post('/people/create', { display });
  input.value = '';
  await refreshDirectory();
  showNotice(`Created ${display}.`);
}

async function savePersonFromDirectory(personId) {
  const card = document.querySelector(`.person-card[data-person-id="${CSS.escape(personId)}"]`);
  if (!card) return;
  const display = card.querySelector('.person-display').value.trim();
  const role = [...card.querySelectorAll('input[name="person-role"]:checked')].map(box => box.value).join(', ');
  const note = card.querySelector('.person-note').value;
  await post('/people/update', { id: personId, display, role, note });
  await refreshDirectory();
  showNotice('Saved.');
}

async function deletePersonFromDirectory(personId) {
  if (!window.confirm('Delete this person? Every contact of theirs is removed too.')) return;
  await post('/people/remove', { id: personId });
  await refreshDirectory();
  showNotice('Person deleted.');
}

async function addContactFromDirectory(personId, kind, value) {
  const result = await post('/people/contact/add', { person_id: personId, kind, value });
  if (result.conflict) {
    showNotice(`That contact already belongs to someone else (person ${result.existing_person_id}). Use link or move instead.`, 'error', 8000);
    return;
  }
  await refreshDirectory();
  showNotice('Contact added.');
}

async function moveContactFromDirectory(contactId, personId) {
  await post('/people/contact/move', { contact_id: contactId, person_id: personId || null });
  await refreshDirectory();
  showNotice(personId ? 'Contact moved.' : 'Contact unlinked.');
}

async function removeContactFromDirectory(contactId) {
  await post('/people/contact/remove', { contact_id: contactId });
  await refreshDirectory();
  showNotice('Contact removed.');
}

async function linkPeopleFromDirectory(mergeId, keepId) {
  await post('/people/link', { keep_id: keepId, merge_id: mergeId });
  await refreshDirectory();
  showNotice('People linked.');
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
  $('#roles-list').innerHTML = state.roles.length ? state.roles.map(role => `<div class="role-card" data-role-name="${escapeHTML(role.name)}">
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
  host.innerHTML = `<form class="role-editor">
    <div class="editor-grid">
      <label class="field">Role name<input name="name" required value="${escapeHTML(role.name)}" ${role.__new ? '' : 'readonly'}></label>
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

function renderSchedules() {
  const host = $('#schedules-list');
  host.setAttribute('aria-busy', 'false');
  $('#global-schedules-pause').textContent = state.schedulesPaused ? 'Resume all' : 'Pause all';
  host.innerHTML = state.schedules.length ? state.schedules.map(schedule => `<article class="schedule-card" data-schedule-id="${escapeHTML(schedule.id)}">
    <div class="schedule-head"><div><span class="mono">S${escapeHTML(schedule.id)}</span><h3>${escapeHTML(schedule.title)}</h3></div><span class="state state-${escapeHTML(schedule.state)}">${escapeHTML(schedule.state)}</span></div>
    <dl class="schedule-facts">
      <div><dt>Cadence</dt><dd>${escapeHTML(schedule.cadence)}</dd></div>
      <div><dt>Next run</dt><dd>${escapeHTML(schedule.next_run ? formatTime(schedule.next_run) : 'none')}</dd></div>
      <div><dt>Last outcome</dt><dd>${escapeHTML(schedule.last_outcome || 'No runs yet.')}</dd></div>
      <div><dt>Report mode</dt><dd>${escapeHTML(schedule.report_mode)}</dd></div>
      ${schedule.kind === 'continue' ? `<div><dt>Runs used</dt><dd>${escapeHTML(schedule.run_count)} of ${escapeHTML(schedule.max_runs)}</dd></div>` : ''}
    </dl>
    <div class="scope-row">${scopeChips(schedule.scopes)}</div>
    <div class="schedule-actions">
      <a class="button button-quiet" href="/console/tasks/${encodeURIComponent(schedule.task_id)}" data-link>Task ledger</a>
      <button class="button button-quiet" type="button" data-schedule-edit>Edit</button>
      ${schedule.state === 'paused' ? '<button class="button button-quiet" type="button" data-schedule-action="resume">Resume</button>' : '<button class="button button-quiet" type="button" data-schedule-action="pause">Pause</button>'}
      <button class="button button-quiet" type="button" data-schedule-action="run_now">Run now</button>
      <button class="button button-danger" type="button" data-schedule-action="delete">Delete</button>
    </div>
  </article>`).join('') : '<div class="empty-state">No schedules.</div>';
}

async function refreshSchedules({ throwOnError = false } = {}) {
  try {
    const [payload, scopes] = await Promise.all([api('/schedules'), state.scopes.length ? Promise.resolve(state.scopes) : api('/scopes')]);
    state.schedules = payload.schedules || [];
    state.schedulesPaused = Boolean(payload.global_paused);
    state.scopes = scopes;
    state.loaded.schedules = true; state.invalidated.schedules = false;
    renderSchedules();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Schedules not refreshed: ${error.message}`, 'error');
  }
}

function localInput(value) {
  if (!value) return '';
  const date = new Date(Number(value) * 1000);
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
}

function openScheduleEditor(schedule = null) {
  $('#schedule-dialog-title').textContent = schedule ? `Edit S${schedule.id}` : 'New schedule';
  $('#schedule-id').value = schedule?.id || '';
  $('#schedule-title').value = schedule?.title || '';
  $('#schedule-prompt').value = schedule?.prompt || '';
  $('#schedule-kind').value = schedule?.kind || 'once';
  $('#schedule-report').value = schedule?.report_mode || 'always';
  $('#schedule-run-at').value = localInput(schedule?.run_at);
  $('#schedule-cron').value = schedule?.cron || '';
  $('#schedule-timezone').value = schedule?.timezone || 'America/New_York';
  $('#schedule-max-runs').value = schedule?.max_runs || 20;
  $('#schedule-deadline').value = localInput(schedule?.deadline);
  const selected = new Set(schedule?.scopes || []);
  $('#schedule-scopes').innerHTML = state.scopes.map(scope => `<label class="scope-option"><input type="checkbox" name="scopes" value="${escapeHTML(scope.name)}" ${selected.has(scope.name) ? 'checked' : ''}><span class="scope-option-text"><span class="scope-name">${escapeHTML(scope.name)}</span><span class="scope-purpose">${escapeHTML(scope.purpose)}</span></span></label>`).join('');
  $('#schedule-dialog').showModal();
}

async function saveSchedule(form) {
  const data = new FormData(form);
  const payload = Object.fromEntries(data.entries());
  payload.scopes = data.getAll('scopes');
  payload.max_runs = Number(payload.max_runs || 20);
  for (const key of ['run_at', 'deadline']) payload[key] = payload[key] ? new Date(payload[key]).toISOString() : null;
  const id = $('#schedule-id').value;
  if (id) payload.id = Number(id);
  setFormBusy(form, true);
  try {
    const result = await post(id ? '/schedules/edit' : '/schedules', payload);
    state.schedules = result.schedules || [];
    state.schedulesPaused = Boolean(result.global_paused);
    renderSchedules();
    $('#schedule-dialog').close();
    showNotice('Schedule saved for approval.');
  } catch (error) { showNotice(`Schedule not saved: ${error.message}`, 'error'); }
  finally { setFormBusy(form, false); }
}

async function scheduleAction(id, action) {
  if (action === 'delete' && !window.confirm(`Delete schedule S${id}?`)) return;
  try {
    const result = await post('/schedules/action', { id: Number(id), action });
    state.schedules = result.schedules || [];
    state.schedulesPaused = Boolean(result.global_paused);
    renderSchedules();
  } catch (error) { showNotice(`Schedule not changed: ${error.message}`, 'error'); }
}

async function toggleGlobalSchedulesPause() {
  try {
    const result = await post('/schedules/global', { paused: !state.schedulesPaused });
    state.schedules = result.schedules || [];
    state.schedulesPaused = Boolean(result.global_paused);
    renderSchedules();
  } catch (error) { showNotice(`Could not change the global pause: ${error.message}`, 'error'); }
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
    invalidateView('permissions', refreshPermissions);
    invalidateView('roles', refreshRoles);
    invalidateView('people', refreshDirectory);
    invalidateView('scopes', refreshScopesBreakdown);
    invalidateHome();
  });
  source.addEventListener('people.synced', () => {
    invalidateView('permissions', refreshPermissions);
    invalidateView('people', refreshDirectory);
    invalidateHome();
  });
  source.addEventListener('people.changed', () => invalidateView('people', refreshDirectory));
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
  if (personButton) { state.selectedPerson = personButton.dataset.personKey; renderPeople(); }
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
  const scheduleEditButton = event.target.closest('[data-schedule-edit]');
  if (scheduleEditButton) {
    const id = Number(scheduleEditButton.closest('[data-schedule-id]').dataset.scheduleId);
    openScheduleEditor(state.schedules.find(schedule => schedule.id === id));
  }
  const scheduleActionButton = event.target.closest('[data-schedule-action]');
  if (scheduleActionButton) {
    const id = Number(scheduleActionButton.closest('[data-schedule-id]').dataset.scheduleId);
    scheduleAction(id, scheduleActionButton.dataset.scheduleAction);
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
  // The Roles page does not otherwise load people (only Permissions does); fetch
  // once, lazily, the first time someone searches from here so the suggestion list
  // has something to search over without a frontend copy of the roster.
  if (!state.people || !state.people.length) {
    try {
      const peopleResponse = await api('/people');
      state.people = peopleResponse.people || [];
    } catch { /* fall through to free entry, which still works without this */ }
  }
  return state.people || [];
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
  if (event.target.matches('#person-form input[name="role"], #person-form input[name="scopes"]')) {
    const form = event.target.form;
    const current = state.people.find(person => person.key === state.selectedPerson) || { __new: true };
    const data = new FormData(form);
    renderPersonEditor({
      ...current,
      __new: !state.selectedPerson,
      key: data.get('key'), person: data.get('person'), role: data.getAll('role').join(', '), note: data.get('note'), scopes: data.getAll('scopes'),
    });
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
  if (event.key === '/' && state.activeView === 'permissions' && !isTypingTarget(event.target)) { event.preventDefault(); $('#permission-search').focus(); return; }
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

$('#permission-search').addEventListener('input', event => { state.search = event.target.value; renderPeople(); });
$('#directory-search').addEventListener('input', renderDirectory);

document.addEventListener('submit', event => {
  if (event.target.id === 'add-person-form') { createPersonFromDirectory(event); return; }
  if (event.target.matches('.contact-add-form')) {
    event.preventDefault();
    const form = event.target;
    const personId = form.dataset.personId;
    const kind = form.querySelector('.contact-add-kind').value;
    const value = form.querySelector('.contact-add-value').value.trim();
    if (value) addContactFromDirectory(personId, kind, value);
    return;
  }
  if (event.target.matches('.contact-move-form')) {
    event.preventDefault();
    const form = event.target;
    moveContactFromDirectory(form.querySelector('.contact-move-which').value, form.querySelector('.contact-move-target').value);
    return;
  }
  if (event.target.matches('.link-form')) {
    event.preventDefault();
    const form = event.target;
    const mergeId = form.dataset.personId;
    const keepId = form.querySelector('.link-target').value;
    if (keepId) linkPeopleFromDirectory(mergeId, keepId);
  }
});

document.addEventListener('click', event => {
  if (event.target.matches('.person-save')) savePersonFromDirectory(event.target.dataset.personId);
  else if (event.target.matches('.person-delete')) deletePersonFromDirectory(event.target.dataset.personId);
  else if (event.target.matches('.contact-remove')) removeContactFromDirectory(event.target.dataset.contactId);
});

document.addEventListener('change', event => {
  if (event.target.matches('.contact-add-kind')) event.target.form.querySelector('.contact-add-value').placeholder = CONTACT_PLACEHOLDERS[event.target.value] || '';
  else if (event.target.matches('.contact-assign')) moveContactFromDirectory(event.target.dataset.contactId, event.target.value);
});
$('#add-person').addEventListener('click', () => { state.selectedPerson = null; renderPersonEditor({ key: '', person: '', role: '', scopes: [], note: '', __new: true }); $('#person-editor input').focus(); });
$('#person-editor').addEventListener('click', event => {
  if (event.target.closest('[data-cancel-person]')) renderPeople();
  if (event.target.closest('[data-delete-person]')) deletePerson(state.selectedPerson);
});
$('#sync-people')?.addEventListener('click', syncPeopleFromInkbox);
$('#add-role')?.addEventListener('click', () => openRoleEditor());
$('#add-schedule')?.addEventListener('click', () => openScheduleEditor());
$('#global-schedules-pause')?.addEventListener('click', toggleGlobalSchedulesPause);
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
