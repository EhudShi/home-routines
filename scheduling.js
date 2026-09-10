// Pure scheduling engine for home-routines-pwa.
// No DOM / Firestore access here — everything takes plain data in and returns plain data,
// so it can run unmodified in the browser (index.html) and in Node (scheduling.test.js).
(function (global) {
  'use strict';

  var MAX_ROUTINES_PER_DAY = 3;
  var MAX_DAILY_LOAD = 6;
  var DEFAULT_LOAD_LEVEL = 2;
  var DEFAULT_HORIZON_DAYS = 30;

  // ---------- Date helpers (pure calendar-day arithmetic, no timezone involved) ----------
  function isoToEpochDay(iso) {
    var parts = iso.split('-');
    var y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2]);
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  }
  function epochDayToISO(ed) {
    var dt = new Date(ed * 86400000);
    return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
  }
  function addDaysISO(iso, n) {
    return epochDayToISO(isoToEpochDay(iso) + n);
  }
  function diffDaysISO(fromISO, toISO) {
    return isoToEpochDay(toISO) - isoToEpochDay(fromISO);
  }
  function maxISO(a, b) {
    if (!a) return b || null;
    if (!b) return a || null;
    return a > b ? a : b;
  }
  function clampToToday(dateISO, todayISO) {
    return dateISO < todayISO ? todayISO : dateISO;
  }

  // ---------- Load level ----------
  function normalizeLoadLevel(routine) {
    var v = routine && routine.loadLevel;
    return (v === 1 || v === 2 || v === 3) ? v : DEFAULT_LOAD_LEVEL;
  }

  // ---------- Minimum-interval anchor: the next occurrence can never be earlier than this ----------
  // Anchored on the routine's LAST ACTUAL COMPLETION date, never on a previously *planned*
  // date. A routine that has never been completed falls back to its startDate (legacy
  // first-occurrence behavior, unchanged for pre-existing data).
  function earliestDueDate(routine, todayISO) {
    var interval = Math.max(1, routine.intervalDays || 1);
    if (routine.lastCompletedDate) {
      return addDaysISO(routine.lastCompletedDate, interval);
    }
    return routine.startDate || todayISO;
  }

  // ---------- Per-day load/count bookkeeping ----------
  function buildDayState(occurrences, routinesById) {
    var state = {};
    (occurrences || []).forEach(function (o) {
      var routine = routinesById[o.routineId];
      if (!routine) return;
      var st = state[o.date] || (state[o.date] = { count: 0, load: 0, routineIds: {} });
      if (st.routineIds[o.routineId]) return;
      st.routineIds[o.routineId] = true;
      st.count += 1;
      st.load += normalizeLoadLevel(routine);
    });
    return state;
  }
  function canPlace(state, date, routine) {
    var st = state[date];
    if (!st) return true;
    if (st.routineIds[routine.id]) return false; // same routine can't occur twice on one day
    if (st.count + 1 > MAX_ROUTINES_PER_DAY) return false;
    if (st.load + normalizeLoadLevel(routine) > MAX_DAILY_LOAD) return false;
    return true;
  }
  function placeOn(state, date, routine) {
    var st = state[date] || (state[date] = { count: 0, load: 0, routineIds: {} });
    st.routineIds[routine.id] = true;
    st.count += 1;
    st.load += normalizeLoadLevel(routine);
  }
  function findEarliestSlot(state, earliestAllowedISO, horizonEndISO, routine) {
    var cur = earliestAllowedISO;
    var guard = 0;
    while (cur <= horizonEndISO && guard < 5000) {
      if (canPlace(state, cur, routine)) return cur;
      cur = addDaysISO(cur, 1);
      guard++;
    }
    return null;
  }

  // ---------- Re-schedule the next `horizonDays` days ----------
  // existingOccurrences: [{date, routineId}] — whatever is currently in the persisted
  //   schedule store within the horizon (both future-planned and, for `today`, possibly
  //   already-completed).
  // isDoneFn(date, routineId): whether that occurrence has actually been completed.
  //
  // Rule: an existing occurrence is KEPT untouched if it is dated before `sinceISO` OR it
  // is already done. Anything else (>= sinceISO and not done) is cleared and replanned.
  // Every active routine's future chain (one or more occurrences across the horizon) is
  // then (re)computed from its true anchor — never earlier than any kept-but-pending
  // occurrence, and never earlier than its last-actual-completion + interval.
  function generateReschedule(opts) {
    var routines = opts.routines || [];
    var todayISO = opts.todayISO;
    var sinceISO = opts.sinceISO || todayISO;
    var horizonDays = opts.horizonDays || DEFAULT_HORIZON_DAYS;
    var existingOccurrences = opts.existingOccurrences || [];
    var isDoneFn = opts.isDoneFn || function () { return false; };

    var horizonEndISO = addDaysISO(todayISO, horizonDays - 1);
    var active = routines.filter(function (r) { return r.active !== false; });
    var byId = {};
    active.forEach(function (r) { byId[r.id] = r; });

    var inHorizon = existingOccurrences.filter(function (o) {
      return o.date >= todayISO && o.date <= horizonEndISO && byId[o.routineId];
    });

    var kept = [];
    var lastPending = {};
    inHorizon.forEach(function (o) {
      var done = !!isDoneFn(o.date, o.routineId);
      if (o.date < sinceISO || done) {
        kept.push(o);
        if (!done) lastPending[o.routineId] = maxISO(lastPending[o.routineId], o.date);
      }
    });

    var state = buildDayState(kept, byId);

    // Every routine's next-due occurrence competes for the same days, so placement is
    // interleaved round-robin by urgency (earliest cursor first) rather than letting one
    // routine claim its whole future chain before the next routine gets a turn — otherwise
    // a daily routine would monopolize the entire horizon and starve everything else.
    var queue = active.map(function (r) {
      var interval = Math.max(1, r.intervalDays || 1);
      var dueFromCompletion = earliestDueDate(r, todayISO);
      var pendingNext = lastPending[r.id] ? addDaysISO(lastPending[r.id], interval) : null;
      var initialCursor = clampToToday(maxISO(dueFromCompletion, pendingNext), todayISO);
      return { routine: r, interval: interval, cursor: initialCursor };
    });

    function byUrgency(a, b) {
      if (a.cursor !== b.cursor) return a.cursor < b.cursor ? -1 : 1;
      if (a.interval !== b.interval) return a.interval - b.interval;
      return String(a.routine.id).localeCompare(String(b.routine.id));
    }

    var placed = [];
    var unplaced = [];
    var guard = 0;
    while (queue.length && guard < 20000) {
      guard++;
      queue.sort(byUrgency);
      var entry = queue.shift();
      if (entry.cursor > horizonEndISO) continue;
      var slot = findEarliestSlot(state, entry.cursor, horizonEndISO, entry.routine);
      if (!slot) {
        unplaced.push({ routineId: entry.routine.id, afterDate: entry.cursor });
        continue;
      }
      placeOn(state, slot, entry.routine);
      placed.push({ date: slot, routineId: entry.routine.id });
      var nextCursor = addDaysISO(slot, entry.interval);
      if (nextCursor <= horizonEndISO) {
        queue.push({ routine: entry.routine, interval: entry.interval, cursor: nextCursor });
      }
    }

    var occurrences = kept.concat(placed).sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });

    return {
      occurrences: occurrences,
      kept: kept,
      placed: placed,
      unplaced: unplaced,
      horizon: { from: todayISO, through: horizonEndISO }
    };
  }

  // ---------- Day View helpers ----------
  function isWithinHorizon(dateISO, horizon) {
    if (!horizon || !horizon.from || !horizon.through) return false;
    return dateISO >= horizon.from && dateISO <= horizon.through;
  }

  // If the viewed day was "following today" (i.e. equal to what today was a moment ago),
  // it keeps following today across a midnight rollover. If the user had deliberately
  // navigated to some other specific day, that stays put.
  function advanceDayViewOnRollover(dayViewISO, prevTodayISO, newTodayISO) {
    if (newTodayISO === prevTodayISO) return dayViewISO;
    if (dayViewISO === prevTodayISO) return newTodayISO;
    return dayViewISO;
  }

  // Best-effort recompute of a routine's last completed date from whatever completion
  // entries happen to be loaded (used when un-checking the completion that was the current
  // anchor, so we don't strand it on a now-wrong date without scanning all history).
  function latestCompletionAmong(entries, routineId) {
    var max = null;
    (entries || []).forEach(function (e) {
      if (e.routineId === routineId && (!max || e.date > max)) max = e.date;
    });
    return max;
  }

  var RoutineScheduling = {
    MAX_ROUTINES_PER_DAY: MAX_ROUTINES_PER_DAY,
    MAX_DAILY_LOAD: MAX_DAILY_LOAD,
    DEFAULT_LOAD_LEVEL: DEFAULT_LOAD_LEVEL,
    DEFAULT_HORIZON_DAYS: DEFAULT_HORIZON_DAYS,
    addDaysISO: addDaysISO,
    diffDaysISO: diffDaysISO,
    maxISO: maxISO,
    clampToToday: clampToToday,
    normalizeLoadLevel: normalizeLoadLevel,
    earliestDueDate: earliestDueDate,
    buildDayState: buildDayState,
    canPlace: canPlace,
    placeOn: placeOn,
    findEarliestSlot: findEarliestSlot,
    generateReschedule: generateReschedule,
    isWithinHorizon: isWithinHorizon,
    advanceDayViewOnRollover: advanceDayViewOnRollover,
    latestCompletionAmong: latestCompletionAmong
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RoutineScheduling;
  } else {
    global.RoutineScheduling = RoutineScheduling;
  }
})(typeof window !== 'undefined' ? window : globalThis);
