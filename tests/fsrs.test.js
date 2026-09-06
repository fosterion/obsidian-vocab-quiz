'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { schedule, retrievability } = require('../src/fsrs');

const AT = new Date('2026-01-01T12:00:00');
const days = (state) => state.interval;

test('new card: initial stability comes from the FSRS weights', () => {
  // w[0..3] of the reference FSRS v4 weight set
  assert.equal(schedule(null, 1, 0.9, AT).stability, 0.4072);
  assert.equal(schedule(null, 2, 0.9, AT).stability, 1.1829);
  assert.equal(schedule(null, 3, 0.9, AT).stability, 3.1262);
  assert.equal(schedule(null, 4, 0.9, AT).stability, 15.4722);
});

test('new card: harder grades leave a higher difficulty', () => {
  const d = [1, 2, 3, 4].map((g) => schedule(null, g, 0.9, AT).difficulty);
  assert.ok(d[0] > d[1] && d[1] > d[2] && d[2] > d[3], `expected descending, got ${d}`);
  for (const value of d) assert.ok(value >= 1 && value <= 10, `difficulty out of range: ${value}`);
});

test('new card: interval grows with the grade', () => {
  assert.deepEqual([1, 2, 3, 4].map((g) => days(schedule(null, g, 0.9, AT))), [0, 1, 3, 15]);
});

test('repeated "good" answers grow stability monotonically', () => {
  let state = null;
  let previous = 0;
  for (let i = 0; i < 8; i++) {
    const at = state ? new Date(state.due) : AT;
    state = schedule(state, 3, 0.9, at);
    assert.ok(state.stability > previous, `stability shrank at rep ${i + 1}`);
    assert.equal(state.reps, i + 1);
    assert.equal(state.lapses, 0);
    previous = state.stability;
  }
  // reference FSRS v4 reaches roughly this scale after eight "good" reviews
  assert.ok(state.interval > 3000, `expected a multi-year interval, got ${state.interval}`);
});

test('"again" records a lapse, collapses the interval and reschedules today', () => {
  const mature = { due: '2026-01-01', stability: 100, difficulty: 5, interval: 100, reps: 9, lapses: 1 };
  const state = schedule(mature, 1, 0.9, AT);
  assert.equal(state.lapses, 2);
  assert.equal(state.reps, 10);
  assert.equal(state.interval, 0);
  assert.ok(state.stability < mature.stability, 'a lapse must lower stability');
  assert.equal(state.due.getTime(), AT.getTime());
});

test('difficulty stays clamped to 1..10 under repeated extremes', () => {
  let easy = null;
  let hard = null;
  for (let i = 0; i < 30; i++) {
    easy = schedule(easy, 4, 0.9, easy ? new Date(easy.due) : AT);
    hard = schedule(hard, 1, 0.9, hard ? new Date(hard.due) : AT);
  }
  assert.ok(easy.difficulty >= 1, `easy difficulty underflowed: ${easy.difficulty}`);
  assert.ok(hard.difficulty <= 10, `hard difficulty overflowed: ${hard.difficulty}`);
});

test('a higher retention target shortens the interval', () => {
  const state = { due: '2026-01-01', stability: 50, difficulty: 5, interval: 50, reps: 4, lapses: 0 };
  const relaxed = schedule(state, 3, 0.8, AT).interval;
  const strict = schedule(state, 3, 0.95, AT).interval;
  assert.ok(strict < relaxed, `expected ${strict} < ${relaxed}`);
});

test('state without stability or due is treated as a new card', () => {
  const fresh = schedule(null, 3, 0.9, AT);
  assert.deepEqual(schedule({ reps: 0, lapses: 0 }, 3, 0.9, AT).stability, fresh.stability);
  assert.deepEqual(schedule({ stability: 5 }, 3, 0.9, AT).stability, fresh.stability);
  assert.deepEqual(schedule({ due: '2026-01-01' }, 3, 0.9, AT).stability, fresh.stability);
});

test('reps and lapses carry over from the previous state', () => {
  const state = schedule(
    { due: '2026-01-01', stability: 10, difficulty: 5, interval: 10, reps: 7, lapses: 3 },
    3, 0.9, AT
  );
  assert.equal(state.reps, 8);
  assert.equal(state.lapses, 3);
});

test('retrievability falls from 1 as time passes and is 0 without stability', () => {
  assert.equal(retrievability(0, 10), 1);
  assert.ok(retrievability(5, 10) < 1);
  assert.ok(retrievability(50, 10) < retrievability(5, 10));
  assert.equal(retrievability(5, 0), 0);
});

test('due date is the review moment plus the interval', () => {
  const state = schedule(null, 3, 0.9, AT);
  assert.equal(state.due.getTime(), AT.getTime() + state.interval * 86400000);
});
