'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const deck = require('../src/deck');
const { makePlugin, stub } = require('./helpers/vault');

const { DIR_FORWARD, DIR_REVERSE } = deck;
const { Notice, Setting } = stub;
// a fresh object per test: saveState edits the frontmatter in place
const word = () => ({ 'vocab/a.md': { word: 'gato', translation: 'Katze' } });
const grade = (over = {}) =>
  Object.assign(
    { due: new Date('2026-12-11T00:00:00'), stability: 96.3, difficulty: 3.9, interval: 96, reps: 7, lapses: 0 },
    over
  );

test('onload registers the commands, the ribbon and the settings tab', async () => {
  const { plugin } = await makePlugin(word());
  assert.deepEqual(
    plugin.commands.map((c) => c.id).sort(),
    ['show-stats', 'start-review', 'start-review-choice', 'start-review-classic']
  );
  assert.equal(plugin.ribbons.length, 1);
  assert.equal(plugin.settingTabs.length, 1);
});

test('settings fall back to the defaults when nothing is stored', async () => {
  const { plugin } = await makePlugin(word());
  plugin.data = null;
  await plugin.onload();
  assert.deepEqual(plugin.settings.directions, [DIR_FORWARD, DIR_REVERSE]);
  assert.equal(plugin.settings.termField, 'word');
  assert.equal(plugin.settings.requestRetention, 0.9);
});

test('unknown or empty direction values fall back to both directions', async () => {
  for (const stored of [[], ['nonsense'], ['en-ru', 'ru-en']]) {
    const { plugin } = await makePlugin(word(), { directions: stored });
    assert.deepEqual(plugin.settings.directions, [DIR_FORWARD, DIR_REVERSE], `for ${JSON.stringify(stored)}`);
  }
});

test('a valid stored direction survives untouched', async () => {
  const { plugin } = await makePlugin(word(), { directions: [DIR_REVERSE] });
  assert.deepEqual(plugin.settings.directions, [DIR_REVERSE]);
});

test('saveState writes only the fields of the graded direction', async () => {
  const { plugin, app } = await makePlugin(word());
  await plugin.saveState('vocab/a.md', DIR_FORWARD, grade());
  const fm = app.notes['vocab/a.md'];
  assert.equal(fm.sr_fwd_due, '2026-12-11');
  assert.equal(fm.sr_fwd_interval, 96);
  assert.equal(fm.sr_fwd_reps, 7);
  assert.equal(fm.sr_rev_due, undefined, 'the other direction must be untouched');
});

test('grading one direction does not overwrite the other', async () => {
  const { plugin, app } = await makePlugin(word());
  await plugin.saveState('vocab/a.md', DIR_FORWARD, grade());
  await plugin.saveState('vocab/a.md', DIR_REVERSE, grade({
    due: new Date('2026-09-08T00:00:00'), stability: 4.8, interval: 0, reps: 7, lapses: 1,
  }));
  const fm = app.notes['vocab/a.md'];
  assert.equal(fm.sr_fwd_interval, 96, 'the easy answer must survive the lapse on the other side');
  assert.equal(fm.sr_rev_interval, 0);
  assert.equal(fm.sr_rev_lapses, 1);
  assert.equal(fm.sr_fwd_lapses, 0);
});

test('stray slashes and blanks are stripped from stored folders', async () => {
  const { plugin } = await makePlugin(word(), { folders: ['/vocab/', ' other ', '', '//deep//nested//'] });
  assert.deepEqual(plugin.settings.folders, ['vocab', 'other', 'deep/nested']);
});

test('a folder typed with a leading slash still collects notes', async () => {
  const { plugin, app } = await makePlugin({ 'vocab/a.md': { word: 'gato', translation: 'Katze' } }, { folders: ['/vocab'] });
  assert.equal(deck.collect(app, plugin.settings).length, 1);
});

test('editing the folders setting normalises what was typed', async () => {
  const { plugin } = await makePlugin(word());
  plugin.settingTabs[0].display();
  await Setting.byName('Folders').components[0].set('/words/, //phrases// , ');
  assert.deepEqual(plugin.settings.folders, ['words', 'phrases']);
});

test('settings sections use the Obsidian heading helper', async () => {
  const { plugin } = await makePlugin(word());
  plugin.settingTabs[0].display();
  const headings = Setting.created.filter((s) => s.heading).map((s) => s.name);
  assert.deepEqual(headings, ['Card source', 'Mode', 'Scheduling']);
});

test('saveState ignores a path that is a folder, not a note', async () => {
  const { plugin, app } = await makePlugin(word());
  await plugin.saveState('vocab', DIR_FORWARD, grade());
  assert.deepEqual(app.writes, []);
});

test('saveState is a no-op for a path that is not in the vault', async () => {
  const { plugin, app } = await makePlugin(word());
  await plugin.saveState('vocab/missing.md', DIR_FORWARD, grade());
  assert.deepEqual(app.writes, []);
});

test('autoPromote marks a word known only once every direction has matured', async () => {
  const notes = { 'vocab/a.md': { word: 'gato', translation: 'Katze', status: 'learning' } };
  const { plugin, app } = await makePlugin(notes);
  await plugin.saveState('vocab/a.md', DIR_FORWARD, grade({ interval: 30 }));
  assert.equal(app.notes['vocab/a.md'].status, 'learning', 'one mature direction is not enough');
  await plugin.saveState('vocab/a.md', DIR_REVERSE, grade({ interval: 25 }));
  assert.equal(app.notes['vocab/a.md'].status, 'known');
});

test('the default status filter does not fight autoPromote', async () => {
  const { plugin } = await makePlugin(word());
  plugin.data = null;
  await plugin.onload();
  assert.ok(
    plugin.settings.statusFilter.includes('known'),
    'promoting to known must not drop the word out of the default filter'
  );
});

test('autoPromote labels a note that had no status at all', async () => {
  const notes = { 'vocab/a.md': { word: 'gato', translation: 'Katze' } };
  const { plugin, app } = await makePlugin(notes);
  await plugin.saveState('vocab/a.md', DIR_FORWARD, grade({ interval: 3, reps: 1 }));
  assert.equal(app.notes['vocab/a.md'].status, 'learning');
});

test('autoPromote moves a new word to learning after the first answer', async () => {
  const notes = { 'vocab/a.md': { word: 'gato', translation: 'Katze', status: 'new' } };
  const { plugin, app } = await makePlugin(notes);
  await plugin.saveState('vocab/a.md', DIR_FORWARD, grade({ interval: 3, reps: 1 }));
  assert.equal(app.notes['vocab/a.md'].status, 'learning');
});

test('autoPromote considers only the directions in use', async () => {
  const notes = { 'vocab/a.md': { word: 'gato', translation: 'Katze', status: 'learning' } };
  const { plugin, app } = await makePlugin(notes, { directions: [DIR_FORWARD] });
  await plugin.saveState('vocab/a.md', DIR_FORWARD, grade({ interval: 30 }));
  assert.equal(app.notes['vocab/a.md'].status, 'known');
});

test('autoPromote off leaves the status alone', async () => {
  const notes = { 'vocab/a.md': { word: 'gato', translation: 'Katze', status: 'new' } };
  const { plugin, app } = await makePlugin(notes, { autoPromote: false });
  await plugin.saveState('vocab/a.md', DIR_FORWARD, grade({ interval: 30 }));
  assert.equal(app.notes['vocab/a.md'].status, 'new');
});

test('statistics count cards per direction, not notes', async () => {
  const notes = {
    'vocab/new.md': { word: 'a', translation: 'b' },
    'vocab/due.md': { word: 'c', translation: 'd', sr_fwd_due: '2020-01-01', sr_fwd_stability: 5, sr_rev_due: '2020-01-01', sr_rev_stability: 5 },
    'vocab/later.md': { word: 'e', translation: 'f', sr_fwd_due: '2999-01-01', sr_fwd_stability: 5, sr_rev_due: '2999-01-01', sr_rev_stability: 5 },
  };
  const { plugin } = await makePlugin(notes);
  plugin.showStats();
  assert.match(Notice.last, /Notes: 3/);
  assert.match(Notice.last, /New: 2/);
  assert.match(Notice.last, /Due: 2/);
  assert.match(Notice.last, /Later: 2/);
});

test('startReview warns when the folders hold no cards', async () => {
  const { plugin } = await makePlugin({ 'other/a.md': { word: 'a', translation: 'b' } });
  plugin.startReview();
  assert.match(Notice.last, /No cards found/);
  assert.equal(stub.Modal.instances.length, 0);
});

test('startReview warns when everything is already reviewed', async () => {
  const notes = {
    'vocab/a.md': { word: 'a', translation: 'b', sr_fwd_due: '2999-01-01', sr_fwd_stability: 5, sr_rev_due: '2999-01-01', sr_rev_stability: 5 },
  };
  const { plugin } = await makePlugin(notes, { newPerDay: 0 });
  plugin.startReview();
  assert.match(Notice.last, /Everything is reviewed/);
});

test('startReview opens a review modal when cards are waiting', async () => {
  const { plugin } = await makePlugin(word());
  plugin.startReview();
  assert.equal(stub.Modal.last.isOpen, true);
});

test('the review commands force their own mode', async () => {
  const { plugin } = await makePlugin(word());
  plugin.command('start-review-classic').callback();
  assert.equal(stub.Modal.last.mode, 'classic');
  plugin.command('start-review-choice').callback();
  assert.equal(stub.Modal.last.mode, 'choice');
});

test('the settings tab renders every control', async () => {
  const { plugin } = await makePlugin(word());
  plugin.settingTabs[0].display();
  for (const name of [
    'Folders', 'Term field', 'Translation field', 'Transcription field', 'Statuses to review',
    'Default mode', 'Answer options', 'Term side label', 'Translation side label', 'Directions',
    'New cards per day', 'Maximum per session', 'Target retention', 'Update status automatically',
  ]) {
    assert.ok(Setting.byName(name), `missing setting: ${name}`);
  }
});

test('editing a setting persists it', async () => {
  const { plugin } = await makePlugin(word());
  plugin.settingTabs[0].display();
  await Setting.byName('Folders').components[0].set(' words , phrases ');
  assert.deepEqual(plugin.settings.folders, ['words', 'phrases']);
  await Setting.byName('Statuses to review').components[0].set('new, learning');
  assert.deepEqual(plugin.settings.statusFilter, ['new', 'learning']);
  assert.deepEqual(plugin.data.folders, ['words', 'phrases'], 'settings must reach storage');
});

test('a blank required field falls back to its default', async () => {
  const { plugin } = await makePlugin(word());
  plugin.settingTabs[0].display();
  await Setting.byName('Term field').components[0].set('   ');
  assert.equal(plugin.settings.termField, 'word');
});

test('the directions dropdown maps "both" onto the two directions', async () => {
  const { plugin } = await makePlugin(word());
  plugin.settingTabs[0].display();
  const dropdown = Setting.byName('Directions').components[0];
  await dropdown.set(DIR_REVERSE);
  assert.deepEqual(plugin.settings.directions, [DIR_REVERSE]);
  await dropdown.set('both');
  assert.deepEqual(plugin.settings.directions, [DIR_FORWARD, DIR_REVERSE]);
});

test('direction labels default to neutral wording', async () => {
  const { plugin } = await makePlugin(word());
  plugin.settingTabs[0].display();
  const labels = Setting.byName('Directions').components[0].options.map((o) => o.label);
  assert.deepEqual(labels, ['Both directions', 'Term → Translation only', 'Translation → Term only']);
});

test('direction labels follow the configured language pair', async () => {
  const { plugin } = await makePlugin(word(), { termLabel: 'ES', translationLabel: 'DE' });
  plugin.settingTabs[0].display();
  const labels = Setting.byName('Directions').components[0].options.map((o) => o.label);
  assert.deepEqual(labels, ['Both directions', 'ES → DE only', 'DE → ES only']);
});

test('a label set on one side only keeps the neutral word on the other', async () => {
  const { plugin } = await makePlugin(word(), { termLabel: 'ES', translationLabel: '  ' });
  plugin.settingTabs[0].display();
  const labels = Setting.byName('Directions').components[0].options.map((o) => o.label);
  assert.deepEqual(labels, ['Both directions', 'ES → Translation only', 'Translation → ES only']);
});
