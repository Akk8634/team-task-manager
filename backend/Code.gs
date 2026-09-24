/**
 * Team Task Manager: Telegram bot + Mini App backend
 * Google Sheet = database, Apps Script = API + bot + scheduled reminders
 *
 * See SETUP.md. Fill in CONFIG below, then run `setup` once from the editor.
 */

const CONFIG = {
  BOT_TOKEN: '',     // From @BotFather, e.g. 123456789:ABC...
  WEB_APP_URL: '',   // This script's web app deployment URL (ends with /exec)
  MINI_APP_URL: '',  // Netlify URL of the Mini App, e.g. https://cityflo-tasks.netlify.app/
};

const SHEET_TASKS = 'Tasks';
const SHEET_LOG = 'TaskLog';
const SHEET_TEAM = 'Team';

const HEADERS = {
  [SHEET_TASKS]: ['ID', 'Title', 'Description', 'Category', 'Weekly Days', 'Monthly Date', 'Due Date', 'Shift', 'Time',
    'Type', 'Checklist', 'Assign To', 'Active', 'Created At'],
  [SHEET_LOG]: ['Log ID', 'Date', 'Task ID', 'Task Title', 'User ID', 'Name', 'Status', 'Checked Items', 'Remarks', 'Updated At'],
  [SHEET_TEAM]: ['User ID', 'Name', 'Username', 'Role', 'Status', 'Gets Tasks', 'Joined At'],
};

const CATEGORIES = ['Daily', 'Weekly', 'Monthly', 'One-time'];
const SHIFTS = ['Morning', 'Evening', 'General'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // index + 1 = ISO weekday
const STATUSES = ['Pending', 'Done', 'N/A'];
const SLOTS = ['morning', 'afternoon', 'evening', 'night'];
const DEFAULT_SETTINGS = { MORNING_TIME: '08:00', AFTERNOON_TIME: '14:00', EVENING_TIME: '20:00', NIGHT_TIME: '23:00', ADMIN_SUMMARY: 'Yes' };
const END_OF_DAY = '23:59';
const MAX_LINES = 30;

// ───────────────────────── Setup ─────────────────────────

/** Run once from the Apps Script editor after filling in CONFIG. Safe to run again. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Create this script from inside a Google Sheet (Extensions → Apps Script).');
  const token = CONFIG.BOT_TOKEN.trim();
  const webUrl = CONFIG.WEB_APP_URL.trim();
  const miniUrl = CONFIG.MINI_APP_URL.trim();
  if (!token || !webUrl || !miniUrl) throw new Error('Fill in BOT_TOKEN, WEB_APP_URL and MINI_APP_URL in CONFIG first (see SETUP.md).');
  if (!/\/exec$/.test(webUrl)) throw new Error('WEB_APP_URL must be the deployment URL that ends with /exec.');
  if (!/^https:\/\//.test(miniUrl)) throw new Error('MINI_APP_URL must start with https://');

  const me = tg_(token, 'getMe');
  if (!me.ok) throw new Error('Invalid BOT_TOKEN: ' + (me.description || 'rejected by Telegram'));

  const p = props_();
  p.setProperties({
    SPREADSHEET_ID: ss.getId(),
    BOT_TOKEN: token,
    BOT_USERNAME: me.result.username,
    WEB_APP_URL: webUrl,
    MINI_APP_URL: miniUrl,
    WEBHOOK_SECRET: p.getProperty('WEBHOOK_SECRET') || Utilities.getUuid().replace(/-/g, ''),
  });
  Object.keys(DEFAULT_SETTINGS).forEach(k => { if (!p.getProperty(k)) p.setProperty(k, DEFAULT_SETTINGS[k]); });

  Object.keys(HEADERS).forEach(name => {
    const headers = HEADERS[name];
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    // Plain text so dates, times and IDs are not auto-converted
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8eaf6');
      sh.setFrozenRows(1);
    }
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  const hook = tg_(token, 'setWebhook', {
    url: webUrl + '?secret=' + p.getProperty('WEBHOOK_SECRET'),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  if (!hook.ok) throw new Error('Could not set the Telegram webhook: ' + hook.description);
  tg_(token, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Open Tasks', web_app: { url: miniAppLink_() } } });
  tg_(token, 'setMyCommands', {
    commands: [
      { command: 'today', description: "Today's tasks" },
      { command: 'pending', description: 'My pending tasks' },
      { command: 'app', description: 'Open Task Manager' },
    ],
  });

  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();

  if (!getTeam_().some(m => m.role === 'Admin' && m.status === 'Active')) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    p.setProperty('ADMIN_CLAIM_CODE', code);
    Logger.log(`✅ Setup complete.\n\nOpen @${me.result.username} in Telegram, tap "Open Tasks" and enter this admin code: ${code}`);
  } else {
    Logger.log('✅ Setup complete. Bot, menu button and reminder trigger are up to date.');
  }
}

function miniAppLink_() {
  const p = props_();
  const base = p.getProperty('MINI_APP_URL');
  return base + (base.includes('?') ? '&' : '?') + 'api=' + encodeURIComponent(p.getProperty('WEB_APP_URL'));
}

// ───────────────────────── HTTP entry points ─────────────────────────

function doGet() {
  return ContentService.createTextOutput('Team Task Manager API is running.');
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Bad request.' });
  }
  if (req.update_id !== undefined) {
    // Telegram webhook
    if ((e.parameter || {}).secret === props_().getProperty('WEBHOOK_SECRET')) {
      try { handleUpdate_(req); } catch (err) { console.error(err && err.stack || err); }
    }
    return ContentService.createTextOutput('ok');
  }
  return json_(handleApi_(req));
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ───────────────────────── Mini App API ─────────────────────────

const API = {
  bootstrap: { role: 'any', fn: apiBootstrap_ },
  claimAdmin: { role: 'any', fn: apiClaimAdmin_ },
  myDay: { role: 'member', fn: apiMyDay_ },
  upcoming: { role: 'member', fn: apiUpcoming_ },
  updateItem: { role: 'member', fn: apiUpdateItem_ },
  dashboard: { role: 'admin', fn: apiDashboard_ },
  listTasks: { role: 'admin', fn: apiListTasks_ },
  saveTask: { role: 'admin', fn: apiSaveTask_ },
  deleteTask: { role: 'admin', fn: apiDeleteTask_ },
  listTeam: { role: 'admin', fn: apiListTeam_ },
  reviewMember: { role: 'admin', fn: apiReviewMember_ },
  saveMember: { role: 'admin', fn: apiSaveMember_ },
  removeMember: { role: 'admin', fn: apiRemoveMember_ },
  getSettings: { role: 'admin', fn: apiGetSettings_ },
  saveSettings: { role: 'admin', fn: apiSaveSettings_ },
  sendNow: { role: 'admin', fn: apiSendNow_ },
};

function handleApi_(req) {
  try {
    const tgUser = verifyInitData_(req.initData);
    const action = API[req.action];
    if (!action) throw new Error('Unknown action.');
    const member = getTeam_().find(m => m.id === String(tgUser.id)) || null;
    if (action.role !== 'any') {
      if (!member || member.status !== 'Active') throw new Error('Your access has not been approved yet.');
      if (action.role === 'admin' && member.role !== 'Admin') throw new Error('Only an Admin can do this.');
    }
    return { ok: true, data: action.fn({ tgUser, member }, req.args || {}) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/** Verifies the signed initData Telegram passes to the Mini App and returns the Telegram user. */
function verifyInitData_(initData) {
  if (!initData) throw new Error('Please open this app from the Telegram bot.');
  const params = {};
  String(initData).split('&').forEach(pair => {
    const i = pair.indexOf('=');
    if (i > 0) params[urlDecode_(pair.slice(0, i))] = urlDecode_(pair.slice(i + 1));
  });
  if (!params.hash) throw new Error('Invalid session. Please reopen the app from Telegram.');
  const dataCheck = Object.keys(params).filter(k => k !== 'hash').sort().map(k => k + '=' + params[k]).join('\n');
  const secretKey = Utilities.computeHmacSha256Signature(props_().getProperty('BOT_TOKEN'), 'WebAppData');
  const sig = Utilities.computeHmacSha256Signature(Utilities.newBlob(dataCheck).getBytes(), secretKey);
  if (hex_(sig) !== params.hash) throw new Error('Invalid session. Please reopen the app from Telegram.');
  if (Date.now() / 1000 - Number(params.auth_date) > 86400) throw new Error('Session expired. Please close and reopen the app.');
  const user = JSON.parse(params.user || '{}');
  if (!user.id) throw new Error('Invalid session. Please reopen the app from Telegram.');
  return user;
}

function apiBootstrap_(ctx) {
  let m = ctx.member;
  if (!m) {
    if (!getTeam_().some(x => x.role === 'Admin' && x.status === 'Active')) return { state: 'claim' };
    m = addJoinRequest_(ctx.tgUser);
  }
  if (m.status === 'Pending') return { state: 'pending', name: m.name };
  if (m.status === 'Rejected') return { state: 'rejected' };
  return {
    state: 'active',
    user: { id: m.id, name: m.name, role: m.role, getsTasks: m.getsTasks },
    today: todayStr_(),
    settings: publicSettings_(),
  };
}

function apiClaimAdmin_(ctx, args) {
  withLock_(() => {
    const p = props_();
    if (getTeam_().some(x => x.role === 'Admin' && x.status === 'Active')) throw new Error('An admin already exists.');
    const code = p.getProperty('ADMIN_CLAIM_CODE');
    if (!code || String(args.code || '').trim() !== code) throw new Error('Wrong admin code. Check the Apps Script log from setup.');
    const u = ctx.tgUser;
    const existing = getTeam_().find(x => x.id === String(u.id));
    const row = [String(u.id), tgName_(u), u.username || '', 'Admin', 'Active', 'No', nowStr_()];
    if (existing) writeRow_(SHEET_TEAM, existing.row, row);
    else appendRow_(SHEET_TEAM, row);
    p.deleteProperty('ADMIN_CLAIM_CODE');
  });
  return apiBootstrap_({ tgUser: ctx.tgUser, member: getTeam_().find(x => x.id === String(ctx.tgUser.id)) });
}

function apiMyDay_(ctx) {
  const today = todayStr_();
  const items = sortItems_(memberItems_(ctx.member, today, getTasks_(), getLogMap_()));
  return { today, now: nowStr_(), items, settings: publicSettings_(), week: weekRange_(today), month: monthRange_(today) };
}

function apiUpcoming_(ctx) {
  const today = todayStr_();
  const tasks = getTasks_().filter(t => t.category !== 'Daily' && !isFlexible_(t) && isAssigned_(t, ctx.member));
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
  return updateItem_(ctx.member, String(args.taskId || ''), String(args.dueDate || ''), {
    status: args.status,
    checked: Array.isArray(args.checked) ? args.checked : undefined,
    remarks: args.remarks,
  });
}

function apiDashboard_(ctx, args) {
  const today = todayStr_();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(args.day || '') && args.day <= today ? args.day : today;
  const tasks = getTasks_();
  const logMap = getLogMap_();
  const members = getTeam_().filter(m => m.status === 'Active').map(m => {
    const items = sortItems_(memberItems_(m, day, tasks, logMap));
    return Object.assign({ id: m.id, name: m.name, items }, countItems_(items, day));
  }).filter(m => m.items.length);
  return { day, today, isPast: day < today, members, activeTasks: tasks.filter(t => t.active).length };
}

function apiListTasks_() {
  return {
    tasks: getTasks_().map(publicTask_),
    members: getTeam_().filter(m => m.status === 'Active').map(m => ({ id: m.id, name: m.name, getsTasks: m.getsTasks })),
  };
}

function apiSaveTask_(ctx, input) {
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
    const valid = getTeam_().filter(m => ids.includes(m.id)).map(m => m.id);
    if (!valid.length) throw new Error('Please select at least one member, or assign to All.');
    t.assignTo = valid.join(', ');
  }

  withLock_(() => {
    const tasks = getTasks_();
    const row = (id, createdAt) => [id, t.title, t.description, t.category, t.weeklyDays, t.monthlyDate, t.dueDate, t.shift,
      t.time, t.type, t.checklist, t.assignTo, t.active ? 'Yes' : 'No', createdAt];
    if (input.id) {
      const ex = tasks.find(x => x.id === input.id);
      if (!ex) throw new Error('Task not found.');
      writeRow_(SHEET_TASKS, ex.row, row(ex.id, ex.createdAt));
    } else {
      const max = tasks.reduce((m, x) => Math.max(m, Number(x.id.replace(/\D/g, '')) || 0), 0);
      appendRow_(SHEET_TASKS, row('T' + String(max + 1).padStart(3, '0'), nowStr_()));
    }
  });
  return apiListTasks_();
}

function apiDeleteTask_(ctx, args) {
  withLock_(() => {
    const ex = getTasks_().find(x => x.id === args.id);
    if (ex) sheet_(SHEET_TASKS).deleteRow(ex.row);
  });
  return apiListTasks_();
}

function apiListTeam_() {
  return getTeam_().map(m => ({
    id: m.id, name: m.name, username: m.username, role: m.role, status: m.status, getsTasks: m.getsTasks, joinedAt: m.joinedAt,
  }));
}

function apiReviewMember_(ctx, args) {
  reviewMember_(String(args.id), !!args.approve, ctx.member);
  return apiListTeam_();
}

function apiSaveMember_(ctx, args) {
  withLock_(() => {
    const team = getTeam_();
    const ex = team.find(x => x.id === String(args.id));
    if (!ex) throw new Error('Member not found.');
    const name = String(args.name || '').trim() || ex.name;
    const role = args.role === 'Admin' ? 'Admin' : 'Member';
    if (ex.role === 'Admin' && role !== 'Admin' && team.filter(x => x.role === 'Admin' && x.status === 'Active').length === 1) {
      throw new Error('There must be at least one Admin.');
    }
    writeRow_(SHEET_TEAM, ex.row, [ex.id, name, ex.username, role, ex.status, args.getsTasks === false ? 'No' : 'Yes', ex.joinedAt]);
  });
  return apiListTeam_();
}

function apiRemoveMember_(ctx, args) {
  if (String(args.id) === ctx.member.id) throw new Error('You cannot remove yourself.');
  withLock_(() => {
    const ex = getTeam_().find(x => x.id === String(args.id));
    if (ex) sheet_(SHEET_TEAM).deleteRow(ex.row);
  });
  return apiListTeam_();
}

function apiGetSettings_() {
  return Object.assign(publicSettings_(), { botUsername: props_().getProperty('BOT_USERNAME') || '', timeZone: tz_() });
}

function apiSaveSettings_(ctx, args) {
  const times = [args.morningTime, args.afternoonTime, args.eveningTime, args.nightTime].map(normTime_);
  if (times.some(x => !x)) throw new Error('Please enter valid times.');
  for (let i = 1; i < times.length; i++) {
    if (times[i] <= times[i - 1]) throw new Error('Reminder times must be in order: Morning, Afternoon, Evening, Night.');
  }
  props_().setProperties({
    MORNING_TIME: times[0], AFTERNOON_TIME: times[1], EVENING_TIME: times[2], NIGHT_TIME: times[3],
    ADMIN_SUMMARY: args.adminSummary ? 'Yes' : 'No',
  });
  return apiGetSettings_();
}

function apiSendNow_(ctx, args) {
  const today = todayStr_();
  if (args.type === 'test') {
    const ok = sendTelegram_(ctx.member.id, '🧪 <b>Test message</b>\n\n' + dayListMessage_(ctx.member, false), openAppKeyboard_());
    if (!ok) throw new Error('Message could not be sent. Open the bot and tap Start first.');
    return { sent: 1 };
  }
  if (!SLOTS.includes(args.type)) throw new Error('Unknown reminder type.');
  return { sent: dispatch_([{ day: today, type: args.type }], getTasks_()) };
}

// ───────────────────────── Task status updates ─────────────────────────

function updateItem_(member, taskId, dueDate, changes) {
  return withLock_(() => {
    const tasks = getTasks_();
    const task = tasks.find(t => t.id === taskId);
    if (!task) throw new Error('Task not found. Please refresh.');
    if (!isAssigned_(task, member)) throw new Error('This task is not assigned to you.');
    const today = todayStr_();
    if (occurrenceFor_(task, today) !== dueDate) throw new Error('This task is closed (the deadline period has ended). Please refresh.');

    const logMap = getLogMap_();
    const entry = logMap[key_(taskId, member.id, dueDate)];
    let status = entry ? entry.status : 'Pending';
    let checked = entry ? entry.checked.slice() : [];
    let remarks = entry ? entry.remarks : '';
    const n = task.checklist.length;
    const required = requiredItems_(task);
    const requiredDone = () => required.every(i => checked.includes(i));

    if (changes.checked) {
      checked = Array.from(new Set(changes.checked.map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < n))).sort((a, b) => a - b);
      // Ticking every required item completes the task; optional items (e.g. surprise checks) never block it
      if (required.length && status !== 'N/A') status = requiredDone() ? 'Done' : 'Pending';
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
      if (entry) sheet_(SHEET_LOG).deleteRow(entry.row);
      delete logMap[key_(taskId, member.id, dueDate)];
    } else {
      // Keep the original completion time when only remarks/checklist change on a done task
      const stamp = entry && entry.status === status && status !== 'Pending' ? entry.updatedAt : updatedAt;
      const row = [entry ? entry.logId : 'L' + Date.now() + Math.floor(Math.random() * 1000), dueDate, taskId, task.title,
        member.id, member.name, status, checked.join('|'), remarks, stamp];
      if (entry) writeRow_(SHEET_LOG, entry.row, row);
      else appendRow_(SHEET_LOG, row);
      logMap[key_(taskId, member.id, dueDate)] = { status, checked, remarks, updatedAt: stamp };
    }
    return memberItems_(member, today, [task], logMap)[0];
  });
}

// ───────────────────────── Team ─────────────────────────

function addJoinRequest_(tgUser) {
  const member = withLock_(() => {
    const existing = getTeam_().find(x => x.id === String(tgUser.id));
    if (existing) return existing;
    appendRow_(SHEET_TEAM, [String(tgUser.id), tgName_(tgUser), tgUser.username || '', 'Member', 'Pending', 'Yes', nowStr_()]);
    return getTeam_().find(x => x.id === String(tgUser.id));
  });
  if (member.status === 'Pending') {
    const who = esc_(member.name) + (member.username ? ' (@' + esc_(member.username) + ')' : '');
    getTeam_().filter(a => a.role === 'Admin' && a.status === 'Active').forEach(a => {
      sendTelegram_(a.id, `🙋 <b>${who}</b> wants to join Team Task Manager.`, {
        inline_keyboard: [[{ text: '✅ Approve', callback_data: 'ap|' + member.id }, { text: '❌ Reject', callback_data: 'rj|' + member.id }]],
      });
    });
  }
  return member;
}

function reviewMember_(id, approve, admin) {
  const m = withLock_(() => {
    const ex = getTeam_().find(x => x.id === id);
    if (!ex) throw new Error('Member not found.');
    if (ex.status === 'Active' && approve) return null;
    if (ex.role === 'Admin' && !approve) throw new Error('Admins cannot be rejected. Change their role first.');
    writeRow_(SHEET_TEAM, ex.row, [ex.id, ex.name, ex.username, ex.role, approve ? 'Active' : 'Rejected', ex.getsTasks ? 'Yes' : 'No', ex.joinedAt]);
    return ex;
  });
  if (!m) return;
  if (approve) {
    sendTelegram_(m.id, `✅ Hi <b>${esc_(m.name)}</b>, your access has been approved by ${esc_(admin.name)}.\nTap <b>Open Tasks</b> to see your tasks.`, openAppKeyboard_());
  } else {
    sendTelegram_(m.id, 'Your request to join Team Task Manager was declined. Please contact your admin.');
  }
}

// ───────────────────────── Telegram bot (webhook) ─────────────────────────

function handleUpdate_(u) {
  const cache = CacheService.getScriptCache();
  const key = 'upd_' + u.update_id;
  if (cache.get(key)) return; // Telegram may redeliver an update
  cache.put(key, '1', 21600);
  if (u.message) onMessage_(u.message);
  else if (u.callback_query) onCallback_(u.callback_query);
}

function onMessage_(msg) {
  if (!msg.chat || msg.chat.type !== 'private' || !msg.text || !msg.from) return;
  const cmd = msg.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  const member = getTeam_().find(m => m.id === String(msg.from.id));
  const chatId = msg.chat.id;

  if (!member || member.status !== 'Active') {
    const text = member && member.status === 'Pending'
      ? '⏳ Your request is waiting for admin approval. You will get a message here once approved.'
      : member && member.status === 'Rejected'
        ? 'Your request was declined. Please contact your admin.'
        : '👋 Welcome to <b>Team Task Manager</b>!\nTap <b>Open Tasks</b> below to request access.';
    sendTelegram_(chatId, text, member && member.status === 'Rejected' ? null : openAppKeyboard_());
    return;
  }
  if (cmd === '/today' || cmd === '/pending') {
    sendTelegram_(chatId, dayListMessage_(member, cmd === '/pending'), openAppKeyboard_());
    return;
  }
  sendTelegram_(chatId, `Hi <b>${esc_(firstName_(member.name))}</b>! Tap <b>Open Tasks</b> to manage your tasks.\n\n/today: today's tasks\n/pending: pending tasks only`, openAppKeyboard_());
}

function onCallback_(cq) {
  const parts = String(cq.data || '').split('|');
  const member = getTeam_().find(m => m.id === String(cq.from.id) && m.status === 'Active');
  if (!member) return answerCallback_(cq.id, 'You do not have access.', true);
  const msg = cq.message;

  if (parts[0] === 'd' || parts[0] === 'u') {
    // d = mark done, u = undo (back to pending). The pressed button flips between the two.
    const done = parts[0] === 'd';
    let item;
    try {
      item = updateItem_(member, parts[1], parts[2], { status: done ? 'Done' : 'Pending' });
    } catch (err) {
      return answerCallback_(cq.id, err.message, true);
    }
    answerCallback_(cq.id, !done ? 'Undone: task is pending again' : item && item.doneLate ? 'Marked as done (late) 🟠' : 'Marked as done ✅');
    if (msg && msg.reply_markup) {
      const title = short_(item ? item.title : '', 24);
      const flipped = done
        ? { text: '↩️ Undo ' + title, callback_data: 'u|' + parts[1] + '|' + parts[2] }
        : { text: '✅ ' + short_(item ? item.title : '', 28), callback_data: 'd|' + parts[1] + '|' + parts[2] };
      const rows = msg.reply_markup.inline_keyboard.map(r => r.map(b => (b.callback_data === cq.data ? flipped : b)));
      tg_(token_(), 'editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: rows } });
    }
    return;
  }

  if (parts[0] === 'ap' || parts[0] === 'rj') {
    if (member.role !== 'Admin') return answerCallback_(cq.id, 'Only an Admin can do this.', true);
    try {
      reviewMember_(parts[1], parts[0] === 'ap', member);
    } catch (err) {
      return answerCallback_(cq.id, err.message, true);
    }
    answerCallback_(cq.id, parts[0] === 'ap' ? 'Approved' : 'Rejected');
    if (msg) {
      tg_(token_(), 'editMessageText', {
        chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'HTML',
        text: esc_(msg.text || '') + `\n\n${parts[0] === 'ap' ? '✅ Approved' : '❌ Rejected'} by ${esc_(member.name)}`,
      });
    }
    return;
  }
  answerCallback_(cq.id, '');
}

function answerCallback_(id, text, alert) {
  tg_(token_(), 'answerCallbackQuery', { callback_query_id: id, text: text || '', show_alert: !!alert });
}

// ───────────────────────── Scheduled reminders ─────────────────────────

/** Runs every 5 minutes and sends the 8 AM / 2 PM / 8 PM / 11 PM reminders when their time arrives. */
function tick() {
  const p = props_();
  if (!p.getProperty('BOT_TOKEN')) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  const events = [];
  try {
    const now = new Date();
    const nowStr = dtStr_(now);
    const floor = dtStr_(new Date(now.getTime() - 30 * 60000)); // never catch up more than 30 minutes
    let last = p.getProperty('LAST_TICK');
    if (!last) last = dtStr_(new Date(now.getTime() - 5 * 60000));
    else if (last < floor) last = floor;
    p.setProperty('LAST_TICK', nowStr);

    const times = slotTimes_();
    Array.from(new Set([last.slice(0, 10), nowStr.slice(0, 10)])).forEach(day => {
      SLOTS.forEach(slot => {
        const x = day + ' ' + times[slot];
        if (x > last && x <= nowStr) events.push({ day, type: slot });
      });
    });
  } finally {
    lock.releaseLock();
  }
  if (events.length) dispatch_(events, getTasks_());
}

/** Sends one combined message per member for the given reminder slots. Returns the number of messages sent. */
function dispatch_(events, tasks) {
  const team = getTeam_().filter(m => m.status === 'Active');
  const logMap = getLogMap_();
  const s = settings_();
  let sent = 0;

  team.forEach(m => {
    const sections = [];
    const buttons = [];
    events.forEach(ev => {
      const items = memberItems_(m, ev.day, tasks, logMap).filter(i => !i.optional);
      const out = slotMessage_(m, ev, items, s);
      if (!out) return;
      sections.push(out.text);
      out.buttons.forEach(b => { if (!buttons.some(x => x.callback_data === b.callback_data)) buttons.push(b); });
    });
    if (!sections.length) return;
    const rows = [];
    for (let i = 0; i < Math.min(buttons.length, 8); i += 2) rows.push(buttons.slice(i, Math.min(i + 2, 8)));
    if (sendTelegram_(m.id, sections.join('\n\n'), { inline_keyboard: rows.concat(openAppKeyboard_().inline_keyboard) })) sent++;
  });

  if (s.ADMIN_SUMMARY !== 'No') {
    events.filter(e => e.type === 'morning').forEach(ev => {
      const text = adminReport_(team, tasks, logMap, ev.day);
      if (!text) return;
      team.filter(a => a.role === 'Admin').forEach(a => { if (sendTelegram_(a.id, text, openAppKeyboard_())) sent++; });
    });
  }
  return sent;
}

/**
 * Builds one member's section for a reminder slot.
 * morning: full day plan + week/month checkpoints · afternoon: morning tasks now late + evening plan
 * evening / night: everything still open today (+ week/month on their last day)
 */
function slotMessage_(m, ev, items, s) {
  const day = ev.day;
  const first = esc_(firstName_(m.name));
  const pending = items.filter(i => i.status === 'Pending');
  const todays = pending.filter(i => !i.flexible);
  const carried = todays.filter(i => i.dueDate < day);
  const morning = todays.filter(i => i.dueDate === day && i.shift === 'Morning');
  const later = todays.filter(i => i.dueDate === day && i.shift !== 'Morning');
  const week = items.filter(i => i.flexible === 'week');
  const month = items.filter(i => i.flexible === 'month');
  const weekPending = week.filter(i => i.status === 'Pending');
  const monthPending = month.filter(i => i.status === 'Pending');
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
  const rows = team.map(m => {
    const items = memberItems_(m, yesterday, tasks, logMap).filter(i => !i.optional && !i.flexible && i.dueDate === yesterday);
    return Object.assign({ name: m.name }, classify_(items));
  }).filter(r => r.total);
  if (rows.length) {
    lines.push(`📊 <b>Daily report</b>, ${prettyDate_(yesterday)}`, '✅ on time · 🟠 late · ❌ not done', '');
    rows.sort((a, b) => b.missed - a.missed || b.late - a.late).forEach(r => {
      lines.push(`${esc_(r.name)}: ✅ ${r.onTime} · 🟠 ${r.late} · ❌ ${r.missed}  (${pct_(r.onTime, r.total)}% on time)`);
    });
  }
  const period = (label, range, kind) => {
    const rs = team.map(m => {
      const items = periodItems_(m, tasks, logMap, range, kind);
      return Object.assign({ name: m.name }, classify_(items));
    }).filter(r => r.total);
    if (!rs.length) return;
    lines.push('', `📅 <b>${label}</b>, ${prettyDate_(range.start)} – ${prettyDate_(range.end)}`);
    rs.forEach(r => lines.push(`${esc_(r.name)}: ✅ ${r.onTime} · 🟠 ${r.late} · ❌ ${r.missed}  of ${r.total}`));
  };
  if (isoDay_(day) === 1) period('Weekly tasks, last week', weekRange_(yesterday), 'Weekly');
  if (Number(day.slice(8)) === 1) period('Monthly tasks, last month', monthRange_(yesterday), 'Monthly');
  return lines.length ? lines.join('\n') : null;
}

/** All occurrences of a member's Weekly/Monthly tasks whose deadline falls in the range. */
function periodItems_(m, tasks, logMap, range, category) {
  const out = [];
  const seen = {};
  for (let d = range.start; d <= range.end; d = addDays_(d, 1)) {
    memberItems_(m, d, tasks.filter(t => t.category === category), logMap).forEach(i => {
      const k = i.taskId + '|' + i.dueDate;
      if (!seen[k] && i.deadline.slice(0, 10) >= range.start && i.deadline.slice(0, 10) <= range.end && !i.optional) {
        seen[k] = 1;
        out.push(i);
      }
    });
  }
  return out;
}

function classify_(items) {
  const onTime = items.filter(i => i.status === 'Done' && !i.doneLate).length;
  const late = items.filter(i => i.status === 'Done' && i.doneLate).length;
  return { total: items.length, onTime, late, missed: items.length - onTime - late };
}

function dayListMessage_(member, pendingOnly) {
  const today = todayStr_();
  const items = sortItems_(memberItems_(member, today, getTasks_(), getLogMap_())).filter(i => !i.optional);
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
    const list = items.filter(fn).filter(i => !pendingOnly || i.status === 'Pending');
    if (!list.length) return;
    lines.push('', `<b>${label}</b>`);
    list.forEach(i => {
      if (shown++ >= MAX_LINES) return;
      const mark = i.status === 'Done' ? (i.doneLate ? '🟠' : '✅') : '⬜';
      lines.push(`${mark} ${esc_(short_(i.title))}` + (i.late && i.dueDate < today ? ` <i>(due ${prettyDate_(i.dueDate)})</i>` : ''));
    });
  });
  if (shown > MAX_LINES) lines.push(`…and ${shown - MAX_LINES} more`);
  if (!items.length) lines.push('', 'No tasks right now 🎉');
  else if (pendingOnly && !items.some(i => i.status === 'Pending')) lines.push('', 'Nothing pending. Great job! 🎉');
  return lines.join('\n');
}

function itemLines_(items, opts) {
  opts = opts || {};
  const lines = items.slice(0, MAX_LINES).map(i => '• ' + esc_(short_(i.title))
    + (i.time ? ` · ${fmt12_(i.time)}` : '')
    + (opts.due && i.dueDate < todayStr_() ? ` <i>(due ${prettyDate_(i.dueDate)})</i>` : ''));
  if (items.length > MAX_LINES) lines.push(`…and ${items.length - MAX_LINES} more`);
  return lines;
}

function openAppKeyboard_() {
  return { inline_keyboard: [[{ text: '📋 Open Tasks', web_app: { url: miniAppLink_() } }]] };
}

function tg_(token, method, payload) {
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true,
  });
  try {
    return JSON.parse(res.getContentText());
  } catch (e) {
    return { ok: false, description: 'HTTP ' + res.getResponseCode() };
  }
}

function sendTelegram_(chatId, text, replyMarkup) {
  const token = token_();
  if (!token) return false;
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const r = tg_(token, 'sendMessage', payload);
  if (!r.ok) console.warn('Telegram send failed for ' + chatId + ': ' + r.description);
  return !!r.ok;
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
      let d = monthlyDue_(day.getFullYear(), day.getMonth(), task.monthlyDate);
      if (d > day) d = monthlyDue_(day.getFullYear(), day.getMonth() - 1, task.monthlyDate);
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
  const last = new Date(y, m + 1, 0).getDate(); // a task on the 31st falls on the last day of shorter months
  return new Date(y, m, Math.min(date, last), 12);
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

function memberItems_(member, dayStr, tasks, logMap) {
  const s = settings_();
  const today = todayStr_();
  const now = nowStr_();
  const items = [];
  tasks.forEach(t => {
    if (!isAssigned_(t, member)) return;
    const due = occurrenceFor_(t, dayStr);
    if (!due) return;
    const entry = logMap[key_(t.id, member.id, due)];
    const status = entry ? entry.status : 'Pending';
    const pending = status === 'Pending';
    const deadline = deadlineFor_(t, due, s);
    const flexible = isFlexible_(t);
    const stillOpen = occurrenceFor_(t, today) === due;
    items.push({
      taskId: t.id,
      title: t.title,
      description: t.description,
      category: t.category,
      schedule: scheduleText_(t),
      shift: t.shift,
      time: t.time,
      optional: t.optional,
      checklist: t.checklist,
      checked: entry ? entry.checked : [],
      status,
      remarks: entry ? entry.remarks : '',
      updatedAt: entry ? entry.updatedAt : '',
      dueDate: due,
      deadline,
      flexible,
      daysLeft: flexible ? daysBetween_(dayStr, deadline.slice(0, 10)) : 0,
      late: pending && !t.optional && stillOpen && now > deadline,
      missed: pending && !t.optional && !stillOpen,
      doneLate: status === 'Done' && !!entry.updatedAt && entry.updatedAt > deadline,
    });
  });
  return items;
}

/** Counts for a day: `total/done/pending/late` cover items due that day or earlier; week/month cover the open periods. */
function countItems_(items, dayStr) {
  const due = items.filter(i => !i.optional && !i.flexible);
  const done = due.filter(i => i.status === 'Done');
  const week = items.filter(i => !i.optional && i.flexible === 'week');
  const month = items.filter(i => !i.optional && i.flexible === 'month');
  return {
    total: due.length,
    done: done.length,
    doneLate: done.filter(i => i.doneLate).length,
    pending: due.length - done.length,
    late: due.filter(i => i.late).length,
    missed: due.filter(i => i.missed).length,
    weekTotal: week.length, weekDone: week.filter(i => i.status === 'Done').length,
    monthTotal: month.length, monthDone: month.filter(i => i.status === 'Done').length,
    optionalDone: items.filter(i => i.optional && i.status === 'Done').length,
  };
}

function sortItems_(items) {
  const rank = i => (i.late || i.missed ? 0 : i.flexible === 'week' ? 4 : i.flexible === 'month' ? 5 : 1 + SHIFTS.indexOf(i.shift));
  return items.sort((a, b) => rank(a) - rank(b) || (a.optional - b.optional)
    || (a.time || '99').localeCompare(b.time || '99') || a.title.localeCompare(b.title));
}

function scheduleText_(t) {
  if (t.category === 'Daily') return 'Every day';
  if (t.category === 'Weekly') return t.weeklyDays.length ? 'Every ' + t.weeklyDays.map(d => WEEKDAYS[d - 1]).join(', ') : 'Any day each week';
  if (t.category === 'Monthly') return t.monthlyAny ? 'Any time each month' : 'Monthly on the ' + ordinal_(t.monthlyDate);
  return 'On ' + (t.dueDate ? Utilities.formatDate(parseDate_(t.dueDate), tz_(), 'd MMM yyyy') : '—');
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

// ───────────────────────── Data access ─────────────────────────

function getTeam_() {
  return readRows_(SHEET_TEAM).map(r => ({
    row: r._row,
    id: str_(r['User ID']),
    name: str_(r['Name']) || 'Unknown',
    username: str_(r['Username']),
    role: str_(r['Role']) === 'Admin' ? 'Admin' : 'Member',
    status: ['Active', 'Pending', 'Rejected'].includes(str_(r['Status'])) ? str_(r['Status']) : 'Pending',
    getsTasks: str_(r['Gets Tasks']).toLowerCase() !== 'no',
    joinedAt: dtCell_(r['Joined At']),
  })).filter(m => m.id);
}

function getTasks_() {
  return readRows_(SHEET_TASKS).map(r => {
    const createdAt = dtCell_(r['Created At']);
    const assign = str_(r['Assign To']);
    const monthly = str_(r['Monthly Date']);
    return {
      row: r._row,
      id: str_(r['ID']),
      title: str_(r['Title']),
      description: str_(r['Description']),
      category: str_(r['Category']),
      weeklyDays: str_(r['Weekly Days']).split(',').map(s => WEEKDAYS.indexOf(s.trim().slice(0, 3)) + 1).filter(n => n > 0),
      monthlyDate: Number(monthly) || '',
      monthlyAny: !monthly || monthly.toLowerCase() === 'any',
      dueDate: str_(r['Due Date']),
      shift: SHIFTS.includes(str_(r['Shift'])) ? str_(r['Shift']) : 'General',
      time: timeCell_(r['Time']),
      optional: str_(r['Type']).toLowerCase() === 'if applicable',
      checklist: str_(r['Checklist']).split('\n').map(parseChecklistItem_).filter(c => c.text),
      assignAll: !assign || assign.toLowerCase() === 'all',
      assignIds: assign.split(',').map(s => s.trim()).filter(Boolean),
      active: str_(r['Active']).toLowerCase() !== 'no',
      createdAt,
      createdDate: createdAt.slice(0, 10),
    };
  }).filter(t => t.id && CATEGORIES.includes(t.category));
}

/** key(taskId|userId|date) → log entry */
function getLogMap_() {
  const map = {};
  readRows_(SHEET_LOG).forEach(r => {
    map[key_(str_(r['Task ID']), str_(r['User ID']), str_(r['Date']))] = {
      row: r._row,
      logId: str_(r['Log ID']),
      status: STATUSES.includes(str_(r['Status'])) ? str_(r['Status']) : 'Pending',
      checked: str_(r['Checked Items']).split('|').filter(s => s !== '').map(Number),
      remarks: str_(r['Remarks']),
      updatedAt: dtCell_(r['Updated At']),
    };
  });
  return map;
}

function readRows_(name) {
  const values = sheet_(name).getDataRange().getValues();
  const headers = values.shift() || [];
  const rows = [];
  values.forEach((row, i) => {
    if (row.every(v => v === '')) return;
    const o = { _row: i + 2 };
    headers.forEach((h, j) => { o[h] = row[j]; });
    rows.push(o);
  });
  return rows;
}

function appendRow_(name, values) {
  const sh = sheet_(name);
  const range = sh.getRange(sh.getLastRow() + 1, 1, 1, values.length);
  range.setNumberFormat('@').setValues([values.map(v => (v === null || v === undefined ? '' : String(v)))]);
}

function writeRow_(name, row, values) {
  sheet_(name).getRange(row, 1, 1, values.length).setNumberFormat('@')
    .setValues([values.map(v => (v === null || v === undefined ? '' : String(v)))]);
}

// ───────────────────────── Helpers ─────────────────────────

function props_() { return PropertiesService.getScriptProperties(); }
function token_() { return props_().getProperty('BOT_TOKEN'); }

function settings_() {
  const p = props_().getProperties();
  const s = {};
  Object.keys(DEFAULT_SETTINGS).forEach(k => { s[k] = p[k] || DEFAULT_SETTINGS[k]; });
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

function ss_() {
  const id = props_().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error(`Sheet "${name}" not found. Please run setup() first.`);
  return sh;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function tz_() { return Session.getScriptTimeZone() || 'Asia/Kolkata'; }
function fmtDate_(d) { return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd'); }
function dtStr_(d) { return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd HH:mm'); }
function nowStr_() { return dtStr_(new Date()); }
function todayStr_() { return fmtDate_(new Date()); }
// Noon keeps the calendar date stable regardless of timezone offsets
function parseDate_(s) { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2], 12); }
function addDays_(s, n) { const d = parseDate_(s); d.setDate(d.getDate() + n); return fmtDate_(d); }
function daysBetween_(a, b) { return Math.round((parseDate_(b) - parseDate_(a)) / 86400000); }
function isoDay_(s) { const d = parseDate_(s).getDay(); return d === 0 ? 7 : d; }
function weekRange_(s) { const start = addDays_(s, 1 - isoDay_(s)); return { start, end: addDays_(start, 6) }; }
function monthRange_(s) {
  const d = parseDate_(s);
  return { start: s.slice(0, 8) + '01', end: fmtDate_(new Date(d.getFullYear(), d.getMonth() + 1, 0, 12)) };
}
function prettyDate_(s) { return Utilities.formatDate(parseDate_(s), tz_(), 'EEE d MMM'); }
function str_(v) { return v instanceof Date ? fmtDate_(v) : (v == null ? '' : String(v).trim()); }
function dtCell_(v) { return v instanceof Date ? dtStr_(v) : str_(v); }
function timeCell_(v) { return v instanceof Date ? Utilities.formatDate(v, tz_(), 'HH:mm') : normTime_(str_(v)); }

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
function hex_(bytes) { return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join(''); }
