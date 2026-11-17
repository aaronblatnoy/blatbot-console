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
  groups: [],
  health: null,
  inbox: null,
  outbox: null,
  followups: null,
  settings: [],
  settingStatus: {},
  selectedPerson: null,
  selectedWaiting: 0,
  activityFilter: 'all',
  activityLimit: 40,
  search: '',
  eventSource: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  noticeTimer: null,
  activeView: 'overview',
  taskId: null,
  loaded: Object.create(null),
  invalidated: Object.create(null),
  taskLedgers: new Map(),
};

const VIEW_PATHS = {
  overview: '/console/',
  approvals: '/console/approvals',
  runs: '/console/runs',
  inbox: '/console/inbox',
  timers: '/console/timers',
  memory: '/console/memory',
  permissions: '/console/permissions',
  scopes: '/console/permissions/all',
  outbox: '/console/outbox',
  people: '/console/people',
  groups: '/console/groups',
  pages: '/console/pages',
  settings: '/console/settings',
};
// Pages that live under another menu item: the menu marks the parent as current.
const NAV_PARENT = { scopes: 'permissions' };
const VIEW_TITLES = { overview: 'Overview', approvals: 'Approvals', runs: 'Runs', inbox: 'Event inbox', timers: 'Timers', memory: 'Memory',
  permissions: 'Permissions', scopes: 'Every permission', outbox: 'Outbox', people: 'People', groups: 'Group chats', pages: 'Pages', settings: 'Settings' };
// Every older address keeps working: each one moves to its new home.
const OLD_PATHS = {
  home: VIEW_PATHS.overview, requests: VIEW_PATHS.approvals, activity: VIEW_PATHS.runs, tasks: VIEW_PATHS.runs,
  messages: VIEW_PATHS.inbox, schedules: VIEW_PATHS.timers, followups: VIEW_PATHS.timers, roles: VIEW_PATHS.permissions,
  health: VIEW_PATHS.settings, scopes: VIEW_PATHS.scopes, overview: VIEW_PATHS.overview, approvals: VIEW_PATHS.approvals,
  runs: VIEW_PATHS.runs, inbox: VIEW_PATHS.inbox, timers: VIEW_PATHS.timers, memory: VIEW_PATHS.memory, permissions: VIEW_PATHS.permissions,
  outbox: VIEW_PATHS.outbox, people: VIEW_PATHS.people, groups: VIEW_PATHS.groups, pages: VIEW_PATHS.pages, settings: VIEW_PATHS.settings,
};
const OLD_DEEP_PATHS = { '/console/people/roles': VIEW_PATHS.permissions, '/console/people/groups': VIEW_PATHS.groups, '/console/scopes': VIEW_PATHS.scopes };
// Plain words for values the backend stores as code names. The stored value is unchanged.
const CHOICE_WORDS = {
  GATE_EXECUTOR: { claude: 'Claude Code', jev: 'Jev, the fast engine' },
  GATE_STRONG_MODEL: { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' },
  GATE_FAST_MODEL: { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' },
  GATE_TASK_PICKER: { jev: 'Typed judgments', router: 'The writing model' },
  GATE_HTML_PAGES_AUDIENCE: { off: 'No one', owner: 'Only you', everyone: 'Everyone' },
};
// Switches for finished migrations and engine internals: kept, but out of the everyday list.
const ADVANCED_SETTINGS = new Set(['GATE_INBOX', 'GATE_PERSON_INBOX', 'GATE_RUN_OUTCOMES', 'GATE_NATIVE_DEFER', 'GATE_AUTO_MODE',
  'GATE_DECIDE_GRAPH', 'GATE_TASK_PICKER', 'GATE_EXECUTOR', 'GATE_EXECUTOR_FALLBACK', 'SESSION_MAX_AGE_HOURS',
  'GATE_CONTEXT_BUDGET_CHARS', 'GATE_VAULT_ATTACH_BUDGET_CHARS', 'GATE_TELEGRAM_STALE_MIN', 'GATE_ACCESS_ASKS']);
const sentenceCase = value => { const text = String(value || ''); return text ? text[0].toUpperCase() + text.slice(1) : text; };
const roleLabel = name => sentenceCase(name);

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
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
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

// Plain words for the states the backend stores as code names.
const STATE_WORDS = {
  pending: 'Waiting on you', waiting_aaron: 'Waiting on you', running: 'Running', done: 'Done',
  failed: 'Failed', open: 'Open', approved: 'Approved', rejected: 'Declined', closed: 'Closed',
  interrupted: 'Interrupted', queued: 'Queued', sending: 'Sending', sent: 'Sent', held: 'Held',
  fired: 'Fired', cancelled: 'Cancelled',
};
const STATE_CLASS = { waiting_aaron: 'pending', open: 'neutral', approved: 'running', rejected: 'neutral', closed: 'neutral',
  queued: 'running', sending: 'running', sent: 'done', held: 'pending', fired: 'done', cancelled: 'neutral' };
function stateWord(value) { return STATE_WORDS[value] || String(value || '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()); }
function statePill(value) {
  return `<span class="state state-${escapeHTML(STATE_CLASS[value] || value || 'neutral')}">${escapeHTML(stateWord(value))}</span>`;
}
const SURFACE_WORDS = { telegram: 'Telegram', imessage: 'iMessage', sms: 'Text', text: 'Text', email: 'Email', voice: 'Phone', web: 'Web', schedule: 'Schedule', timer: 'Timer', console: 'Console', a2a: 'Agent' };
function surfaceWord(value) { return SURFACE_WORDS[String(value || '').toLowerCase()] || (value ? String(value) : ''); }

// Group messages are stored with a routing note in front ("[telegram group: X | from: Y |
// your reply goes to ...]") and runs sometimes start with "STATUS: OK". Neither is for a person
// to read: show the message itself, and the group as its own label.
function cleanText(value) {
  let text = String(value || '');
  let group = '';
  const m = text.match(/^\s*\[telegram group:\s*([^|\]]+)(?:\|[^\]]*)?\]\s*/i);
  if (m) { group = m[1].trim(); text = text.slice(m[0].length); }
  text = text.replace(/^((?:[^:\n]{1,60}):\s*)?STATUS:\s*(OK|DONE|STOP|INCOMPLETE|FAILED)\b[\s.:]*/i, '$1');
  return { text: text.trim(), group };
}
const clean = value => cleanText(value).text;
function uniqueNames(list = []) {
  return [...new Set(list.map(person => typeof person === 'string' ? person : (person.display || person.key || '')).filter(Boolean))];
}

function scopeChips(scopes = []) {
  return scopes.length
    ? scopes.map(scope => `<span class="scope-chip">${escapeHTML(scope)}</span>`).join('')
    : '<span class="muted">no scopes</span>';
}

function routeFromPath(pathname = location.pathname) {
  const path = pathname.replace(/\/+$/, '') || '/console';
  if (path === '/console') return { view: 'overview', taskId: null };
  for (const prefix of ['/console/runs/', '/console/activity/', '/console/tasks/']) {
    if (path.startsWith(prefix)) {
      const encodedId = path.slice(prefix.length);
      let taskId = encodedId;
      try { taskId = decodeURIComponent(encodedId); } catch { /* keep the raw id */ }
      const canonical = `${VIEW_PATHS.runs}/${encodeURIComponent(taskId)}`;
      return { view: 'runs', taskId, redirect: path === canonical ? null : canonical };
    }
  }
  const view = Object.keys(VIEW_PATHS).find(name => VIEW_PATHS[name].replace(/\/+$/, '') === path);
  if (view) return { view, taskId: null };
  if (OLD_DEEP_PATHS[path]) return { ...routeFromPath(OLD_DEEP_PATHS[path]), redirect: OLD_DEEP_PATHS[path] };
  const old = path.match(/^\/console\/([a-z]+)$/);
  if (old && OLD_PATHS[old[1]]) {
    const target = OLD_PATHS[old[1]];
    return { ...routeFromPath(target), redirect: target };
  }
  return { view: 'overview', taskId: null, unknown: true };
}

// A bookmark with an old #page address goes to that page's new home.
function oldHashTarget() {
  const name = (location.hash || '').replace(/^#\/?/, '').toLowerCase();
  return name && OLD_PATHS[name] ? OLD_PATHS[name] : null;
}

function updateWaitingCount() {
  const count = pendingRequests().length;
  const navBadge = $('#nav-waiting-count');
  navBadge.hidden = !count;
  navBadge.textContent = count;
  const approvalsCount = $('#approvals-count');
  if (approvalsCount) { approvalsCount.textContent = count; approvalsCount.className = `badge${count ? ' tone-waiting' : ''}`; }
}

async function refreshWaitingCount() {
  const pending = await api('/requests?state=pending');
  state.requests = [...pending, ...state.requests.filter(request => request.state !== 'pending')]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  updateWaitingCount();
}

async function loadView(view = state.activeView, { force = false } = {}) {
  if (!force && state.loaded[view] && !state.invalidated[view]) {
    if (view === 'runs' && state.taskId) await openTask(state.taskId);
    return;
  }
  try {
    const t = { throwOnError: true };
    if (view === 'overview') await refreshHome(t);
    if (view === 'approvals') await refreshApprovals(t);
    if (view === 'runs') await refreshActivity(t);
    if (view === 'inbox' || view === 'outbox') await refreshMessages(t);
    if (view === 'timers') await Promise.all([refreshSchedules(t), refreshMessages(t)]);
    if (view === 'memory') await refreshMemory(t);
    if (view === 'permissions') await Promise.all([refreshRoles(t), refreshSettings(t)]);
    if (view === 'scopes') await refreshScopesBreakdown(t);
    if (view === 'people') await refreshPeople(t);
    if (view === 'groups') await refreshGroups(t);
    if (view === 'pages') await refreshPages(t);
    if (view === 'settings') await Promise.all([refreshSettings(t), refreshHealth(t)]);
    state.loaded[view] = true; state.invalidated[view] = false;
    setStarting(false);
    if (view === 'runs' && state.taskId) await openTask(state.taskId);
  } catch (error) {
    if (error.status === 503) {
      setStarting(true, error.message || 'The console will retry when the API is ready.');
      renderUnavailable();
      window.setTimeout(() => loadSnapshot({ quiet: true }), 4000);
      return;
    }
    setStarting(false);
    if (!(error instanceof ApiError) && !state.retriedNetwork?.[view]) {
      // A dropped connection on first load: try once more before showing an error.
      state.retriedNetwork = { ...(state.retriedNetwork || {}), [view]: true };
      window.setTimeout(() => loadView(view, { force: true }), 1500);
      return;
    }
    showNotice(`Could not load ${VIEW_TITLES[view] || view}: ${error.message}`, 'error', 0);
    renderUnavailable();
  }
}

async function loadSnapshot({ quiet = false } = {}) {
  state.invalidated[state.activeView] = true;
  const loads = [loadView(state.activeView, { force: true })];
  if (state.activeView !== 'overview') loads.push(refreshWaitingCount());
  await Promise.all(loads);
  if (!quiet) showNotice('Console refreshed.');
}

function renderUnavailable() {
  for (const selector of ['#home-content', '#approvals-content', '#activity-list', '#inbox-content', '#outbox-content', '#memory-content', '#pages-content', '#people-list', '#groups-list', '#health-content', '#settings-list']) {
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
    const [overview, pending] = await Promise.all([api('/overview'), api('/requests?state=pending')]);
    state.overview = overview;
    state.requests = [...pending, ...state.requests.filter(request => request.state !== 'pending')]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    loadScopeLabels();
    // Older overview APIs omit the actual error; resolve it from the last run.
    if ((state.overview.stuck || []).some(row => row.kind === 'schedule' && /it did not say why/i.test(row.sentence))) {
      try {
        const payload = await api('/schedules');
        for (const row of state.overview.stuck) {
          const run = (payload.schedules || []).find(item => String(item.id) === String(row.id))?.last_run;
          if (row.kind === 'schedule' && /it did not say why/i.test(row.sentence) && (run?.result_line || run?.final_status)) {
            row.sentence = `${row.title}: ${run.result_line || run.final_status}`;
          }
        }
      } catch { /* Keep the overview usable if schedule details are unavailable. */ }
    }
    state.loaded.overview = true;
    state.invalidated.overview = false;
    renderHome();
    refreshLoopData();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Overview not refreshed: ${error.message}`, 'error');
  }
}

// The loop diagram's counts come from several read-only endpoints; any that fail leave their node at its last value.
async function refreshLoopData() {
  const get = path => api(path).catch(() => null);
  const [health, followups, schedules, memory, summary, groups, directory, settings] = await Promise.all([
    get('/health'), get('/followups'), get('/schedules'), get('/memory'), state.rolesSummary ? state.rolesSummary : get('/roles/summary'),
    get('/groups'), get('/people/directory'), state.settings.length ? state.settings : get('/settings')]);
  if (health) state.health = health;
  if (followups) state.followups = followups;
  if (schedules) state.schedules = schedules.schedules || state.schedules;
  if (memory) state.memory = memory;
  if (summary) state.rolesSummary = summary;
  if (groups) state.groups = groups.groups || state.groups;
  if (directory) { state.people = directory.people || state.people; state.contactKinds = directory.contact_kinds || state.contactKinds; }
  if (Array.isArray(settings)) state.settings = settings;
  const slot = $('#loop-slot');
  if (slot) slot.innerHTML = loopHTML();
  updateMessagesBadge();
  updateNavCounts();
}

// Overview wording comes from the API; legacy missing reasons are resolved
// from the schedule last run above. Labels and empty states are UI chrome.
const HOME_OUTCOME_STATE = { finished: 'done', could_not_finish: 'pending', declined: 'neutral', failed: 'failed' };
const HOME_OUTCOME_WORD = { finished: 'Finished', could_not_finish: 'Could not finish', declined: 'Declined', failed: 'Failed' };

function homeActionButtons(actions) {
  return (actions || [])
    .map(a => a.action === 'wait' ? `<span class="muted">${escapeHTML(a.label)}</span>` : `<button type="button" class="button ${a.action === 'approve' ? 'button-primary' : 'button-secondary'}" data-home-action="${escapeHTML(JSON.stringify(a))}">${escapeHTML(a.label)}</button>`)
    .join('');
}

function homeSection(id, title, count, body, { link = '', linkLabel = '', tone = '', icon: iconName = 'list' } = {}) {
  return `<section class="card home-block home-${id}" aria-labelledby="home-${id}-title">
    <header class="title-bar">
      <span class="tb-icon${tone ? ` tone-${tone}` : ''}">${icon(iconName)}</span>
      <h2 id="home-${id}-title">${escapeHTML(title)}</h2>
      <span class="badge${tone && count ? ` tone-${tone}` : ''}"${id === 'waiting' ? ' id="home-waiting-count"' : ''}>${escapeHTML(count)}</span>
      ${link ? `<div class="tb-actions"><a class="button button-secondary button-small" href="${VIEW_PATHS[link]}" data-route="${link}">${escapeHTML(linkLabel)}</a></div>` : ''}
    </header>
    ${body}
  </section>`;
}

function homeWaitingBlock() {
  const waiting = pendingRequests();
  const row = request => {
    const message = cleanText(request.original_message);
    const who = request.sender_name || request.sender || 'Someone';
    const ask = request.outcome?.ask?.question ? request.outcome.ask.question.replace(/^Asked you:\s*/, '') : '';
    return `<div class="row approval-row" data-request-id="${escapeHTML(request.id)}">
      <div class="row-lead">${avatar(who)}<div class="row-main"><span class="row-title">${escapeHTML(clean(request.summary) || message.text || 'No summary')}</span>
        <span class="row-meta">${channelMark(request.surface)}<span class="badge tone-waiting">#${escapeHTML(request.id)}</span><span class="pill">${escapeHTML(who)}</span>${message.group ? `<span class="pill">${escapeHTML(message.group)}</span>` : ''}${ask ? `<span class="outcome-pill outcome-asked">${icon('approvals')}<span>${escapeHTML(ask)}</span></span>` : ''}</span></div></div>
      <div class="row-actions"><button class="button button-primary button-small" type="button" data-decision="yes">Approve</button><button class="button button-secondary button-small" type="button" data-decision="no">Decline</button></div>
    </div>`;
  };
  return homeSection('waiting', 'Waiting on you', waiting.length,
    waiting.length ? `<div class="row-list">${waiting.map(row).join('')}</div>`
      : `<div class="approval-empty"><span class="tb-icon">${icon('done')}</span><span>Nothing is waiting on you.</span></div>`,
    { tone: 'waiting', icon: 'approvals', link: 'approvals', linkLabel: 'Open approvals' });
}

function homeStuckBlock() {
  // Approvals already sit in Waiting on you with their full card; Stuck lists the rest.
  const pendingIds = new Set(pendingRequests().map(request => String(request.id)));
  const rows = (state.overview?.stuck || []).filter(row => !(row.kind === 'approval' && pendingIds.has(String(row.id))));
  return homeSection('stuck', 'Stuck', rows.length, `<div>${rows.length
    ? `<ul class="row-list">${rows.map(row => `<li class="row stuck-row">
          <div class="row-main">
            <p class="row-title">${escapeHTML(clean(row.sentence))}</p>
            ${row.since_text ? `<span class="row-meta">${escapeHTML(row.since_text)}</span>` : ''}
          </div>
          <div class="row-actions">${homeActionButtons(row.actions)}</div>
        </li>`).join('')}</ul>`
    : '<p class="empty-line">Nothing is stuck.</p>'}</div>`, { tone: 'failed', icon: 'stuck' });
}

function homeRunningBlock() {
  const rows = state.overview?.running || [];
  return homeSection('running', 'Running', rows.length, `<div>${rows.length
    ? `<ul class="row-list">${rows.map(row => `<li class="row">
          <span class="state state-running">Running</span>
          <div class="row-main"><p class="row-title">${escapeHTML(clean(row.sentence))}</p>${row.latest_step ? `<span class="row-meta">${escapeHTML(row.latest_step)}</span>` : ''}</div>
          <span class="row-time">${escapeHTML(row.started_text || '')}</span>
        </li>`).join('')}</ul>`
    : '<p class="empty-line">Nothing is running.</p>'}</div>`, { link: 'runs', linkLabel: 'Runs', tone: 'running', icon: 'running' });
}

function homeDoneTodayBlock() {
  const rows = state.overview?.done_today || [];
  return homeSection('done', 'Done today', rows.length, `<div>${rows.length
    ? `<ul class="row-list">${rows.map(row => `<li class="row">
          <span class="state state-${HOME_OUTCOME_STATE[row.outcome] || 'neutral'}">${escapeHTML(HOME_OUTCOME_WORD[row.outcome] || row.outcome)}</span>
          <div class="row-main"><p class="row-title">${escapeHTML(clean(row.sentence))}</p></div>
          <span class="row-time">${escapeHTML(shortTimeText(row.time_text))}</span>
        </li>`).join('')}</ul>`
    : '<p class="empty-line">Nothing finished today yet.</p>'}</div>`, { link: 'runs', linkLabel: 'Runs', tone: 'done', icon: 'done' });
}

function homeComingUpBlock() {
  const rows = state.overview?.coming_up || [];
  return homeSection('coming', 'Coming up', rows.length, `<div>${rows.length
    ? `<ul class="row-list">${rows.map(s => `<li class="row">
          <div class="row-main"><p class="row-title">${escapeHTML(s.title)}</p><span class="row-meta">${escapeHTML(sentenceCase(s.cadence_text))}</span></div>
          <span class="row-time">${escapeHTML(shortTimeText(s.next_run_text))}</span>
        </li>`).join('')}</ul>`
    : '<p class="empty-line">Nothing scheduled.</p>'}</div>`, { link: 'timers', linkLabel: 'Timers', icon: 'coming' });
}

// "Mon Nov 16, 9:57 PM EST" reads as just the time when it is today.
function shortTimeText(text) {
  const value = String(text || '');
  const now = new Date();
  const part = options => new Intl.DateTimeFormat('en-US', options).format(now);
  const today = `${part({ weekday: 'short' })} ${part({ month: 'short' })} ${part({ day: 'numeric' })}`;
  return value.startsWith(`${today}, `) ? value.slice(today.length + 2) : value;
}

async function homeAction(action) {
  const target = action?.target || {};
  try {
    let result = null;
    if (target.endpoint === 'requests/decide') {
      await post('/requests/decide', { id: target.id, decision: target.decision });
    } else if (target.endpoint === 'requests/retry') {
      result = await post('/requests/retry', { id: target.id });
    } else if (target.endpoint === 'requests/dismiss') {
      result = await post('/requests/dismiss', { id: target.id });
    } else if (target.endpoint === 'schedules/approve') {
      await post('/schedules/approve', { id: target.id, approve: target.approve });
    } else if (target.endpoint === 'schedules/action') {
      await post('/schedules/action', { id: target.id, action: target.action });
    } else if (target.endpoint === 'schedules/edit') {
      await post('/schedules/edit', { id: target.id, scopes: target.scopes });
    } else if (target.endpoint === 'schedules/repair') {
      openRepairDialog(target.id);
      return;
    } else if (target.endpoint === 'schedules') {
      navigate(VIEW_PATHS.timers);
      return;
    } else {
      // An action target this build does not recognize must never fail
      // silently -- say so inline rather than doing nothing.
      showNotice(`I don't know how to do "${action?.label || 'that'}" yet.`, 'error');
      return;
    }
    showNotice((result && result.message) || 'Done.');
    await refreshHome({ throwOnError: false });
  } catch (error) {
    showNotice(`Could not do that: ${error.message}`, 'error');
  }
}

function renderHome() {
  const host = $('#home-content');
  host.setAttribute('aria-busy', 'false');
  if (!state.overview) { host.innerHTML = '<div class="empty-state">Data is not available yet.</div>'; return; }
  host.innerHTML = `<section class="card loop-card" aria-labelledby="loop-title">
      <header class="title-bar"><span class="tb-icon tone-flow">${icon('overview')}</span><h2 id="loop-title">How everything fits together</h2><span class="pill pill-live">${state.streamState === 'live' ? 'Live' : sentenceCase(state.streamState)}</span></header>
      <div id="loop-slot" class="loop-wrap">${loopHTML()}</div>
    </section>
    ${homeWaitingBlock()}
    <div class="overview-columns">${homeStuckBlock()}<div class="overview-side">${homeRunningBlock()}${homeComingUpBlock()}</div></div>
    ${homeDoneTodayBlock()}`;
  updateWaitingCount();
  updateNavCounts();
}

function renderRequests() {
  if (state.activeView === 'overview' && state.overview) renderHome();
  else if (state.activeView === 'approvals') renderApprovals();
  else updateWaitingCount();
}

// Plain names for the systems a request would use, from the scope registry.
async function loadScopeLabels() {
  if (state.scopeLabels || state.scopeLabelsLoading) return;
  state.scopeLabelsLoading = true;
  try {
    const [scopes, summary] = await Promise.all([api('/scopes'), state.rolesSummary ? state.rolesSummary : api('/roles/summary')]);
    const systems = Object.fromEntries((summary.systems || []).map(sys => [sys.system, sys.system_label]));
    state.scopeLabels = Object.fromEntries(scopes.map(scope => [scope.name, systems[scope.group] || sentenceCase(String(scope.group || scope.name).replace(/_/g, ' '))]));
    if (pendingRequests().some(request => (request.scopes || []).length)) renderRequests();
  } catch { state.scopeLabels = {}; }
  finally { state.scopeLabelsLoading = false; }
}
function scopeLabelChips(scopes = []) {
  const labels = [...new Set(scopes.map(scope => state.scopeLabels?.[scope] || sentenceCase(String(scope).replace(/[_:]/g, ' '))))];
  return labels.map(label => `<span class="tag">${escapeHTML(label)}</span>`).join('');
}

function requestCard(request, index) {
  const message = cleanText(request.original_message);
  const summary = clean(request.summary) || message.text || 'No summary';
  const where = [surfaceWord(request.surface), message.group].filter(Boolean).join(' in ');
  return `<article class="request-card${index === state.selectedWaiting ? ' is-selected' : ''}" data-request-id="${escapeHTML(request.id)}" data-waiting-index="${index}" data-request-detail="${escapeHTML(request.id)}" role="button" tabindex="0" aria-label="Waiting request from ${escapeHTML(request.sender_name || request.sender)}">
    <div class="request-main">
      <div class="request-who">
        ${avatar(request.sender_name || request.sender || '?', 'lg')}
        <div class="request-who-text">
          <div class="sender">${escapeHTML(request.sender_name || request.sender || 'Unknown sender')}</div>
          <div class="surface">${channelMark(request.surface)}<span>${escapeHTML(where || 'Unknown surface')}</span></div>
          <div class="request-id"><span class="badge tone-waiting">#${escapeHTML(request.id)}</span><span class="pill">${escapeHTML(relativeAge(request.created_at))}</span></div>
        </div>
      </div>
      <div class="request-body">
        <p class="request-summary">${escapeHTML(summary)}</p>
        ${request.outcome?.ask?.question ? `<p class="request-ask"><span class="pill tone-waiting">${request.outcome.ask.kind === 'permission' ? 'Needs your yes' : 'Needs your answer'}</span>${escapeHTML(request.outcome.ask.question.replace(/^Asked you:\s*/, ''))}</p>` : ''}
        ${request.scopes?.length ? `<div class="tag-line">${scopeLabelChips(request.scopes)}</div>` : ''}
        ${message.text && message.text !== summary ? `<details class="original-message"><summary>What they wrote</summary><blockquote>${escapeHTML(message.text)}</blockquote></details>` : ''}
      </div>
      <div class="request-actions">
        <button class="button button-primary" type="button" data-decision="yes">Approve</button>
        <button class="button button-secondary" type="button" data-decision="no">Decline</button>
        <button class="button button-quiet" type="button" data-show-edit aria-expanded="false">Edit</button>
      </div>
    </div>
    <div class="decision-note" hidden>
      <textarea aria-label="Edited instruction" placeholder="What it should do instead"></textarea>
      <button class="button button-primary" type="button" data-decision="edit">Run edit</button>
    </div>
  </article>`;
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
    showNotice(`Request #${requestId} ${stateWord(actualState).toLowerCase()}.`);
  } catch (error) {
    const actual = error.payload?.state || error.payload?.current_state || error.payload?.request?.state;
    const detail = actual ? `${error.message} Current state: ${actual}.` : error.message;
    showNotice(`Decision not applied: ${detail}`, 'error', 8000);
  } finally {
    state.invalidated.runs = true;
    if (state.activeView === 'approvals') await refreshApprovals(); else await refreshHome();
  }
}

async function refreshRoles({ throwOnError = false } = {}) {
  try {
    const [summary, directory, knowledge] = await Promise.all([api('/roles/summary'), api('/people/directory'), api('/knowledge').catch(() => null)]);
    state.rolesSummary = summary;
    state.knowledge = knowledge;
    state.people = directory.people || []; state.unassigned = directory.unlinked || []; state.contactKinds = directory.contact_kinds || [];
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
    .map(r => `<option value="${escapeHTML(r.name)}">${escapeHTML(roleLabel(r.name))}</option>`).join('');
}
function personRoleChips(p) {
  const chips = (p.role_badges || []).map(rb => `<span class="tag person-role-chip${rb.locked ? ' person-role-chip-locked' : ''}">${escapeHTML(roleLabel(rb.name))}${rb.locked ? '' : `<button type="button" class="person-role-chip-remove" data-remove-person-role="${escapeHTML(rb.name)}" aria-label="Remove ${escapeHTML(roleLabel(rb.name))} from ${escapeHTML(personName(p))}">&times;</button>`}</span>`).join('');
  const addControl = p.commander ? '' : `<span class="person-role-add"><select data-add-person-role aria-label="Add a role"><option value="">Add a role</option>${addableRoleOptions(p)}</select></span>`;
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
  $('#people-count').textContent = state.search ? `${people.length} of ${state.people.length}` : `${state.people.length}`;
  const peopleBadge = $('#people-badge'); if (peopleBadge) peopleBadge.textContent = state.people.length;
  $('#people-list').innerHTML = people.length ? people.map(p => `<button type="button" class="person-row${p.id === state.selectedPerson ? ' is-selected' : ''}" role="option" aria-selected="${p.id === state.selectedPerson}" data-person-key="${escapeHTML(p.id)}">${avatar(personName(p))}<span class="person-name">${escapeHTML(personName(p))}</span><span class="person-role">${escapeHTML(heldRoles(p.role).map(roleLabel).join(', ') || 'No role')}</span><span class="person-impact">${contactsOf(p).length} contact${contactsOf(p).length === 1 ? '' : 's'}</span></button>`).join('') : `<div class="empty-state">${state.people.length ? 'No people match this search.' : 'No people yet'}</div>`;
  const selected = state.people.find(p => p.id === state.selectedPerson);
  const unassigned = state.unassigned.filter(c => c.kind !== 'name');
  $('#unassigned-count').textContent = unassigned.length;
  $('#switch-unassigned-count').textContent = unassigned.length;
  $('#unassigned-list').innerHTML = unassigned.filter(c => !state.search || `${c.value} ${c.raw_value || ''} ${contactKind(c.kind).label}`.toLowerCase().includes(state.search.toLowerCase())).map(c => `<div class="unassigned-row" data-contact-id="${escapeHTML(c.id)}"><strong>${escapeHTML(c.raw_value || c.value)}</strong><span class="row-meta">${escapeHTML(contactKind(c.kind).label)}, seen ${escapeHTML(formatTime(c.last_seen))}</span><div class="unassigned-actions"><button type="button" class="button button-secondary button-small" data-assign ${selected ? '' : 'disabled'}>Assign to ${escapeHTML(selected ? personName(selected) : 'selected person')}</button><button type="button" class="button button-quiet button-small" data-new-contact-person>New person</button><button type="button" class="button button-quiet button-small is-danger" data-delete-unassigned>Delete</button></div></div>`).join('') || '<p class="empty-line">No unassigned contacts.</p>';
  $(`[data-person-key="${CSS.escape(state.selectedPerson || '')}"]`)?.scrollIntoView({block:'nearest'});
}
// Where Blatbot met this person and when, from auto-indexing; nothing for a record made by hand.
function personMet(p) {
  const places = p.met_in || [];
  if (!p.first_seen && !places.length) return '';
  const where = places.length ? `Met in ${places.map(escapeHTML).join(', ')}` : 'Met';
  return `<p class="person-met"><span class="pill">${where}</span>${p.first_seen ? `<span class="pill">First seen ${escapeHTML(formatTime(p.first_seen))}</span>` : ''}</p>`;
}
function renderPersonEditor() {
  const p = state.people.find(p => p.id === state.selectedPerson);
  state.editorPerson = p ? structuredClone(p) : null;
  state.personDirty = false;
  if (!p) { $('#person-editor').innerHTML = '<div class="empty-state">Select a person</div>'; return; }
  const contacts = contactsOf(p);
  $('#person-editor').innerHTML = `<div class="editor-head title-bar"><button type="button" class="button button-quiet button-small" data-person-back>All people</button>${avatar(personName(p), 'lg')}<h2>${escapeHTML(personName(p))}</h2><span class="chan-row">${[...new Set(contacts.map(c => c.kind))].map(kind => channelMark(kind)).join('')}</span></div><p id="person-external-change" hidden>Changed elsewhere. <button type="button" class="button button-secondary button-small" data-reload-person>Reload</button></p>
    <form id="person-form"><label class="field">Name<input name="display" value="${escapeHTML(p.display || '')}"></label><label class="field">Note<textarea name="note" rows="3">${escapeHTML(p.note || '')}</textarea></label><div class="person-save-actions"><button class="button button-primary" type="submit" disabled>Save</button><button class="button button-quiet" type="button" data-discard-person disabled>Discard</button><span id="person-dirty-label" class="row-meta" hidden>Unsaved changes</span></div></form>
    ${personMet(p)}${subBar('Contacts', 'user', contacts.length)}<div id="person-contacts">${contacts.length ? contacts.map(c => `<div class="person-contact" data-contact-id="${escapeHTML(c.id)}"><select aria-label="Contact type" data-contact-kind>${kindOptions(c.kind)}</select><input aria-label="Contact value" data-contact-value value="${escapeHTML(c.raw_value || c.value)}" placeholder="${escapeHTML(contactKind(c.kind).hint)}"><button class="button button-quiet button-small" type="button" data-remove-contact>Remove</button><div class="contact-status" role="status"></div></div>`).join('') : '<p class="empty-line">No contacts.</p>'}</div>
    <form id="contact-add-form" class="person-contact"><select aria-label="New contact type" name="kind">${kindOptions()}</select><input name="value" aria-label="New contact value" required placeholder="${escapeHTML((state.contactKinds || []).find(k => k.addable)?.hint || '')}"><button class="button button-secondary button-small" type="submit">Add</button><div class="contact-status" role="status"></div></form>
    <div class="person-access">${subBar('Roles', 'roles', heldRoles(p.role).length)}${personRoleChips(p)}<p class="person-can-text">${escapeHTML(p.can_text || '')}</p><p class="person-can-text-link"><a class="button button-secondary button-small" href="/console/permissions" data-route="permissions">Edit roles</a></p></div>
    ${p.commander ? '<p class="person-commander-note">This person cannot be deleted or merged into another person here.</p>' : `<details class="person-advanced"><summary>Move or merge</summary><form id="contact-move-form"><label class="field">Contact<select name="contact_id" required><option value="">Choose contact</option>${contacts.map(c => `<option value="${escapeHTML(c.id)}">${escapeHTML(contactKind(c.kind).label + ' ' + (c.raw_value || c.value))}</option>`).join('')}</select></label><label class="field">To person (or Unassigned)<select name="person_id"><option value="">Unassigned</option>${personOptions(p.id)}</select></label><button class="button button-secondary button-small" type="submit">Move</button></form><form id="person-merge-form"><label class="field">This is the same person as<select name="keep_id" required><option value="">Choose person</option>${personOptions(p.id)}</select></label><p class="row-meta">Their contacts move to that person. Roles and note are not combined.</p><button class="button button-secondary button-small" type="submit">Merge into them</button></form></details><div class="danger-zone"><button class="button button-secondary is-danger" type="button" data-delete-person>Delete person</button></div>`}`;
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
  try { const result = await post(path,body); if(result?.conflict) throw new ApiError('Contact conflict',409,result); state.invalidated.overview = true; state.invalidated.permissions = true; return result; }
  catch(error) { state.ownEvents = state.ownEvents.filter(t => t !== token); throw error; }
}
function handlePeopleEvent(event) {
  let payload; try { payload = JSON.parse(event.data); } catch { payload = {}; }
  state.ownEvents = state.ownEvents.filter(t => t.expires > Date.now());
  const index = state.ownEvents.findIndex(t => t.matches(payload));
  if(index >= 0) { state.ownEvents.splice(index,1); invalidateView('permissions',refreshRoles); invalidateHome(); return; }
  state.invalidated.people = true;
  if(state.activeView === 'people') refreshPeople({external:true});
  invalidateView('permissions',refreshRoles); invalidateHome();
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
    state.invalidated.permissions = true; showNotice('Saved.');
  } catch(error) { if(state.selectedPerson === id) { setFormBusy($('#person-editor'),false); markPersonDirty(); } showNotice(`Person not saved: ${error.message}`,'error'); }
  finally { delete form.dataset.saving; }
}
async function createPerson(display = '') {
  const p = await peoplePost('/people/create',{display},e => e.kind === 'person' && e.action === 'created');
  state.personDirty = false; state.selectedPerson = (p.person || p).id; await refreshPeople(); $('#person-form input')?.focus(); return state.selectedPerson;
}
async function immediatePeople(path,body,match) {
  const result = await peoplePost(path,body,match); await refreshPeople({localContacts:true}); state.invalidated.permissions = true; return result;
}
function showContactClash(host,error) {
  const payload = error.payload || {};
  if(error.status !== 409 || !payload.conflict) { showNotice(error.message,'error'); return; }
  const contact = payload.contact || state.people.flatMap(p => p.contacts || []).find(c => c.value === $('[data-contact-value],input[name="value"]',host)?.value);
  const status = $('.contact-status',host);
  const owner = !payload.existing_person_id ? 'Unassigned' : payload.existing_person_display && payload.existing_person_display !== payload.existing_person_id ? payload.existing_person_display : personName(state.people.find(p => p.id === payload.existing_person_id));
  status.innerHTML = `Already belongs to ${escapeHTML(owner)} <button type="button" class="button button-secondary button-small" data-clash-move="${escapeHTML(contact?.id || '')}">Move it here</button>`;
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
  const scopesBadge = $('#scopes-badge'); if (scopesBadge) scopesBadge.textContent = groups.reduce((n, g) => n + (g.scopes || []).length, 0);
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
    return `<li><label><input type="checkbox" data-role-note-folder data-scope="${escapeHTML(f.scope)}" ${on ? 'checked' : ''}> ${escapeHTML(sentenceCase(f.label))}</label></li>`;
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

const MEMORY_LEVEL_WORDS = { own: 'Own conversations', groups: 'Plus every group chat', all: 'Every conversation' };

function roleMemoryRow(role) {
  const levels = state.rolesSummary?.memory_levels || Object.entries(MEMORY_LEVEL_WORDS).map(([value, label]) => ({ value, label }));
  const level = role.memory?.level || 'own';
  return `<div class="role-notes-row">
    <div class="role-notes-head">
      <span class="role-system-label">Memory</span>
    </div>
    <div class="role-system-controls">
      <select class="role-system-level-select" data-role-memory-level aria-label="Memory reach">
        ${levels.map(l => `<option value="${escapeHTML(l.value)}" ${l.value === level ? 'selected' : ''}>${escapeHTML(l.label)}</option>`).join('')}
      </select>
    </div>
    ${(role.memory?.chats || []).length ? `<p class="role-knowledge-extra">Also: ${escapeHTML(role.memory.chats.join(', '))}</p>` : ''}
  </div>`;
}

function notesPill(notes) {
  const level = notes?.level || 'none';
  if (level === 'all') return `<span class="pill tone-accent">${icon('notes')}All notes</span>`;
  if (level === 'some') {
    const names = (notes.folders || []).filter(f => f.on !== false).map(f => typeof f === 'string' ? f : f.label).map(folderName);
    return names.map(n => `<span class="pill tone-waiting">${icon('notes')}${escapeHTML(n)}</span>`).join('');
  }
  return `<span class="pill">${icon('notes')}No notes</span>`;
}

function memoryPill(memory) {
  const level = memory?.level || 'own';
  const tone = level === 'all' ? ' tone-accent' : level === 'groups' ? ' tone-waiting' : '';
  return `<span class="pill${tone}">${icon('graph')}${escapeHTML(MEMORY_LEVEL_WORDS[level] || 'Own conversations')}</span>`;
}

function folderName(label) {
  return String(label || '').replace(/^read (all of )?your notes (in|on) /i, '');
}

function roleKnowledgeLine(role) {
  const folders = role.notes?.level === 'some' ? { ...role.notes, folders: (role.notes.folders || []).filter(f => f.on) } : role.notes;
  return `<div class="tag-line role-knowledge-line">${notesPill(folders)}${memoryPill(role.memory)}</div>`;
}

function roleMembersBlock(role) {
  const held = new Set((role.members || []).map(m => m.person_id));
  const addable = (state.people || []).filter(p => !held.has(p.id));
  return `<div class="role-members">
    <ul class="role-member-list">${(role.members || []).length ? role.members.map(m => `<li class="role-member-row"><span class="role-member-name">${escapeHTML(m.name || m.person_id)}</span>${role.locked ? '' : `<button type="button" class="button button-quiet button-small role-member-remove" data-remove-role-member="${escapeHTML(m.person_id)}">Remove</button>`}</li>`).join('') : '<li class="muted">No members</li>'}</ul>
    ${role.locked ? '' : `<div class="role-add-member"><select data-add-role-member aria-label="Add person to ${escapeHTML(roleLabel(role.name))}"><option value="">Add a person</option>${addable.map(p => `<option value="${escapeHTML(p.id)}">${escapeHTML(personName(p))}</option>`).join('')}</select></div>`}
  </div>`;
}

function roleDeleteBlock(role) {
  if (!(role.actions || []).includes('delete')) return '';
  return `<div class="role-delete-block">
    <button type="button" class="button button-secondary is-danger" data-delete-role-preview>Delete role</button>
    <div class="role-delete-confirm" hidden></div>
  </div>`;
}

function renderRoleRow(role) {
  const isOpen = state.roleOpen.has(role.name);
  const affects = state.roleAffectsText.get(role.name);
  const canRename = (role.actions || []).includes('rename');
  const renameHTML = canRename
    ? `<label class="field role-rename">Name<input class="role-name-input" data-role-name-input data-original-name="${escapeHTML(role.name)}" value="${escapeHTML(role.name)}" aria-label="Role name"></label>`
    : '';
  return `<div class="role-row${isOpen ? ' is-open' : ''}" role="button" tabindex="0" aria-expanded="${isOpen}" aria-label="${escapeHTML(roleLabel(role.name))} details" data-role-name="${escapeHTML(role.name)}">
    <div class="role-row-head">
      <div class="role-row-title"><span class="tb-icon">${icon(role.locked ? 'approvals' : 'roles')}</span><h3>${escapeHTML(roleLabel(role.name))}</h3>${role.locked ? '<span class="pill tone-accent">Built in</span>' : ''}</div>
      <span class="pill role-member-count">${role.member_count} ${role.member_count === 1 ? 'member' : 'members'}</span>
      <button type="button" class="button button-secondary button-small role-row-toggle" data-toggle-role aria-expanded="${isOpen}">${isOpen ? 'Done' : 'Edit'}</button>
    </div>
    <p class="role-row-can-text">${escapeHTML(role.can_text || '')}</p>
    ${roleKnowledgeLine(role)}
    ${isOpen ? `<div class="role-row-body">
      ${renameHTML}
      ${roleMembersBlock(role)}
      ${role.locked ? '' : `<div class="role-systems">${(role.systems || []).map(roleSystemControl).join('')}</div>`}
      ${role.locked ? '' : roleNotesRow(role)}
      ${role.locked ? '' : roleMemoryRow(role)}
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
    ? matches.map(m => `<div class="who-can-match"><div class="who-can-phrase">${escapeHTML(sentenceCase(m.phrase))}</div>${(m.roles || []).map(r => `<div class="who-can-role-line"><strong>${escapeHTML(roleLabel(r.name))}</strong>: ${(r.members || []).length ? r.members.map(mm => escapeHTML(mm.name)).join(', ') : 'no members'}</div>`).join('')}</div>`).join('')
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
  host.innerHTML = ordered.length ? ordered.map(renderRoleRow).join('') : '<p class="empty-line">No roles yet.</p>';
  const rolesBadge = $('#roles-badge'); if (rolesBadge) rolesBadge.textContent = ordered.length;
  renderKnowledgeAccess();
  renderAutoMode();
  bindWhoCanSearch();
  renderWhoCanResults();
}

function knowledgeRules(rules) {
  return `<div class="knowledge-rules">${(rules || []).map(r => `<div class="knowledge-rule"><span class="knowledge-rule-title">${escapeHTML(r.title)}</span><span class="knowledge-rule-text">${escapeHTML(r.text)}</span></div>`).join('')}</div>`;
}

function renderKnowledgeAccess() {
  const host = $('#knowledge-access');
  if (!host) return;
  host.setAttribute('aria-busy', 'false');
  const k = state.knowledge;
  if (!k) { host.innerHTML = '<p class="empty-line">Not loaded.</p>'; return; }
  const badge = $('#knowledge-badge'); if (badge) badge.textContent = k.counts?.beyond_own ?? 0;
  const people = k.people || [];
  const reach = people.filter(p => p.you || p.notes.level !== 'none' || p.memory.level !== 'own');
  const rest = people.filter(p => !reach.includes(p));
  const row = p => `<li class="row knowledge-person">
      <div class="row-main"><span class="row-title">${escapeHTML(p.you ? `${p.name} (you)` : p.name)}</span>
        <span class="row-sub tag-line">${(p.roles || []).map(r => `<span class="tag">${escapeHTML(r)}</span>`).join('')}</span></div>
      <span class="row-meta tag-line">${notesPill({ level: p.notes.level, folders: (p.notes.folders || []).map(label => ({ label })) })}${memoryPill(p.memory)}</span>
    </li>`;
  host.innerHTML = `${knowledgeRules(k.rules)}
    ${subBar('Reach beyond their own conversations', 'people', reach.length)}
    <ul class="row-list">${reach.map(row).join('')}</ul>
    ${rest.length ? `<details class="lane-more"><summary><span class="pill tone-accent">${escapeHTML(pl(rest.length, 'person', 'people'))} with no notes and their own conversations only</span></summary><ul class="row-list">${rest.map(row).join('')}</ul></details>` : ''}`;
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
    showNotice(`Renamed to ${roleLabel(newName)}.`);
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

async function setRoleMemoryLevel(name, level) {
  try {
    const result = await post('/roles/set_memory', { role: name, level });
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
    showNotice(`Added ${personName(p)} to ${roleLabel(name)}.`);
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
    showNotice(`Created ${roleLabel(name)}.`);
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
    showNotice(`Deleted ${roleLabel(name)}.`);
    await refreshRoles();
  } catch (error) { showNotice(`Could not delete role: ${error.message}`, 'error'); }
}

function setFormBusy(form, busy) {
  $$('button, input, select, textarea', form).forEach(control => { control.disabled = busy; });
}

// ---- How a run ended, and the always-on loop (inbox, outbox, timers) ----------------
// Every sentence here comes from the console API (outcome.text, kind_label, ...).
const RUN_OUTCOME_CLASS = { sent: 'done', quiet: 'neutral', asked: 'pending', deferred: 'pending', failed: 'failed', none: 'neutral' };
const OUTCOME_WORD = { sent: 'Sent', quiet: 'Quiet', asked: 'Asked you', deferred: 'Asked you', failed: 'Did not finish', none: 'Replied' };
function outcomeLine(outcome) {
  // "Replied with its closing text" is how every run ended before runs chose their own
  // ending, so it says nothing; only the choices a run made are shown.
  if (!outcome || !outcome.text || outcome.kind === 'none') return '';
  return outcomePill(outcome);
}

function relTime(value) {
  const n = Number(value);
  if (!n) return '';
  const diff = n - Date.now() / 1000;
  const abs = Math.abs(diff);
  const unit = abs < 90 ? [Math.round(abs), 's'] : abs < 5400 ? [Math.round(abs / 60), 'm'] : abs < 129600 ? [Math.round(abs / 3600), 'h'] : [Math.round(abs / 86400), 'd'];
  const text = `${unit[0]}${unit[1]}`;
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

function pulseHTML() {
  const inbox = state.inbox?.counts || state.health?.inbox || {};
  const outbox = state.outbox?.counts || state.health?.outbox || {};
  const timers = state.followups ? state.followups.pending : null;
  const cell = (label, value, cls = '') => `<div class="pulse-cell${cls && value ? ` ${cls}` : ''}"><span class="pulse-count">${escapeHTML(value ?? 0)}</span><span class="pulse-label">${escapeHTML(label)}</span></div>`;
  return `<div class="pulse" role="group" aria-label="Messages moving through Blatbot">
    <div class="pulse-stage"><span class="pulse-stage-name">In</span>${cell('waiting', inbox.pending, 'is-warn')}${cell('being handled', inbox.running, 'is-live')}${cell('failed', inbox.failed, 'is-bad')}</div>
    <div class="pulse-arrow" aria-hidden="true"></div>
    <div class="pulse-stage"><span class="pulse-stage-name">Out</span>${cell('sending', (outbox.queued || 0) + (outbox.sending || 0), 'is-live')}${cell('held', outbox.held, 'is-warn')}${cell('failed', outbox.failed, 'is-bad')}${cell('sent', outbox.sent)}</div>
    ${timers === null ? '' : `<div class="pulse-arrow" aria-hidden="true"></div><div class="pulse-stage"><span class="pulse-stage-name">Later</span>${cell('follow-ups set', timers, 'is-live')}</div>`}
  </div>`;
}

const INBOX_KINDS = [['all', 'All'], ['message', 'Messages'], ['timer', 'Timers'], ['schedule', 'Schedules'], ['webhook', 'Webhooks'], ['approval', 'Your answers']];
const INBOX_STATUSES = [['all', 'All'], ['open', 'Open'], ['done', 'Done'], ['failed', 'Failed']];
state.inboxKind = 'all';
state.inboxStatus = 'all';
state.outboxStatus = 'all';

function inboxEventMatches(event) {
  const kindOk = state.inboxKind === 'all' || event.kind === state.inboxKind;
  const status = event.status === 'pending' || event.status === 'running' ? 'open' : event.status;
  return kindOk && (state.inboxStatus === 'all' || status === state.inboxStatus);
}

function inboxLaneHTML(lane) {
  const busy = (lane.counts.pending || 0) + (lane.counts.running || 0);
  const events = (lane.events || []).filter(inboxEventMatches);
  if (!events.length) return '';
  const row = event => `<li class="msg-row">
      ${statePill(event.status === 'pending' ? 'queued' : event.status)}
      <span class="msg-main"><span class="msg-meta">${event.kind === 'timer' ? `<span class="chan chan-other">${icon('timers')}</span>` : channelMark(event.surface)}<span class="pill">${escapeHTML(event.kind_label)}</span>${event.where && event.where !== lane.label ? `<span class="pill">${escapeHTML(event.where)}</span>` : ''}</span><span class="msg-text">${escapeHTML(clean(event.preview) || (event.kind === 'timer' ? 'Checking back on its own' : 'No text'))}</span>${event.error ? `<span class="msg-error">${escapeHTML(event.error)}</span>` : ''}</span>
      <time title="${escapeHTML(formatTime(event.created_at))}">${escapeHTML(relTime(event.created_at))}</time>
    </li>`;
  const isGroup = String(lane.lane || '').startsWith('tg:-');
  return `<article class="lane-card${busy ? ' is-busy' : ''}">
    <header class="lane-head"><span class="who-line">${avatar(lane.label, isGroup ? 'group' : '')}<strong>${escapeHTML(lane.label)}</strong></span>
      <span class="lane-counts">${busy ? `<span class="pill tone-running">${busy} open</span>` : ''}${lane.counts.failed ? `<span class="pill tone-failed">${lane.counts.failed} failed</span>` : ''}<span class="badge">${events.length}</span></span></header>
    <ul class="msg-list">${events.slice(0, 4).map(row).join('')}</ul>
    ${events.length > 4 ? `<details class="lane-more"><summary><span class="pill tone-accent">Show ${events.length - 4} more</span></summary><ul class="msg-list">${events.slice(4).map(row).join('')}</ul></details>` : ''}
  </article>`;
}

function outboxRowHTML(row) {
  return `<li class="msg-row${row.status === 'failed' ? ' is-failed' : row.status === 'held' ? ' is-held' : ''}">
    ${statePill(row.status)}
    <span class="msg-main"><span class="msg-meta">${channelMark(row.surface)}<strong>${escapeHTML(row.to)}</strong>${row.kind_label ? `<span class="pill">${escapeHTML(row.kind_label)}</span>` : ''}${row.attempts > 1 ? `<span class="pill tone-waiting">${escapeHTML(row.attempts)} tries</span>` : ''}</span><span class="msg-text">${escapeHTML(clean(row.preview) || 'No text')}</span>${row.error ? `<span class="msg-error">${escapeHTML(row.error)}</span>` : ''}</span>
    <time title="${escapeHTML(formatTime(row.sent_at || row.created_at))}">${escapeHTML(relTime(row.sent_at || row.created_at))}</time>
  </li>`;
}

// A schedule is a follow-up (the article's sense: a run checks back until something
// happens) when it was stored with a stop condition. Decided from the stored cadence,
// never from the title.
function isFollowupSchedule(schedule) { return Boolean(schedule?.cadence?.stop_when); }
function timerCounts() {
  const active = (state.schedules || []).filter(sch => sch.state === 'active');
  const followSchedules = active.filter(isFollowupSchedule).length;
  return { followups: (state.followups?.pending || 0) + followSchedules, schedules: active.length - followSchedules };
}

function followupRowHTML(row) {
  return `<li class="msg-row">
    ${statePill(row.status)}
    <span class="msg-main"><span class="msg-meta">${avatar(row.for)}<strong>${escapeHTML(row.for)}</strong>${row.task_id ? `<span class="badge">T${escapeHTML(row.task_id)}</span>` : ''}</span><span class="msg-text">${escapeHTML(row.note || 'Check back')}</span>${row.result ? `<span class="msg-meta">${escapeHTML(row.result)}</span>` : ''}</span>
    <time title="${escapeHTML(formatTime(row.due_at))}">${escapeHTML(row.status === 'pending' ? relTime(row.due_at) : relTime(row.fired_at || row.due_at))}</time>
  </li>`;
}

function segmentedHTML(name, options, current, counts = {}) {
  return `<div class="segmented" role="group" aria-label="${escapeHTML(name)}">${options.map(([value, label]) => `<button type="button" data-seg="${escapeHTML(name)}" data-value="${escapeHTML(value)}" aria-pressed="${value === current}">${escapeHTML(label)}${counts[value] != null ? ` <span class="seg-count">${escapeHTML(counts[value])}</span>` : ''}</button>`).join('')}</div>`;
}

function renderInbox() {
  const host = $('#inbox-content');
  if (!host) return;
  host.setAttribute('aria-busy', 'false');
  const counts = state.inbox?.counts || {};
  const lanes = state.inbox?.lanes || [];
  const all = lanes.flatMap(lane => lane.events || []);
  const kindCounts = { all: all.length };
  all.forEach(event => { kindCounts[event.kind] = (kindCounts[event.kind] || 0) + 1; });
  const kinds = INBOX_KINDS.filter(([value]) => value === 'all' || kindCounts[value]);
  const open = (counts.pending || 0) + (counts.running || 0);
  $('#inbox-badge').textContent = open; $('#inbox-badge').className = `badge${open ? ' tone-running' : ''}`;
  const lanesHTML = lanes.map(inboxLaneHTML).filter(Boolean);
  host.innerHTML = `<div class="stat-cards">
      ${statCard({ label: 'Waiting', icon: 'inbox', value: counts.pending || 0, tone: counts.pending ? 'waiting' : '' })}
      ${statCard({ label: 'Being handled', icon: 'running', value: counts.running || 0, tone: counts.running ? 'running' : '' })}
      ${statCard({ label: 'Done', icon: 'done', value: counts.done || 0, tone: 'done' })}
      ${statCard({ label: 'Failed', icon: 'stuck', value: counts.failed || 0, tone: counts.failed ? 'failed' : '' })}
      ${statCard({ label: 'Events per hour', icon: 'chart', chart: sparkBars(hourBuckets(all.map(e => e.created_at), 24), 'flow'), axis: ['24h ago', 'Now'] })}
    </div>
    <section class="card">
      <header class="title-bar"><span class="tb-icon">${icon('user')}</span><h2>Lanes by person</h2><span class="badge">${lanes.length}</span>
        <div class="tb-actions">${segmentedHTML('Source', kinds, state.inboxKind, kindCounts)}${segmentedHTML('Status', INBOX_STATUSES, state.inboxStatus)}</div></header>
      ${lanesHTML.length ? `<div class="lane-grid card-body">${lanesHTML.join('')}</div>` : `<p class="empty-line">${lanes.length ? 'No events match these filters.' : 'Nothing has come in yet.'}</p>`}
    </section>`;
}

function renderOutbox() {
  const host = $('#outbox-content');
  if (!host) return;
  host.setAttribute('aria-busy', 'false');
  const counts = state.outbox?.counts || {};
  const rank = { failed: 0, held: 1, sending: 2, queued: 3, sent: 4 };
  const rows = [...(state.outbox?.rows || [])].sort((a, b) => (rank[a.status] ?? 5) - (rank[b.status] ?? 5) || b.id - a.id);
  const shown = rows.filter(row => state.outboxStatus === 'all' || row.status === state.outboxStatus);
  const trouble = (counts.failed || 0) + (counts.held || 0);
  const moving = (counts.queued || 0) + (counts.sending || 0);
  const dispatcher = trouble ? ['Needs you', 'failed'] : moving ? ['Sending', 'running'] : ['Idle', 'done'];
  $('#outbox-badge').textContent = counts.sent || 0;
  const cell = (label, value, tone) => `<div class="dispatch-cell"><span class="stat-card-label">${escapeHTML(label)}</span><span class="stat-card-value"${value && tone ? ` style="color:var(--${tone})"` : ''}>${escapeHTML(value || 0)}</span></div>`;
  const days = dayBuckets(rows.filter(r => r.status === 'sent').map(r => r.sent_at || r.created_at), 14);
  host.innerHTML = `<section class="card">
      <header class="title-bar"><span class="tb-icon tone-flow">${icon('dispatcher')}</span><h2>Dispatcher</h2><span class="pill tone-${dispatcher[1]}">${dispatcher[0]}</span></header>
      <div class="dispatch-strip">${cell('Queued', counts.queued, 'running')}${cell('Sending', counts.sending, 'running')}${cell('Held', counts.held, 'waiting')}${cell('Failed', counts.failed, 'failed')}${cell('Sent', counts.sent, '')}</div>
    </section>
    <div class="stat-cards">
      ${statCard({ label: 'Sends per day', icon: 'chart', value: days.reduce((a, b) => a + b, 0), unit: 'in 14 days', chart: sparkBars(days), axis: ['14 days ago', 'Today'] })}
      ${statCard({ label: 'Replies', icon: 'outbox', value: rows.filter(r => r.kind === 'reply').length, unit: 'recent' })}
      ${statCard({ label: 'Notices to you', icon: 'reported', value: rows.filter(r => r.kind === 'notice').length, unit: 'recent' })}
      ${statCard({ label: 'Approval asks', icon: 'approvals', value: rows.filter(r => r.kind === 'approval').length, unit: 'recent', tone: 'waiting' })}
    </div>
    <section class="card">
      <header class="title-bar"><span class="tb-icon">${icon('outbox')}</span><h2>Outcomes delivered</h2><span class="badge">${shown.length}</span>
        <div class="tb-actions">${segmentedHTML('Outbox status', [['all', 'All'], ['queued', 'Queued'], ['sending', 'Sending'], ['held', 'Held'], ['failed', 'Failed'], ['sent', 'Sent']], state.outboxStatus, { all: rows.length, ...countBy(rows, 'status') })}</div></header>
      ${shown.length ? `<ul class="msg-list">${shown.slice(0, 40).map(outboxRowHTML).join('')}</ul>` : '<p class="empty-line">Nothing here.</p>'}
    </section>`;
}

function renderFollowups() {
  const host = $('#followups-content');
  if (!host) return;
  const timers = state.followups?.rows || [];
  const followSchedules = (state.schedules || []).some(isFollowupSchedule);
  host.innerHTML = state.followups && !state.followups.available && !followSchedules ? '<p class="empty-line">Follow-up timers are off on this server.</p>'
    : timers.length ? `<ul class="msg-list">${timers.slice(0, 30).map(followupRowHTML).join('')}</ul>` : followSchedules ? '' : '<p class="empty-line">No follow-ups set.</p>';
  updateTimersBadge();
}

function updateTimersBadge() {
  const badge = $('#timers-badge');
  if (!badge) return;
  const { followups, schedules } = timerCounts();
  badge.textContent = followups + schedules;
  const fb = $('#followups-badge'); if (fb) { fb.textContent = followups; fb.className = `badge${followups ? ' tone-running' : ''}`; }
  const sb = $('#schedules-badge'); if (sb) sb.textContent = (state.schedules || []).filter(sch => !isFollowupSchedule(sch)).length;
}

function renderMessages() {
  renderInbox();
  renderOutbox();
  renderFollowups();
  updateMessagesBadge();
  updateNavCounts();
}

function updateMessagesBadge() {
  const outbox = state.outbox?.counts || state.health?.outbox || {};
  const inbox = state.inbox?.counts || state.health?.inbox || {};
  const trouble = (outbox.failed || 0) + (outbox.held || 0) + (inbox.failed || 0);
  const badge = $('#nav-messages-count');
  if (!badge) return;
  badge.hidden = !trouble;
  badge.textContent = trouble;
}

async function refreshMessages({ throwOnError = false } = {}) {
  try {
    const [inbox, outbox, followups] = await Promise.all([api('/inbox'), api('/outbox'), api('/followups')]);
    Object.assign(state, { inbox, outbox, followups });
    renderMessages();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Messages not refreshed: ${error.message}`, 'error');
  }
}

async function refreshPulse() {
  try {
    state.health = await api('/health');
    updateMessagesBadge();
  } catch { /* An older API without these counts keeps the menu as it was. */ }
}

// ---- Activity: every task, and every run that is not part of a listed task -----------
const ACTIVITY_STATUS_WORD = { waiting: 'Waiting on you', running: 'Running', done: 'Done', failed: 'Failed', open: 'Open' };
const ACTIVITY_STATUS_CLASS = { waiting: 'pending', running: 'running', done: 'done', failed: 'failed', open: 'neutral' };
const REQUEST_STATUS = { pending: 'waiting', running: 'running', done: 'done', failed: 'failed' };
function taskStatus(task) {
  const runs = task.runs || [];
  if (task.state === 'waiting_aaron' || runs.some(run => run.state === 'pending')) return 'waiting';
  if (task.state === 'running' || runs.some(run => run.state === 'running')) return 'running';
  if (task.state === 'failed') return 'failed';
  if (task.state === 'done' || task.state === 'closed') return 'done';
  return 'open';
}
function activityRows() {
  const inTasks = new Set(state.tasks.flatMap(task => (task.runs || []).map(run => String(run.id))));
  const tasks = state.tasks.map(task => ({
    kind: 'task', id: task.id, status: taskStatus(task), title: clean(task.title) || 'Untitled task', surface: (task.runs || [])[0]?.surface || '',
    where: cleanText(task.title).group, who: uniqueNames(task.participants || []).join(', '),
    outcome: task.outcome, at: Number(task.updated_at) || 0, runs: (task.runs || []).length,
  }));
  const runs = state.requests.filter(request => !inTasks.has(String(request.id))).map(request => ({
    kind: 'run', id: request.id, status: REQUEST_STATUS[request.state] || 'open',
    title: clean(request.summary) || clean(request.original_message) || 'Run', where: cleanText(request.original_message).group,
    who: request.sender_name || request.sender || '', outcome: request.outcome, at: Number(request.updated_at || request.created_at) || 0, surface: request.surface,
  }));
  return [...tasks, ...runs].sort((a, b) => b.at - a.at);
}
function activityRowHTML(row) {
  const attrs = row.kind === 'task' ? `data-task-id="${escapeHTML(row.id)}"` : `data-request-detail="${escapeHTML(row.id)}"`;
  return `<button class="row activity-row" type="button" ${attrs}>
    <span class="state state-${ACTIVITY_STATUS_CLASS[row.status]}">${ACTIVITY_STATUS_WORD[row.status]}</span>
    <span class="row-main"><span class="row-title">${escapeHTML(row.title)}</span><span class="row-meta">${row.surface ? channelMark(row.surface) : ''}<span class="badge">${row.kind === 'task' ? `Session T${escapeHTML(row.id)}` : `Run #${escapeHTML(row.id)}`}</span>${row.kind === 'task' && row.runs ? `<span class="pill">${row.runs} ${row.runs === 1 ? 'run' : 'runs'}</span>` : ''}${row.where ? `<span class="pill">${escapeHTML(row.where)}</span>` : ''}${row.outcome && row.outcome.kind !== 'none' && row.outcome.text ? outcomePill(row.outcome) : ''}</span></span>
    <span class="row-who">${row.who ? `${avatar(row.who.split(',')[0])}<span>${escapeHTML(row.who)}</span>` : ''}</span>
    <time class="row-time" datetime="${escapeHTML(row.at ? new Date(row.at * 1000).toISOString() : '')}">${escapeHTML(formatTime(row.at))}</time>
  </button>`;
}
function renderActivity() {
  const host = $('#activity-list');
  host.setAttribute('aria-busy', 'false');
  const rows = activityRows();
  const counts = { all: rows.length };
  rows.forEach(row => { counts[row.status] = (counts[row.status] || 0) + 1; });
  $$('[data-activity-count]').forEach(node => { node.textContent = counts[node.dataset.activityCount] || 0; });
  $$('[data-activity-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.activityFilter === state.activityFilter)));
  const shown = rows.filter(row => state.activityFilter === 'all' || row.status === state.activityFilter);
  const limit = state.activityLimit || 40;
  host.innerHTML = shown.length
    ? shown.slice(0, limit).map(activityRowHTML).join('') + (shown.length > limit ? `<div class="row-list-more"><button type="button" class="button button-secondary" data-activity-more>Show ${Math.min(40, shown.length - limit)} more</button></div>` : '')
    : `<p class="empty-line">${state.activityFilter === 'all' ? 'No runs yet.' : `Nothing ${ACTIVITY_STATUS_WORD[state.activityFilter].toLowerCase()}.`}</p>`;
  const outcomes = countBy(state.requests.map(r => ({ kind: r.outcome?.kind || 'none' })), 'kind');
  const stats = $('#runs-stats');
  if (stats) stats.innerHTML = `
    ${statCard({ label: 'Runs per hour', icon: 'chart', value: state.requests.filter(r => Number(r.created_at) > Date.now() / 1000 - 86400).length, unit: 'today', chart: sparkBars(hourBuckets(state.requests.map(r => r.created_at), 24)), axis: ['24h ago', 'Now'] })}
    ${statCard({ label: 'Sent', icon: 'outbox', value: outcomes.sent || 0, tone: 'done' })}
    ${statCard({ label: 'Stayed quiet', icon: 'runs', value: outcomes.quiet || 0 })}
    ${statCard({ label: 'Deferred to you', icon: 'approvals', value: (outcomes.asked || 0) + (outcomes.deferred || 0), tone: 'waiting', href: VIEW_PATHS.approvals, route: 'approvals' })}
    ${statCard({ label: 'Did not finish', icon: 'stuck', value: outcomes.failed || 0, tone: outcomes.failed ? 'failed' : '' })}`;
  updateNavCounts();
}
async function refreshActivity({ throwOnError = false } = {}) {
  try {
    const [tasks, ...requests] = await Promise.all([api('/tasks'), ...['pending', 'running', 'done', 'failed'].map(requestState => api(`/requests?state=${requestState}`))]);
    state.tasks = tasks;
    state.requests = requests.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    renderActivity();
    updateWaitingCount();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Activity not refreshed: ${error.message}`, 'error');
  }
}

// A task's ledger is the list of events the API returns for it, oldest first. Each one
// is shown whole: when it happened, what kind of event it was, and its full text.
function renderLedger(task) {
  const events = Array.isArray(task.events) ? task.events : [];
  const host = $('#ledger-content');
  const runs = Array.isArray(task.runs) ? task.runs : [];
  const runsHTML = runs.length ? `<section class="ledger-runs card">${subBar('Runs in this session', 'runs', runs.length)}<ul class="msg-list">${runs.map(run => `<li class="msg-row">${statePill(run.state)}<span class="msg-main"><span class="msg-meta">${channelMark(run.surface)}<span class="badge">#${escapeHTML(run.id)}</span></span><span class="msg-text">${escapeHTML(clean(run.summary) || 'Run')}</span>${outcomeLine(run.outcome)}</span><time>${escapeHTML(relTime(run.created_at))}</time></li>`).join('')}</ul></section>` : '';
  if (!events.length) { host.innerHTML = runsHTML || 'No ledger entries recorded.'; return; }
  host.innerHTML = runsHTML + events.map(event => {
    const when = event.created_at ? new Date(event.created_at * 1000).toISOString() : '';
    return `<article class="ledger-entry">
      <header class="ledger-meta">
        <span class="pill ledger-kind ledger-kind-${escapeHTML(event.kind || 'note')}">${escapeHTML(stateWord(event.kind || 'note'))}</span>
        <time datetime="${escapeHTML(when)}">${escapeHTML(formatTime(event.created_at))}</time>
        ${event.request_id ? `<span class="badge">#${escapeHTML(event.request_id)}</span>` : ''}
      </header>
      <div class="ledger-text">${escapeHTML(cleanText(event.text).group ? `${cleanText(event.text).group}: ${clean(event.text)}` : (event.text || ''))}</div>
    </article>`;
  }).join('');
}

async function openTask(taskId) {
  const dialog = $('#task-dialog');
  $('#ledger-id').textContent = `T${taskId}`;
  if (!dialog.open) dialog.showModal();
  const cached = state.taskLedgers.get(taskId);
  if (cached) {
    $('#ledger-title').textContent = cached.title || 'Task ledger';
    renderLedger(cached);
    return;
  }
  $('#ledger-title').textContent = 'Loading session';
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
  const line = item => escapeHTML(typeof item === 'string' ? item : (item?.text || item?.message || JSON.stringify(item)));
  const problems = interruptedCount + errors.length + (tunnelUp ? 0 : 1);
  $('#health-content').innerHTML = `<section class="card"><header class="title-bar"><span class="tb-icon tone-${problems ? 'waiting' : 'done'}">${icon('system')}</span><h2>System</h2><span class="pill tone-${tunnelUp && !errors.length ? 'done' : 'waiting'}">${tunnelUp && !errors.length ? 'Healthy' : 'Check'}</span></header>
  <dl class="stat-strip">
    <div class="stat"><dt>Tunnel</dt><dd><span class="state state-${tunnelUp ? 'done' : 'failed'}">${tunnelUp ? 'Up' : 'Down'}</span>${tunnelWhere ? `<span class="stat-note">${escapeHTML(String(tunnelWhere).replace(/^https?:\/\//, ''))}</span>` : ''}</dd></div>
    <div class="stat"><dt>Uptime</dt><dd class="num">${escapeHTML(formatDuration(state.health.uptime_s ?? state.health.uptime_seconds))}</dd></div>
    <div class="stat"><dt>Last restart</dt><dd class="num">${escapeHTML(formatTime(state.health.last_restart))}</dd></div>
    <div class="stat"><dt>Interrupted runs</dt><dd class="num${interruptedCount ? ' is-warn' : ''}">${interruptedCount}</dd></div>
    <div class="stat"><dt>Recent errors</dt><dd class="num${errors.length ? ' is-bad' : ''}">${errors.length}</dd></div>
  </dl>
  ${interrupted.length || errors.length ? `<ul class="row-list system-log">${interrupted.map(item => `<li class="row"><span class="state state-pending">Interrupted</span><span class="row-main"><span class="row-title">${line(item)}</span></span></li>`).join('')}${errors.map(item => `<li class="row"><span class="state state-failed">Error</span><span class="row-main"><span class="row-title">${line(item)}</span></span></li>`).join('')}</ul>` : ''}</section>`;
}

async function refreshHealth({ throwOnError = false } = {}) {
  try {
    state.health = await api('/health');
    renderHealth();
  }
  catch (error) {
    if (throwOnError) throw error;
    showNotice(`Health not refreshed: ${error.message}`, 'error');
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
  repair: 'Repair and resume',
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
  const failureLabels = { usage_limit: 'Usage limit', missing_permission: 'Missing permission',
    tool_network_error: 'Tool or network error', could_not_finish: 'Could not finish' };
  return `<div class="schedule-last-run">
    <dt>Last run</dt>
    <dd>
      <span class="schedule-outcome schedule-outcome-${outcomeClass}">${escapeHTML(run.outcome_label)}</span>
      ${run.result_line || run.final_status ? `<span>${escapeHTML(run.result_line || run.final_status)}</span>` : ''}
      ${run.failure_class ? `<span>${escapeHTML(failureLabels[run.failure_class] || run.failure_class)}</span>` : ''}
      ${schedule.retry_text ? `<span class="muted">Auto-retrying ${escapeHTML(schedule.retry_text)}</span>` : ''}
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
    <button class="button button-secondary button-small" type="button" data-schedule-let-it>Let it ${labels}</button>
  </p>`;
}

function scheduleActionButtons(schedule) {
  return (schedule.actions || []).map(action => {
    const danger = action === 'stop' || action === 'reject';
    const primary = action === 'approve' || action === 'repair';
    return `<button class="button ${primary ? 'button-primary' : 'button-secondary'}${danger ? ' is-danger' : ''} button-small" type="button" data-schedule-action="${escapeHTML(action)}">${escapeHTML(ACTION_LABELS[action] || action)}</button>`;
  }).join('');
}

function scheduleCapabilitiesBlock(schedule) {
  const labels = (schedule.capabilities || []).map(c => c.label);
  // Not scopeChips(): that helper's default empty text says "no scopes" and its chip
  // is set in the mono face. Schedules never says the word "scopes" to the owner, and
  // the console's rule is no monospace anywhere, so this renders its own chip markup.
  return labels.length
    ? labels.map(label => `<span class="tag">${escapeHTML(sentenceCase(label))}</span>`).join('')
    : '';
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
          <td>${escapeHTML(run.result_line || run.final_status || 'No result recorded')}</td>
          <td>${refused}</td>
          <td>${escapeHTML(cost)}</td>
        </tr>
        <tr class="schedule-run-detail" data-run-detail="${escapeHTML(run.id)}" hidden><td colspan="6"><pre class="schedule-run-full"></pre><button type="button" class="button button-quiet button-small" data-run-back>Hide</button></td></tr>`;
      }).join('')}</tbody>
    </table>
  </div>`;
}

function renderSchedules() {
  const host = $('#schedules-list');
  host.setAttribute('aria-busy', 'false');
  const plain = state.schedules.filter(schedule => !isFollowupSchedule(schedule));
  const follow = state.schedules.filter(isFollowupSchedule);
  const followHost = $('#followup-schedules');
  if (followHost) followHost.innerHTML = follow.map(scheduleCardHTML).join('');
  host.innerHTML = plain.length ? plain.map(scheduleCardHTML).join('') : '<div class="panel"><p class="empty-line">No schedules yet.</p></div>';
  tickScheduleClocks();
  updateTimersBadge();
  renderFollowups();
}

function scheduleCardHTML(schedule) {
  return `<article class="schedule-card panel" data-schedule-id="${escapeHTML(schedule.id)}">
    <div class="schedule-head">
      <div><h3>${escapeHTML(schedule.title)}</h3></div>
      ${isFollowupSchedule(schedule) ? '<span class="pill tone-accent">Follow-up</span>' : ''}<span class="state state-${stateClassForSchedule(schedule)}">${escapeHTML(schedule.state_label)}</span>
    </div>
    ${isFollowupSchedule(schedule) ? `<p class="schedule-stop">Stops when: ${escapeHTML(schedule.cadence.stop_when)}</p>` : ''}
    <p class="schedule-cadence">${escapeHTML(sentenceCase(schedule.cadence_text))}${schedule.next_run_text ? ` &middot; <span data-next-run-text>${escapeHTML(schedule.next_run_text)}</span> <span class="muted" data-next-run-rel="${escapeHTML(schedule.next_run_in_seconds ?? '')}" data-next-run-fetched="${Date.now()}"></span>` : ''}</p>
    ${scheduleLastRunBlock(schedule)}
    ${scheduleMissingBlock(schedule)}
    ${(schedule.capabilities || []).length ? `<div class="tag-line">${scheduleCapabilitiesBlock(schedule)}</div>` : ''}
    ${state.scheduleErrors.has(schedule.id) ? `<p class="schedule-inline-error">${escapeHTML(state.scheduleErrors.get(schedule.id))}</p>` : ''}
    <div class="schedule-action-row">
      <div class="schedule-actions">${scheduleActionButtons(schedule)}</div>
      <button class="button button-quiet button-small schedule-history-toggle" type="button" data-schedule-history="${escapeHTML(schedule.id)}" aria-expanded="${state.scheduleHistoryOpen.has(schedule.id)}">${state.scheduleHistoryOpen.has(schedule.id) ? 'Hide history' : 'Run history'}</button>
    </div>
    <div class="schedule-history-panel" data-schedule-history-panel="${escapeHTML(schedule.id)}">${state.scheduleHistoryOpen.has(schedule.id) ? scheduleHistoryBlock(schedule) : ''}</div>
  </article>`;
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
    renderSchedules();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Schedules not refreshed: ${error.message}`, 'error');
  }
}

const GROUP_MODE_OPTIONS = [
  { value: 'natural', label: 'Natural' },
  { value: 'mention', label: 'Mention only' },
  { value: 'silent', label: 'Silent' },
];

function renderGroups() {
  const host = $('#groups-list');
  host.setAttribute('aria-busy', 'false');
  const badge = $('#groups-badge'); if (badge) badge.textContent = state.groups.length;
  if (!state.groups.length) {
    host.innerHTML = '<div class="card"><p class="empty-line">No group chats yet.</p></div>';
    return;
  }
  const MODE_TONE = { natural: 'done', mention: 'accent', silent: '' };
  host.innerHTML = state.groups.map(g => `<article class="card group-card group-row" data-chat-id="${escapeHTML(g.chat_id)}">
    <header class="title-bar">${avatar(g.title, 'group')}<h2 class="group-row-title">${escapeHTML(g.title)}</h2>${channelMark(g.channel)}</header>
    <div class="card-body">
      <span class="tag-line"><span class="pill">${g.member_count} member${g.member_count === 1 ? '' : 's'}</span><span class="pill tone-${MODE_TONE[g.response_mode] ?? ''}">${escapeHTML((GROUP_MODE_OPTIONS.find(o => o.value === g.response_mode) || {}).label || g.response_mode)}</span>${g.updated_at ? `<span class="pill">${escapeHTML(relTime(g.updated_at))}</span>` : ''}</span>
      <label class="group-row-mode">
        <span class="visually-hidden">Reply mode for ${escapeHTML(g.title)}</span>
        <select data-group-mode aria-label="Reply mode for ${escapeHTML(g.title)}">${GROUP_MODE_OPTIONS.map(o => `<option value="${o.value}" ${o.value === g.response_mode ? 'selected' : ''}>${o.label}</option>`).join('')}</select>
      </label>
      <span class="group-row-save-state pill" role="status" hidden></span>
    </div>
  </article>`).join('');
}

async function saveGroupMode(chatId, mode) {
  const row = $(`.group-row[data-chat-id="${CSS.escape(chatId)}"]`);
  const status = row ? $('.group-row-save-state', row) : null;
  if (status) { status.hidden = false; status.textContent = 'Saving'; }
  try {
    const result = await post('/groups/mode', { chat_id: chatId, response_mode: mode });
    state.groups = result.groups || state.groups;
    if (status) status.textContent = 'Saved';
    showNotice('Group chat mode saved.');
  } catch (error) {
    if (status) status.textContent = error.message;
    showNotice(`Mode not saved: ${error.message}`, 'error', 8000);
    renderGroups();
  }
}

async function refreshGroups({ throwOnError = false } = {}) {
  try {
    const payload = await api('/groups');
    state.groups = payload.groups || [];
    renderGroups();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Group chats not refreshed: ${error.message}`, 'error');
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

function cadenceOptionsHTML(selectedKind) {
  return `<label>Frequency<select name="cadence_kind">${state.scheduleKinds.map(k => `<option value="${escapeHTML(k.kind)}" ${selectedKind === k.kind ? 'selected' : ''}>${escapeHTML(k.label)}</option>`).join('')}</select></label>`
    + state.scheduleKinds.map(k => `<div class="cadence-fields" data-cadence-fields="${escapeHTML(k.kind)}" ${selectedKind === k.kind ? '' : 'hidden'}>${cadenceFieldsHTML(k.kind)}</div>`).join('');
}

function renderCadenceOptions(selectedKind) {
  $('#schedule-cadence-options').innerHTML = cadenceOptionsHTML(selectedKind);
  $('#schedule-cadence-advanced').innerHTML = '';
  $('.cadence-advanced').hidden = true;
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
  $('#schedule-report-options').innerHTML = `<label>Report<select name="report_every_time">${state.reportOptions.map((opt, index) => `<option value="${escapeHTML(opt.value)}" ${(schedule ? String(schedule.report_every_time) === String(opt.value) : index === 0) ? 'selected' : ''}>${escapeHTML(schedule && String(schedule.report_every_time) === String(opt.value) && schedule.report_text ? schedule.report_text : opt.label)}</option>`).join('')}</select></label>`;
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

// -- one-step repair dialog (ScheduleService.repair_plan/repair_apply) ------

state.repairPlan = null;

function renderRepairCadenceOptions(selectedKind) {
  $('#repair-cadence-options').innerHTML = cadenceOptionsHTML(selectedKind);
}

function renderRepairDialog() {
  const plan = state.repairPlan;
  if (!plan) return;
  $('#repair-sentence').textContent = plan.sentence;
  const timingFieldset = $('#repair-timing-fieldset');
  if (plan.timing) {
    // A timing the plan already recovered: shown prefilled, still editable with the
    // same "When" control the edit form uses, but not required -- it is already set.
    timingFieldset.hidden = false;
    renderRepairCadenceOptions(plan.timing.cadence_kind);
    fillCadenceFields($('#repair-form'), plan.timing.cadence_kind, plan.timing.cadence);
  } else {
    // No timing recovered from the old instructions: the owner must choose one.
    timingFieldset.hidden = false;
    renderRepairCadenceOptions(state.scheduleKinds[0]?.kind || 'every');
  }
  $('#repair-capabilities-block').innerHTML = (plan.add_capabilities || []).length
    ? `<fieldset><legend>New permission</legend>${plan.add_capabilities.map(c => `<span class="schedule-capability-chip">${escapeHTML(c.label)}</span>`).join('')}</fieldset>`
    : '';
  $('#repair-removals-block').innerHTML = (plan.prompt_changes || []).length
    ? `<fieldset><legend>Instructions to remove</legend>${plan.prompt_changes.map(c => `<p class="repair-removed">${escapeHTML(c.remove)}</p><p class="muted repair-removed-why">${escapeHTML(c.why)}</p>`).join('')}</fieldset>`
    : '';
  $('#repair-submit').textContent = (plan.add_capabilities || []).length || (plan.prompt_changes || []).length
    ? 'Apply and ask me to approve' : 'Apply and resume';
}

async function openRepairDialog(id) {
  try {
    const plan = await api(`/schedules/${encodeURIComponent(id)}/repair`);
    state.repairPlan = plan;
    $('#repair-id').value = id;
    renderRepairDialog();
    $('#repair-dialog').showModal();
  } catch (error) {
    showNotice(`Could not load the repair plan: ${error.message}`, 'error');
  }
}

async function saveRepair(form) {
  const id = Number($('#repair-id').value);
  const plan = state.repairPlan;
  const payload = { id };
  if (!plan?.timing) {
    payload.timing = { cadence_kind: form.cadence_kind.value, cadence: cadencePayload(form) };
  }
  setFormBusy(form, true);
  try {
    const result = await post('/schedules/repair', payload);
    $('#repair-dialog').close();
    showNotice(result.message || 'Repaired.', 'info', 0);
    await refreshSchedules({ throwOnError: false });
    await refreshHome({ throwOnError: false });
  } catch (error) { showNotice(`Could not repair it: ${error.message}`, 'error'); }
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
    const words = CHOICE_WORDS[setting.name] || {};
    return `<select data-setting-control data-setting-kind="choice" aria-label="${escapeHTML(setting.label)}">${(setting.choices || []).map(choice => `<option value="${escapeHTML(choice)}" ${choice === value ? 'selected' : ''}>${escapeHTML(words[choice] || sentenceCase(choice))}</option>`).join('')}</select>`;
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
  const SOURCE_WORDS = { console: 'Changed here', environment: 'Set on the server' };
  const rowHTML = setting => {
    const serious = isSeriousSetting(setting);
    const status = state.settingStatus[setting.name];
    const changed = setting.source === 'console' || setting.value !== setting.default;
    return `<div class="setting-row${serious ? ' is-serious' : ''}" data-setting-name="${escapeHTML(setting.name)}">
        <div class="setting-copy">
          <div class="setting-label" title="${escapeHTML(setting.name)}">${escapeHTML(setting.label)}${serious ? '<span class="tag tag-warn">Serious</span>' : ''}</div>
          <p class="setting-help">${escapeHTML(setting.help || '')}</p>
        </div>
        <div class="setting-value">
          ${settingControl(setting)}
          <div class="setting-meta">
            ${SOURCE_WORDS[setting.source] ? `<span class="pill${setting.source === 'console' ? ' tone-accent' : ''}">${SOURCE_WORDS[setting.source]}</span>` : ''}
            ${changed ? '<button class="button button-quiet button-small setting-reset" type="button" data-reset-setting>Reset</button>' : ''}
            <span class="setting-save-state${status?.type === 'error' ? ' is-error' : ''}" role="status">${escapeHTML(status?.text || '')}</span>
          </div>
        </div>
      </div>`;
  };
  const GROUP_ICONS = { Speaking: 'groups', Safety: 'approvals', Memory: 'memory', Pages: 'pages', Schedules: 'schedule', Engine: 'runs', Models: 'runs' };
  const groupHTML = (prefix, entries) => entries.map(([group, settings], groupIndex) => `<section class="card settings-group" aria-labelledby="${prefix}-${groupIndex}">
    <header class="title-bar"><span class="tb-icon">${icon(GROUP_ICONS[group] || 'settings')}</span><h2 id="${prefix}-${groupIndex}">${escapeHTML(group)}</h2><span class="badge">${settings.length}</span></header>
    <div class="settings-panel">${settings.map(rowHTML).join('')}</div>
  </section>`).join('');
  const split = advanced => [...groups.entries()].map(([group, settings]) => [group, settings.filter(setting => ADVANCED_SETTINGS.has(setting.name) === advanced)]).filter(([, settings]) => settings.length);
  host.innerHTML = groupHTML('settings-group', split(false))
    + `<details class="advanced-settings card"${state.advancedOpen ? ' open' : ''}><summary class="title-bar"><span class="tb-icon">${icon('auto')}</span><h2>Advanced</h2><span class="badge">${state.settings.filter(st => ADVANCED_SETTINGS.has(st.name)).length}</span></summary><div class="advanced-body">
      ${groupHTML('settings-advanced', split(true))}
      <p class="advanced-link"><a class="button button-secondary button-small" href="${VIEW_PATHS.scopes}" data-route="scopes">Every permission</a></p>
    </div></details>`;
  $('.advanced-settings', host)?.addEventListener('toggle', event => { state.advancedOpen = event.target.open; });
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
    renderSettings();
    renderAutoMode();
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
    invalidateView('permissions', refreshRoles);
    invalidateView('people', () => refreshPeople({external:true}));
    invalidateView('scopes', refreshScopesBreakdown);
    invalidateHome();
  });
  source.addEventListener('people.synced', () => {
    invalidateView('people', () => refreshPeople({external:true}));
    invalidateHome();
  });
  source.addEventListener('people.changed', handlePeopleEvent);
  source.addEventListener('health.changed', () => { invalidateView('settings', refreshHealth); invalidateView('inbox', refreshMessages); invalidateView('outbox', refreshMessages); invalidateHome(); });
  source.addEventListener('settings.changed', () => { invalidateView('settings', refreshSettings); invalidateView('permissions', refreshSettings); });
  source.addEventListener('schedules.changed', () => { invalidateHome(); invalidateView('timers', refreshSchedules); invalidateView('approvals', refreshApprovals); });
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
  invalidateView('overview', refreshHome);
}

function handleRequestEvent() {
  invalidateView('runs', refreshActivity);
  invalidateView('approvals', refreshApprovals);
  invalidateView('inbox', refreshMessages);
  invalidateView('outbox', refreshMessages);
  invalidateHome();
  if (state.activeView !== 'overview') refreshWaitingCount().catch(error => showNotice(`Waiting count not refreshed: ${error.message}`, 'error'));
}

function setStreamState(streamState) {
  state.streamState = streamState;
  const dot = $('#stream-dot');
  dot.className = `stream-dot${streamState === 'live' ? ' is-live' : streamState === 'connecting' ? ' is-connecting' : ''}`;
  $('#stream-pill').className = `pill pill-${streamState === 'live' ? 'live' : streamState === 'connecting' ? 'connecting' : 'offline'}`;
  $('#stream-label').textContent = sentenceCase(streamState);
}

function applyRoute({ replaceUnknown = false } = {}) {
  const hashTarget = oldHashTarget();
  if (hashTarget) history.replaceState(null, '', hashTarget);
  const route = routeFromPath();
  if (route.redirect) history.replaceState(null, '', route.redirect);
  else if (route.unknown && replaceUnknown) history.replaceState(null, '', VIEW_PATHS.overview);
  state.activeView = route.view;
  state.taskId = route.taskId;
  $$('[data-view]').forEach(section => { section.hidden = section.dataset.view !== route.view; });
  const menuView = NAV_PARENT[route.view] || route.view;
  $$('nav [data-route]').forEach(link => {
    if (link.dataset.route === menuView) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $$('.tabs [data-route]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.route === route.view)));
  document.title = `${VIEW_TITLES[route.view] || 'Console'} · Blatbot`;
  const taskDialog = $('#task-dialog');
  if (!route.taskId && taskDialog.open) taskDialog.close();
  window.scrollTo({ top: 0, behavior: 'auto' });
  loadView(route.view);
}

function navigate(path, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  applyRoute();
  const heading = $(`[data-view="${state.activeView}"] h1`);
  if (heading && !$('dialog[open]')) {
    heading.tabIndex = -1;
    heading.classList.toggle('quiet-focus', !state.lastInputKeyboard);
    heading.addEventListener('blur', () => heading.classList.remove('quiet-focus'), { once: true });
    heading.focus({ preventScroll: true });
  }
}

function moveWaiting(direction) {
  const waiting = pendingRequests();
  if (!waiting.length) return;
  state.selectedWaiting = (state.selectedWaiting + direction + waiting.length) % waiting.length;
  renderApprovals();
  const selected = $(`[data-waiting-index="${state.selectedWaiting}"]`);
  selected?.focus({ preventScroll: true });
  selected?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function isTypingTarget(target) {
  return target.matches('input, textarea, select, [contenteditable="true"]');
}

document.addEventListener('click', event => {
  const routeLink = event.target.closest('a[data-route]');
  if (routeLink && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    navigate(routeLink.pathname || new URL(routeLink.getAttribute('href'), location.href).pathname);
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
    editButton.setAttribute('aria-expanded', String(!note.hidden));
    if (!note.hidden) $('textarea', note).focus();
  }
  const personButton = event.target.closest('[data-person-key]');
  if (personButton) { state.selectedPerson = personButton.dataset.personKey; state.personDirty = false; renderPeople(); renderPersonEditor(); if (matchMedia('(max-width: 760px)').matches) window.scrollTo({ top: 0 }); $('[data-person-back]')?.focus({ preventScroll: true }); }
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
  if (taskButton) navigate(`${VIEW_PATHS.runs}/${encodeURIComponent(taskButton.dataset.taskId)}`);
  const scheduleActionButton = event.target.closest('[data-schedule-action]');
  if (scheduleActionButton) {
    const id = Number(scheduleActionButton.closest('[data-schedule-id]').dataset.scheduleId);
    if (scheduleActionButton.dataset.scheduleAction === 'edit') openScheduleEditor(state.schedules.find(schedule => schedule.id === id));
    else if (scheduleActionButton.dataset.scheduleAction === 'repair') openRepairDialog(id);
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
  if (event.target.id === 'repair-form') saveRepair(event.target);
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
  const memoryLevel = event.target.closest('[data-role-memory-level]');
  if (memoryLevel) {
    setRoleMemoryLevel(memoryLevel.closest('[data-role-name]').dataset.roleName, memoryLevel.value);
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
  if (event.target.matches('[data-group-mode]')) {
    const row = event.target.closest('[data-chat-id]');
    if (row) saveGroupMode(row.dataset.chatId, event.target.value);
    return;
  }
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
  if (state.activeView !== 'approvals') return;
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
  if (!event.target.matches('#schedule-form [name=cadence_kind], #repair-form [name=cadence_kind]')) return;
  $$('.cadence-fields', event.target.form).forEach(el => { el.hidden = el.dataset.cadenceFields !== event.target.value; });
});
$$('[data-activity-filter]').forEach(button => button.addEventListener('click', () => {
  state.activityFilter = button.dataset.activityFilter;
  state.activityLimit = 40;
  renderActivity();
}));
document.addEventListener('click', event => {
  if (!event.target.closest('[data-activity-more]')) return;
  state.activityLimit = (state.activityLimit || 40) + 40;
  renderActivity();
});
$('#retry-all').addEventListener('click', () => loadSnapshot());
$('#refresh-activity').addEventListener('click', () => refreshActivity());
$('#refresh-groups').addEventListener('click', () => refreshGroups());
$('#refresh-health').addEventListener('click', () => { refreshHealth(); refreshSettings(); });
$('#refresh-messages').addEventListener('click', () => refreshMessages());
$('#refresh-inbox').addEventListener('click', () => refreshMessages());
$('#refresh-overview').addEventListener('click', () => refreshHome());
$('#refresh-approvals').addEventListener('click', () => refreshApprovals());
$('#refresh-memory').addEventListener('click', () => refreshMemory());
$('#refresh-pages').addEventListener('click', () => refreshPages());
document.addEventListener('click', event => {
  const seg = event.target.closest('[data-seg]');
  if (!seg) return;
  const key = { Source: 'inboxKind', Status: 'inboxStatus', 'Outbox status': 'outboxStatus' }[seg.dataset.seg];
  if (!key) return;
  state[key] = seg.dataset.value;
  if (key === 'outboxStatus') renderOutbox(); else renderInbox();
});
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close();
}));
$('#task-dialog').addEventListener('close', () => {
  if (state.taskId) navigate(VIEW_PATHS.runs, { replace: true });
});
window.addEventListener('popstate', applyRoute);
document.addEventListener('keydown', () => { state.lastInputKeyboard = true; }, true);
document.addEventListener('pointerdown', () => { state.lastInputKeyboard = false; }, true);

applyRoute({ replaceUnknown: true });
if (state.activeView !== 'overview') refreshWaitingCount().catch(error => showNotice(`Waiting count not loaded: ${error.message}`, 'error'));
connectEvents();

// Blatbot's picture comes from the backend, which fetches it from its Inkbox identity.
document.querySelectorAll('.brand-avatar').forEach(img => { img.src = `${API}/avatar`; });

// Card navigation is deliberately read-only. Nested controls retain their own actions.
function openCardDetail(title, text) {
  $('#card-detail-title').textContent = title;
  $('#card-detail-body').textContent = text;
  $('#card-detail-dialog').showModal();
}
const cardSelector = '[data-request-detail], .role-row';
document.addEventListener('click', event => {
  if (event.target.closest('[data-person-back]')) {
    if (state.personDirty && !confirm('Discard unsaved changes?')) return;
    const selected = state.selectedPerson;
    state.selectedPerson = null;
    renderPeople(); renderPersonEditor();
    $(`[data-person-key="${CSS.escape(selected || '')}"]`)?.focus();
    return;
  }
  if (event.target.closest('[data-run-back]')) {
    const detail = event.target.closest('.schedule-run-detail');
    detail.hidden = true;
    detail.previousElementSibling.focus();
    return;
  }
  const card = event.target.closest(cardSelector);
  if (!card || event.target.closest('a, input, textarea, select, label, summary, .role-row-body') || (event.target.closest('button') && event.target.closest('button') !== card)) return;
  if (card.dataset.cardRoute) {
    navigate(VIEW_PATHS[card.dataset.cardRoute]);
  } else if (card.dataset.requestDetail) {
    const request = state.requests.find(r => String(r.id) === card.dataset.requestDetail);
    if (request) openCardDetail(clean(request.summary) || 'Run', [`#${request.id}, ${request.sender_name || request.sender || ''}, ${formatTime(request.created_at)}`, stateWord(request.state), request.outcome?.text, clean(request.original_message), clean(request.result)].filter(Boolean).join('\n\n'));
  } else if (card.matches('.schedule-card')) {
    card.querySelector('[data-schedule-history]').click();
  } else if (card.matches('.role-row')) {
    card.querySelector('[data-toggle-role]').click();
    $(`.role-row[data-role-name="${CSS.escape(card.dataset.roleName)}"]`)?.focus();
  } else {
    const title = card.querySelector('.group-row-title, .setting-label, dt, h3')?.textContent || 'Details';
    const control = card.querySelector('select, input, textarea');
    const value = control?.tagName === 'SELECT' ? control.selectedOptions[0]?.textContent : control?.type === 'checkbox' ? (control.checked ? 'On' : 'Off') : control?.value;
    openCardDetail(title, [card.innerText, value].filter(Boolean).join('\n\n'));
  }
});
document.addEventListener('keydown', event => {
  if (event.target.matches(cardSelector + ', .schedule-run-row') && ['Enter', ' '].includes(event.key)) {
    event.preventDefault();
    event.target.click();
  }
});

// ---- Shared marks: icons, avatars, channel marks, pills, small charts ----------------------
// Declared as functions (hoisted) so the first route, which runs above, can use them.
function pl(n, one, many = `${one}s`) {
  const value = Number(n);
  const shown = Number.isFinite(value) ? value.toLocaleString() : String(n ?? '');
  return `${shown} ${value === 1 ? one : many}`;
}
function icon(name) { return `<svg class="ic" aria-hidden="true"><use href="#i-${escapeHTML(name)}"/></svg>`; }

function hueFor(text) {
  let h = 0;
  for (const ch of String(text || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function initials(name) {
  const words = String(name || '?').replace(/[^\p{L}\p{N}\s&]/gu, ' ').split(/\s+/).filter(w => w && w !== '&');
  return ((words[0]?.[0] || '?') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}
function avatar(name, size = '') {
  return `<span class="avatar${size ? ` ${size}` : ''}" style="--h:${hueFor(name)}" aria-hidden="true">${escapeHTML(initials(name))}</span>`;
}
function channelMark(surface) {
  const key = String(surface || '').toLowerCase();
  if (!key) return '';
  const marks = {
    telegram: ['telegram', 'Telegram', '<path fill="#fff" d="M5.2 11.6l12.4-4.8c.6-.2 1.1.1.9 1L16.4 18c-.2.7-.6.9-1.2.6l-3.2-2.4-1.6 1.5c-.2.2-.3.3-.7.3l.2-3.3 6-5.4c.3-.2-.1-.4-.4-.2l-7.4 4.7-3.2-1c-.7-.2-.7-.7.3-1.2z"/>'],
    imessage: ['imessage', 'iMessage', '<path fill="#fff" d="M12 5c-4.4 0-8 2.9-8 6.5 0 2 1.1 3.8 2.9 5L6 19.5l3.3-1.7c.9.2 1.8.4 2.7.4 4.4 0 8-2.9 8-6.6S16.4 5 12 5z"/>'],
    sms: ['sms', 'Text message', '<path fill="#fff" d="M5 6h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4 3v-3H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"/><path stroke="#26b851" stroke-width="1.6" stroke-linecap="round" d="M8 10h8M8 13h5"/>'],
    email: ['email', 'Email', '<rect x="4" y="6" width="16" height="12" rx="2" fill="#fff"/><path d="M4.5 7l7.5 6 7.5-6" fill="none" stroke="#5267e8" stroke-width="1.6"/>'],
    phone: ['phone', 'Phone', '<path fill="#fff" d="M7.5 4.5h2.6l1.3 3.6-1.8 1.1a9.5 9.5 0 0 0 5.2 5.2l1.1-1.8 3.6 1.3v2.6a1.8 1.8 0 0 1-1.8 1.8A14 14 0 0 1 5.7 6.3a1.8 1.8 0 0 1 1.8-1.8z"/>'],
  };
  const alias = { text: 'sms', voice: 'phone', 'text message': 'sms', mail: 'email' };
  const mark = marks[alias[key] || key];
  if (!mark) {
    const other = { schedule: 'schedule', timer: 'timers', web: 'pages', console: 'settings', a2a: 'runs', webhook: 'inbox' }[key] || 'groups';
    return `<span class="chan chan-other" title="${escapeHTML(surfaceWord(surface))}" aria-label="${escapeHTML(surfaceWord(surface))}">${icon(other)}</span>`;
  }
  return `<span class="chan chan-${mark[0]}" title="${mark[1]}" aria-label="${mark[1]}"><svg viewBox="0 0 24 24">${mark[2]}</svg></span>`;
}
function outcomePill(outcome) {
  if (!outcome || !outcome.text || outcome.kind === 'none') return '';
  const icons = { sent: 'outbox', quiet: 'runs', asked: 'approvals', deferred: 'approvals', failed: 'stuck' };
  return `<span class="outcome-pill outcome-${escapeHTML(outcome.kind)}" title="${escapeHTML(outcome.text)}">${icon(icons[outcome.kind] || 'runs')}<span>${escapeHTML(outcome.text)}</span></span>`;
}
function subBar(title, iconName, count) {
  return `<div class="sub-bar"><span class="tb-icon">${icon(iconName)}</span><h3>${escapeHTML(title)}</h3>${count == null ? '' : `<span class="badge">${escapeHTML(count)}</span>`}</div>`;
}
function countBy(rows, key) {
  return rows.reduce((acc, row) => { const k = row[key]; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
}
function toSeconds(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n / 1000 : n;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / 1000 : 0;
}
function hourBuckets(times, hours) {
  const now = Date.now() / 1000;
  const out = new Array(hours).fill(0);
  times.forEach(t => { const age = now - toSeconds(t); const i = hours - 1 - Math.floor(age / 3600); if (age >= 0 && i >= 0 && i < hours) out[i] += 1; });
  return out;
}
function dayBuckets(times, days) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const today = start.getTime() / 1000;
  const out = new Array(days).fill(0);
  times.forEach(t => {
    const s = toSeconds(t);
    if (!s) return;
    const idx = s >= today ? days - 1 : days - 2 - Math.floor((today - s) / 86400);
    if (idx >= 0 && idx < days) out[idx] += 1;
  });
  return out;
}
function sparkBars(values, variant = '') {
  const max = Math.max(1, ...values);
  const w = 100 / values.length;
  const bars = values.map((v, i) => { const h = v ? Math.max(3, (v / max) * 32) : 1.5; return `<rect x="${(i * w + w * 0.15).toFixed(2)}" y="${(34 - h).toFixed(2)}" width="${(w * 0.7).toFixed(2)}" height="${h.toFixed(2)}" rx="1"${i === values.length - 1 ? ' class="is-now"' : ''}><title>${v}</title></rect>`; }).join('');
  return `<svg class="spark${variant ? ` ${variant}` : ''}" viewBox="0 0 100 34" preserveAspectRatio="none" role="img" aria-label="${escapeHTML(values.join(', '))}">${bars}</svg>`;
}
function statCard({ label, icon: iconName = 'chart', value = null, unit = '', tone = '', pill = '', pillTone = '', chart = '', axis = null, href = '', route = '', foot = '' }) {
  const tag = href ? 'a' : 'div';
  return `<${tag} class="stat-card"${href ? ` href="${escapeHTML(href)}" data-route="${escapeHTML(route)}"` : ''}>
    <div class="stat-card-head"><span class="tb-icon${tone ? ` tone-${tone}` : ''}">${icon(iconName)}</span><span class="stat-card-label">${escapeHTML(label)}</span></div>
    ${value === null ? '' : `<div class="stat-card-value"${tone && (Number(value) || value === 'On') ? ` style="color:var(--${tone === 'accent' ? 'accent-hi' : tone})"` : ''}>${escapeHTML(typeof value === 'number' ? value.toLocaleString() : value)}${unit ? `<small>${escapeHTML(unit)}</small>` : ''}</div>`}
    ${chart}${axis ? `<div class="spark-axis"><span>${escapeHTML(axis[0])}</span><span>${escapeHTML(axis[1])}</span></div>` : ''}
    ${foot || pill ? `<div class="stat-card-foot">${pill ? `<span class="pill${pillTone ? ` tone-${pillTone}` : ''}">${escapeHTML(pill)}</span>` : ''}${foot}</div>` : ''}
  </${tag}>`;
}

function updateNavCounts() {
  const running = state.overview?.counts?.running || 0;
  const nr = $('#nav-running-count'); if (nr) { nr.hidden = !running; nr.textContent = running; }
  const inbox = state.inbox?.counts || state.health?.inbox || {};
  const open = (inbox.pending || 0) + (inbox.running || 0);
  const ni = $('#nav-inbox-count'); if (ni) { ni.hidden = !open; ni.textContent = open; }
}

function settingValue(name) { return (state.settings || []).find(s => s.name === name); }

// ---- Overview: the loop from the article, drawn with live counts ----------------------------
function loopModel() {
  const inbox = state.health?.inbox || state.inbox?.counts || {};
  const outbox = state.health?.outbox || state.outbox?.counts || {};
  const counts = state.overview?.counts || {};
  const { followups, schedules: schedulesActive } = timerCounts();
  const mem = state.memory;
  const msgTotal = mem ? Object.values(mem.messages?.by_kind || {}).reduce((a, b) => a + b, 0) : null;
  const waiting = pendingRequests().length;
  const auto = settingValue('GATE_AUTO_MODE');
  const roles = state.rolesSummary?.roles?.length;
  const n = v => (v == null ? '–' : Number(v).toLocaleString());
  return {
    timers: { title: 'Timers', icon: 'timers', route: 'timers', num: n(schedulesActive + followups), unit: 'set', chips: [[pl(followups, 'follow-up'), followups ? 'running' : ''], [pl(schedulesActive, 'schedule'), '']] },
    inbox: { title: 'Event inbox', icon: 'inbox', route: 'inbox', num: n((inbox.pending || 0) + (inbox.running || 0)), unit: 'open', tone: inbox.failed ? 'bad' : '',
      chips: [[`${n(inbox.done)} done`, 'done'], ...(inbox.failed ? [[`${inbox.failed} failed`, 'failed']] : [[`${inbox.pending || 0} waiting`, inbox.pending ? 'waiting' : '']])] },
    run: { title: 'Runs and sessions', icon: 'runs', route: 'runs', core: true, num: n(counts.running || 0), unit: 'running now',
      chips: [[`${counts.done_today || 0} done today`, 'done'], [`${counts.stuck || 0} stuck`, counts.stuck ? 'failed' : '']] },
    memory: { title: 'Memory', icon: 'memory', route: 'memory', num: n(msgTotal), unit: 'messages kept',
      chips: [[mem ? pl(mem.notes?.total || 0, 'note') : '– notes', ''], [mem?.graph?.enabled ? 'Graph on' : 'Graph off', mem?.graph?.enabled ? 'done' : '']] },
    permissions: { title: 'Permissions', icon: 'permissions', route: waiting ? 'approvals' : 'permissions', num: n(waiting), unit: 'waiting on you', tone: waiting ? 'alert' : '',
      chips: [[roles == null ? '– roles' : pl(roles, 'role'), ''], [auto ? `Auto mode ${auto.value ? 'on' : 'off'}` : 'Auto mode', auto?.value ? 'done' : '']] },
    outbox: { title: 'Outbox', icon: 'outbox', route: 'outbox', num: n(outbox.sent), unit: 'sent', tone: outbox.failed ? 'bad' : '',
      chips: [[`${(outbox.queued || 0) + (outbox.sending || 0)} queued`, (outbox.queued || outbox.sending) ? 'running' : ''], [`${outbox.held || 0} held`, outbox.held ? 'waiting' : ''], ...(outbox.failed ? [[`${outbox.failed} failed`, 'failed']] : [])] },
    people: { title: 'You and people', icon: 'people', route: 'people', num: n(state.people?.length || null), unit: state.people?.length === 1 ? 'person' : 'people', chips: [[pl(state.groups?.length || 0, 'group chat'), '']] },
  };
}

function loopNodeSVG(node, x, y, w, h) {
  const chipX = [];
  let cx = x + 16;
  const chips = node.chips.map(([text, tone]) => {
    const cw = Math.round(text.length * 6.1 + 16);
    const out = `<g class="chip${tone ? ` tone-${tone}` : ''}"><rect x="${cx}" y="${y + h - 32}" width="${cw}" height="20" rx="10"/><text x="${cx + cw / 2}" y="${y + h - 18.5}" text-anchor="middle">${escapeHTML(text)}</text></g>`;
    chipX.push(cx); cx += cw + 6;
    return out;
  }).join('');
  return `<a class="node${node.core ? ' is-core' : ''}${node.tone ? ` is-${node.tone}` : ''}" href="${VIEW_PATHS[node.route]}" data-route="${node.route}" aria-label="${escapeHTML(node.title)}: ${escapeHTML(node.num)} ${escapeHTML(node.unit)}">
    <rect class="node-bg" x="${x}" y="${y}" width="${w}" height="${h}" rx="14"/>
    <rect class="node-icon-bg" x="${x + 14}" y="${y + 14}" width="30" height="30" rx="9"/>
    <use class="node-icon" href="#i-${node.icon}" x="${x + 20}" y="${y + 20}" width="18" height="18"/>
    <text class="node-title" x="${x + 54}" y="${y + 34}">${escapeHTML(node.title)}</text>
    <text x="${x + 16}" y="${y + 80}"><tspan class="node-num">${escapeHTML(node.num)}</tspan><tspan class="node-unit" dx="8">${escapeHTML(node.unit)}</tspan></text>
    ${chips}
  </a>`;
}

function loopHTML() {
  const m = loopModel();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const edges = [
    ['e-timers', 'M244 102 C 300 102 290 220 344 220', ['Due timers'], 286, 182, true, 'end'],
    ['e-people', 'M244 378 C 300 378 290 262 344 262', ['Replies arrive', 'as events'], 288, 284, true, 'end'],
    ['e-inbox', 'M568 240 H 668', ['Starts a run'], 618, 230, true],
    ['e-settimer', 'M668 184 H 628 Q 612 184 612 168 V 70 Q 612 54 596 54 H 244', ['Sets follow-ups', 'and timers'], 428, 30, true],
    ['e-memory', 'M792 118 V 160', ['Reads and writes back'], 804, 143, false, 'start'],
    ['e-perm', 'M792 320 V 362', ['Acts within'], 804, 345, false, 'start'],
    ['e-outbox', 'M916 240 H 1012', ['Sends, stays', 'quiet or defers'], 964, 216, true],
    ['e-deliver', 'M1118 304 V 486 Q 1118 504 1100 504 H 150 Q 132 504 132 486 V 440', ['Delivers outcomes'], 560, 496, true],
  ];
  const edgeSVG = edges.map(([id, d, label, lx, ly, hot, anchor = 'middle']) => `<path id="${id}" class="edge${hot ? ' is-hot' : ' is-quiet'}" d="${d}" marker-end="url(#arrow)"${id === 'e-memory' ? ' marker-start="url(#arrowStart)"' : ''}/>
    <text class="edge-label" x="${lx}" y="${ly}" text-anchor="${anchor}">${label.map((line, k) => `<tspan x="${lx}" dy="${k ? 14 : 0}">${escapeHTML(line)}</tspan>`).join('')}</text>
    ${hot && !reduced ? `<circle class="dot" r="3.2"><animateMotion dur="${id === 'e-deliver' ? 6 : id === 'e-settimer' ? 4.2 : 2.8}s" repeatCount="indefinite"><mpath href="#${id}"/></animateMotion></circle>` : ''}`).join('');
  const svg = `<svg class="loop-svg" viewBox="0 0 1240 520" role="group" aria-label="How everything fits together">
    <defs>
      <linearGradient id="flowGrad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1240" y2="0"><stop offset="0" stop-color="#8f7cff"/><stop offset="1" stop-color="#45d6c4"/></linearGradient>
      <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#6f7bc0"/></marker>
      <marker id="arrowStart" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#6f7bc0"/></marker>
    </defs>
    ${edgeSVG}
    ${loopNodeSVG(m.timers, 20, 40, 224, 124)}
    ${loopNodeSVG(m.people, 20, 316, 224, 124)}
    ${loopNodeSVG(m.inbox, 344, 176, 224, 128)}
    ${loopNodeSVG(m.memory, 668, 0, 248, 118)}
    ${loopNodeSVG(m.run, 668, 160, 248, 160)}
    ${loopNodeSVG(m.permissions, 668, 362, 248, 118)}
    ${loopNodeSVG(m.outbox, 1012, 176, 212, 128)}
  </svg>`;
  const step = (node, link = true) => `<a class="loop-step${node.core ? ' is-core' : ''}" href="${VIEW_PATHS[node.route]}" data-route="${node.route}">
      <span class="tb-icon">${icon(node.icon)}</span>
      <span><span class="loop-step-title">${escapeHTML(node.title)}</span><span class="loop-step-sub">${node.chips.map(([t, tone]) => `<span class="pill${tone ? ` tone-${tone}` : ''}">${escapeHTML(t)}</span>`).join('')}</span></span>
      <span class="loop-step-num">${escapeHTML(node.num)}</span>
    </a>${link ? '<div class="loop-link" aria-hidden="true"></div>' : ''}`;
  const loopBack = `<a class="loop-back" href="${VIEW_PATHS.timers}" data-route="timers"><span class="loop-back-mark" aria-hidden="true">${icon('timers')}</span><span>Sets follow-ups and timers, which come back through the inbox</span></a>`;
  const stack = `<div class="loop-stack">${step(m.timers)}${step(m.inbox)}${step(m.memory)}${step(m.run, false)}${loopBack}<div class="loop-link" aria-hidden="true"></div>${step(m.permissions)}${step(m.outbox)}${step(m.people, false)}</div>`;
  return svg + stack;
}

// ---- Approvals: deferred tool calls and access asks -----------------------------------------------
async function refreshApprovals({ throwOnError = false } = {}) {
  try {
    const [pending, schedules] = await Promise.all([api('/requests?state=pending'), api('/schedules').catch(() => null)]);
    state.requests = [...pending, ...state.requests.filter(request => request.state !== 'pending')]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (schedules) state.schedules = schedules.schedules || state.schedules;
    loadScopeLabels();
    renderApprovals();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Approvals not refreshed: ${error.message}`, 'error');
  }
}

function renderApprovals() {
  const host = $('#approvals-content');
  if (!host) return;
  host.setAttribute('aria-busy', 'false');
  // A live update must not throw away an edit Aaron is typing into a waiting request.
  const drafts = $$('.request-card', host).map(card => ({ id: card.dataset.requestId, open: !$('.decision-note', card).hidden, text: $('textarea', card)?.value || '' })).filter(d => d.open || d.text);
  const focusedId = document.activeElement?.closest?.('.request-card textarea') ? document.activeElement.closest('.request-card').dataset.requestId : null;
  const waiting = pendingRequests();
  state.selectedWaiting = Math.max(0, Math.min(state.selectedWaiting, waiting.length - 1));
  const held = (state.schedules || []).filter(s => s.needs_approval);
  const access = waiting.filter(r => (r.outcome?.text || '').startsWith('Asked you for access')).length;
  host.innerHTML = `<div class="stat-cards">
      ${statCard({ label: 'Deferred tool calls', icon: 'runs', value: waiting.length - access, tone: waiting.length - access ? 'waiting' : '' })}
      ${statCard({ label: 'Access asks', icon: 'permissions', value: access, tone: access ? 'waiting' : '' })}
      ${statCard({ label: 'Schedules waiting', icon: 'schedule', value: held.length, tone: held.length ? 'waiting' : '' })}
    </div>
    <section class="card">
      <header class="title-bar"><span class="tb-icon tone-waiting">${icon('approvals')}</span><h2>Waiting on you</h2><span class="badge${waiting.length ? ' tone-waiting' : ''}">${waiting.length}</span></header>
      <div id="waiting-list" class="waiting-list">${waiting.length ? waiting.map((request, index) => requestCard(request, index)).join('') : `<div class="approval-empty"><span class="tb-icon">${icon('done')}</span><span>Nothing is waiting on you.</span></div>`}</div>
    </section>
    ${held.length ? `<section class="card">
      <header class="title-bar"><span class="tb-icon tone-waiting">${icon('schedule')}</span><h2>Schedules waiting for your yes</h2><span class="badge tone-waiting">${held.length}</span></header>
      <div class="row-list">${held.map(sch => `<div class="row" data-schedule-id="${escapeHTML(sch.id)}"><div class="row-main"><span class="row-title">${escapeHTML(sch.title)}</span><span class="row-meta"><span class="pill">${escapeHTML(sentenceCase(sch.cadence_text))}</span><span class="pill tone-waiting">${escapeHTML(sch.state_label)}</span></span></div><div class="row-actions">${scheduleActionButtons(sch)}</div></div>`).join('')}</div>
    </section>` : ''}`;
  drafts.forEach(draft => {
    const card = $(`.request-card[data-request-id="${CSS.escape(draft.id)}"]`, host);
    if (!card) return;
    $('.decision-note', card).hidden = !draft.open;
    $('[data-show-edit]', card)?.setAttribute('aria-expanded', String(draft.open));
    $('textarea', card).value = draft.text;
    if (draft.id === focusedId) $('textarea', card).focus({ preventScroll: true });
  });
  updateWaitingCount();
}

// ---- Memory ------------------------------------------------------------------------------------
async function refreshMemory({ throwOnError = false } = {}) {
  try {
    state.memory = await api('/memory');
    renderMemory();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Memory not refreshed: ${error.message}`, 'error');
  }
}

function barList(entries, variant = '') {
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return `<div class="bar-list">${entries.map(([label, n]) => `<div class="bar-item"><span>${escapeHTML(label)}</span><span class="bar-track"><span class="bar-fill${variant ? ` ${variant}` : ''}" style="width:${Math.max(2, (n / max) * 100).toFixed(1)}%"></span></span><span class="num">${Number(n).toLocaleString()}</span></div>`).join('')}</div>`;
}

function renderMemory() {
  const host = $('#memory-content');
  if (!host) return;
  host.setAttribute('aria-busy', 'false');
  const m = state.memory;
  if (!m) { host.innerHTML = '<div class="card"><p class="empty-line">Memory is not available yet.</p></div>'; return; }
  const kindWords = { inbound: 'Received', outbound: 'Sent', system: 'Notes to itself' };
  const msgs = Object.entries(m.messages?.by_kind || {}).map(([k, v]) => [kindWords[k] || sentenceCase(k), v]).sort((a, b) => b[1] - a[1]);
  const msgTotal = msgs.reduce((a, [, v]) => a + v, 0);
  const taskWords = { open: 'Open', waiting_aaron: 'Waiting on you', running: 'Running', done: 'Done', failed: 'Failed', closed: 'Closed' };
  const tasks = Object.entries(m.tasks?.by_state || {}).map(([k, v]) => [taskWords[k] || sentenceCase(k), v]).sort((a, b) => b[1] - a[1]);
  const taskTotal = tasks.reduce((a, [, v]) => a + v, 0);
  const reported = Object.entries(m.reported?.by_kind || {}).sort((a, b) => b[1] - a[1]);
  const paragraphs = m.instructions?.paragraphs || [];
  host.innerHTML = `<div class="stat-cards">
      ${statCard({ label: 'User instructions', icon: 'instructions', value: paragraphs.length, unit: paragraphs.length === 1 ? 'paragraph' : 'paragraphs', pill: m.instructions?.updated_at ? relTime(m.instructions.updated_at) : '' })}
      ${statCard({ label: 'User notes', icon: 'notes', value: m.notes?.total || 0, unit: m.notes?.total === 1 ? 'note' : 'notes' })}
      ${statCard({ label: 'Past messages', icon: 'archive', value: msgTotal, unit: pl(m.messages?.chats || 0, 'chat'), chart: sparkBars(m.messages?.per_day || [], 'flow'), axis: ['14 days ago', 'Today'] })}
      ${statCard({ label: 'Task progress', icon: 'tasks', value: taskTotal, unit: taskTotal === 1 ? 'task' : 'tasks', pill: pl(m.tasks?.ledger_entries || 0, 'ledger line') })}
      ${statCard({ label: 'Graph memory', icon: 'graph', value: m.graph?.enabled ? 'On' : 'Off', tone: m.graph?.enabled ? 'done' : 'failed', pill: `${m.graph?.pending_writes || 0} queued` })}
    </div>
    <div class="memory-grid">
      <section class="card">
        <header class="title-bar"><span class="tb-icon">${icon('instructions')}</span><h2>User instructions</h2><span class="badge">${paragraphs.length}</span></header>
        ${paragraphs.length ? `<div class="instruction-list">${paragraphs.slice(0, 6).map(t => `<p class="instruction"><span>${escapeHTML(t)}</span></p>`).join('')}</div>
          ${paragraphs.length > 6 ? `<details class="lane-more"><summary><span class="pill tone-accent">Show ${paragraphs.length - 6} more</span></summary><div class="instruction-list" style="counter-reset: ins 6">${paragraphs.slice(6).map(t => `<p class="instruction"><span>${escapeHTML(t)}</span></p>`).join('')}</div></details>` : ''}`
          : '<p class="empty-line">No standing instructions.</p>'}
      </section>
      <div class="stack">
        <section class="card">
          <header class="title-bar"><span class="tb-icon">${icon('notes')}</span><h2>User notes</h2><span class="badge">${m.notes?.total || 0}</span></header>
          ${m.notes?.available ? barList((m.notes.sections || []).map(s => [s.name, s.count])) : '<p class="empty-line">No vault on this server.</p>'}
          ${(m.notes?.recent || []).length ? `${subBar('Recently changed', 'notes', m.notes.recent.length)}<ul class="row-list">${m.notes.recent.map(n => `<li class="row"><div class="row-main"><span class="row-title">${escapeHTML(n.title)}</span></div><span class="row-meta"><span class="pill">${escapeHTML(n.section)}</span><span class="pill">${escapeHTML(relTime(n.updated_at))}</span></span></li>`).join('')}</ul>` : ''}
        </section>
        <section class="card">
          <header class="title-bar"><span class="tb-icon tone-flow">${icon('graph')}</span><h2>Graph memory</h2><span class="pill tone-${m.graph?.enabled ? 'done' : 'failed'}">${m.graph?.enabled ? 'On' : 'Off'}</span></header>
          <div class="card-body tag-line"><span class="pill">Recall waits ${escapeHTML(m.graph?.recall_seconds)} s</span><span class="pill">Up to ${escapeHTML(m.graph?.max_facts)} facts a turn</span><span class="pill${m.graph?.pending_writes ? ' tone-running' : ''}">${escapeHTML(pl(m.graph?.pending_writes || 0, 'write'))} queued</span></div>
        </section>
      </div>
      <section class="card">
        <header class="title-bar"><span class="tb-icon">${icon('archive')}</span><h2>Past messages</h2><span class="badge">${msgTotal.toLocaleString()}</span></header>
        ${barList(msgs, 'flow')}
        ${subBar('Reported back', 'reported', m.reported?.total || 0)}
        ${reported.length ? barList(reported) : '<p class="empty-line">Nothing reported yet.</p>'}
      </section>
      ${(m.access || []).length ? `<section class="card memory-access">
        <header class="title-bar"><span class="tb-icon">${icon('permissions')}</span><h2>Who can read it</h2><a class="pill tone-accent" href="${VIEW_PATHS.permissions}" data-route="permissions">${icon('roles')}Edit on Permissions</a></header>
        <ul class="row-list">${m.access.map(a => `<li class="row access-part">
          <div class="row-main"><span class="row-title">${escapeHTML(a.part)}</span><span class="row-sub">${escapeHTML(a.readers)}</span>
          ${(a.who || []).length ? `<span class="tag-line">${a.who.map(w => `<span class="pill tone-waiting" title="${escapeHTML(w.people)}">${escapeHTML(folderName(w.reach))} · ${escapeHTML(pl(w.count, 'person', 'people'))}</span>`).join('')}</span>` : ''}</div>
        </li>`).join('')}</ul>
      </section>` : ''}
      <section class="card">
        <header class="title-bar"><span class="tb-icon">${icon('tasks')}</span><h2>Task progress</h2><span class="badge">${taskTotal}</span></header>
        ${barList(tasks)}
        ${subBar('Latest', 'tasks', (m.tasks?.latest || []).length)}
        <div class="row-list">${(m.tasks?.latest || []).map(t => `<button type="button" class="row" data-task-id="${escapeHTML(t.id)}">${statePill(t.state)}<span class="row-main"><span class="row-title">${escapeHTML(clean(t.title) || 'Untitled task')}</span></span><span class="row-time">${escapeHTML(relTime(t.updated_at))}</span></button>`).join('')}</div>
      </section>
    </div>`;
}

// ---- Pages: the formatted web pages Blatbot sends for long answers -----------------------------
async function refreshPages({ throwOnError = false } = {}) {
  try {
    state.pages = await api('/pages');
    renderPages();
  } catch (error) {
    if (throwOnError) throw error;
    showNotice(`Pages not refreshed: ${error.message}`, 'error');
  }
}

function renderPages() {
  const host = $('#pages-content');
  if (!host) return;
  host.setAttribute('aria-busy', 'false');
  const data = state.pages || { pages: [] };
  const pages = data.pages || [];
  $('#pages-badge').textContent = pages.length;
  const audience = (CHOICE_WORDS.GATE_HTML_PAGES_AUDIENCE || {})[data.audience] || sentenceCase(data.audience || '');
  host.innerHTML = `<div class="stat-cards">
      ${statCard({ label: 'Live pages', icon: 'pages', value: pages.length })}
      ${statCard({ label: 'Who gets them', icon: 'people', value: audience || 'Unknown' })}
      ${statCard({ label: 'Kept for', icon: 'timers', value: Math.round(data.days || 0), unit: Math.round(data.days || 0) === 1 ? 'day' : 'days' })}
    </div>
    ${pages.length ? `<div class="page-cards">${pages.map(page => `<a class="card page-card" href="${escapeHTML(page.url)}" target="_blank" rel="noopener noreferrer">
        <div class="page-thumb" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <div class="page-card-body">${escapeHTML(page.title)}</div>
        <div class="page-card-foot"><span class="pill tone-accent">${icon('external')}Open</span><span class="pill">${escapeHTML(relTime(page.created_at))}</span><span class="pill">Expires ${escapeHTML(relTime(page.expires_at))}</span><span class="pill">${Math.max(1, Math.round((page.bytes || 0) / 1024))} KB</span></div>
      </a>`).join('')}</div>` : '<div class="card"><p class="empty-line">No pages sent yet.</p></div>'}`;
}

// ---- Permissions: auto mode and deferral switches ----------------------------------------------
function renderAutoMode() {
  const host = $('#automode-content');
  if (!host || !state.settings.length) return;
  const card = (name, iconName) => {
    const st = settingValue(name);
    if (!st) return '';
    const on = st.kind === 'bool' ? !!st.value : st.value != null;
    return statCard({ label: st.label, icon: iconName, value: st.kind === 'bool' ? (on ? 'On' : 'Off') : String(st.value), tone: on ? 'done' : '', href: VIEW_PATHS.settings, route: 'settings' });
  };
  const waiting = pendingRequests().length;
  host.innerHTML = [card('GATE_AUTO_MODE', 'auto'), card('GATE_NATIVE_DEFER', 'runs'), card('GATE_ACCESS_ASKS', 'permissions'),
    statCard({ label: 'Approvals waiting', icon: 'approvals', value: waiting, tone: waiting ? 'waiting' : '', href: VIEW_PATHS.approvals, route: 'approvals' })].join('');
}
