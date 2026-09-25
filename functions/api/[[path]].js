/**
 * Team Task Manager backend: Cloudflare Pages Functions + D1 database.
 * Serves the Mini App API, the Telegram bot webhook and the reminder check, all under /api.
 *
 *   POST /api            Mini App API: { action, args, initData }
 *   POST /api/telegram   Telegram webhook
 *   GET  /api/cron       Reminder check. Called every 5 minutes by the Google Sheet script.
 *   GET  /api/sync       Data for the Google Sheet copy (tasks, team, history, reports)
 *   POST /api/import     Copies the data from the Google Sheet into the database (one time)
 *   POST /api/setup      Points the bot at this server
 *
 * cron, sync, import and setup need the SYNC_KEY secret. See SETUP.md.
 */

const CATEGORIES = ['Daily', 'Weekly', 'Monthly', 'One-time'];
const SHIFTS = ['Morning', 'Evening', 'General'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // index + 1 = ISO weekday
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATUSES = ['Pending', 'In progress', 'Done', 'N/A'];
/** Pending and In progress are both still open (not done). */
function isOpen_(status) { return status === 'Pending' || status === 'In progress'; }
const SLOTS = ['morning', 'afternoon', 'evening', 'night'];
const DEFAULT_SETTINGS = { MORNING_TIME: '08:00', AFTERNOON_TIME: '14:00', EVENING_TIME: '20:00', NIGHT_TIME: '23:00', ADMIN_SUMMARY: 'Yes' };
const END_OF_DAY = '23:59';
const MAX_LINES = 30;
const TIME_ZONE = 'Asia/Kolkata';
const TZ_OFFSET_MIN = 330; // India has no daylight saving time
const HISTORY_DAYS = 62;   // the app looks this far back (dashboard); older data stays in the database and the Sheet
// Free plan: at most 50 outgoing requests per call. Messages over this budget wait in the outbox for the next check.
const SEND_BUDGET = 40;

// Column order of the Google Sheet copy (same as the old sheets, so nothing changes for people reading it)
const SHEET_COLUMNS = {
  tasks: ['ID', 'Title', 'Description', 'Category', 'Weekly Days', 'Monthly Date', 'Due Date', 'Shift', 'Time',
    'Type', 'Checklist', 'Assign To', 'Active', 'Created At'],
  team: ['User ID', 'Name', 'Username', 'Role', 'Status', 'Gets Tasks', 'Joined At'],
  logs: ['Log ID', 'Date', 'Task ID', 'Task Title', 'User ID', 'Name', 'Status', 'Checked Items', 'Remarks', 'Updated At'],
};
const DB_COLUMNS = {
  tasks: ['id', 'title', 'description', 'category', 'weekly_days', 'monthly_date', 'due_date', 'shift', 'time',
    'type', 'checklist', 'assign_to', 'active', 'created_at'],
  team: ['user_id', 'name', 'username', 'role', 'status', 'gets_tasks', 'joined_at'],
  logs: ['log_id', 'date', 'task_id', 'task_title', 'user_id', 'name', 'status', 'checked', 'remarks', 'updated_at'],
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, category TEXT, weekly_days TEXT,
    monthly_date TEXT, due_date TEXT, shift TEXT, time TEXT, type TEXT, checklist TEXT, assign_to TEXT, active TEXT, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS team (user_id TEXT PRIMARY KEY, name TEXT, username TEXT, role TEXT, status TEXT,
    gets_tasks TEXT, joined_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS logs (log_id TEXT PRIMARY KEY, date TEXT, task_id TEXT, task_title TEXT, user_id TEXT, name TEXT,
    status TEXT, checked TEXT, remarks TEXT, updated_at TEXT, updated_ms INTEGER, UNIQUE (task_id, user_id, date))`,
  'CREATE INDEX IF NOT EXISTS logs_date ON logs (date, task_id)',
  'CREATE INDEX IF NOT EXISTS logs_changed ON logs (updated_ms, log_id)',
  'CREATE TABLE IF NOT EXISTS deleted_logs (log_id TEXT PRIMARY KEY, deleted_ms INTEGER)',
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)',
  // Short-lived keys: Telegram update ids (duplicate delivery) and client ids of new tasks (retried saves)
  'CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, value TEXT, at INTEGER)',
  'CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT, at INTEGER)',
];

// ───────────────────────── HTTP entry point ─────────────────────────

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  if (!env.DB) return text_('The database is not connected yet (binding "DB" is missing). See SETUP.md.', 500);
  const app = makeApp(env, url.origin);
  try {
    if (route === '' || route === 'app') {
      if (request.method !== 'POST') return text_('Team Task Manager API is running.');
      let req;
      try { req = await request.json(); } catch (e) { return json_({ ok: false, error: 'Bad request.' }); }
      return json_(await app.api(req));
    }
    if (route === 'telegram') {
      if (request.method !== 'POST') return text_('ok');
      let u = null;
      try { u = await request.json(); } catch (e) { /* ignore */ }
      if (u) {
        try { await app.telegram(u, request.headers.get('X-Telegram-Bot-Api-Secret-Token') || ''); } catch (err) { console.error(err && err.stack || err); }
      }
      return text_('ok'); // always 200, or Telegram keeps redelivering the same update
    }
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const key = url.searchParams.get('key') || body.key || '';
    if (!['cron', 'sync', 'import', 'setup'].includes(route)) return text_('Not found', 404);
    if (!env.SYNC_KEY || key !== env.SYNC_KEY) return json_({ ok: false, error: 'Wrong or missing SYNC_KEY.' }, 403);
    if (route === 'cron') return json_({ ok: true, data: await app.cron() });
    if (route === 'sync') return json_({ ok: true, data: await app.sync(Object.fromEntries(url.searchParams)) });
    if (route === 'import') return json_({ ok: true, data: await app.importData(body) });
    return json_({ ok: true, data: await app.setup(body) });
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: (err && err.message) || String(err) }, route === '' || route === 'app' ? 200 : 500);
  }
}

function json_(o, status) {
  return new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
function text_(s, status) {
  return new Response(s, { status: status || 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// ───────────────────────── App (one instance per request) ─────────────────────────

/**
 * Everything below runs inside one request. Team, tasks and settings are read once at the start;
 * task history is read only for the days a request needs. Writes are collected and saved together
 * in one transaction (flush_).
 */
function makeApp(env, origin) {
  const db = env.DB;
  let TEAM = null;
  let TASKS = null;
  let SETTINGS = null;
  const LOGS = {};              // key(taskId|userId|date) → log entry
  const loadedDates = new Set(); // 'userId|taskId|date' or '*|taskId|date' already read from the database
  const WRITES = [];
  const OCC = new Map();         // occurrence cache: 'taskId|day' → due date
  const TASK_DAY = new Map();    // 'taskId|day' → the parts of an item that are the same for every member
  let SETTINGS_CACHE = null;
  const TODAY = todayStr_();
  const NOW = nowStr_();
  let sendBudget = SEND_BUDGET;

  // ── Loading ──

  async function loadBase_() {
    if (TEAM) return;
    let res;
    try {
      res = await db.batch([
        db.prepare('SELECT * FROM team ORDER BY rowid'),
        db.prepare('SELECT * FROM tasks ORDER BY rowid'),
        db.prepare('SELECT key, value FROM settings'),
      ]);
    } catch (err) {
      if (/no such table/i.test(String(err && err.message))) throw new Error('The app is being upgraded. Please try again in a few minutes.');
      throw err;
    }
    TEAM = res[0].results.map(teamFromDb_).filter(m => m.id);
    TASKS = res[1].results.map(taskFromDb_).filter(t => t.id && CATEGORIES.includes(t.category));
    SETTINGS = {};
    res[2].results.forEach(r => { SETTINGS[r.key] = r.value; });
  }

  /**
   * Reads the history rows the given days need: for each task, only its open occurrence on those days
   * (e.g. a weekly task's Monday row, not every daily task's row on that Monday).
   */
  async function loadLogs_(days, userId) {
    const who = userId || '*';
    const byDate = {}; // due date → task ids
    days.forEach(d => TASKS.forEach(t => {
      const o = occurrenceFor_(t, d);
      if (!o || loadedDates.has('*|' + t.id + '|' + o) || loadedDates.has(who + '|' + t.id + '|' + o)) return;
      (byDate[o] = byDate[o] || new Set()).add(t.id);
    }));
    const groups = Object.keys(byDate).sort().map(d => [d, [...byDate[d]]]);
    if (!groups.length) return;
    // One statement per group of dates, staying under the 100-parameter limit
    const stmts = [];
    let conds = [];
    let params = [];
    const push = () => {
      if (!conds.length) return;
      const sql = 'SELECT * FROM logs WHERE (' + conds.join(' OR ') + ')' + (userId ? ' AND user_id = ?' : '');
      stmts.push(db.prepare(sql).bind(...params, ...(userId ? [userId] : [])));
      conds = [];
      params = [];
    };
    groups.forEach(([d, ids]) => {
      for (let i = 0; i < ids.length; i += 80) {
        const part = ids.slice(i, i + 80);
        if (params.length + part.length + 2 > 95) push();
        conds.push(`(date = ? AND task_id IN (${part.map(() => '?').join(',')}))`);
        params.push(d, ...part);
      }
    });
    push();
    const res = await db.batch(stmts);
    res.forEach(r => r.results.forEach(row => { LOGS[key_(row.task_id, row.user_id, row.date)] = logFromDb_(row); }));
    groups.forEach(([d, ids]) => ids.forEach(id => loadedDates.add(who + '|' + id + '|' + d)));
  }

  function daysBetweenList_(start, end) {
    const out = [];
    for (let d = start; d <= end; d = addDays_(d, 1)) out.push(d);
    return out;
  }

  // ── Writing ──

  function run_(sql, ...params) { WRITES.push(db.prepare(sql).bind(...params.map(v => (v === undefined || v === null ? '' : v)))); }
  async function flush_() {
    if (!WRITES.length) return;
    await db.batch(WRITES.splice(0));
  }

  function setSetting_(k, v) {
    SETTINGS[k] = String(v);
    SETTINGS_CACHE = null;
    TASK_DAY.clear();
    run_('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', k, String(v));
  }
  function deleteSetting_(k) { delete SETTINGS[k]; SETTINGS_CACHE = null; run_('DELETE FROM settings WHERE key = ?', k); }

  /** values in SHEET_COLUMNS.team order */
  function saveTeamRow_(values) {
    const v = values.map(x => String(x == null ? '' : x));
    run_(`INSERT INTO team (${DB_COLUMNS.team.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET ${DB_COLUMNS.team.slice(1).map(c => `${c} = excluded.${c}`).join(', ')}`, ...v);
    const m = teamFromDb_(Object.fromEntries(DB_COLUMNS.team.map((c, i) => [c, v[i]])));
    const i = TEAM.findIndex(x => x.id === m.id);
    if (i >= 0) TEAM[i] = m; else TEAM.push(m);
    return m;
  }
  function deleteTeamRow_(id) {
    run_('DELETE FROM team WHERE user_id = ?', id);
    TEAM = TEAM.filter(x => x.id !== id);
  }

  /** values in SHEET_COLUMNS.tasks order */
  function saveTaskRow_(values, isNew) {
    const v = values.map(x => String(x == null ? '' : x));
    if (isNew) run_(`INSERT INTO tasks (${DB_COLUMNS.tasks.join(', ')}) VALUES (${DB_COLUMNS.tasks.map(() => '?').join(', ')})`, ...v);
    else run_(`UPDATE tasks SET ${DB_COLUMNS.tasks.slice(1).map(c => `${c} = ?`).join(', ')} WHERE id = ?`, ...v.slice(1), v[0]);
    const t = taskFromDb_(Object.fromEntries(DB_COLUMNS.tasks.map((c, i) => [c, v[i]])));
    const i = TASKS.findIndex(x => x.id === t.id);
    if (i >= 0) TASKS[i] = t; else TASKS.push(t);
    OCC.clear();
    TASK_DAY.clear();
  }
  function deleteTaskRow_(id) {
    run_('DELETE FROM tasks WHERE id = ?', id);
    TASKS = TASKS.filter(x => x.id !== id);
    OCC.clear();
    TASK_DAY.clear();
  }

  function saveLog_(values) {
    const v = values.map(x => String(x == null ? '' : x));
    run_(`INSERT INTO logs (${DB_COLUMNS.logs.join(', ')}, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (task_id, user_id, date) DO UPDATE SET task_title = excluded.task_title, name = excluded.name,
      status = excluded.status, checked = excluded.checked, remarks = excluded.remarks, updated_at = excluded.updated_at,
      updated_ms = excluded.updated_ms`, ...v, Date.now());
  }
  function deleteLog_(taskId, userId, date) {
    run_(`INSERT INTO deleted_logs (log_id, deleted_ms) SELECT log_id, ? FROM logs WHERE task_id = ? AND user_id = ? AND date = ?
      ON CONFLICT (log_id) DO UPDATE SET deleted_ms = excluded.deleted_ms`, Date.now(), taskId, userId, date);
    run_('DELETE FROM logs WHERE task_id = ? AND user_id = ? AND date = ?', taskId, userId, date);
  }

  // ── Accessors (same names as the old Apps Script version) ──

  function getTeam_() { return TEAM; }
  function getTasks_() { return TASKS; }
  function getLogMap_() { return LOGS; }
  function token_() { return SETTINGS.BOT_TOKEN || ''; }
  function settings_() {
    if (SETTINGS_CACHE) return SETTINGS_CACHE;
    const s = {};
    Object.keys(DEFAULT_SETTINGS).forEach(k => { s[k] = SETTINGS[k] || DEFAULT_SETTINGS[k]; });
    SETTINGS_CACHE = s;
    return s;
  }
  function slotTimes_() {
    const s = settings_();
    return { morning: s.MORNING_TIME, afternoon: s.AFTERNOON_TIME, evening: s.EVENING_TIME, night: s.NIGHT_TIME };
  }
  function publicSettings_() {
    const s = settings_();
    return {
      morningTime: s.MORNING_TIME, afternoonTime: s.AFTERNOON_TIME, eveningTime: s.EVENING_TIME, nightTime: s.NIGHT_TIME,
      adminSummary: s.ADMIN_SUMMARY !== 'No',
    };
  }
  function miniAppLink_() { return origin + '/'; }

  // ───────────────────────── Mini App API ─────────────────────────

  const API = {
    bootstrap: { role: 'any', fn: apiBootstrap_ },
    claimAdmin: { role: 'any', fn: apiClaimAdmin_ },
    myDay: { role: 'member', fn: apiMyDay_ },
    upcoming: { role: 'member', fn: apiUpcoming_ },
    updateItem: { role: 'member', fn: apiUpdateItem_ },
    updateItems: { role: 'member', fn: apiUpdateItems_ },
    dashboard: { role: 'admin', fn: apiDashboard_ },
    listTasks: { role: 'admin', fn: apiListTasks_ },
    saveTask: { role: 'admin', fn: apiSaveTask_ },
    saveTasks: { role: 'admin', fn: apiSaveTasks_ },
    deleteTask: { role: 'admin', fn: apiDeleteTask_ },
    listTeam: { role: 'admin', fn: apiListTeam_ },
    reviewMember: { role: 'admin', fn: apiReviewMember_ },
    saveMember: { role: 'admin', fn: apiSaveMember_ },
    removeMember: { role: 'admin', fn: apiRemoveMember_ },
    getSettings: { role: 'admin', fn: apiGetSettings_ },
    saveSettings: { role: 'admin', fn: apiSaveSettings_ },
    sendNow: { role: 'admin', fn: apiSendNow_ },
    broadcast: { role: 'admin', fn: apiBroadcast_ },
  };

  async function api(req) {
    try {
      await loadBase_();
      if (SETTINGS.READY !== '1' || !token_()) throw new Error('The app is being upgraded. Please try again in a few minutes.');
      const tgUser = await verifyInitData_(req.initData);
      const action = API[req.action];
      if (!action) throw new Error('Unknown action.');
      const member = TEAM.find(m => m.id === String(tgUser.id)) || null;
      if (action.role !== 'any') {
        if (!member || member.status !== 'Active') throw new Error('Your access has not been approved yet.');
        if (action.role === 'admin' && member.role !== 'Admin') throw new Error('Only an Admin can do this.');
      }
      await loadLogs_([todayStr_()], String(tgUser.id)); // almost every action needs the caller's open tasks
      const data = await action.fn({ tgUser, member }, req.args || {});
      await flush_();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  /** Verifies the signed initData Telegram passes to the Mini App and returns the Telegram user. */
  async function verifyInitData_(initData) {
    if (!initData) throw new Error('Please open this app from the Telegram bot.');
    const params = {};
    String(initData).split('&').forEach(pair => {
      const i = pair.indexOf('=');
      if (i > 0) params[urlDecode_(pair.slice(0, i))] = urlDecode_(pair.slice(i + 1));
    });
    if (!params.hash) throw new Error('Invalid session. Please reopen the app from Telegram.');
    const dataCheck = Object.keys(params).filter(k => k !== 'hash').sort().map(k => k + '=' + params[k]).join('\n');
    const secretKey = await hmac_(utf8_('WebAppData'), utf8_(token_()));
    const sig = hex_(await hmac_(secretKey, utf8_(dataCheck)));
    if (sig !== params.hash) throw new Error('Invalid session. Please reopen the app from Telegram.');
    if (Date.now() / 1000 - Number(params.auth_date) > 86400) throw new Error('Session expired. Please close and reopen the app.');
    const user = JSON.parse(params.user || '{}');
    if (!user.id) throw new Error('Invalid session. Please reopen the app from Telegram.');
    return user;
  }

  async function apiBootstrap_(ctx) {
    let m = ctx.member;
    if (!m) {
      if (!TEAM.some(x => x.role === 'Admin' && x.status === 'Active')) return { state: 'claim' };
      m = await addJoinRequest_(ctx.tgUser);
    }
    if (m.status === 'Pending') return { state: 'pending', name: m.name };
    if (m.status === 'Rejected') return { state: 'rejected' };
    // Everything the first screens need comes in this one request
    const ctxM = { member: m };
    const out = {
      state: 'active',
      user: { id: m.id, name: m.name, role: m.role, getsTasks: m.getsTasks },
      today: todayStr_(),
      settings: publicSettings_(),
      myDay: apiMyDay_(ctxM),
      upcoming: apiUpcoming_(ctxM),
    };
    if (m.role === 'Admin') out.admin = { tasks: apiListTasks_(), team: apiListTeam_(), settings: apiGetSettings_() };
    return out;
  }

  async function apiClaimAdmin_(ctx, args) {
    if (TEAM.some(x => x.role === 'Admin' && x.status === 'Active')) throw new Error('An admin already exists.');
    const code = SETTINGS.ADMIN_CLAIM_CODE;
    if (!code || String(args.code || '').trim() !== code) throw new Error('Wrong admin code. Check the log of setup in Apps Script.');
    const u = ctx.tgUser;
    saveTeamRow_([String(u.id), tgName_(u), u.username || '', 'Admin', 'Active', 'No', nowStr_()]);
    deleteSetting_('ADMIN_CLAIM_CODE');
    await flush_();
    return apiBootstrap_({ tgUser: u, member: TEAM.find(x => x.id === String(u.id)) });
  }

  function apiMyDay_(ctx) {
    const today = todayStr_();
    const items = sortItems_(memberItems_(ctx.member, today, TASKS, LOGS));
    return { today, now: nowStr_(), items, settings: publicSettings_(), week: weekRange_(today), month: monthRange_(today) };
  }

  function apiUpcoming_(ctx) {
    const today = todayStr_();
    const tasks = TASKS.filter(t => t.category !== 'Daily' && !isFlexible_(t) && isAssigned_(t, ctx.member));
    const list = [];
    for (let i = 1; i <= 31; i++) {
      const day = addDays_(today, i);
      tasks.forEach(t => {
        if (occurrenceFor_(t, day) === day) {
          list.push({ date: day, taskId: t.id, title: t.title, category: t.category, shift: t.shift, time: t.time, optional: t.optional });
        }
      });
    }
    return { today, list };
  }

  function apiUpdateItem_(ctx, args) {
    return applyItemUpdate_(ctx.member, String(args.taskId || ''), String(args.dueDate || ''), {
      status: args.status,
      checked: Array.isArray(args.checked) ? args.checked : undefined,
      remarks: args.remarks,
    });
  }

  /**
   * Several task updates from one member in a single request (the Mini App batches quick taps).
   * updates: [{ taskId, dueDate, status?, checked?, remarks? }]. Each one succeeds or fails on its own.
   */
  function apiUpdateItems_(ctx, args) {
    const updates = (Array.isArray(args.updates) ? args.updates : []).slice(0, 100);
    return {
      results: updates.map(u => {
        try {
          const changes = { status: u.status, checked: Array.isArray(u.checked) ? u.checked : undefined, remarks: u.remarks };
          return { item: applyItemUpdate_(ctx.member, String(u.taskId || ''), String(u.dueDate || ''), changes) };
        } catch (e) {
          return { error: e.message };
        }
      }),
    };
  }

  async function apiDashboard_(ctx, args) {
    const today = todayStr_();
    const minDay = addDays_(today, -HISTORY_DAYS);
    let day = /^\d{4}-\d{2}-\d{2}$/.test(args.day || '') && args.day <= today ? args.day : today;
    if (day < minDay) day = minDay;
    await loadLogs_([day]);
    const members = TEAM.filter(m => m.status === 'Active').map(m => {
      const items = sortItems_(memberItems_(m, day, TASKS, LOGS));
      const slim = items.map(i => ({
        taskId: i.taskId, title: i.title, category: i.category, optional: i.optional, status: i.status,
        updatedAt: i.updatedAt, remarks: i.remarks, late: i.late, missed: i.missed, doneLate: i.doneLate,
      }));
      return Object.assign({ id: m.id, name: m.name, items: slim }, countItems_(items, day));
    }).filter(m => m.items.length);
    return { day, today, minDay, isPast: day < today, members, activeTasks: TASKS.filter(t => t.active).length };
  }

  function apiListTasks_() {
    return {
      tasks: TASKS.map(publicTask_),
      members: TEAM.filter(m => m.status === 'Active').map(m => ({ id: m.id, name: m.name, getsTasks: m.getsTasks })),
    };
  }

  /** Validates one task from the Mini App and returns the values to store. Throws a readable error. */
  function prepareTask_(input) {
    const t = {
      title: String(input.title || '').trim().slice(0, 200),
      description: String(input.description || '').trim().slice(0, 1000),
      category: input.category,
      weeklyDays: '', monthlyDate: '', dueDate: '',
      shift: SHIFTS.includes(input.shift) ? input.shift : 'General',
      time: '',
      type: input.optional ? 'If applicable' : 'Mandatory',
      // Stored one item per line; optional items end with "(optional)" so the sheet stays readable
      checklist: (Array.isArray(input.checklist) ? input.checklist : String(input.checklist || '').split('\n'))
        .map(c => (typeof c === 'object' && c ? c : parseChecklistItem_(String(c))))
        .map(c => ({ text: String(c.text || '').trim().slice(0, 120), optional: !!c.optional }))
        .filter(c => c.text).slice(0, 30)
        .map(c => c.text + (c.optional ? ' (optional)' : '')).join('\n'),
      assignTo: 'All',
      active: input.active !== false,
    };
    if (!t.title) throw new Error('Task title is required.');
    if (!CATEGORIES.includes(t.category)) throw new Error('Please select a category.');
    if (t.category === 'Weekly') {
      if (input.weeklyAny) {
        t.weeklyDays = 'Any';
      } else {
        const days = (input.weeklyDays || []).filter(d => WEEKDAYS.includes(d));
        if (!days.length) throw new Error('Please select at least one day, or choose "Any day".');
        t.weeklyDays = WEEKDAYS.filter(d => days.includes(d)).join(', ');
      }
    }
    if (t.category === 'Monthly') {
      if (input.monthlyAny) {
        t.monthlyDate = 'Any';
      } else {
        const n = Number(input.monthlyDate);
        if (!(Number.isInteger(n) && n >= 1 && n <= 31)) throw new Error('Please enter a date between 1 and 31, or choose "Any time".');
        t.monthlyDate = n;
      }
    }
    if (t.category === 'One-time') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate || '')) throw new Error('Please select a due date for the one-time task.');
      t.dueDate = input.dueDate;
    }
    if (input.time) {
      t.time = normTime_(input.time);
      if (!t.time) throw new Error('Please enter a valid time.');
    }
    if (input.assignTo && input.assignTo !== 'All') {
      const ids = (input.assignTo || []).map(String);
      const valid = TEAM.filter(m => ids.includes(m.id)).map(m => m.id);
      if (!valid.length) throw new Error('Please select at least one member, or assign to All.');
      t.assignTo = valid.join(', ');
    }
    return t;
  }

  function taskRow_(t, id, createdAt) {
    return [id, t.title, t.description, t.category, t.weeklyDays, t.monthlyDate, t.dueDate, t.shift,
      t.time, t.type, t.checklist, t.assignTo, t.active ? 'Yes' : 'No', createdAt];
  }

  /**
   * Saves several task changes in one request (the Mini App batches quick successive saves).
   * items: [{ op: 'save', clientId, task } | { op: 'delete', id }]. Each item succeeds or fails on its own.
   * New tasks carry a clientId so a retried request never creates the same task twice.
   */
  async function apiSaveTasks_(ctx, args) {
    const items = (Array.isArray(args.items) ? args.items : []).slice(0, 50);
    const results = items.map(it => ({ clientId: String(it.clientId || ''), op: it.op === 'delete' ? 'delete' : 'save' }));
    const prepared = items.map((it, i) => {
      if (results[i].op === 'delete') return null;
      try { return prepareTask_(it.task || {}); } catch (e) { results[i].error = e.message; return null; }
    });
    // Tasks an earlier attempt of this same request already created
    const clientKeys = results.filter(r => r.clientId).map(r => 'ct_' + r.clientId);
    const known = {};
    if (clientKeys.length) {
      const r = await db.prepare(`SELECT key, value FROM seen WHERE key IN (${clientKeys.map(() => '?').join(',')})`).bind(...clientKeys).all();
      r.results.forEach(x => { known[x.key] = x.value; });
    }
    let max = TASKS.reduce((m, x) => Math.max(m, Number(x.id.replace(/\D/g, '')) || 0), 0);
    items.forEach((it, i) => {
      const r = results[i];
      if (r.error) return;
      if (r.op === 'delete') {
        if (TASKS.some(x => x.id === it.id)) deleteTaskRow_(it.id);
        r.id = it.id;
        return;
      }
      const input = it.task;
      if (input.id) {
        const ex = TASKS.find(x => x.id === input.id);
        if (!ex) { r.error = 'Task not found. It may have been deleted.'; return; }
        saveTaskRow_(taskRow_(prepared[i], ex.id, ex.createdAt), false);
        r.id = ex.id;
        return;
      }
      const already = r.clientId && known['ct_' + r.clientId];
      if (already) { r.id = already; return; }
      r.id = 'T' + String(++max).padStart(3, '0');
      saveTaskRow_(taskRow_(prepared[i], r.id, nowStr_()), true);
      if (r.clientId) run_('INSERT OR REPLACE INTO seen (key, value, at) VALUES (?, ?, ?)', 'ct_' + r.clientId, r.id, Date.now());
    });
    await flush_();
    return Object.assign(apiListTasks_(), { results });
  }

  async function apiSaveTask_(ctx, input) {
    const out = await apiSaveTasks_(ctx, { items: [{ op: 'save', clientId: input.clientId, task: input }] });
    if (out.results[0].error) throw new Error(out.results[0].error);
    return { tasks: out.tasks, members: out.members };
  }

  async function apiDeleteTask_(ctx, args) {
    const out = await apiSaveTasks_(ctx, { items: [{ op: 'delete', id: args.id }] });
    return { tasks: out.tasks, members: out.members };
  }

  function apiListTeam_() {
    return TEAM.map(m => ({
      id: m.id, name: m.name, username: m.username, role: m.role, status: m.status, getsTasks: m.getsTasks, joinedAt: m.joinedAt,
    }));
  }

  async function apiReviewMember_(ctx, args) {
    await reviewMember_(String(args.id), !!args.approve, ctx.member);
    return apiListTeam_();
  }

  function apiSaveMember_(ctx, args) {
    const ex = TEAM.find(x => x.id === String(args.id));
    if (!ex) throw new Error('Member not found.');
    const name = String(args.name || '').trim() || ex.name;
    const role = args.role === 'Admin' ? 'Admin' : 'Member';
    if (ex.role === 'Admin' && role !== 'Admin' && TEAM.filter(x => x.role === 'Admin' && x.status === 'Active').length === 1) {
      throw new Error('There must be at least one Admin.');
    }
    saveTeamRow_([ex.id, name, ex.username, role, ex.status, args.getsTasks === false ? 'No' : 'Yes', ex.joinedAt]);
    return apiListTeam_();
  }

  function apiRemoveMember_(ctx, args) {
    if (String(args.id) === ctx.member.id) throw new Error('You cannot remove yourself.');
    if (TEAM.some(x => x.id === String(args.id))) deleteTeamRow_(String(args.id));
    return apiListTeam_();
  }

  function apiGetSettings_() {
    return Object.assign(publicSettings_(), { botUsername: SETTINGS.BOT_USERNAME || '', timeZone: TIME_ZONE });
  }

  function apiSaveSettings_(ctx, args) {
    const times = [args.morningTime, args.afternoonTime, args.eveningTime, args.nightTime].map(normTime_);
    if (times.some(x => !x)) throw new Error('Please enter valid times.');
    for (let i = 1; i < times.length; i++) {
      if (times[i] <= times[i - 1]) throw new Error('Reminder times must be in order: Morning, Afternoon, Evening, Night.');
    }
    setSetting_('MORNING_TIME', times[0]);
    setSetting_('AFTERNOON_TIME', times[1]);
    setSetting_('EVENING_TIME', times[2]);
    setSetting_('NIGHT_TIME', times[3]);
    setSetting_('ADMIN_SUMMARY', args.adminSummary ? 'Yes' : 'No');
    return apiGetSettings_();
  }

  async function apiSendNow_(ctx, args) {
    const today = todayStr_();
    if (args.type === 'test') {
      const ok = await sendTelegram_(ctx.member.id, '🧪 <b>Test message</b>\n\n' + dayListMessage_(ctx.member, false), openAppKeyboard_());
      if (!ok) throw new Error('Message could not be sent. Open the bot and tap Start first.');
      return { sent: 1 };
    }
    if (!SLOTS.includes(args.type)) throw new Error('Unknown reminder type.');
    return { sent: await dispatch_([{ day: today, type: args.type }]) };
  }

  /**
   * Admin's custom message to the team through the bot.
   * args: { text, to: 'All' | [userIds] }. Returns who got it and who couldn't be reached.
   */
  async function apiBroadcast_(ctx, args) {
    const textIn = String(args.text || '').trim();
    if (!textIn) throw new Error('Please write a message.');
    if (textIn.length > 3500) throw new Error('Message is too long (max 3500 characters).');
    let people = TEAM.filter(m => m.status === 'Active');
    if (args.to !== 'All') {
      const ids = (Array.isArray(args.to) ? args.to : []).map(String);
      people = people.filter(m => ids.includes(m.id));
      if (!people.length) throw new Error('Please select at least one person.');
    }
    const body = `📢 <b>Message from ${esc_(ctx.member.name)}</b>\n\n${esc_(textIn)}`;
    const results = await sendMany_(people.map(m => ({ chat_id: m.id, text: body, reply_markup: openAppKeyboard_() })));
    const failed = [];
    let sent = 0;
    results.forEach((r, i) => { if (r === false) failed.push(people[i].name); else sent++; }); // queued counts as sent
    return { sent, failed };
  }

  // ───────────────────────── Task status updates ─────────────────────────

  /** Applies one status/checklist/remarks change. The caller's logs for today must be loaded. */
  function applyItemUpdate_(member, taskId, dueDate, changes) {
    const task = TASKS.find(t => t.id === taskId);
    if (!task) throw new Error('Task not found. Please refresh.');
    if (!isAssigned_(task, member)) throw new Error('This task is not assigned to you.');
    const today = todayStr_();
    if (occurrenceFor_(task, today) !== dueDate) throw new Error('This task is closed (the deadline period has ended). Please refresh.');

    const k = key_(taskId, member.id, dueDate);
    const entry = LOGS[k];
    let status = entry ? entry.status : 'Pending';
    let checked = entry ? entry.checked.slice() : [];
    let remarks = entry ? entry.remarks : '';
    const n = task.checklist.length;
    const required = requiredItems_(task);
    const requiredDone = () => required.every(i => checked.includes(i));

    if (changes.checked) {
      checked = Array.from(new Set(changes.checked.map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < n))).sort((a, b) => a - b);
      // Ticking every required item completes the task; some ticks mean work has started (In progress).
      // Optional items (e.g. surprise checks) never block completion.
      if (status !== 'N/A') {
        if (required.length) status = requiredDone() ? 'Done' : (checked.length ? 'In progress' : 'Pending');
        else if (status !== 'Done') status = checked.length ? 'In progress' : 'Pending';
      }
    }
    if (changes.status) {
      if (!STATUSES.includes(changes.status)) throw new Error('Invalid status.');
      if (changes.status === 'N/A' && !task.optional) throw new Error('Only "If applicable" tasks can be marked N/A.');
      if (changes.status === 'Done' && !requiredDone()) {
        throw new Error('This task has a checklist. Please tick all required items first.');
      }
      if (changes.status === 'Pending') checked = [];
      status = changes.status;
    }
    if (changes.remarks !== undefined && changes.remarks !== null) remarks = String(changes.remarks).trim().slice(0, 500);

    const updatedAt = nowStr_();
    const empty = status === 'Pending' && !checked.length && !remarks;
    if (empty) {
      if (entry) deleteLog_(taskId, member.id, dueDate);
      delete LOGS[k];
    } else {
      // Keep the original completion time when only remarks/checklist change on a done task
      const stamp = entry && entry.status === status && status !== 'Pending' ? entry.updatedAt : updatedAt;
      const logId = entry ? entry.logId : 'L' + Date.now() + Math.floor(Math.random() * 1000);
      saveLog_([logId, dueDate, taskId, task.title, member.id, member.name, status, checked.join('|'), remarks, stamp]);
      LOGS[k] = { logId, status, checked, remarks, updatedAt: stamp };
    }
    return memberItems_(member, today, [task], LOGS)[0];
  }

  // ───────────────────────── Team ─────────────────────────

  async function addJoinRequest_(tgUser) {
    let member = TEAM.find(x => x.id === String(tgUser.id));
    if (!member) {
      member = saveTeamRow_([String(tgUser.id), tgName_(tgUser), tgUser.username || '', 'Member', 'Pending', 'Yes', nowStr_()]);
      await flush_();
    }
    if (member.status === 'Pending') {
      const who = esc_(member.name) + (member.username ? ' (@' + esc_(member.username) + ')' : '');
      await sendMany_(TEAM.filter(a => a.role === 'Admin' && a.status === 'Active').map(a => ({
        chat_id: a.id,
        text: `🙋 <b>${who}</b> wants to join Team Task Manager.`,
        reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: 'ap|' + member.id }, { text: '❌ Reject', callback_data: 'rj|' + member.id }]] },
      })));
    }
    return member;
  }

  async function reviewMember_(id, approve, admin) {
    const ex = TEAM.find(x => x.id === id);
    if (!ex) throw new Error('Member not found.');
    if (ex.status === 'Active' && approve) return;
    if (ex.role === 'Admin' && !approve) throw new Error('Admins cannot be rejected. Change their role first.');
    const m = saveTeamRow_([ex.id, ex.name, ex.username, ex.role, approve ? 'Active' : 'Rejected', ex.getsTasks ? 'Yes' : 'No', ex.joinedAt]);
    await flush_();
    if (approve) {
      await sendTelegram_(m.id, `✅ Hi <b>${esc_(m.name)}</b>, your access has been approved by ${esc_(admin.name)}.\nTap <b>Open Tasks</b> to see your tasks.`, openAppKeyboard_());
    } else {
      await sendTelegram_(m.id, 'Your request to join Team Task Manager was declined. Please contact your admin.');
    }
  }

  // ───────────────────────── Telegram bot (webhook) ─────────────────────────

  async function telegram(u, secretHeader) {
    await loadBase_();
    if (SETTINGS.READY !== '1' || !token_()) return;
    if (secretHeader !== await webhookSecret_()) return;
    // Telegram may deliver the same update twice
    const r = await db.prepare('INSERT OR IGNORE INTO seen (key, value, at) VALUES (?, ?, ?)').bind('upd_' + u.update_id, '1', Date.now()).run();
    if (!r.meta || !r.meta.changes) return;
    if (u.message) await onMessage_(u.message);
    else if (u.callback_query) await onCallback_(u.callback_query);
    await flush_();
  }

  async function webhookSecret_() {
    return hex_(await hmac_(utf8_(token_()), utf8_('telegram-webhook'))).slice(0, 48);
  }

  async function onMessage_(msg) {
    if (!msg.chat || msg.chat.type !== 'private' || !msg.text || !msg.from) return;
    const cmd = msg.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
    const member = TEAM.find(m => m.id === String(msg.from.id));
    const chatId = msg.chat.id;

    if (!member || member.status !== 'Active') {
      const t = member && member.status === 'Pending'
        ? '⏳ Your request is waiting for admin approval. You will get a message here once approved.'
        : member && member.status === 'Rejected'
          ? 'Your request was declined. Please contact your admin.'
          : '👋 Welcome to <b>Team Task Manager</b>!\nTap <b>Open Tasks</b> below to request access.';
      await sendTelegram_(chatId, t, member && member.status === 'Rejected' ? null : openAppKeyboard_());
      return;
    }
    await loadLogs_([todayStr_()], member.id);
    if (cmd === '/today' || cmd === '/pending') {
      await sendTelegram_(chatId, dayListMessage_(member, cmd === '/pending'), openAppKeyboard_());
      return;
    }
    await sendTelegram_(chatId, greetingMessage_(member), openAppKeyboard_());
  }

  /** Friendly time-of-day greeting with a one-line snapshot of the member's day. */
  function greetingMessage_(member) {
    const h = Number(nowHM_().slice(0, 2));
    const hello = h < 5 ? '🌙 Hello' : h < 12 ? '☀️ Good morning' : h < 17 ? '🌤️ Good afternoon' : '🌆 Good evening';
    const lines = [`${hello}, <b>${esc_(firstName_(member.name))}</b>!`];
    if (member.getsTasks) {
      const today = todayStr_();
      const c = countItems_(memberItems_(member, today, TASKS, LOGS), today);
      if (!c.total) lines.push('Nothing is due today. Have a great day!');
      else if (!c.pending) lines.push(`All <b>${c.total}</b> tasks for today are done. Great work! 🎉`);
      else lines.push(`You have <b>${c.pending}</b> of ${c.total} tasks left today${c.late ? `, <b>${c.late}</b> late` : ''}.`);
    } else {
      lines.push('Your team dashboard is ready.');
    }
    return lines.join('\n');
  }

  async function onCallback_(cq) {
    const parts = String(cq.data || '').split('|');
    const member = TEAM.find(m => m.id === String(cq.from.id) && m.status === 'Active');
    if (!member) return answerCallback_(cq.id, 'You do not have access.', true);
    const msg = cq.message;

    if (parts[0] === 'd' || parts[0] === 'u') {
      // d = mark done, u = undo (back to pending). The pressed button flips between the two.
      const done = parts[0] === 'd';
      let item;
      try {
        await loadLogs_([todayStr_()], member.id);
        item = applyItemUpdate_(member, parts[1], parts[2], { status: done ? 'Done' : 'Pending' });
        await flush_();
      } catch (err) {
        return answerCallback_(cq.id, err.message, true);
      }
      await answerCallback_(cq.id, !done ? 'Undone: task is pending again' : item && item.doneLate ? 'Marked as done (late) 🟠' : 'Marked as done ✅');
      if (msg && msg.reply_markup) {
        const title = short_(item ? item.title : '', 24);
        const flipped = done
          ? { text: '↩️ Undo ' + title, callback_data: 'u|' + parts[1] + '|' + parts[2] }
          : { text: '✅ ' + short_(item ? item.title : '', 28), callback_data: 'd|' + parts[1] + '|' + parts[2] };
        const rows = msg.reply_markup.inline_keyboard.map(r => r.map(b => (b.callback_data === cq.data ? flipped : b)));
        await tg_('editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: rows } });
      }
      return;
    }

    if (parts[0] === 'ap' || parts[0] === 'rj') {
      if (member.role !== 'Admin') return answerCallback_(cq.id, 'Only an Admin can do this.', true);
      try {
        await reviewMember_(parts[1], parts[0] === 'ap', member);
      } catch (err) {
        return answerCallback_(cq.id, err.message, true);
      }
      await answerCallback_(cq.id, parts[0] === 'ap' ? 'Approved' : 'Rejected');
      if (msg) {
        await tg_('editMessageText', {
          chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'HTML',
          text: esc_(msg.text || '') + `\n\n${parts[0] === 'ap' ? '✅ Approved' : '❌ Rejected'} by ${esc_(member.name)}`,
        });
      }
      return;
    }
    return answerCallback_(cq.id, '');
  }

  function answerCallback_(id, t, alert) {
    return tg_('answerCallbackQuery', { callback_query_id: id, text: t || '', show_alert: !!alert });
  }

  // ───────────────────────── Scheduled reminders ─────────────────────────

  /** Runs every 5 minutes and sends the 8 AM / 2 PM / 8 PM / 11 PM reminders when their time arrives. */
  async function cron() {
    await loadBase_();
    if (SETTINGS.READY !== '1' || !token_()) return { skipped: 'not ready' };
    const queued = await flushOutbox_();

    const now = new Date();
    const nowStr = dtStr_(now);
    const floor = dtStr_(new Date(now.getTime() - 30 * 60000)); // never catch up more than 30 minutes
    const prev = SETTINGS.LAST_TICK || '';
    let last = prev || dtStr_(new Date(now.getTime() - 5 * 60000));
    if (last < floor) last = floor;
    if (nowStr <= last) return { sentQueued: queued, events: [] };
    // Claim this window. If two checks run at once, only the one that moves LAST_TICK first sends.
    const claim = prev
      ? await db.prepare("UPDATE settings SET value = ? WHERE key = 'LAST_TICK' AND value = ?").bind(nowStr, prev).run()
      : await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('LAST_TICK', ?)").bind(nowStr).run();
    if (!claim.meta || !claim.meta.changes) return { skipped: 'another check is running' };

    const times = slotTimes_();
    const events = [];
    Array.from(new Set([last.slice(0, 10), nowStr.slice(0, 10)])).forEach(day => {
      SLOTS.forEach(slot => {
        const x = day + ' ' + times[slot];
        if (x > last && x <= nowStr) events.push({ day, type: slot });
      });
    });
    const sent = events.length ? await dispatch_(events) : 0;

    // Once a day: forget old duplicate-check keys
    const today = todayStr_();
    if (SETTINGS.LAST_CLEANUP !== today) {
      setSetting_('LAST_CLEANUP', today);
      run_('DELETE FROM seen WHERE at < ?', Date.now() - 3 * 86400000);
      run_('DELETE FROM deleted_logs WHERE deleted_ms < ?', Date.now() - 30 * 86400000);
      await flush_();
    }
    return { sentQueued: queued, events, sent };
  }

  /** Sends one combined message per member for the given reminder slots. Returns the number of messages sent. */
  async function dispatch_(events) {
    const team = TEAM.filter(m => m.status === 'Active');
    const s = settings_();
    const days = new Set();
    events.forEach(ev => {
      days.add(ev.day);
      if (ev.type === 'morning') {
        const y = addDays_(ev.day, -1);
        days.add(y);
        if (isoDay_(ev.day) === 1) daysBetweenList_(weekRange_(y).start, y).forEach(d => days.add(d));
        if (Number(ev.day.slice(8)) === 1) daysBetweenList_(monthRange_(y).start, y).forEach(d => days.add(d));
      }
    });
    days.add(todayStr_());
    await loadLogs_([...days]);

    const messages = [];
    team.forEach(m => {
      const sections = [];
      const buttons = [];
      events.forEach(ev => {
        const items = memberItems_(m, ev.day, TASKS, LOGS).filter(i => !i.optional);
        const out = slotMessage_(m, ev, items, s);
        if (!out) return;
        sections.push(out.text);
        out.buttons.forEach(b => { if (!buttons.some(x => x.callback_data === b.callback_data)) buttons.push(b); });
      });
      if (!sections.length) return;
      const rows = [];
      for (let i = 0; i < Math.min(buttons.length, 8); i += 2) rows.push(buttons.slice(i, Math.min(i + 2, 8)));
      messages.push({ chat_id: m.id, text: sections.join('\n\n'), reply_markup: { inline_keyboard: rows.concat(openAppKeyboard_().inline_keyboard) } });
    });

    if (s.ADMIN_SUMMARY !== 'No') {
      events.filter(e => e.type === 'morning').forEach(ev => {
        const t = adminReport_(team, TASKS, LOGS, ev.day);
        if (!t) return;
        team.filter(a => a.role === 'Admin').forEach(a => messages.push({ chat_id: a.id, text: t, reply_markup: openAppKeyboard_() }));
      });
    }
    const results = await sendMany_(messages);
    return results.filter(r => r !== false).length;
  }

  /**
   * Builds one member's section for a reminder slot.
   * morning: full day plan + week/month checkpoints · afternoon: morning tasks now late + evening plan
   * evening / night: everything still open today (+ week/month on their last day)
   */
  function slotMessage_(m, ev, items, s) {
    const day = ev.day;
    const first = esc_(firstName_(m.name));
    const pending = items.filter(i => isOpen_(i.status));
    const todays = pending.filter(i => !i.flexible);
    const carried = todays.filter(i => i.dueDate < day);
    const morning = todays.filter(i => i.dueDate === day && i.shift === 'Morning');
    const later = todays.filter(i => i.dueDate === day && i.shift !== 'Morning');
    const week = items.filter(i => i.flexible === 'week');
    const month = items.filter(i => i.flexible === 'month');
    const weekPending = week.filter(i => isOpen_(i.status));
    const monthPending = month.filter(i => isOpen_(i.status));
    const wd = isoDay_(day);
    const dom = Number(day.slice(8));
    const monthEnd = Number(monthRange_(day).end.slice(8));
    const isLastWeekDay = wd === 7;
    const isLastMonthDay = dom === monthEnd;
    const lines = [];
    const buttons = [];
    const addButtons = list => list.forEach(i => {
      if (!i.checklist.some(c => !c.optional)) buttons.push({ text: '✅ ' + short_(i.title, 28), callback_data: 'd|' + i.taskId + '|' + i.dueDate });
    });
    const section = (title, list, opts) => {
      if (!list.length) return;
      lines.push('', title, ...itemLines_(list, opts));
    };

    if (ev.type === 'morning') {
      lines.push(`☀️ <b>Good morning, ${first}!</b> ${prettyDate_(day)}`);
      section(`🔴 <b>Late (${carried.length})</b>: still open from earlier`, carried, { due: true });
      section(`☀️ <b>Morning tasks (${morning.length})</b>: complete by ${fmt12_(s.AFTERNOON_TIME)}`, morning);
      section(`🌇 <b>Evening &amp; general tasks (${later.length})</b>: complete by end of day`, later);
      if (wd === 1 && week.length) section(`📆 <b>This week (${week.length})</b>: complete by Sunday`, weekPending.length ? weekPending : [], {});
      else if (wd === 4 && weekPending.length) section(`📆 <b>Mid-week check</b>: ${weekPending.length} of ${week.length} weekly tasks pending, ${7 - wd} days left`, weekPending);
      else if (isLastWeekDay && weekPending.length) section(`⚠️ <b>Last day of the week</b>: ${weekPending.length} weekly task${weekPending.length === 1 ? '' : 's'} will be Missed after tonight`, weekPending);
      const left = monthEnd - dom;
      if (dom === 1 && month.length) section(`🗓️ <b>This month (${month.length})</b>: complete by ${prettyDate_(monthRange_(day).end)}`, monthPending);
      else if (dom === 15 && monthPending.length) section(`🗓️ <b>Mid-month check</b>: ${monthPending.length} of ${month.length} monthly tasks pending, ${left} days left`, monthPending);
      else if (left <= 2 && monthPending.length) {
        section(left === 0
          ? `⚠️ <b>Last day of the month</b>: ${monthPending.length} monthly task${monthPending.length === 1 ? '' : 's'} will be Missed after tonight`
          : `⚠️ <b>Month ends in ${left} day${left === 1 ? '' : 's'}</b>: ${monthPending.length} monthly task${monthPending.length === 1 ? '' : 's'} pending`, monthPending);
      }
      if (lines.length === 1) return null;
      addButtons(carried);
    } else if (ev.type === 'afternoon') {
      if (!carried.length && !morning.length && !later.length) return null;
      lines.push(`🌤️ <b>Afternoon check</b>, ${prettyDate_(day)}`);
      section(`🔴 <b>Late: morning tasks not done by ${fmt12_(s.AFTERNOON_TIME)} (${morning.length})</b>`, morning);
      section(`🔴 <b>Still open from earlier (${carried.length})</b>`, carried, { due: true });
      section(`🌇 <b>Evening &amp; general tasks (${later.length})</b>: complete by end of day`, later);
      addButtons(morning.concat(carried, later));
    } else {
      const isNight = ev.type === 'night';
      const openList = carried.concat(morning, later);
      const extraWeek = isLastWeekDay ? weekPending : [];
      const extraMonth = isLastMonthDay ? monthPending : [];
      if (!openList.length && !extraWeek.length && !extraMonth.length) return null;
      const total = openList.length + extraWeek.length + extraMonth.length;
      lines.push(isNight
        ? `🌙 <b>Final reminder, ${first}</b>: ${total} task${total === 1 ? '' : 's'} will be marked <b>Missed</b> at midnight.`
        : `🌆 <b>Evening reminder, ${first}</b>: ${total} task${total === 1 ? '' : 's'} still pending today.`);
      section(`🔴 <b>Late (${carried.length + morning.length})</b>`, carried.concat(morning), { due: true });
      section(`⏳ <b>Pending (${later.length})</b>`, later);
      section(`📆 <b>Weekly: last day (${extraWeek.length})</b>`, extraWeek);
      section(`🗓️ <b>Monthly: last day (${extraMonth.length})</b>`, extraMonth);
      addButtons(openList.concat(extraWeek, extraMonth));
    }
    return { text: lines.join('\n'), buttons };
  }

  /** Morning report for admins: yesterday's results, plus last week's (Mondays) and last month's (1st). */
  function adminReport_(team, tasks, logMap, day) {
    const yesterday = addDays_(day, -1);
    const lines = [];
    const rows = dayReport_(team, yesterday);
    if (rows.length) {
      lines.push(`📊 <b>Daily report</b>, ${prettyDate_(yesterday)}`, '✅ on time · 🟠 late · ❌ not done', '');
      rows.slice().sort((a, b) => b.missed - a.missed || b.late - a.late).forEach(r => {
        lines.push(`${esc_(r.name)}: ✅ ${r.onTime} · 🟠 ${r.late} · ❌ ${r.missed}  (${pct_(r.onTime, r.total)}% on time)`);
      });
    }
    const period = (label, range, kind) => {
      const rs = periodReport_(team, range, kind);
      if (!rs.length) return;
      lines.push('', `📅 <b>${label}</b>, ${prettyDate_(range.start)} – ${prettyDate_(range.end)}`);
      rs.forEach(r => lines.push(`${esc_(r.name)}: ✅ ${r.onTime} · 🟠 ${r.late} · ❌ ${r.missed}  of ${r.total}`));
    };
    if (isoDay_(day) === 1) period('Weekly tasks, last week', weekRange_(yesterday), 'Weekly');
    if (Number(day.slice(8)) === 1) period('Monthly tasks, last month', monthRange_(yesterday), 'Monthly');
    return lines.length ? lines.join('\n') : null;
  }

  /** Per member: tasks that were due on `day` (daily, fixed-day weekly/monthly, one-time) and how they went. */
  function dayReport_(team, day) {
    return team.map(m => {
      const items = memberItems_(m, day, TASKS, LOGS).filter(i => !i.optional && !i.flexible && i.dueDate === day);
      return Object.assign({ id: m.id, name: m.name }, classify_(items));
    }).filter(r => r.total);
  }

  function periodReport_(team, range, kind) {
    return team.map(m => Object.assign({ id: m.id, name: m.name }, classify_(periodItems_(m, TASKS, LOGS, range, kind)))).filter(r => r.total);
  }

  /** All occurrences of a member's Weekly/Monthly tasks whose deadline falls in the range. */
  function periodItems_(m, tasks, logMap, range, category) {
    const out = [];
    const seen = {};
    const list = tasks.filter(t => t.category === category);
    for (let d = range.start; d <= range.end; d = addDays_(d, 1)) {
      memberItems_(m, d, list, logMap).forEach(i => {
        const k = i.taskId + '|' + i.dueDate;
        if (!seen[k] && i.deadline.slice(0, 10) >= range.start && i.deadline.slice(0, 10) <= range.end && !i.optional) {
          seen[k] = 1;
          out.push(i);
        }
      });
    }
    return out;
  }

  function dayListMessage_(member, pendingOnly) {
    const today = todayStr_();
    const items = sortItems_(memberItems_(member, today, TASKS, LOGS)).filter(i => !i.optional);
    const c = countItems_(items, today);
    const lines = [`📋 <b>${pendingOnly ? 'Pending tasks' : "Today's tasks"}</b>, ${prettyDate_(today)}`, `Today: <b>${c.done}/${c.total}</b> done`];
    const groups = [
      ['🔴 Late', i => i.late],
      ['☀️ Morning', i => !i.late && !i.flexible && i.shift === 'Morning'],
      ['🌇 Evening', i => !i.late && !i.flexible && i.shift === 'Evening'],
      ['📌 General', i => !i.late && !i.flexible && i.shift === 'General'],
      ['📆 This week', i => i.flexible === 'week'],
      ['🗓️ This month', i => i.flexible === 'month'],
    ];
    let shown = 0;
    groups.forEach(([label, fn]) => {
      const list = items.filter(fn).filter(i => !pendingOnly || isOpen_(i.status));
      if (!list.length) return;
      lines.push('', `<b>${label}</b>`);
      list.forEach(i => {
        if (shown++ >= MAX_LINES) return;
        const mark = i.status === 'Done' ? (i.doneLate ? '🟠' : '✅') : i.status === 'In progress' ? '🔄' : '⬜';
        lines.push(`${mark} ${esc_(short_(i.title))}` + (i.late && i.dueDate < today ? ` <i>(due ${prettyDate_(i.dueDate)})</i>` : ''));
      });
    });
    if (shown > MAX_LINES) lines.push(`…and ${shown - MAX_LINES} more`);
    if (!items.length) lines.push('', 'No tasks right now 🎉');
    else if (pendingOnly && !items.some(i => isOpen_(i.status))) lines.push('', 'Nothing pending. Great job! 🎉');
    return lines.join('\n');
  }

  function openAppKeyboard_() {
    return { inline_keyboard: [[{ text: '📋 Open Tasks', web_app: { url: miniAppLink_() } }]] };
  }

  // ───────────────────────── Telegram API ─────────────────────────

  async function tg_(method, payload, token) {
    sendBudget--;
    try {
      const res = await fetch('https://api.telegram.org/bot' + (token || token_()) + '/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
      try { return await res.json(); } catch (e) { return { ok: false, description: 'HTTP ' + res.status }; }
    } catch (e) {
      return { ok: false, description: String(e && e.message || e) };
    }
  }

  async function sendTelegram_(chatId, t, replyMarkup) {
    if (!token_()) return false;
    const payload = { chat_id: chatId, text: t, parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const r = await tg_('sendMessage', payload);
    if (!r.ok) console.warn('Telegram send failed for ' + chatId + ': ' + r.description);
    return !!r.ok;
  }

  /**
   * Sends many messages, 8 at a time. Anything over this call's budget waits in the outbox and goes
   * with the next reminder check (within 5 minutes). Returns true / false / 'queued' per message.
   */
  async function sendMany_(messages) {
    const results = new Array(messages.length);
    const now = messages.slice(0, Math.max(0, sendBudget));
    const later = messages.slice(now.length);
    for (let i = 0; i < now.length; i += 8) {
      const part = now.slice(i, i + 8);
      const rs = await Promise.all(part.map(m => sendTelegram_(m.chat_id, m.text, m.reply_markup)));
      rs.forEach((r, j) => { results[i + j] = r; });
    }
    later.forEach((m, j) => {
      run_('INSERT INTO outbox (payload, at) VALUES (?, ?)', JSON.stringify(m), Date.now());
      results[now.length + j] = 'queued';
    });
    await flush_();
    return results;
  }

  async function flushOutbox_() {
    const r = await db.prepare('SELECT id, payload FROM outbox ORDER BY id LIMIT ?').bind(Math.max(0, sendBudget - 10)).all();
    if (!r.results.length) return 0;
    const ids = r.results.map(x => x.id);
    await db.prepare(`DELETE FROM outbox WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
    const msgs = r.results.map(x => JSON.parse(x.payload));
    let sent = 0;
    for (let i = 0; i < msgs.length; i += 8) {
      const rs = await Promise.all(msgs.slice(i, i + 8).map(m => sendTelegram_(m.chat_id, m.text, m.reply_markup)));
      sent += rs.filter(Boolean).length;
    }
    return sent;
  }

  // ───────────────────────── Schedule & deadline logic ─────────────────────────

  /**
   * Returns the key (date) of the task's occurrence that is open on dayStr, or null.
   *  Daily            → that day
   *  Weekly, any day  → Monday of that week (open Mon–Sun)
   *  Weekly, fixed    → most recent fixed day (<= dayStr), open until the next fixed day
   *  Monthly, any     → 1st of that month (open all month)
   *  Monthly, fixed   → most recent fixed date (<= dayStr), open until next month's date
   *  One-time         → the due date once it arrives, open until done
   */
  function occurrenceFor_(task, dayStr) {
    const ck = task.id + '|' + dayStr;
    if (OCC.has(ck)) return OCC.get(ck);
    const v = occurrenceUncached_(task, dayStr);
    OCC.set(ck, v);
    return v;
  }

  /** The parts of a task's item on dayStr that are the same for every member (computed once per request). */
  function taskDay_(t, dayStr) {
    const ck = t.id + '|' + dayStr;
    const hit = TASK_DAY.get(ck);
    if (hit !== undefined) return hit;
    const due = occurrenceFor_(t, dayStr);
    let v = null;
    if (due) {
      const deadline = deadlineFor_(t, due, settings_());
      const flexible = isFlexible_(t);
      v = {
        due, deadline, flexible,
        stillOpen: occurrenceFor_(t, TODAY) === due,
        schedule: scheduleText_(t),
        daysLeft: flexible ? daysBetween_(dayStr, deadline.slice(0, 10)) : 0,
      };
    }
    TASK_DAY.set(ck, v);
    return v;
  }

  function memberItems_(member, dayStr, tasks, logMap) {
    const items = [];
    tasks.forEach(t => {
      if (!isAssigned_(t, member)) return;
      const b = taskDay_(t, dayStr);
      if (!b) return;
      const entry = logMap[t.id + '|' + member.id + '|' + b.due];
      const status = entry ? entry.status : 'Pending';
      // A one-time task has no next occurrence: once finished, show it only on the day it was finished
      if (t.category === 'One-time' && (status === 'Done' || status === 'N/A') && entry.updatedAt && entry.updatedAt.slice(0, 10) < dayStr) return;
      const pending = isOpen_(status);
      items.push({
        taskId: t.id,
        title: t.title,
        description: t.description,
        category: t.category,
        schedule: b.schedule,
        shift: t.shift,
        time: t.time,
        optional: t.optional,
        checklist: t.checklist,
        checked: entry ? entry.checked : [],
        status,
        remarks: entry ? entry.remarks : '',
        updatedAt: entry ? entry.updatedAt : '',
        dueDate: b.due,
        deadline: b.deadline,
        flexible: b.flexible,
        daysLeft: b.daysLeft,
        late: pending && !t.optional && b.stillOpen && NOW > b.deadline,
        missed: pending && !t.optional && !b.stillOpen,
        doneLate: status === 'Done' && !!entry.updatedAt && entry.updatedAt > b.deadline,
      });
    });
    return items;
  }

  // ───────────────────────── Google Sheet copy ─────────────────────────

  /**
   * Everything the Google Sheet script needs to keep its copy up to date.
   * q.since: history cursor from the last call ('' = from the start). q.reportAfter: last day already in the reports.
   * History comes in pages; call again while `history.more` is true or `reports.more` is true.
   */
  async function sync(q) {
    await loadBase_();
    const out = {
      now: nowStr_(),
      tasks: [SHEET_COLUMNS.tasks].concat((await db.prepare('SELECT * FROM tasks ORDER BY rowid').all()).results.map(r => DB_COLUMNS.tasks.map(c => r[c] || ''))),
      team: [SHEET_COLUMNS.team].concat((await db.prepare('SELECT * FROM team ORDER BY rowid').all()).results.map(r => DB_COLUMNS.team.map(c => r[c] || ''))),
    };

    // History: rows changed since the cursor, oldest first
    const [ms, id] = String(q.since || '0|').split('|');
    const sinceMs = Number(ms) || 0;
    const LIMIT = 2000;
    const changed = (await db.prepare(`SELECT * FROM logs WHERE updated_ms > ? OR (updated_ms = ? AND log_id > ?)
      ORDER BY updated_ms, log_id LIMIT ?`).bind(sinceMs, sinceMs, id || '', LIMIT).all()).results;
    const deleted = sinceMs ? (await db.prepare('SELECT log_id FROM deleted_logs WHERE deleted_ms >= ?').bind(sinceMs).all()).results.map(r => r.log_id) : [];
    const lastRow = changed[changed.length - 1];
    out.history = {
      columns: SHEET_COLUMNS.logs,
      rows: changed.map(r => DB_COLUMNS.logs.map(c => r[c] || '')),
      deleted,
      cursor: lastRow ? lastRow.updated_ms + '|' + lastRow.log_id : (q.since || '0|'),
      more: changed.length === LIMIT,
    };

    // Reports: a few closed days per call (keeps each call small)
    const yesterday = addDays_(todayStr_(), -1);
    let after = /^\d{4}-\d{2}-\d{2}$/.test(q.reportAfter || '') ? q.reportAfter : '';
    if (!after) {
      const first = await db.prepare('SELECT MIN(date) AS d FROM logs').first();
      const start = first && first.d ? first.d : yesterday;
      after = addDays_(start > addDays_(yesterday, -HISTORY_DAYS) ? start : addDays_(yesterday, -HISTORY_DAYS), -1);
    }
    const daily = [];
    const period = [];
    let day = after;
    const team = TEAM.filter(m => m.status === 'Active');
    for (let n = 0; n < 3 && day < yesterday; n++) {
      day = addDays_(day, 1);
      const need = [day];
      if (isoDay_(day) === 7) daysBetweenList_(weekRange_(day).start, day).forEach(d => need.push(d));
      if (day === monthRange_(day).end) daysBetweenList_(monthRange_(day).start, day).forEach(d => need.push(d));
      await loadLogs_(need);
      dayReport_(team, day).forEach(r => daily.push([day, r.name, r.total, r.onTime, r.late, r.missed, pct_(r.onTime, r.total) / 100]));
      if (isoDay_(day) === 7) {
        const range = weekRange_(day);
        periodReport_(team, range, 'Weekly').forEach(r => period.push(['Weekly', range.start, range.end, r.name, r.total, r.onTime, r.late, r.missed, pct_(r.onTime, r.total) / 100]));
      }
      if (day === monthRange_(day).end) {
        const range = monthRange_(day);
        periodReport_(team, range, 'Monthly').forEach(r => period.push(['Monthly', range.start, range.end, r.name, r.total, r.onTime, r.late, r.missed, pct_(r.onTime, r.total) / 100]));
      }
    }
    out.reports = {
      dailyColumns: ['Date', 'Member', 'Tasks due', 'Done on time', 'Done late', 'Not done', 'On-time %'],
      periodColumns: ['Type', 'From', 'To', 'Member', 'Tasks', 'Done on time', 'Done late', 'Not done', 'On-time %'],
      daily, period,
      reportDay: day,
      more: day < yesterday,
    };
    return out;
  }

  // ───────────────────────── Setup and data import ─────────────────────────

  async function ensureSchema_() {
    await db.batch(SCHEMA.map(s => db.prepare(s)));
  }

  /**
   * One-time copy of the Google Sheet data. Steps: begin → rows (repeated, per table) → finish.
   * `begin` refuses to run again once the import has finished, unless `force` is true.
   */
  async function importData(body) {
    await ensureSchema_();
    await loadBase_();
    if (body.step === 'begin') {
      if (SETTINGS.READY === '1' && !body.force) throw new Error('Data was already moved. Nothing was changed.');
      await db.batch(['tasks', 'team', 'logs', 'deleted_logs', 'seen', 'outbox', 'settings'].map(t => db.prepare('DELETE FROM ' + t)));
      return { begun: true };
    }
    if (body.step === 'rows') {
      const table = body.table;
      if (!DB_COLUMNS[table]) throw new Error('Unknown table.');
      const cols = DB_COLUMNS[table];
      const rows = (Array.isArray(body.rows) ? body.rows : []).map(r => cols.map((c, i) => String(r[i] == null ? '' : r[i])));
      const per = Math.floor(90 / (cols.length + (table === 'logs' ? 1 : 0)));
      const stmts = [];
      const now = Date.now();
      for (let i = 0; i < rows.length; i += per) {
        const part = rows.slice(i, i + per);
        const extra = table === 'logs' ? ', updated_ms' : '';
        const ph = '(' + cols.map(() => '?').concat(table === 'logs' ? ['?'] : []).join(', ') + ')';
        const params = [];
        part.forEach(r => { params.push(...r); if (table === 'logs') params.push(now); });
        stmts.push(db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}${extra}) VALUES ${part.map(() => ph).join(', ')}`).bind(...params));
      }
      if (stmts.length) await db.batch(stmts);
      return { added: rows.length };
    }
    if (body.step === 'finish') {
      const s = body.settings || {};
      Object.keys(DEFAULT_SETTINGS).forEach(k => setSetting_(k, s[k] || DEFAULT_SETTINGS[k]));
      if (s.BOT_TOKEN) setSetting_('BOT_TOKEN', s.BOT_TOKEN);
      setSetting_('READY', '1');
      await flush_();
      const counts = await db.batch(['tasks', 'team', 'logs'].map(t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`)));
      return { tasks: counts[0].results[0].n, team: counts[1].results[0].n, history: counts[2].results[0].n };
    }
    throw new Error('Unknown import step.');
  }

  /** Points the bot (webhook, menu button, commands) at this server. body.token sets or replaces the bot token. */
  async function setup(body) {
    await ensureSchema_();
    await loadBase_();
    const token = String(body.token || token_() || '').trim();
    if (!token) throw new Error('Bot token missing. Put BOT_TOKEN in CONFIG and run setup again.');
    const me = await tg_('getMe', {}, token);
    if (!me.ok) throw new Error('Invalid BOT_TOKEN: ' + (me.description || 'rejected by Telegram'));
    setSetting_('BOT_TOKEN', token);
    setSetting_('BOT_USERNAME', me.result.username);
    Object.keys(DEFAULT_SETTINGS).forEach(k => { if (!SETTINGS[k]) setSetting_(k, DEFAULT_SETTINGS[k]); });
    if (SETTINGS.READY !== '1') setSetting_('READY', '1'); // a fresh install with no data to move
    await flush_();

    const hook = await tg_('setWebhook', {
      url: origin + '/api/telegram',
      secret_token: await webhookSecret_(),
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
    if (!hook.ok) throw new Error('Could not set the Telegram webhook: ' + hook.description);
    await tg_('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Open Tasks', web_app: { url: miniAppLink_() } } });
    await tg_('setMyCommands', {
      commands: [
        { command: 'today', description: "Today's tasks" },
        { command: 'pending', description: 'My pending tasks' },
        { command: 'app', description: 'Open Task Manager' },
      ],
    });
    let claimCode = '';
    if (!TEAM.some(m => m.role === 'Admin' && m.status === 'Active')) {
      claimCode = SETTINGS.ADMIN_CLAIM_CODE || String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
      setSetting_('ADMIN_CLAIM_CODE', claimCode);
      await flush_();
    }
    return { bot: me.result.username, appUrl: miniAppLink_(), claimCode };
  }

  return { api, telegram, cron, sync, importData, setup };
}

// ───────────────────────── Pure helpers ─────────────────────────

function occurrenceUncached_(task, dayStr) {
  if (!task.active) return null;
  const day = parseDate_(dayStr);
  let due;
  switch (task.category) {
    case 'Daily':
      due = dayStr;
      break;
    case 'Weekly': {
      const cur = isoDay_(dayStr);
      due = task.weeklyDays.length
        ? addDays_(dayStr, -Math.min.apply(null, task.weeklyDays.map(d => (cur - d + 7) % 7)))
        : addDays_(dayStr, -(cur - 1));
      break;
    }
    case 'Monthly': {
      if (task.monthlyAny) {
        due = dayStr.slice(0, 8) + '01';
        break;
      }
      if (!task.monthlyDate) return null;
      let d = monthlyDue_(day.getUTCFullYear(), day.getUTCMonth(), task.monthlyDate);
      if (d > day) d = monthlyDue_(day.getUTCFullYear(), day.getUTCMonth() - 1, task.monthlyDate);
      due = fmtDate_(d);
      break;
    }
    case 'One-time':
      return task.dueDate && task.dueDate <= dayStr ? task.dueDate : null;
    default:
      return null;
  }
  // Periods that ended before the task was created don't count
  if (task.createdDate && periodEnd_(task, due) < task.createdDate) return null;
  return due;
}

function isFlexible_(t) {
  if (t.category === 'Weekly' && !t.weeklyDays.length) return 'week';
  if (t.category === 'Monthly' && t.monthlyAny) return 'month';
  return null;
}

/** Last calendar day of an occurrence's completion window. */
function periodEnd_(task, due) {
  const f = isFlexible_(task);
  if (f === 'week') return addDays_(due, 6);
  if (f === 'month') return monthRange_(due).end;
  return due;
}

/** 'yyyy-MM-dd HH:mm' by which the occurrence should be done to count as on time. */
function deadlineFor_(task, due, s) {
  if (isFlexible_(task)) return periodEnd_(task, due) + ' ' + END_OF_DAY;
  return due + ' ' + (task.shift === 'Morning' ? s.AFTERNOON_TIME : END_OF_DAY);
}

function monthlyDue_(y, m, date) {
  const last = new Date(Date.UTC(y, m + 1, 0, 12)).getUTCDate(); // a task on the 31st falls on the last day of shorter months
  return new Date(Date.UTC(y, m, Math.min(date, last), 12));
}

function parseChecklistItem_(line) {
  const m = String(line).trim().match(/^(.*?)\s*\((optional|surprise)\)$/i);
  return m ? { text: m[1].trim(), optional: true } : { text: String(line).trim(), optional: false };
}

/** Indexes of checklist items that must be ticked before the task counts as done. */
function requiredItems_(task) {
  return task.checklist.map((c, i) => (c.optional ? -1 : i)).filter(i => i >= 0);
}

function isAssigned_(task, member) {
  if (!member || member.status !== 'Active') return false;
  return task.assignAll ? member.getsTasks : task.assignIds.includes(member.id);
}

/** Counts for a day: `total/done/pending/late` cover items due that day or earlier; week/month cover the open periods. */
function countItems_(items) {
  const due = items.filter(i => !i.optional && !i.flexible);
  const done = due.filter(i => i.status === 'Done');
  const week = items.filter(i => !i.optional && i.flexible === 'week');
  const month = items.filter(i => !i.optional && i.flexible === 'month');
  return {
    total: due.length,
    done: done.length,
    doneLate: done.filter(i => i.doneLate).length,
    pending: due.length - done.length,
    inProgress: due.filter(i => i.status === 'In progress').length,
    late: due.filter(i => i.late).length,
    missed: due.filter(i => i.missed).length,
    weekTotal: week.length, weekDone: week.filter(i => i.status === 'Done').length,
    monthTotal: month.length, monthDone: month.filter(i => i.status === 'Done').length,
    optionalDone: items.filter(i => i.optional && i.status === 'Done').length,
  };
}

function cmp_(a, b) { return a < b ? -1 : a > b ? 1 : 0; } // much faster than localeCompare

function classify_(items) {
  const onTime = items.filter(i => i.status === 'Done' && !i.doneLate).length;
  const late = items.filter(i => i.status === 'Done' && i.doneLate).length;
  return { total: items.length, onTime, late, missed: items.length - onTime - late };
}

function sortItems_(items) {
  const rank = i => (i.late || i.missed ? 0 : i.flexible === 'week' ? 4 : i.flexible === 'month' ? 5 : 1 + SHIFTS.indexOf(i.shift));
  return items.sort((a, b) => rank(a) - rank(b) || (a.optional - b.optional)
    || cmp_(a.time || '99', b.time || '99') || cmp_(a.title.toLowerCase(), b.title.toLowerCase()));
}

function scheduleText_(t) {
  if (t.category === 'Daily') return 'Every day';
  if (t.category === 'Weekly') return t.weeklyDays.length ? 'Every ' + t.weeklyDays.map(d => WEEKDAYS[d - 1]).join(', ') : 'Any day each week';
  if (t.category === 'Monthly') return t.monthlyAny ? 'Any time each month' : 'Monthly on the ' + ordinal_(t.monthlyDate);
  if (!t.dueDate) return 'On —';
  const d = parseDate_(t.dueDate);
  return `On ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function publicTask_(t) {
  return {
    id: t.id, title: t.title, description: t.description, category: t.category,
    weeklyDays: t.weeklyDays.map(d => WEEKDAYS[d - 1]), weeklyAny: t.category === 'Weekly' && !t.weeklyDays.length,
    monthlyDate: t.monthlyDate, monthlyAny: t.monthlyAny, dueDate: t.dueDate,
    shift: t.shift, time: t.time, optional: t.optional, checklist: t.checklist,
    assignTo: t.assignAll ? 'All' : t.assignIds, active: t.active, schedule: scheduleText_(t),
  };
}

function itemLines_(items, opts) {
  opts = opts || {};
  const lines = items.slice(0, MAX_LINES).map(i => (i.status === 'In progress' ? '🔄 ' : '• ') + esc_(short_(i.title))
    + (i.time ? ` · ${fmt12_(i.time)}` : '')
    + (opts.due && i.dueDate < todayStr_() ? ` <i>(due ${prettyDate_(i.dueDate)})</i>` : ''));
  if (items.length > MAX_LINES) lines.push(`…and ${items.length - MAX_LINES} more`);
  return lines;
}

// ── Rows from the database ──

function teamFromDb_(r) {
  const status = str_(r.status);
  return {
    id: str_(r.user_id),
    name: str_(r.name) || 'Unknown',
    username: str_(r.username),
    role: str_(r.role) === 'Admin' ? 'Admin' : 'Member',
    status: ['Active', 'Pending', 'Rejected'].includes(status) ? status : 'Pending',
    getsTasks: str_(r.gets_tasks).toLowerCase() !== 'no',
    joinedAt: str_(r.joined_at),
  };
}

function taskFromDb_(r) {
  const createdAt = str_(r.created_at);
  const assign = str_(r.assign_to);
  const monthly = str_(r.monthly_date);
  return {
    id: str_(r.id),
    title: str_(r.title),
    description: str_(r.description),
    category: str_(r.category),
    weeklyDays: str_(r.weekly_days).split(',').map(s => WEEKDAYS.indexOf(s.trim().slice(0, 3)) + 1).filter(n => n > 0),
    monthlyDate: Number(monthly) || '',
    monthlyAny: !monthly || monthly.toLowerCase() === 'any',
    dueDate: str_(r.due_date),
    shift: SHIFTS.includes(str_(r.shift)) ? str_(r.shift) : 'General',
    time: normTime_(str_(r.time)),
    optional: str_(r.type).toLowerCase() === 'if applicable',
    checklist: str_(r.checklist).split('\n').map(parseChecklistItem_).filter(c => c.text),
    assignAll: !assign || assign.toLowerCase() === 'all',
    assignIds: assign.split(',').map(s => s.trim()).filter(Boolean),
    active: str_(r.active).toLowerCase() !== 'no',
    createdAt,
    createdDate: createdAt.slice(0, 10),
  };
}

function logFromDb_(r) {
  const status = str_(r.status);
  return {
    logId: str_(r.log_id),
    status: STATUSES.includes(status) ? status : 'Pending',
    checked: str_(r.checked).split('|').filter(s => s !== '').map(Number),
    remarks: str_(r.remarks),
    updatedAt: str_(r.updated_at),
  };
}

// ── Dates (India time; day strings are 'yyyy-MM-dd', times 'yyyy-MM-dd HH:mm') ──

function dtStr_(d) { return new Date(d.getTime() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 16).replace('T', ' '); }
function nowStr_() { return dtStr_(new Date()); }
function todayStr_() { return nowStr_().slice(0, 10); }
function nowHM_() { return nowStr_().slice(11, 16); }
// Noon UTC keeps the calendar date stable in date arithmetic
function parseDate_(s) { const p = String(s).split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)); }
function fmtDate_(d) { return d.toISOString().slice(0, 10); }
function addDays_(s, n) { const d = parseDate_(s); d.setUTCDate(d.getUTCDate() + n); return fmtDate_(d); }
function daysBetween_(a, b) { return Math.round((parseDate_(b) - parseDate_(a)) / 86400000); }
function isoDay_(s) { const d = parseDate_(s).getUTCDay(); return d === 0 ? 7 : d; }
function weekRange_(s) { const start = addDays_(s, 1 - isoDay_(s)); return { start, end: addDays_(start, 6) }; }
function monthRange_(s) {
  const d = parseDate_(s);
  return { start: s.slice(0, 8) + '01', end: fmtDate_(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12))) };
}
function prettyDate_(s) {
  const d = parseDate_(s);
  return `${WEEKDAYS[isoDay_(s) - 1]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// ── Text ──

function str_(v) { return v == null ? '' : String(v).trim(); }
function normTime_(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return '';
  return m[1].padStart(2, '0') + ':' + m[2];
}
function fmt12_(hm) {
  if (!hm) return '';
  const [h, m] = hm.split(':').map(Number);
  return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM');
}
function pct_(a, b) { return b ? Math.round(a * 100 / b) : 0; }
function ordinal_(n) { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function key_(taskId, userId, date) { return taskId + '|' + userId + '|' + date; }
function tgName_(u) { return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u.id); }
function firstName_(name) { return String(name).split(' ')[0] || name; }
function short_(s, n) { n = n || 100; return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function esc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function urlDecode_(s) { return decodeURIComponent(s.replace(/\+/g, ' ')); }

// ── Crypto ──

function utf8_(s) { return new TextEncoder().encode(s); }
async function hmac_(keyBytes, dataBytes) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, dataBytes));
}
function hex_(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
