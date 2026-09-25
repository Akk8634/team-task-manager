/**
 * Team Task Manager: Google Sheet script
 *
 * The app now runs on Cloudflare (Mini App + bot + database). This script:
 *   1. moves the existing data from this Sheet into the Cloudflare database (once, in setup),
 *   2. runs the reminder check every 5 minutes,
 *   3. keeps a read-only copy in this Sheet: Tasks, Team, History, Daily Report,
 *      Weekly & Monthly Report and Monthly Summary (updated every 15 minutes).
 *
 * See SETUP.md. Fill in CONFIG, then run `setup` once from the editor.
 * Changes made by hand in the copied sheets are overwritten. Manage tasks and people in the app.
 */

const CONFIG = {
  APP_URL: 'https://cityflo-tasks.pages.dev', // the Cloudflare Pages site
  SYNC_KEY: '',  // the same secret you saved as SYNC_KEY in Cloudflare
  BOT_TOKEN: '', // optional: leave empty to keep the bot token saved by the old setup
};

const SYNC_EVERY_MIN = 15;
const SHEETS = {
  tasks: 'Tasks',
  team: 'Team',
  history: 'History',
  daily: 'Daily Report',
  period: 'Weekly & Monthly Report',
  summary: 'Monthly Summary',
};
const OLD_LOG_SHEETS = { 'TaskLog': 'Old TaskLog', 'TaskLog Archive': 'Old TaskLog Archive' };
const COLUMNS = {
  tasks: ['ID', 'Title', 'Description', 'Category', 'Weekly Days', 'Monthly Date', 'Due Date', 'Shift', 'Time',
    'Type', 'Checklist', 'Assign To', 'Active', 'Created At'],
  team: ['User ID', 'Name', 'Username', 'Role', 'Status', 'Gets Tasks', 'Joined At'],
  logs: ['Log ID', 'Date', 'Task ID', 'Task Title', 'User ID', 'Name', 'Status', 'Checked Items', 'Remarks', 'Updated At'],
};
const SETTING_KEYS = ['MORNING_TIME', 'AFTERNOON_TIME', 'EVENING_TIME', 'NIGHT_TIME', 'ADMIN_SUMMARY'];

// ───────────────────────── Setup ─────────────────────────

/** Run once after filling in CONFIG. Safe to run again: data is moved only the first time. */
function setup() {
  const url = CONFIG.APP_URL.trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(url)) throw new Error('APP_URL must start with https://');
  if (!CONFIG.SYNC_KEY.trim()) throw new Error('Fill in SYNC_KEY in CONFIG first (see SETUP.md).');
  const p = props_();
  p.setProperties({ APP_URL: url, SYNC_KEY: CONFIG.SYNC_KEY.trim() });
  const token = CONFIG.BOT_TOKEN.trim() || p.getProperty('BOT_TOKEN') || '';

  if (!p.getProperty('MOVED_AT')) {
    let counts = null;
    try {
      counts = moveData_(token);
    } catch (err) {
      // The database already has the live data (e.g. this script was pasted again): never overwrite it
      if (!/already moved/i.test(String(err && err.message))) throw err;
    }
    p.setProperty('MOVED_AT', new Date().toISOString());
    Logger.log(counts
      ? `✅ Data moved to Cloudflare: ${counts.tasks} tasks, ${counts.team} people, ${counts.history} history rows.`
      : 'The Cloudflare database already has the data. Nothing was moved or overwritten.');
    Object.keys(OLD_LOG_SHEETS).forEach(name => {
      const sh = ss_().getSheetByName(name);
      if (sh && !ss_().getSheetByName(OLD_LOG_SHEETS[name])) sh.setName(OLD_LOG_SHEETS[name]);
    });
  } else {
    Logger.log('Data was already moved on ' + p.getProperty('MOVED_AT') + '. Skipping that step.');
  }

  const out = call_('setup', null, { token: CONFIG.BOT_TOKEN.trim() });
  Logger.log(`✅ Bot @${out.bot} now runs on ${out.appUrl}`);
  if (out.claimCode) Logger.log(`Open the bot in Telegram, tap "Open Tasks" and enter this admin code: ${out.claimCode}`);

  ScriptApp.getProjectTriggers().forEach(t => {
    if (['tick', 'onOpenMenu_'].includes(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();

  syncSheet_();
  Logger.log('✅ Setup complete. Reminders are checked every 5 minutes and this Sheet updates every 15 minutes.');
}

/** Copies Tasks, Team, TaskLog (+ archive) and the settings from this Sheet into the database. */
function moveData_(token) {
  const p = props_();
  if (!token) throw new Error('Bot token not found. Put it in CONFIG.BOT_TOKEN and run setup again.');
  call_('import', null, { step: 'begin' });
  const send = (table, rows) => {
    for (let i = 0; i < rows.length; i += 200) call_('import', null, { step: 'rows', table, rows: rows.slice(i, i + 200) });
  };
  send('tasks', readOld_('Tasks', COLUMNS.tasks));
  send('team', readOld_('Team', COLUMNS.team));
  send('logs', readOld_('TaskLog Archive', COLUMNS.logs).concat(readOld_('TaskLog', COLUMNS.logs)));
  const settings = { BOT_TOKEN: token };
  SETTING_KEYS.forEach(k => { const v = p.getProperty(k); if (v) settings[k] = v; });
  return call_('import', null, { step: 'finish', settings });
}

/** Rows of an old sheet in the given column order, as text exactly as shown. */
function readOld_(name, columns) {
  const sh = ss_().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getDisplayValues();
  const head = values.shift().map(h => String(h).trim());
  const idx = columns.map(c => head.indexOf(c));
  return values.filter(r => r.some(v => v !== '')).map(r => idx.map(i => (i < 0 ? '' : r[i])));
}

// ───────────────────────── Every 5 minutes ─────────────────────────

function tick() {
  const p = props_();
  if (!p.getProperty('SYNC_KEY')) return;
  try { call_('cron'); } catch (err) { console.error('Reminder check failed: ' + (err && err.message)); }
  const last = Number(p.getProperty('LAST_SYNC_MS') || 0);
  if (Date.now() - last >= (SYNC_EVERY_MIN - 1) * 60000) {
    try { syncSheet_(); } catch (err) { console.error('Sheet update failed: ' + (err && err.stack || err)); }
  }
}

/** Updates the Sheet copy right now (also in the menu: Task Manager → Update this Sheet now). */
function syncNow() { syncSheet_(); }

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Task Manager').addItem('Update this Sheet now', 'syncNow').addToUi();
}

// ───────────────────────── Sheet copy ─────────────────────────

function syncSheet_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const p = props_();
    let since = p.getProperty('SYNC_CURSOR') || '';
    // Look 2 minutes back each time so a change saved at the same moment as the last sync is not missed
    if (since) since = Math.max(0, Number(since.split('|')[0]) - 120000) + '|';
    let reportAfter = p.getProperty('REPORT_DAY') || '';
    let historyIndex = null;
    let newReports = false;
    for (let page = 0; page < 30; page++) {
      const d = call_('sync', { since, reportAfter });
      if (page === 0) {
        writeTable_(SHEETS.tasks, d.tasks);
        writeTable_(SHEETS.team, d.team);
      }
      historyIndex = applyHistory_(d.history, historyIndex);
      if (d.reports.daily.length || d.reports.period.length) {
        appendRows_(SHEETS.daily, d.reports.dailyColumns, d.reports.daily, 7);
        appendRows_(SHEETS.period, d.reports.periodColumns, d.reports.period, 9);
        newReports = true;
      }
      since = d.history.cursor;
      reportAfter = d.reports.reportDay;
      p.setProperties({ SYNC_CURSOR: since, REPORT_DAY: reportAfter });
      if (!d.history.more && !d.reports.more) break;
    }
    if (newReports || !ss_().getSheetByName(SHEETS.summary)) rebuildSummary_();
    p.setProperty('LAST_SYNC_MS', String(Date.now()));
  } finally {
    lock.releaseLock();
  }
}

/** Replaces a whole sheet (Tasks, Team) with the given rows (first row = headers). */
function writeTable_(name, rows) {
  const sh = sheetFor_(name, rows[0]);
  const width = rows[0].length;
  const old = sh.getLastRow();
  if (old > 1) sh.getRange(2, 1, old - 1, Math.max(width, sh.getLastColumn())).clearContent();
  if (rows.length > 1) sh.getRange(2, 1, rows.length - 1, width).setNumberFormat('@').setValues(rows.slice(1).map(r => r.map(String)));
}

/**
 * History: one row per task per person per period, like the old TaskLog. Changed rows are updated
 * in place (found by Log ID), new rows are added at the bottom, removed ones (undo) are deleted.
 */
function applyHistory_(h, index) {
  const sh = sheetFor_(SHEETS.history, h.columns);
  if (!index) {
    index = {};
    const n = sh.getLastRow() - 1;
    if (n > 0) sh.getRange(2, 1, n, 1).getValues().forEach((r, i) => { if (r[0] !== '') index[String(r[0])] = i + 2; });
  }
  const append = [];
  h.rows.forEach(r => {
    const row = index[r[0]];
    if (row) sh.getRange(row, 1, 1, r.length).setNumberFormat('@').setValues([r.map(String)]);
    else append.push(r.map(String));
  });
  if (append.length) {
    const start = sh.getLastRow() + 1;
    sh.getRange(start, 1, append.length, append[0].length).setNumberFormat('@').setValues(append);
    append.forEach((r, i) => { index[r[0]] = start + i; });
  }
  const gone = h.deleted.map(id => index[id]).filter(Boolean).sort((a, b) => b - a);
  if (gone.length) {
    gone.forEach(row => sh.deleteRow(row));
    return null; // row numbers moved; rebuild the index next time
  }
  return index;
}

function appendRows_(name, columns, rows, pctCol) {
  const sh = sheetFor_(name, columns);
  if (!rows.length) return;
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, columns.length).setValues(rows);
  sh.getRange(start, pctCol, rows.length, 1).setNumberFormat('0%');
}

/** Monthly Summary: per month and person, from the Daily Report and the Weekly & Monthly Report. */
function rebuildSummary_() {
  const agg = {};
  const add = (month, name, total, onTime, late, missed) => {
    const k = month + '|' + name;
    const a = agg[k] || (agg[k] = { month, name, total: 0, onTime: 0, late: 0, missed: 0 });
    a.total += Number(total) || 0; a.onTime += Number(onTime) || 0; a.late += Number(late) || 0; a.missed += Number(missed) || 0;
  };
  const read = name => {
    const sh = ss_().getSheetByName(name);
    return sh && sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues() : [];
  };
  read(SHEETS.daily).forEach(r => add(monthOf_(r[0]), r[1], r[2], r[3], r[4], r[5]));
  read(SHEETS.period).forEach(r => add(monthOf_(r[2]), r[3], r[4], r[5], r[6], r[7]));
  const rows = Object.keys(agg).map(k => agg[k])
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : a.name.localeCompare(b.name)))
    .map(a => [a.month, a.name, a.total, a.onTime, a.late, a.missed, a.total ? a.onTime / a.total : 0]);
  const columns = ['Month', 'Member', 'Tasks', 'Done on time', 'Done late', 'Not done', 'On-time %'];
  const sh = sheetFor_(SHEETS.summary, columns);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, columns.length).clearContent();
  if (rows.length) {
    sh.getRange(2, 1, rows.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, rows.length, columns.length).setValues(rows);
    sh.getRange(2, 7, rows.length, 1).setNumberFormat('0%');
  }
}

function monthOf_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM');
  return String(v).slice(0, 7);
}

/** Gets (or creates) a copy sheet with bold, frozen headers and a warning if someone edits it by hand. */
function sheetFor_(name, headers) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const head = sh.getRange(1, 1, 1, headers.length);
  if (sh.getLastRow() === 0 || head.getValues()[0].join('|') !== headers.join('|')) {
    head.setValues([headers]).setFontWeight('bold').setBackground('#e8eaf6');
    sh.setFrozenRows(1);
  }
  if (!sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
    sh.protect().setDescription('Copied from the Task Manager app. Changes here are overwritten.').setWarningOnly(true);
  }
  return sh;
}

// ───────────────────────── Helpers ─────────────────────────

function call_(route, params, body) {
  const p = props_();
  const base = p.getProperty('APP_URL') || CONFIG.APP_URL.replace(/\/+$/, '');
  let url = base + '/api/' + route + '?key=' + encodeURIComponent(p.getProperty('SYNC_KEY') || CONFIG.SYNC_KEY);
  Object.keys(params || {}).forEach(k => { url += '&' + k + '=' + encodeURIComponent(params[k]); });
  const opts = { method: body ? 'post' : 'get', muteHttpExceptions: true };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch(url, opts);
  let j;
  try { j = JSON.parse(res.getContentText()); } catch (e) {
    throw new Error(`The app server answered ${res.getResponseCode()}: ${res.getContentText().slice(0, 200)}`);
  }
  if (!j.ok) throw new Error(j.error || 'The app server returned an error.');
  return j.data;
}

function props_() { return PropertiesService.getScriptProperties(); }
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
