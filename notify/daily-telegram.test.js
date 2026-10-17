// Plain-Node tests — run with: node notify/daily-telegram.test.js
'use strict';
const assert = require('assert');
const N = require('./daily-telegram.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.log('  FAIL - ' + name + '\n    ' + (e && e.stack || e)); }
}

const R = [
  { id: 'a', name: 'כיריים', intervalDays: 7, startDate: '2026-10-01', active: true },
  { id: 'b', name: 'מקרר', intervalDays: 14, startDate: '2026-10-02', active: true },
  { id: 'c', name: 'מושבתת', intervalDays: 7, startDate: '2026-10-01', active: false },
];
const base = (over) => Object.assign({ routines: R, horizon: { from: '2026-10-10', through: '2026-11-08' },
  scheduleFlat: {}, overridesFlat: {}, blockedFlat: {}, completionsFlat: {} }, over || {});
const names = (items) => items.map(o => o.routine.name);

test('decodeFields handles string/bool/int/map', () => {
  const out = N.decodeFields({ s: { stringValue: 'x' }, b: { booleanValue: true }, i: { integerValue: '7' },
    m: { mapValue: { fields: { done: { booleanValue: true } } } } });
  assert.deepStrictEqual(out, { s: 'x', b: true, i: 7, m: { done: true } });
});

test('inside horizon: uses persisted schedule, ignores inactive/unknown routines and other days', () => {
  const d = base({ scheduleFlat: { '2026-10-17_a': true, '2026-10-17_c': true, '2026-10-17_zzz': true, '2026-10-18_b': true } });
  assert.deepStrictEqual(names(N.resolveTodayRoutines(d, '2026-10-17')), ['כיריים']);
});

test('done flag comes from completions (object or true)', () => {
  const d = base({ scheduleFlat: { '2026-10-17_a': true, '2026-10-17_b': true }, completionsFlat: { '2026-10-17_a': { done: true } } });
  const items = N.resolveTodayRoutines(d, '2026-10-17');
  assert.deepStrictEqual(items.map(o => [o.routine.id, o.done]).sort(), [['a', true], ['b', false]]);
});

test('blocked day hides pending but keeps completed', () => {
  const d = base({ scheduleFlat: { '2026-10-17_a': true, '2026-10-17_b': true }, blockedFlat: { '2026-10-17': true },
    completionsFlat: { '2026-10-17_b': true } });
  assert.deepStrictEqual(names(N.resolveTodayRoutines(d, '2026-10-17')), ['מקרר']);
});

test('outside horizon: legacy interval schedule (7-day routine from 2026-10-01 hits 11-12)', () => {
  const d = base({ horizon: { from: '2026-09-01', through: '2026-09-30' } });
  const hits = [];
  for (let day = 9; day <= 15; day++) {
    const iso = '2026-11-' + String(day).padStart(2, '0');
    if (names(N.resolveTodayRoutines(d, iso)).includes('כיריים')) hits.push(iso);
  }
  assert.ok(hits.length === 1, 'exactly one occurrence expected in a 7-day window, got ' + hits.join(','));
  assert.ok(!names(N.resolveTodayRoutines(d, hits[0])).includes('מושבתת'));
});

test('outside horizon: an override moves the occurrence to its new date and off the old one', () => {
  const d0 = base({ horizon: null });
  let natural = null;
  for (let day = 1; day <= 30 && !natural; day++) {
    const iso = '2026-11-' + String(day).padStart(2, '0');
    if (names(N.resolveTodayRoutines(d0, iso)).includes('כיריים')) natural = iso;
  }
  assert.ok(natural);
  const moved = natural === '2026-11-30' ? '2026-11-29' : '2026-11-30';
  const d1 = base({ horizon: null, overridesFlat: { [natural + '_a']: moved } });
  assert.ok(!names(N.resolveTodayRoutines(d1, natural)).includes('כיריים'));
  assert.ok(names(N.resolveTodayRoutines(d1, moved)).includes('כיריים'));
});

test('buildMessage: pending list, done count footer, all-done, empty', () => {
  const mk = (n, done) => ({ routine: { name: n }, done });
  assert.strictEqual(N.buildMessage('2026-10-17', []), null);
  const t1 = N.buildMessage('2026-10-17', [mk('א', false), mk('ב', true)]);
  assert.ok(t1.startsWith('🏠 שגרות להיום – יום שבת, 17.10'));
  assert.ok(t1.includes('⬜ א') && !t1.includes('⬜ ב') && t1.includes('✅ 1 כבר בוצעו'));
  assert.ok(N.buildMessage('2026-10-17', [mk('ב', true)]).includes('כל שגרות היום כבר בוצעו'));
});

test('formatHeader weekday: 2026-10-17 is Saturday, 2026-10-18 is Sunday', () => {
  assert.ok(N.formatHeader('2026-10-17').startsWith('יום שבת'));
  assert.ok(N.formatHeader('2026-10-18').startsWith('יום ראשון'));
});

test('israelNow: 20:00 local in summer (UTC+3) and winter (UTC+2)', () => {
  assert.deepStrictEqual(N.israelNow(new Date('2026-07-15T17:00:00Z')), { dateISO: '2026-07-15', hour: 20 });
  assert.deepStrictEqual(N.israelNow(new Date('2026-12-15T18:00:00Z')), { dateISO: '2026-12-15', hour: 20 });
  assert.strictEqual(N.israelNow(new Date('2026-12-15T17:00:00Z')).hour, 19);
  assert.strictEqual(N.israelNow(new Date('2026-07-15T18:00:00Z')).hour, 21);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
