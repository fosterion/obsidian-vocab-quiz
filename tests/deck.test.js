'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const deck = require('../src/deck');
const { makeApp, BASE_SETTINGS } = require('./helpers/vault');

const { DIR_FORWARD, DIR_REVERSE } = deck;
const NOW = new Date('2026-09-06T12:00:00');
const settings = (over = {}) => Object.assign({}, BASE_SETTINGS, over);

const state = (due, over = {}) =>
  Object.assign({ due, stability: 5, difficulty: 5, interval: 5, reps: 3, lapses: 0 }, over);

/** An entry as collect() would produce it, without going through a vault. */
const entry = (path, fwd = null, rev = null) => ({
  path,
  term: path,
  translation: 't-' + path,
  transcription: '',
  status: '',
  level: '',
  sr: { [DIR_FORWARD]: fwd, [DIR_REVERSE]: rev },
});

test('collect: a note needs both a term and a translation', () => {
  const app = makeApp({
    'vocab/ok.md': { word: 'gato', translation: 'Katze' },
    'vocab/no-translation.md': { word: 'perro' },
    'vocab/no-frontmatter.md': null,
  });
  const paths = deck.collect(app, settings()).map((e) => e.path);
  assert.deepEqual(paths, ['vocab/ok.md']);
});

test('collect: the term falls back to the file name', () => {
  const app = makeApp({ 'vocab/casa.md': { translation: 'Haus' } });
  assert.equal(deck.collect(app, settings())[0].term, 'casa');
});

test('collect: only notes inside the configured folders', () => {
  const app = makeApp({
    'vocab/in.md': { word: 'a', translation: 'b' },
    'vocab/deep/nested.md': { word: 'c', translation: 'd' },
    'other/out.md': { word: 'e', translation: 'f' },
  });
  const paths = deck.collect(app, settings()).map((e) => e.path).sort();
  assert.deepEqual(paths, ['vocab/deep/nested.md', 'vocab/in.md']);
});

test('collect: a trailing slash on the folder is accepted', () => {
  const app = makeApp({ 'vocab/in.md': { word: 'a', translation: 'b' } });
  assert.equal(deck.collect(app, settings({ folders: ['vocab/'] })).length, 1);
});

test('collect: a folder prefix does not leak into a sibling folder', () => {
  const app = makeApp({ 'vocabulary/x.md': { word: 'a', translation: 'b' } });
  assert.equal(deck.collect(app, settings({ folders: ['vocab'] })).length, 0);
});

test('collect: statusFilter keeps only the listed statuses', () => {
  const app = makeApp({
    'vocab/new.md': { word: 'a', translation: 'b', status: 'new' },
    'vocab/learning.md': { word: 'c', translation: 'd', status: 'learning' },
    'vocab/known.md': { word: 'e', translation: 'f', status: 'known' },
  });
  const paths = deck.collect(app, settings({ statusFilter: ['new', 'learning'] })).map((e) => e.path);
  assert.deepEqual(paths, ['vocab/new.md', 'vocab/learning.md']);
});

test('collect: a note with no status counts as new', () => {
  const app = makeApp({
    'vocab/blank.md': { word: 'a', translation: 'b' },
    'vocab/marked.md': { word: 'c', translation: 'd', status: 'learning' },
  });
  const collected = deck.collect(app, settings({ statusFilter: ['new', 'learning'] }));
  assert.deepEqual(collected.map((e) => e.path).sort(), ['vocab/blank.md', 'vocab/marked.md']);
  assert.equal(collected.find((e) => e.path === 'vocab/blank.md').status, 'new');
});

test('collect: a status outside the filter is excluded on purpose', () => {
  const app = makeApp({
    'vocab/suspended.md': { word: 'a', translation: 'b', status: 'suspended' },
    'vocab/new.md': { word: 'c', translation: 'd', status: 'new' },
  });
  const collected = deck.collect(app, settings({ statusFilter: ['new', 'learning', 'known'] }));
  assert.deepEqual(collected.map((e) => e.path), ['vocab/new.md']);
});

test('collect: the default filter keeps a promoted word in rotation', () => {
  const app = makeApp({
    'vocab/known.md': {
      word: 'a', translation: 'b', status: 'known',
      sr_fwd_due: '2020-01-01', sr_fwd_stability: 30, sr_fwd_interval: 30,
    },
  });
  assert.equal(deck.collect(app, settings()).length, 1, 'autoPromote must not delete a word from review');
});

test('statusOf normalises a missing or blank status', () => {
  assert.equal(deck.statusOf({}), 'new');
  assert.equal(deck.statusOf({ status: '  ' }), 'new');
  assert.equal(deck.statusOf({ status: ' learning ' }), 'learning');
});

test('collect: an empty statusFilter keeps every note', () => {
  const app = makeApp({
    'vocab/a.md': { word: 'a', translation: 'b', status: 'known' },
    'vocab/b.md': { word: 'c', translation: 'd' },
  });
  assert.equal(deck.collect(app, settings({ statusFilter: [] })).length, 2);
});

test('statePrefix separates the two directions', () => {
  assert.equal(deck.statePrefix(settings(), DIR_FORWARD), 'sr_fwd_');
  assert.equal(deck.statePrefix(settings(), DIR_REVERSE), 'sr_rev_');
  assert.equal(deck.statePrefix(settings({ fieldPrefix: 'x_' }), DIR_FORWARD), 'x_fwd_');
});

test('each direction reads its own scheduling fields', () => {
  const app = makeApp({
    'vocab/a.md': {
      word: 'gato', translation: 'Katze',
      sr_fwd_due: '2026-09-01', sr_fwd_stability: 20, sr_fwd_interval: 20, sr_fwd_reps: 4,
      sr_rev_due: '2026-10-01', sr_rev_stability: 3, sr_rev_interval: 3, sr_rev_reps: 1,
    },
  });
  const e = deck.collect(app, settings())[0];
  assert.equal(e.sr[DIR_FORWARD].interval, 20);
  assert.equal(e.sr[DIR_REVERSE].interval, 3);
  assert.equal(e.sr[DIR_FORWARD].due, '2026-09-01');
  assert.equal(e.sr[DIR_REVERSE].due, '2026-10-01');
});

test('both directions seed from the shared fields when they have no state yet', () => {
  const app = makeApp({
    'vocab/a.md': {
      word: 'gato', translation: 'Katze',
      sr_due: '2026-09-20', sr_stability: 96.3273, sr_difficulty: 3.9196,
      sr_interval: 96, sr_reps: 6, sr_lapses: 0,
    },
  });
  const e = deck.collect(app, settings())[0];
  assert.equal(e.sr[DIR_FORWARD].interval, 96);
  assert.equal(e.sr[DIR_REVERSE].interval, 96);
  assert.notEqual(e.sr[DIR_FORWARD], e.sr[DIR_REVERSE], 'directions must not share one object');
});

test('a direction that already has state ignores the shared fields', () => {
  const app = makeApp({
    'vocab/a.md': {
      word: 'gato', translation: 'Katze',
      sr_due: '2026-09-20', sr_interval: 96, sr_stability: 96,
      sr_fwd_due: '2026-12-11', sr_fwd_interval: 200, sr_fwd_stability: 200,
    },
  });
  const e = deck.collect(app, settings())[0];
  assert.equal(e.sr[DIR_FORWARD].interval, 200);
  assert.equal(e.sr[DIR_REVERSE].interval, 96, 'the untouched direction still seeds');
});

test('a note with no scheduling fields at all has null state', () => {
  const app = makeApp({ 'vocab/a.md': { word: 'gato', translation: 'Katze' } });
  const e = deck.collect(app, settings())[0];
  assert.equal(e.sr[DIR_FORWARD], null);
  assert.equal(e.sr[DIR_REVERSE], null);
});

test('isDue is decided per direction', () => {
  const e = entry('a', state('2026-09-01'), state('2026-12-01'));
  assert.equal(deck.isDue({ entry: e, direction: DIR_FORWARD }, NOW), true);
  assert.equal(deck.isDue({ entry: e, direction: DIR_REVERSE }, NOW), false);
  assert.equal(deck.isDue({ entry: entry('b'), direction: DIR_FORWARD }, NOW), true, 'new cards are due');
});

test('buildQueue expands a note into one card per enabled direction', () => {
  const q = deck.buildQueue([entry('a')], settings(), NOW);
  assert.equal(q.length, 2);
  assert.deepEqual(q.map((c) => c.direction).sort(), [DIR_FORWARD, DIR_REVERSE]);
});

test('buildQueue honours a single enabled direction', () => {
  const q = deck.buildQueue([entry('a')], settings({ directions: [DIR_FORWARD] }), NOW);
  assert.deepEqual(q.map((c) => c.direction), [DIR_FORWARD]);
});

test('buildQueue leaves out cards that are not due yet', () => {
  const q = deck.buildQueue([entry('a', state('2026-12-01'), state('2026-12-01'))], settings(), NOW);
  assert.equal(q.length, 0);
});

test('buildQueue spends the session limit on the most overdue cards first', () => {
  const entries = [];
  for (let i = 0; i < 100; i++) {
    const due = `2026-0${(i % 8) + 1}-0${(i % 9) + 1}`;
    entries.push(entry(`due-${i}`, state(due), state(due)));
  }
  for (let i = 0; i < 50; i++) entries.push(entry(`new-${i}`));

  const queue = deck.buildQueue(entries, settings({ maxPerSession: 40, newPerDay: 10 }), NOW);
  assert.equal(queue.length, 40);
  assert.ok(
    queue.every((c) => c.entry.sr[c.direction]),
    'new cards must not displace a backlog of due cards'
  );

  const oldest = entries
    .flatMap((e) => [DIR_FORWARD, DIR_REVERSE].map((d) => ({ e, d })))
    .filter(({ e, d }) => e.sr[d])
    .sort((a, b) => new Date(a.e.sr[a.d].due) - new Date(b.e.sr[b.d].due))
    .slice(0, 40)
    .map(({ e, d }) => `${e.path}|${d}`);
  const picked = queue.map((c) => `${c.entry.path}|${c.direction}`).sort();
  assert.deepEqual(picked, oldest.sort());
});

test('buildQueue fills leftover room with new cards, capped by newPerDay', () => {
  const entries = [];
  for (let i = 0; i < 5; i++) entries.push(entry(`due-${i}`, state('2026-08-01'), state('2026-08-01')));
  for (let i = 0; i < 50; i++) entries.push(entry(`new-${i}`));

  const queue = deck.buildQueue(entries, settings({ maxPerSession: 40, newPerDay: 10 }), NOW);
  const fresh = queue.filter((c) => !c.entry.sr[c.direction]);
  assert.equal(queue.length - fresh.length, 10, 'all due cards are kept');
  assert.equal(fresh.length, 10, 'new cards are capped by newPerDay');
});

test('buildQueue with newPerDay 0 shows no new cards', () => {
  const queue = deck.buildQueue([entry('a')], settings({ newPerDay: 0 }), NOW);
  assert.equal(queue.length, 0);
});

test('buildQueue treats maxPerSession 0 as no limit', () => {
  const entries = Array.from({ length: 30 }, (_, i) => entry(`due-${i}`, state('2026-08-01'), state('2026-08-01')));
  const queue = deck.buildQueue(entries, settings({ maxPerSession: 0, newPerDay: 0 }), NOW);
  assert.equal(queue.length, 60);
});

test('buildQueue on an empty vault returns nothing', () => {
  assert.deepEqual(deck.buildQueue([], settings(), NOW), []);
});

test('buildChoices returns the requested number of options including the answer', () => {
  const pool = Array.from({ length: 10 }, (_, i) => entry(`w${i}`));
  const card = { entry: pool[0], direction: DIR_FORWARD };
  const choices = deck.buildChoices(card, pool, 4);
  assert.equal(choices.length, 4);
  assert.ok(choices.includes(deck.answerOf(card)));
  assert.equal(new Set(choices).size, 4, 'options must be distinct');
});

test('buildChoices never offers the card own note as a distractor twice', () => {
  const pool = Array.from({ length: 5 }, (_, i) => entry(`w${i}`));
  const card = { entry: pool[0], direction: DIR_FORWARD };
  const choices = deck.buildChoices(card, pool, 5);
  const answer = deck.answerOf(card);
  assert.equal(choices.filter((c) => c === answer).length, 1);
});

test('buildChoices degrades gracefully when the pool is too small', () => {
  const pool = [entry('only')];
  const card = { entry: pool[0], direction: DIR_FORWARD };
  assert.deepEqual(deck.buildChoices(card, pool, 4), [deck.answerOf(card)]);
});

test('buildChoices draws from the side being asked', () => {
  const pool = [entry('a'), entry('b'), entry('c')];
  const reverse = deck.buildChoices({ entry: pool[0], direction: DIR_REVERSE }, pool, 3);
  assert.ok(reverse.every((choice) => pool.some((e) => e.term === choice)));
  const forward = deck.buildChoices({ entry: pool[0], direction: DIR_FORWARD }, pool, 3);
  assert.ok(forward.every((choice) => pool.some((e) => e.translation === choice)));
});

test('promptOf and answerOf mirror each other across directions', () => {
  const e = entry('gato');
  const fwd = { entry: e, direction: DIR_FORWARD };
  const rev = { entry: e, direction: DIR_REVERSE };
  assert.equal(deck.promptOf(fwd), e.term);
  assert.equal(deck.answerOf(fwd), e.translation);
  assert.equal(deck.promptOf(rev), e.translation);
  assert.equal(deck.answerOf(rev), e.term);
});

test('shuffle keeps every element exactly once', () => {
  const source = Array.from({ length: 50 }, (_, i) => i);
  const shuffled = deck.shuffle(source.slice());
  assert.deepEqual(shuffled.slice().sort((a, b) => a - b), source);
});
