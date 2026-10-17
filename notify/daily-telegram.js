// Daily Telegram reminder for home-routines-pwa.
// Reads the same Firestore data the app uses and resolves "today's routines" the same way
// the app's Day View does (resolveOccurrencesForDate in index.html):
//   1. inside the saved schedule horizon  -> the persisted `schedule/<YYYY-MM>` plan
//   2. outside it                         -> legacy natural schedule + `overrides`
//   3. a "day off" (blockedDays) hides everything that isn't already done.
// Runs in Node 20+ (global fetch), no dependencies. Secrets come from the environment:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  (never committed — stored as GitHub Secrets)
'use strict';

const RoutineScheduling = require('../scheduling.js');

const PROJECT_ID = 'hous-holds-by-me';
const FS_BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents';
const TIMEZONE = 'Asia/Jerusalem';
const SEND_HOUR = 20; // local hour at which the reminder is sent

// ---------- Firestore REST decoding ----------
function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  return null;
}
function decodeFields(fields) {
  const out = {};
  Object.keys(fields || {}).forEach(function (k) { out[k] = decodeValue(fields[k]); });
  return out;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore ' + res.status + ' for ' + url.replace(FS_BASE, ''));
  return res.json();
}
async function fetchDoc(path) {
  const json = await fetchJson(FS_BASE + '/' + path);
  return json ? decodeFields(json.fields) : null; // missing doc -> null
}
async function fetchRoutines() {
  const list = [];
  let pageToken = '';
  do {
    const json = await fetchJson(FS_BASE + '/routines?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''));
    if (!json) break;
    (json.documents || []).forEach(function (d) {
      const r = decodeFields(d.fields);
      r.id = d.name.split('/').pop();
      list.push(r);
    });
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return list;
}

// ---------- Date helpers (pure calendar arithmetic) ----------
function isoParts(iso) { const p = iso.split('-').map(Number); return { y: p[0], m: p[1] - 1, d: p[2] }; }
function monthKeyOf(y, m0) { return y + '-' + String(m0 + 1).padStart(2, '0'); }
function isoOf(y, m0, d) { return monthKeyOf(y, m0) + '-' + String(d).padStart(2, '0'); }
function daysInMonthOf(y, m0) { return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate(); }
function addMonths(y, m0, n) { const t = y * 12 + m0 + n; return { y: Math.floor(t / 12), m: ((t % 12) + 12) % 12 }; }

// ---------- Legacy schedule (port of getDueDatesInMonth / buildMonthSchedule in index.html) ----------
function getDueDays(routine, y, m0, todayISO) {
  const monthEnd = isoOf(y, m0, daysInMonthOf(y, m0));
  const monthStart = isoOf(y, m0, 1);
  const startISO = routine.startDate || todayISO;
  const interval = Math.max(1, routine.intervalDays || 1);
  if (startISO > monthEnd) return [];
  let cursor = startISO;
  let guard = 0;
  while (cursor < monthStart && guard < 100000) { cursor = RoutineScheduling.addDaysISO(cursor, interval); guard++; }
  const days = [];
  guard = 0;
  while (cursor <= monthEnd && guard < 500) {
    days.push(Number(cursor.slice(8, 10)));
    cursor = RoutineScheduling.addDaysISO(cursor, interval);
    guard++;
  }
  return days;
}
function buildMonthSchedule(routines, y, m0, todayISO) {
  const dim = daysInMonthOf(y, m0);
  const raw = [];
  routines.forEach(function (routine) {
    if (routine.active === false) return;
    getDueDays(routine, y, m0, todayISO).forEach(function (day) { raw.push({ routine: routine, day: day }); });
  });
  const cap = Math.max(1, Math.ceil(raw.length / dim) || 1);
  // Array.prototype.sort is stable (ES2019), matching the browser's behavior in the app.
  raw.sort(function (a, b) { return a.routine.intervalDays - b.routine.intervalDays || a.day - b.day; });
  const dayLoad = new Array(dim + 1).fill(0);
  const dayMap = {};
  for (let d = 1; d <= dim; d++) dayMap[d] = [];
  raw.forEach(function (item) {
    const ideal = Math.min(Math.max(item.day, 1), dim);
    const searchLimit = Math.max(3, Math.floor(item.routine.intervalDays / 2));
    let placed = false;
    if (dayLoad[ideal] < cap) {
      dayMap[ideal].push(item.routine); dayLoad[ideal]++; placed = true;
    } else {
      for (let d = 1; d <= searchLimit && !placed; d++) {
        const cands = [ideal - d, ideal + d];
        for (let i = 0; i < cands.length; i++) {
          const cand = cands[i];
          if (cand >= 1 && cand <= dim && dayLoad[cand] < cap) {
            dayMap[cand].push(item.routine); dayLoad[cand]++; placed = true; break;
          }
        }
      }
    }
    if (!placed) {
      let bestDay = ideal, bestLoad = Infinity;
      for (let d = Math.max(1, ideal - searchLimit); d <= Math.min(dim, ideal + searchLimit); d++) {
        if (dayLoad[d] < bestLoad) { bestLoad = dayLoad[d]; bestDay = d; }
      }
      dayMap[bestDay].push(item.routine); dayLoad[bestDay]++;
    }
  });
  return { dayMap: dayMap, daysInMonth: dim };
}
// Override-aware legacy occurrences whose EFFECTIVE date is `dateISO`. The natural month is
// searched with a ±1 month margin so an override that crosses a month boundary is found.
function legacyRoutinesForDate(routines, overridesFlat, dateISO, todayISO) {
  const t = isoParts(dateISO);
  const result = [];
  for (let off = -1; off <= 1; off++) {
    const mm = addMonths(t.y, t.m, off);
    const sched = buildMonthSchedule(routines, mm.y, mm.m, todayISO);
    for (let d = 1; d <= sched.daysInMonth; d++) {
      const natural = isoOf(mm.y, mm.m, d);
      sched.dayMap[d].forEach(function (routine) {
        const eff = overridesFlat[natural + '_' + routine.id] || natural;
        if (eff === dateISO) result.push(routine);
      });
    }
  }
  return result;
}

// ---------- Resolve today's routines (mirrors resolveOccurrencesForDate) ----------
// data: { routines, horizon, scheduleFlat, overridesFlat, blockedFlat, completionsFlat }
function resolveTodayRoutines(data, dateISO) {
  let list;
  if (RoutineScheduling.isWithinHorizon(dateISO, data.horizon)) {
    list = Object.keys(data.scheduleFlat)
      .filter(function (k) { return k.slice(0, 10) === dateISO && data.scheduleFlat[k]; })
      .map(function (k) { return data.routines.find(function (r) { return r.id === k.slice(11) && r.active !== false; }); })
      .filter(Boolean);
  } else {
    list = legacyRoutinesForDate(data.routines, data.overridesFlat, dateISO, dateISO);
  }
  const withDone = list.map(function (routine) {
    return { routine: routine, done: !!data.completionsFlat[dateISO + '_' + routine.id] };
  });
  // "Day off": only completions that already happened stay visible.
  if (data.blockedFlat[dateISO]) return withDone.filter(function (o) { return o.done; });
  return withDone;
}

// ---------- Message ----------
const WEEKDAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
function formatHeader(dateISO) {
  const p = isoParts(dateISO);
  const wd = new Date(Date.UTC(p.y, p.m, p.d)).getUTCDay();
  return 'יום ' + WEEKDAYS_HE[wd] + ', ' + String(p.d).padStart(2, '0') + '.' + String(p.m + 1).padStart(2, '0');
}
// Returns the message text, or null when there is nothing worth sending (no routines today).
function buildMessage(dateISO, items) {
  if (!items.length) return null;
  const pending = items.filter(function (o) { return !o.done; });
  const doneCount = items.length - pending.length;
  const header = '🏠 שגרות להיום – ' + formatHeader(dateISO);
  if (!pending.length) return header + '\n\n🎉 כל שגרות היום כבר בוצעו. כל הכבוד!';
  const lines = pending.map(function (o) { return '⬜ ' + o.routine.name; });
  let text = header + '\n\n' + lines.join('\n');
  if (doneCount) text += '\n\n✅ ' + doneCount + ' כבר בוצעו';
  return text;
}

// ---------- Time (Israel local, DST-aware) ----------
function israelNow(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now || new Date());
  const get = function (t) { return parts.find(function (p) { return p.type === t; }).value; };
  return { dateISO: get('year') + '-' + get('month') + '-' + get('day'), hour: Number(get('hour')) };
}

// ---------- Data loading ----------
async function loadData(dateISO) {
  const t = isoParts(dateISO);
  const keys = [-1, 0, 1].map(function (off) { const mm = addMonths(t.y, t.m, off); return monthKeyOf(mm.y, mm.m); });
  const thisKey = keys[1];
  const [routines, horizon, schedule, blocked, completions, ...overridesDocs] = await Promise.all([
    fetchRoutines(),
    fetchDoc('meta/scheduleHorizon'),
    fetchDoc('schedule/' + thisKey),
    fetchDoc('blockedDays/' + thisKey),
    fetchDoc('completions/' + thisKey),
    ...keys.map(function (k) { return fetchDoc('overrides/' + k); }),
  ]);
  return {
    routines: routines,
    horizon: horizon,
    scheduleFlat: schedule || {},
    blockedFlat: blocked || {},
    completionsFlat: completions || {},
    overridesFlat: Object.assign({}, ...overridesDocs.map(function (d) { return d || {}; })),
  };
}

// ---------- Telegram ----------
async function telegram(token, method, payload) {
  const res = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const json = await res.json().catch(function () { return {}; });
  if (!res.ok || !json.ok) throw new Error('Telegram ' + method + ' failed: ' + res.status + ' ' + (json.description || ''));
  return json;
}

// One-time helper: replies (privately, in Telegram) with the chat id of whoever messaged the bot,
// so the id never appears in the public Actions log.
async function setupChatId(token) {
  const upd = await telegram(token, 'getUpdates', {});
  const msgs = (upd.result || []).map(function (u) { return u.message || u.edited_message; }).filter(Boolean);
  const last = msgs.filter(function (m) { return m.chat && m.chat.type === 'private'; }).pop();
  if (!last) {
    console.log('No private message found. Send any message to the bot in Telegram, then run this again.');
    process.exitCode = 1;
    return;
  }
  await telegram(token, 'sendMessage', {
    chat_id: last.chat.id,
    text: 'המזהה שלך הוא:\n' + last.chat.id + '\n\nהעתק אותו כ-Secret בשם TELEGRAM_CHAT_ID בגיטהאב.',
  });
  console.log('Chat id sent privately to the user in Telegram.');
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const mode = process.env.NOTIFY_MODE || 'scheduled'; // scheduled | force | setup
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');

  if (mode === 'setup') { await setupChatId(token); return; }
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID is not set (run the workflow with mode=setup first)');

  const now = israelNow();
  // Two cron entries (summer/winter UTC offsets) both call this; only the one that lands in
  // the 20:00 Israel hour sends. A manual "force" run always sends.
  if (mode !== 'force' && now.hour !== SEND_HOUR) {
    console.log('Israel hour is ' + now.hour + ', not ' + SEND_HOUR + ' - skipping.');
    return;
  }

  const data = await loadData(now.dateISO);
  const items = resolveTodayRoutines(data, now.dateISO);
  const text = buildMessage(now.dateISO, items);
  if (!text) { console.log('No routines scheduled for ' + now.dateISO + ' - nothing to send.'); return; }
  await telegram(token, 'sendMessage', { chat_id: chatId, text: text });
  console.log('Sent reminder for ' + now.dateISO + ' (' + items.length + ' routines).');
}

module.exports = { decodeValue, decodeFields, buildMonthSchedule, legacyRoutinesForDate, resolveTodayRoutines, buildMessage, israelNow, formatHeader, loadData };

if (require.main === module) {
  main().catch(function (e) { console.error(e.message || e); process.exit(1); });
}
