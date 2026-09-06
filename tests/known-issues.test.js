'use strict';

/**
 * Findings from the audit that are not fixed yet. Each test states the wanted
 * behaviour and is marked `todo`, so the suite stays green while the gap is on
 * record; drop the flag once the fix lands.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const deck = require('../src/deck');
const { makePlugin, makeApp, BASE_SETTINGS } = require('./helpers/vault');

const { DIR_FORWARD } = deck;
const settings = (over = {}) => Object.assign({}, BASE_SETTINGS, over);

test('a distractor must never be a valid answer for the prompt', { todo: true }, () => {
  const entry = (path, term, translation) => ({
    path, term, translation, transcription: '', status: '', level: '',
    sr: { [DIR_FORWARD]: null, [DIR_REVERSE]: null },
  });
  const pool = [
    entry('a.md', 'begin', 'to start'),
    entry('b.md', 'start', 'to start'),
    entry('c.md', 'stop', 'to halt'),
  ];
  const card = { entry: pool[0], direction: DIR_REVERSE };
  const choices = deck.buildChoices(card, pool, 3);
  const valid = pool.filter((e) => e.translation === card.entry.translation).map((e) => e.term);
  const wrong = choices.filter((c) => c !== deck.answerOf(card));
  assert.deepEqual(
    wrong.filter((c) => valid.includes(c)),
    [],
    'a synonym scored as wrong punishes a correct answer'
  );
});

test('a list-valued translation should not collapse into one string', { todo: true }, () => {
  const app = makeApp({ 'vocab/a.md': { word: 'egg', translation: ['egg', 'ovum'] } });
  const entry = deck.collect(app, settings())[0];
  assert.notEqual(entry.translation, 'egg,ovum', 'a YAML list becomes a comma-joined answer');
});

test('due dates should be compared in local time', { todo: true }, () => {
  const now = new Date();
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 30);
  const card = {
    direction: DIR_FORWARD,
    entry: { sr: { [DIR_FORWARD]: { due: local, stability: 5, interval: 5, reps: 1, lapses: 0 } } },
  };
  assert.equal(deck.isDue(card, midnight), true, 'a card due today is not due until the UTC offset passes');
});

test('directions stored as a bare string should be normalised to an array', { todo: true }, async () => {
  const { plugin } = await makePlugin({ 'vocab/a.md': { word: 'a', translation: 'b' } }, { directions: DIR_FORWARD });
  assert.ok(Array.isArray(plugin.settings.directions));
});
