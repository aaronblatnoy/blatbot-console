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
  rolesSummary: null,
  whoCanMatches: [],
  roleOpen: new Set(),
  roleAffectsText: new Map(),
  roleAffectsTimers: new Map(),
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
    state.overview = await api('/overview');
    state.loaded.home = true;
    state.invalidated.home = false;
    renderHome();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Home not refreshed: ${error.message}`, 'error');
  }
}

// Every sentence, label and action in these four blocks comes straight from the
// overview API; nothing here encodes wording of its own beyond the section
// headings and the empty-state lines, which are chrome, not data.
const HOME_OUTCOME_STATE = { finished: 'done', could_not_finish: 'pending', failed: 'failed' };
const HOME_OUTCOME_WORD = { finished: 'Finished', could_not_finish: 'Could not finish', failed: 'Failed' };

function homeActionButtons(actions) {
  return (actions || [])
    .map(a => `<button type="button" class="button button-quiet" data-home-action="${escapeHTML(JSON.stringify(a))}">${escapeHTML(a.label)}</button>`)
    .join('');
}

function homeStuckBlock() {
  const rows = state.overview?.stuck || [];
  const quiet = !rows.length;
  return `<article class="home-card home-stuck${quiet ? ' is-quiet' : ' is-urgent'}" aria-labelledby="home-stuck-title">
    <div class="home-card-head">
      <h2 id="home-stuck-title">Stuck</h2>
      <span class="home-needs-count">${rows.length}</span>
    </div>
    ${quiet
      ? '<p class="home-card-body muted">Nothing is stuck.</p>'
      : `<ul class="home-mini-list">${rows.map(row => `<li class="home-row">
          <div class="home-row-body">
            <p class="home-card-body">${escapeHTML(row.sentence)}</p>
            ${row.since_text ? `<span class="muted">${escapeHTML(row.since_text)}</span>` : ''}
          </div>
          <div class="home-row-actions">${homeActionButtons(row.actions)}</div>
        </li>`).join('')}</ul>`}
  </article>`;
}

function homeRunningBlock() {
  const rows = state.overview?.running || [];
  return `<article class="home-card home-running" aria-labelledby="home-running-title">
    <div class="home-card-head"><h2 id="home-running-title">Running</h2></div>
    ${rows.length
      ? `<ul class="home-mini-list">${rows.map(row => `<li>
          <span class="state state-running">running</span>
          <span class="home-mini-summary">${escapeHTML(row.sentence)}${row.latest_step ? ` &middot; ${escapeHTML(row.latest_step)}` : ''}</span>
          <span class="muted">${escapeHTML(row.started_text || '')}</span>
        </li>`).join('')}</ul>`
      : '<p class="home-card-body muted">Nothing is running.</p>'}
  </article>`;
}

function homeDoneTodayBlock() {
  const rows = state.overview?.done_today || [];
  return `<article class="home-card home-done-today" aria-labelledby="home-done-title">
    <div class="home-card-head"><h2 id="home-done-title">Done today</h2></div>
    ${rows.length
      ? `<ul class="home-mini-list">${rows.map(row => `<li>
          <span class="state state-${HOME_OUTCOME_STATE[row.outcome] || 'neutral'}">${escapeHTML(HOME_OUTCOME_WORD[row.outcome] || row.outcome)}</span>
          <span class="home-mini-summary">${escapeHTML(row.sentence)}</span>
          <span class="muted">${escapeHTML(row.time_text || '')}</span>
        </li>`).join('')}</ul>`
      : '<p class="home-card-body muted">Nothing finished today yet.</p>'}
  </article>`;
}

function homeComingUpBlock() {
  const rows = state.overview?.coming_up || [];
  return `<article class="home-card home-coming-up" aria-labelledby="home-coming-up-title">
    <div class="home-card-head"><h2 id="home-coming-up-title">Coming up</h2></div>
    ${rows.length
      ? `<ul class="home-mini-list">${rows.map(s => `<li><span class="home-mini-summary"><strong>${escapeHTML(s.title)}</strong> &middot; ${escapeHTML(s.cadence_text)}</span><span class="muted">${escapeHTML(s.next_run_text || '')}</span></li>`).join('')}</ul>`
      : '<p class="home-card-body muted">No scheduled runs are coming up.</p>'}
    <a class="home-card-link" href="${VIEW_PATHS.schedules}" data-home-link="schedules">See schedules →</a>
  </article>`;
}

function homeSourcesLine() {
  const sources = state.overview?.sources || [];
  if (!sources.length) return '';
  return `<p class="home-sources">${sources.map(s => `${escapeHTML(s.label)}: ${escapeHTML(s.detail)}`).join(' &middot; ')}</p>`;
}

async function homeAction(action) {
  const target = action?.target || {};
  try {
    if (target.endpoint === 'requests/decide') {
      await post('/requests/decide', { id: target.id, decision: target.decision });
    } else if (target.endpoint === 'schedules/approve') {
      await post('/schedules/approve', { id: target.id, approve: target.approve });
    } else if (target.endpoint === 'schedules/action') {
      await post('/schedules/action', { id: target.id, action: target.action });
    } else if (target.endpoint === 'schedules/edit') {
      await post('/schedules/edit', { id: target.id, scopes: target.scopes });
    } else if (target.endpoint === 'schedules') {
      navigate(VIEW_PATHS.schedules);
      return;
    } else {
      return;
    }
    showNotice('Done.');
    await refreshHome({ throwOnError: false });
  } catch (error) {
    showNotice(`Could not do that: ${error.message}`, 'error');
  }
}

function renderHome() {
  const host = $('#home-content');
  host.setAttribute('aria-busy', 'false');
  if (!state.overview) { host.innerHTML = '<div class="empty-state">Data is not available yet.</div>'; return; }
  host.innerHTML = homeStuckBlock() + homeRunningBlock() + homeDoneTodayBlock() + homeComingUpBlock() + homeSourcesLine();
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

async function refreshRoles({ throwOnError = false } = {}) {
  try {
    const [summary, directory] = await Promise.all([api('/roles/summary'), api('/people/directory')]);
    state.rolesSummary = summary;
    state.people = directory.people || []; state.unassigned = directory.unlinked || []; state.contactKinds = directory.contact_kinds || [];
    state.loaded.roles = true;
    state.invalidated.roles = false;
    renderRolesPage();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Roles not refreshed: ${error.message}`, 'error');
  }
}

function heldRoles(value) { return String(value || '').split(',').map(n => n.trim()).filter(Boolean); }
function addableRoleOptions(p) {
  const held = new Set((p?.role_badges || []).map(rb => rb.name));
  return (state.rolesSummary?.roles || []).filter(r => !r.locked && !held.has(r.name))
    .map(r => `<option value="${escapeHTML(r.name)}">${escapeHTML(r.name)}</option>`).join('');
}
function personRoleChips(p) {
  const chips = (p.role_badges || []).map(rb => `<span class="person-role-chip${rb.locked ? ' person-role-chip-locked' : ''}">${escapeHTML(rb.name)}${rb.locked ? '' : `<button type="button" class="person-role-chip-remove" data-remove-person-role="${escapeHTML(rb.name)}" aria-label="Remove ${escapeHTML(rb.name)} from ${escapeHTML(personName(p))}">&times;</button>`}</span>`).join('');
  const addControl = p.commander ? '' : `<span class="person-role-add"><select data-add-person-role aria-label="Add a role"><option value="">Add role&hellip;</option>${addableRoleOptions(p)}</select></span>`;
  return `<div class="person-role-chips">${chips || '<span class="muted">No roles.</span>'}${addControl}</div>`;
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
    <form id="person-form"><label class="field">Name<input name="display" value="${escapeHTML(p.display || '')}"></label><label class="field">Note<textarea name="note" rows="3">${escapeHTML(p.note || '')}</textarea></label><div class="person-save-actions"><button class="button button-primary" type="submit" disabled>Save</button><span id="person-dirty-label" hidden>Unsaved changes</span><button class="button button-quiet" type="button" data-discard-person disabled>Discard</button></div></form>
    <h3>Contacts</h3><div id="person-contacts">${contacts.length ? contacts.map(c => `<div class="person-contact" data-contact-id="${escapeHTML(c.id)}"><select aria-label="Contact type" data-contact-kind>${kindOptions(c.kind)}</select><input aria-label="Contact value" data-contact-value value="${escapeHTML(c.raw_value || c.value)}" placeholder="${escapeHTML(contactKind(c.kind).hint)}"><button class="button button-quiet" type="button" data-remove-contact>Remove</button><div class="contact-status" role="status"></div></div>`).join('') : '<p class="muted">No contacts. Add one below or assign one from the unassigned list.</p>'}</div>
    <form id="contact-add-form" class="person-contact"><select aria-label="New contact type" name="kind">${kindOptions()}</select><input name="value" aria-label="New contact value" required placeholder="${escapeHTML((state.contactKinds || []).find(k => k.addable)?.hint || '')}"><button class="button button-quiet" type="submit">Add</button><div class="contact-status" role="status"></div></form>
    <div class="person-access"><h3>Roles</h3>${personRoleChips(p)}<p class="person-can-text">${escapeHTML(p.can_text || '')}</p><p class="person-can-text-link"><a href="/console/roles" data-route="roles">Change what a role can do</a></p></div>
    ${p.commander ? '<p class="person-commander-note">This person cannot be deleted or merged into another person here.</p>' : `<details class="person-advanced"><summary>Move or merge</summary><form id="contact-move-form"><label class="field">Contact<select name="contact_id" required><option value="">Choose contact</option>${contacts.map(c => `<option value="${escapeHTML(c.id)}">${escapeHTML(contactKind(c.kind).label + ' ' + (c.raw_value || c.value))}</option>`).join('')}</select></label><label class="field">To person (or Unassigned)<select name="person_id"><option value="">Unassigned</option>${personOptions(p.id)}</select></label><button class="button button-quiet" type="submit">Move</button></form><form id="person-merge-form"><label class="field">This is the same person as<select name="keep_id" required><option value="">Choose person</option>${personOptions(p.id)}</select></label><p class="muted">Their contacts move to that person. Roles and note are not combined.</p><button class="button button-quiet" type="submit">Merge into them</button></form></details><button class="button button-danger" type="button" data-delete-person>Delete person</button>`}`;
}
function markPersonDirty() {
  const form = $('#person-form'); if (!form || !state.editorPerson) return;
  const data = new FormData(form), p = state.editorPerson;
  state.personDirty = data.get('display') !== (p.display || '') || data.get('note') !== (p.note || '');
  $('button[type="submit"]',form).disabled = !state.personDirty;
  $('[data-discard-person]',form).disabled = !state.personDirty;
  $('#person-dirty-label').hidden = !state.personDirty;
}
async function refreshPeople({throwOnError = false, external = false, localContacts = false} = {}) {
  try {
    const [directory,summary] = await Promise.all([api('/people/directory'),api('/roles/summary')]);
    state.people = directory.people || []; state.unassigned = directory.unlinked || []; state.contactKinds = directory.contact_kinds || []; state.rolesSummary = summary;
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
  const body = {id,display:data.get('display'),note:data.get('note'),scopes:state.people.find(p => p.id === id)?.scopes || state.editorPerson.scopes || []};
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

async function setPersonRole(personId, roleName, add) {
  const p = state.people.find(pp => pp.id === personId);
  if (!p) return;
  const current = heldRoles(p.role);
  const next = add ? [...new Set([...current, roleName])] : current.filter(n => n !== roleName);
  try {
    const result = await peoplePost('/people/update', { id: personId, role: next.join(', ') }, e => e.id === personId && e.action === 'updated');
    const person = result.person || result;
    state.people = state.people.map(pp => pp.id === person.id ? person : pp);
    if (state.selectedPerson === personId) { state.editorPerson = structuredClone(person); state.personDirty = false; renderPersonEditor(); }
    renderPeople();
    return person;
  } catch (error) { showNotice(`Could not change roles: ${error.message}`, 'error'); throw error; }
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

function systemBySummary(name) {
  return (state.rolesSummary?.systems || []).find(s => s.system === name);
}

function roleSystemControl(sv) {
  const sysDef = systemBySummary(sv.system);
  const levels = sysDef?.levels || [];
  const levelOptions = levels.map(l => `<option value="${escapeHTML(l.value)}" ${l.value === sv.level ? 'selected' : ''}>${escapeHTML(l.label)}</option>`).join('');
  const customOption = sv.level === 'custom' ? `<option value="custom" selected hidden>${escapeHTML(sv.level_label)}</option>` : '';
  const sendControl = sv.send_label ? `<label class="role-system-send"><input type="checkbox" data-role-send data-system="${escapeHTML(sv.system)}" ${sv.send ? 'checked' : ''}> ${escapeHTML(sv.send_label)}</label>` : '';
  // The custom-level phrases, when present, read as the plain-words explanation of
  // what this grant currently does -- they must appear BEFORE the three-way control
  // that would replace them, not after it.
  const customPhrases = sv.level === 'custom' && (sv.phrases || []).length
    ? `<ul class="role-custom-phrases">${sv.phrases.map(p => `<li>${escapeHTML(p)}</li>`).join('')}</ul>` : '';
  return `<div class="role-system-row">
    <div class="role-system-head">
      <span class="role-system-label">${escapeHTML(sv.system_label)}</span>
    </div>
    ${customPhrases}
    <div class="role-system-controls">
      <select class="role-system-level-select" data-role-level data-system="${escapeHTML(sv.system)}" aria-label="${escapeHTML(sv.system_label)} level">${levelOptions}${customOption}</select>
      ${sendControl}
    </div>
    ${sv.send ? '<p class="role-system-send-warning">Blatbot can send as itself here without Aaron seeing it first.</p>' : ''}
  </div>`;
}

function roleNotesRow(role) {
  const folders = state.rolesSummary?.note_folders || [];
  const notes = role.notes || { level: 'none', folders: [] };
  const folderList = notes.level === 'some' ? `<ul class="role-notes-folders">${folders.map(f => {
    const on = (notes.folders || []).find(x => x.scope === f.scope)?.on;
    return `<li><label><input type="checkbox" data-role-note-folder data-scope="${escapeHTML(f.scope)}" ${on ? 'checked' : ''}> ${escapeHTML(f.label)}</label></li>`;
  }).join('')}</ul>` : '';
  return `<div class="role-notes-row">
    <div class="role-notes-head">
      <span class="role-system-label">Notes</span>
    </div>
    <div class="role-system-controls">
      <select class="role-system-level-select" data-role-notes-level aria-label="Notes level">
        <option value="none" ${notes.level === 'none' ? 'selected' : ''}>None</option>
        <option value="all" ${notes.level === 'all' ? 'selected' : ''}>All notes</option>
        <option value="some" ${notes.level === 'some' ? 'selected' : ''}>Some folders</option>
      </select>
    </div>
    ${folderList}
  </div>`;
}

function roleMembersBlock(role) {
  const held = new Set((role.members || []).map(m => m.person_id));
  const addable = (state.people || []).filter(p => !held.has(p.id));
  return `<div class="role-members">
    <ul class="role-member-list">${(role.members || []).length ? role.members.map(m => `<li class="role-member-row"><span class="role-member-name">${escapeHTML(m.name || m.person_id)}</span>${role.locked ? '' : `<button type="button" class="role-member-remove" data-remove-role-member="${escapeHTML(m.person_id)}">Remove</button>`}</li>`).join('') : '<li class="muted">No members</li>'}</ul>
    ${role.locked ? '' : `<div class="role-add-member"><select data-add-role-member aria-label="Add person to ${escapeHTML(role.name)}"><option value="">Add person&hellip;</option>${addable.map(p => `<option value="${escapeHTML(p.id)}">${escapeHTML(personName(p))}</option>`).join('')}</select></div>`}
  </div>`;
}

function roleDeleteBlock(role) {
  if (!(role.actions || []).includes('delete')) return '';
  return `<div class="role-delete-block">
    <button type="button" class="button button-quiet" data-delete-role-preview>Delete role</button>
    <div class="role-delete-confirm" hidden></div>
  </div>`;
}

function renderRoleRow(role) {
  const isOpen = state.roleOpen.has(role.name);
  const affects = state.roleAffectsText.get(role.name);
  const canRename = (role.actions || []).includes('rename');
  const titleHTML = canRename
    ? `<input class="role-name-input" data-role-name-input data-original-name="${escapeHTML(role.name)}" value="${escapeHTML(role.name)}" aria-label="Role name">`
    : `<span class="role-name-input" aria-label="Role name">${escapeHTML(role.name)}</span>${role.locked ? '<span class="role-row-locked-badge">Built in</span>' : ''}`;
  return `<div class="role-row" data-role-name="${escapeHTML(role.name)}">
    <div class="role-row-head">
      <div class="role-row-title">${titleHTML}</div>
      <button type="button" class="role-row-toggle" data-toggle-role aria-expanded="${isOpen}">${role.member_count} members${isOpen ? ' &middot; hide' : ''}</button>
    </div>
    <p class="role-row-can-text">${escapeHTML(role.can_text || '')}</p>
    ${isOpen ? `<div class="role-row-body">
      ${roleMembersBlock(role)}
      ${role.locked ? '' : `<div class="role-systems">${(role.systems || []).map(roleSystemControl).join('')}</div>`}
      ${role.locked ? '' : roleNotesRow(role)}
      ${roleDeleteBlock(role)}
    </div>` : ''}
    ${affects ? `<p class="role-affects-text${affects.fading ? ' is-fading' : ''}">${escapeHTML(affects.text)}</p>` : ''}
  </div>`;
}

function renderWhoCanResults() {
  const host = $('#who-can-results');
  if (!host) return;
  const term = $('#who-can-search')?.value.trim() || '';
  if (!term) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  const matches = state.whoCanMatches || [];
  host.innerHTML = matches.length
    ? matches.map(m => `<div class="who-can-match"><div class="who-can-phrase">${escapeHTML(m.phrase)}</div>${(m.roles || []).map(r => `<div class="who-can-role-line"><strong>${escapeHTML(r.name)}</strong>: ${(r.members || []).length ? r.members.map(mm => escapeHTML(mm.name)).join(', ') : 'no members'}</div>`).join('')}</div>`).join('')
    : '<p class="who-can-empty">No matches.</p>';
}

let whoCanDebounceTimer;
function bindWhoCanSearch() {
  const input = $('#who-can-search');
  if (!input || input.dataset.bound) return;
  input.dataset.bound = '1';
  input.addEventListener('input', () => {
    clearTimeout(whoCanDebounceTimer);
    const q = input.value.trim();
    if (!q) { state.whoCanMatches = []; renderWhoCanResults(); return; }
    whoCanDebounceTimer = setTimeout(async () => {
      try {
        const result = await api(`/roles/who_can?q=${encodeURIComponent(q)}`);
        if (input.value.trim() !== q) return; // stale response, typed on
        state.whoCanMatches = result.matches || [];
        renderWhoCanResults();
      } catch (error) { showNotice(`Search failed: ${error.message}`, 'error'); }
    }, 250);
  });
}

function renderRolesPage() {
  const summary = state.rolesSummary;
  const host = $('#roles-list');
  host.setAttribute('aria-busy', 'false');
  if (!summary) { host.innerHTML = '<div class="empty-state">Roles not loaded.</div>'; return; }
  // The locked (built-in) role, if present, is shown first -- it is a fixed
  // fact about the system, not something this list can rearrange or edit.
  const ordered = [...(summary.roles || [])].sort((a, b) => (b.locked ? 1 : 0) - (a.locked ? 1 : 0));
  host.innerHTML = ordered.length ? ordered.map(renderRoleRow).join('') : '<div class="empty-state">No roles configured. People default to no permissions.</div>';
  // Render the backend's own intro sentence when it sends one (field name not yet
  // finalized upstream); otherwise keep the static fallback already in index.html --
  // never build our own "scope list"-style copy here.
  const introText = summary.intro_text || summary.intro || summary.page_intro;
  const introLine = $('#roles-intro');
  if (introLine && introText) introLine.textContent = introText;
  const sources = summary.sources || [];
  const sourcesLine = $('#roles-sources');
  if (sourcesLine) sourcesLine.textContent = sources.length ? sources.map(s => `${s.label}: ${s.detail}`).join(' · ') : '';
  bindWhoCanSearch();
  renderWhoCanResults();
}

function showRoleAffects(name, text) {
  if (!text) return;
  if (!state.roleAffectsTimers) state.roleAffectsTimers = new Map();
  clearTimeout(state.roleAffectsTimers.get(name));
  state.roleAffectsText.set(name, { text, fading: false });
  renderRolesPage();
  state.roleAffectsTimers.set(name, setTimeout(() => {
    const cur = state.roleAffectsText.get(name);
    if (cur) { cur.fading = true; renderRolesPage(); }
    state.roleAffectsTimers.set(name, setTimeout(() => { state.roleAffectsText.delete(name); renderRolesPage(); }, 700));
  }, 3000));
}

async function renameRole(oldName, newName) {
  newName = (newName || '').trim();
  if (!newName || newName === oldName) { renderRolesPage(); return; }
  try {
    await post('/roles/rename', { name: oldName, new_name: newName });
    if (state.roleOpen.has(oldName)) { state.roleOpen.delete(oldName); state.roleOpen.add(newName); }
    await refreshRoles();
    showNotice(`Renamed to ${newName}.`);
  } catch (error) { showNotice(`Could not rename: ${error.message}`, 'error'); await refreshRoles(); }
}

async function setRoleLevel(name, system, level) {
  try {
    const result = await post('/roles/set_level', { role: name, system, level });
    state.roleOpen.add(name);
    await refreshRoles();
    showRoleAffects(name, result.affects_text);
  } catch (error) { showNotice(`Could not change ${name}: ${error.message}`, 'error'); await refreshRoles(); }
}

async function setRoleSend(name, system, on) {
  try {
    const result = await post('/roles/set_send', { role: name, system, on });
    state.roleOpen.add(name);
    await refreshRoles();
    showRoleAffects(name, result.affects_text);
  } catch (error) { showNotice(`Could not change ${name}: ${error.message}`, 'error'); await refreshRoles(); }
}

async function setRoleNotesLevel(name, level) {
  const role = (state.rolesSummary?.roles || []).find(r => r.name === name);
  const folders = ((role?.notes || {}).folders || []).filter(f => f.on).map(f => f.scope);
  try {
    const result = await post('/roles/set_notes', { role: name, level, folders });
    state.roleOpen.add(name);
    await refreshRoles();
    showRoleAffects(name, result.affects_text);
  } catch (error) { showNotice(`Could not change ${name}: ${error.message}`, 'error'); await refreshRoles(); }
}

async function setRoleNotesFolders(name) {
  const row = $(`[data-role-name="${CSS.escape(name)}"]`);
  const folders = row ? $$('[data-role-note-folder]', row).filter(cb => cb.checked).map(cb => cb.dataset.scope) : [];
  try {
    const result = await post('/roles/set_notes', { role: name, level: 'some', folders });
    state.roleOpen.add(name);
    await refreshRoles();
    showRoleAffects(name, result.affects_text);
  } catch (error) { showNotice(`Could not change ${name}: ${error.message}`, 'error'); await refreshRoles(); }
}

async function addRoleMemberByPerson(name, personId) {
  if (!personId) return;
  const p = state.people.find(pp => pp.id === personId);
  if (!p) return;
  try {
    await setPersonRole(personId, name, true);
    state.roleOpen.add(name);
    await refreshRoles();
    showNotice(`Added ${personName(p)} to ${name}.`);
  } catch { /* setPersonRole already reported the error */ }
}

async function removeRoleMemberByPerson(name, personId) {
  try {
    await setPersonRole(personId, name, false);
    state.roleOpen.add(name);
    await refreshRoles();
  } catch { /* setPersonRole already reported the error */ }
}

async function createRole(name) {
  name = (name || '').trim();
  if (!name) return;
  try {
    await post('/roles', { name, scopes: [], note: '' });
    state.roleOpen.add(name.toLowerCase());
    await refreshRoles();
    showNotice(`Created ${name}.`);
  } catch (error) { showNotice(`Could not create role: ${error.message}`, 'error'); }
}

async function showRoleDeletePreview(name) {
  const row = $(`[data-role-name="${CSS.escape(name)}"]`);
  if (!row) return;
  const confirmHost = row.querySelector('.role-delete-confirm');
  const trigger = row.querySelector('[data-delete-role-preview]');
  if (!confirmHost) return;
  try {
    const preview = await api(`/roles/delete_preview?role=${encodeURIComponent(name)}`);
    confirmHost.innerHTML = `<p class="role-delete-confirm-text">${escapeHTML(preview.text || '')}</p><div class="role-delete-confirm-actions"><button type="button" class="button button-danger" data-confirm-delete-role="${escapeHTML(name)}">Confirm delete</button><button type="button" class="button button-quiet" data-cancel-delete-role>Cancel</button></div>`;
    confirmHost.hidden = false;
    if (trigger) trigger.hidden = true;
  } catch (error) { showNotice(`Could not load delete preview: ${error.message}`, 'error'); }
}

function hideRoleDeletePreview(name) {
  const row = $(`[data-role-name="${CSS.escape(name)}"]`);
  if (!row) return;
  const confirmHost = row.querySelector('.role-delete-confirm');
  const trigger = row.querySelector('[data-delete-role-preview]');
  if (confirmHost) { confirmHost.hidden = true; confirmHost.innerHTML = ''; }
  if (trigger) trigger.hidden = false;
}

async function confirmDeleteRole(name) {
  try {
    await post('/roles/delete', { name });
    state.roleOpen.delete(name);
    showNotice(`Deleted ${name}.`);
    await refreshRoles();
  } catch (error) { showNotice(`Could not delete role: ${error.message}`, 'error'); }
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
state.scheduleHistoryOpen = new Set(); // schedule ids whose history panel is expanded
state.scheduleKinds = [];
state.reportOptions = [];
state.capabilityOptions = [];
state.weekdayOptions = [];

// Colour comes from `state` + `needs_approval`, never from parsing `state_label` text
// (the label wording -- "Running", "Waiting", "Paused", "Needs your yes", "Stopped",
// "Ended" -- is the API's to change without this breaking).
function stateClassForSchedule(schedule) {
  if (schedule.needs_approval) return 'pending';
  if (schedule.state === 'active') return 'running';
  return 'neutral'; // paused, proposed (without approval pending), ended: no alarm color
}

const OUTCOME_CLASS = { complete: 'neutral', incomplete: 'pending', failed: 'failed', interrupted: 'failed', skipped: 'neutral' };

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
  const outcomeClass = OUTCOME_CLASS[run.outcome] || 'neutral';
  return `<div class="schedule-last-run">
    <dt>Last run</dt>
    <dd>
      <span class="schedule-outcome schedule-outcome-${outcomeClass}">${escapeHTML(run.outcome_label)}</span>
      ${run.result_line ? `<span>${escapeHTML(run.result_line)}</span>` : ''}
      <span class="muted schedule-last-run-time">${escapeHTML(run.started_text)}</span>
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

function scheduleActionButtons(schedule) {
  return (schedule.actions || []).map(action => {
    const danger = action === 'stop' || action === 'reject';
    return `<button class="button ${danger ? 'button-danger' : 'button-quiet'}" type="button" data-schedule-action="${escapeHTML(action)}">${escapeHTML(ACTION_LABELS[action] || action)}</button>`;
  }).join('');
}

function scheduleCapabilitiesBlock(schedule) {
  const labels = (schedule.capabilities || []).map(c => c.label);
  // Not scopeChips(): that helper's default empty text says "no scopes" and its chip
  // is set in the mono face. Schedules never says the word "scopes" to the owner, and
  // the console's rule is no monospace anywhere, so this renders its own chip markup.
  return labels.length
    ? labels.map(label => `<span class="schedule-capability-chip">${escapeHTML(label)}</span>`).join('')
    : '<span class="muted">No capabilities</span>';
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
    <div class="scope-row">${scheduleCapabilitiesBlock(schedule)}</div>
    ${state.scheduleErrors.has(schedule.id) ? `<p class="schedule-inline-error">${escapeHTML(state.scheduleErrors.get(schedule.id))}</p>` : ''}
    <div class="schedule-action-row">
      <div class="schedule-actions">${scheduleActionButtons(schedule)}</div>
      <button class="schedule-history-toggle" type="button" data-schedule-history="${escapeHTML(schedule.id)}" aria-expanded="${state.scheduleHistoryOpen.has(schedule.id)}">Run history</button>
    </div>
    <div class="schedule-history-panel" data-schedule-history-panel="${escapeHTML(schedule.id)}">${state.scheduleHistoryOpen.has(schedule.id) ? scheduleHistoryBlock(schedule) : ''}</div>
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
}

function cadenceFieldsHTML(kind) {
  if (kind === 'once') return '<label>Date and time<input type="datetime-local" name="cadence_at"></label>';
  if (kind === 'every') return `<label>Every<span class="cadence-every"><input type="number" min="1" name="cadence_every_value" value="1"><select name="cadence_every_unit"><option value="minutes">minutes</option><option value="hours">hours</option></select></span></label>`;
  // Separate field names per kind even where two kinds look identical ("daily" and
  // "weekdays" both ask for just a time): both fields exist in the DOM at once (only
  // hidden, not removed), so a shared name makes form.cadence_time ambiguous --
  // accessing .value on it then silently reads as empty instead of throwing.
  if (kind === 'daily') return '<label>Time<input type="time" name="cadence_daily_time"></label>';
  if (kind === 'weekdays') return '<label>Time<input type="time" name="cadence_weekdays_time"></label>';
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
  if (kind === 'daily' && cadence.time) form.cadence_daily_time.value = cadence.time;
  if (kind === 'weekdays' && cadence.time) form.cadence_weekdays_time.value = cadence.time;
  if (kind === 'weekly') { if (cadence.day) form.cadence_day.value = cadence.day; if (cadence.time) form.cadence_weekly_time.value = cadence.time; }
  if (kind === 'cron' && cadence.expr) form.cadence_expr.value = cadence.expr;
}

function openScheduleEditor(schedule = null) {
  // Remembered so saveSchedule can tell whether the owner actually touched the
  // prompt or capabilities (which need a fresh yes) versus just cadence/report/
  // title/until (which the contract applies at once).
  state.editingSchedule = schedule || null;
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
  $('#schedule-scopes').innerHTML = state.capabilityOptions.map(opt => `<label class="scope-option" title="${escapeHTML((opt.tools || []).join(', '))}"><input type="checkbox" name="capabilities" value="${escapeHTML(opt.scope)}" ${selected.has(opt.scope) ? 'checked' : ''}><span class="capability-label">${escapeHTML(opt.label)}</span></label>`).join('');
  $('#schedule-dialog').showModal();
}

function cadencePayload(form) {
  const kind = form.cadence_kind.value;
  // The data contract's "at" is an ISO LOCAL datetime read in the schedule's own
  // timezone field, not a UTC instant -- the <input type=datetime-local> value is
  // already exactly that ("YYYY-MM-DDTHH:MM"), so send it as-is. Running it through
  // new Date(...).toISOString() would convert through the browser's own local zone
  // and tag it "Z" (UTC), shifting the time the owner actually picked.
  if (kind === 'once') return { at: form.cadence_at.value ? `${form.cadence_at.value}:00` : null };
  if (kind === 'every') {
    let minutes = Number(form.cadence_every_value.value || 0);
    if (form.cadence_every_unit.value === 'hours') minutes *= 60;
    return { minutes };
  }
  if (kind === 'daily') return { time: form.cadence_daily_time.value };
  if (kind === 'weekdays') return { time: form.cadence_weekdays_time.value };
  if (kind === 'weekly') return { day: form.cadence_day.value, time: form.cadence_weekly_time.value };
  if (kind === 'cron') return { expr: form.cadence_expr.value };
  return {};
}

async function saveSchedule(form) {
  const data = new FormData(form);
  const cadenceKind = data.get('cadence_kind');
  const reportValue = data.get('report_every_time');
  const prompt = data.get('prompt');
  const scopes = data.getAll('capabilities');
  const id = $('#schedule-id').value;
  const editing = state.editingSchedule;
  // On edit, the contract applies cadence/report/title/until at once but needs a
  // fresh yes for a prompt or capabilities change -- decided by whether the key is
  // even present in the request, not its value. Sending prompt/scopes unconditionally
  // (their current, often-unchanged, values) would ask for approval on every edit,
  // including a plain cadence change. Only include them when they actually differ,
  // or on create, where both are required regardless.
  const promptChanged = !editing || prompt !== editing.prompt;
  const scopesChanged = !editing || JSON.stringify([...scopes].sort()) !== JSON.stringify((editing.capabilities || []).map(c => c.scope).sort());
  const payload = {
    title: data.get('title'),
    cadence_kind: cadenceKind,
    cadence: cadencePayload(form),
    report_every_time: reportValue === 'true' ? true : reportValue === 'false' ? false : reportValue,
    // The data contract's `until` is epoch seconds (a number), not an ISO string.
    until: data.get('until') ? Math.floor(new Date(data.get('until')).getTime() / 1000) : null,
  };
  if (!id || promptChanged) payload.prompt = prompt;
  if (!id || scopesChanged) payload.scopes = scopes;
  if (id) payload.id = Number(id);
  setFormBusy(form, true);
  try {
    const result = await post(id ? '/schedules/edit' : '/schedules', payload);
    $('#schedule-dialog').close();
    // On create this is the full plain proposal paragraph (what it will do, when,
    // and whether it needs a yes) -- shown whole, with no auto-dismiss timeout so
    // it does not vanish before it is read.
    showNotice(result.message || 'Schedule saved.', 'info', 0);
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
  if (state.activeView === 'home' && state.overview) renderHome();
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
  const toggleRole = event.target.closest('[data-toggle-role]');
  if (toggleRole) {
    const name = toggleRole.closest('[data-role-name]').dataset.roleName;
    if (state.roleOpen.has(name)) state.roleOpen.delete(name); else state.roleOpen.add(name);
    renderRolesPage();
  }
  const removeRoleMemberButton = event.target.closest('[data-remove-role-member]');
  if (removeRoleMemberButton) removeRoleMemberByPerson(removeRoleMemberButton.closest('[data-role-name]').dataset.roleName, removeRoleMemberButton.dataset.removeRoleMember);
  const removePersonRoleButton = event.target.closest('[data-remove-person-role]');
  if (removePersonRoleButton) setPersonRole(state.selectedPerson, removePersonRoleButton.dataset.removePersonRole, false);
  const deleteRolePreviewButton = event.target.closest('[data-delete-role-preview]');
  if (deleteRolePreviewButton) showRoleDeletePreview(deleteRolePreviewButton.closest('[data-role-name]').dataset.roleName);
  const confirmDeleteRoleButton = event.target.closest('[data-confirm-delete-role]');
  if (confirmDeleteRoleButton) confirmDeleteRole(confirmDeleteRoleButton.dataset.confirmDeleteRole);
  const cancelDeleteRoleButton = event.target.closest('[data-cancel-delete-role]');
  if (cancelDeleteRoleButton) hideRoleDeletePreview(cancelDeleteRoleButton.closest('[data-role-name]').dataset.roleName);
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
  const homeActionButton = event.target.closest('[data-home-action]');
  if (homeActionButton) {
    homeActionButton.disabled = true;
    homeAction(JSON.parse(homeActionButton.dataset.homeAction)).finally(() => { homeActionButton.disabled = false; });
  }
  const resetSetting = event.target.closest('[data-reset-setting]');
  if (resetSetting) {
    const setting = state.settings.find(item => item.name === resetSetting.closest('[data-setting-name]').dataset.settingName);
    if (setting) saveSetting(setting, null);
  }
});

document.addEventListener('submit', event => {
  event.preventDefault();
  if (event.target.id === 'person-form') savePerson(event.target);
  if (event.target.id === 'schedule-form') saveSchedule(event.target);
  if (event.target.id === 'new-role-form') {
    const input = event.target.querySelector('[name="name"]');
    createRole(input.value);
    event.target.reset();
  }
});

document.addEventListener('focusout', event => {
  if (event.target.matches('[data-role-name-input]')) {
    renameRole(event.target.dataset.originalName, event.target.value);
  }
});

document.addEventListener('keydown', event => {
  if (event.target.matches('[data-role-name-input]') && event.key === 'Enter') {
    event.preventDefault();
    event.target.blur();
  }
});

document.addEventListener('change', event => {
  const levelSelect = event.target.closest('[data-role-level]');
  if (levelSelect) {
    setRoleLevel(levelSelect.closest('[data-role-name]').dataset.roleName, levelSelect.dataset.system, levelSelect.value);
    return;
  }
  const sendToggle = event.target.closest('[data-role-send]');
  if (sendToggle) {
    setRoleSend(sendToggle.closest('[data-role-name]').dataset.roleName, sendToggle.dataset.system, sendToggle.checked);
    return;
  }
  const notesLevel = event.target.closest('[data-role-notes-level]');
  if (notesLevel) {
    setRoleNotesLevel(notesLevel.closest('[data-role-name]').dataset.roleName, notesLevel.value);
    return;
  }
  const notesFolder = event.target.closest('[data-role-note-folder]');
  if (notesFolder) {
    setRoleNotesFolders(notesFolder.closest('[data-role-name]').dataset.roleName);
    return;
  }
  const addMemberSelect = event.target.closest('[data-add-role-member]');
  if (addMemberSelect) {
    const name = addMemberSelect.closest('[data-role-name]').dataset.roleName;
    const personId = addMemberSelect.value;
    addMemberSelect.value = '';
    addRoleMemberByPerson(name, personId);
    return;
  }
  const addPersonRole = event.target.closest('[data-add-person-role]');
  if (addPersonRole) {
    const roleName = addPersonRole.value;
    addPersonRole.value = '';
    if (roleName && state.selectedPerson) setPersonRole(state.selectedPerson, roleName, true);
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
$('#add-schedule')?.addEventListener('click', () => openScheduleEditor());
// A plain toggle button rather than <details>/<summary>: re-rendering an already-open
// <details> on every unrelated card update risks re-firing its own native toggle
// event (open state re-asserted on the freshly parsed element), which would re-render
// again, forever. A button has no such feedback loop.
document.addEventListener('click', event => {
  const toggle = event.target.closest('[data-schedule-history]');
  if (!toggle) return;
  const id = Number(toggle.dataset.scheduleHistory);
  if (state.scheduleHistoryOpen.has(id)) {
    state.scheduleHistoryOpen.delete(id);
    renderSchedules();
  } else {
    state.scheduleHistoryOpen.add(id);
    if (!state.scheduleHistory.has(id)) loadScheduleHistory(id);
    else renderSchedules();
  }
});
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
