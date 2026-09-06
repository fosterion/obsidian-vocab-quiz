'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const deck = require('../src/deck');
const { makePlugin, stub } = require('./helpers/vault');

const { DIR_FORWARD, DIR_REVERSE } = deck;
const { Modal } = stub;

/** Opens a review over the given notes and hands back the modal and its content. */
async function review(notes, overrides = {}) {
  const { plugin, app } = await makePlugin(notes, overrides);
  plugin.startReview();
  const modal = Modal.last;
  return { plugin, app, modal, el: () => modal.contentEl };
}

const single = () => ({ 'vocab/a.md': { word: 'gato', translation: 'Katze', transcription: '[ˈgato]' } });

test('a card shows the counter, the direction and the prompt', async () => {
  const { modal, el } = await review(single(), { directions: [DIR_FORWARD], termLabel: 'ES', translationLabel: 'DE' });
  assert.equal(el().first('vq-counter').textContent, '1 / 1');
  assert.equal(el().first('vq-direction').textContent, 'ES → DE');
  assert.equal(el().first('vq-prompt').textContent, 'gato');
  assert.equal(modal.modalEl.hasClass('vocab-quiz-modal'), true);
});

test('the transcription is shown with the term but hidden when the term is the answer', async () => {
  const forward = await review(single(), { directions: [DIR_FORWARD] });
  assert.equal(forward.el().first('vq-transcription').textContent, '[ˈgato]');

  const reverse = await review(single(), { directions: [DIR_REVERSE] });
  assert.equal(reverse.el().first('vq-transcription'), null, 'the transcription would give the answer away');
  assert.equal(reverse.el().first('vq-prompt').textContent, 'Katze');
});

test('choice mode offers buttons and grades appear only after answering', async () => {
  const notes = {
    'vocab/a.md': { word: 'gato', translation: 'Katze' },
    'vocab/b.md': { word: 'perro', translation: 'Hund' },
    'vocab/c.md': { word: 'casa', translation: 'Haus' },
  };
  const { el } = await review(notes, { directions: [DIR_FORWARD], choiceCount: 3, maxPerSession: 10 });
  assert.equal(el().all('vq-choice').length, 3);
  assert.equal(el().first('vq-grades'), null, 'grades must wait for an answer');

  const correct = el().all('vq-choice').find((b) => b.textContent === 'Katze') || el().all('vq-choice')[0];
  correct.click();
  assert.equal(el().all('vq-grade').length, 4);
});

test('answering marks the right option and disables the rest', async () => {
  const notes = {
    'vocab/a.md': { word: 'gato', translation: 'Katze' },
    'vocab/b.md': { word: 'perro', translation: 'Hund' },
  };
  const { el } = await review(notes, { directions: [DIR_FORWARD], choiceCount: 2, maxPerSession: 1 });
  const buttons = el().all('vq-choice');
  const answer = el().first('vq-prompt').textContent === 'gato' ? 'Katze' : 'Hund';
  const wrong = buttons.find((b) => b.textContent !== answer);
  wrong.click();

  assert.equal(wrong.hasClass('vq-wrong'), true);
  assert.equal(buttons.find((b) => b.textContent === answer).hasClass('vq-right'), true);
  assert.ok(buttons.every((b) => b.disabled), 'every option must be locked after answering');
});

test('a second click on a locked option changes nothing', async () => {
  const notes = {
    'vocab/a.md': { word: 'gato', translation: 'Katze' },
    'vocab/b.md': { word: 'perro', translation: 'Hund' },
  };
  const { el, modal } = await review(notes, { directions: [DIR_FORWARD], choiceCount: 2, maxPerSession: 1 });
  const button = el().all('vq-choice')[0];
  button.click();
  const answered = modal.answered;
  button.click();
  assert.equal(modal.answered, answered);
});

test('classic mode reveals the answer behind a button', async () => {
  const { el } = await review(single(), { mode: 'classic', directions: [DIR_FORWARD] });
  assert.equal(el().first('vq-answer'), null);
  const reveal = el().first('vq-reveal');
  assert.equal(reveal.textContent, 'Show answer');
  reveal.click();
  assert.equal(el().first('vq-answer').textContent, 'Katze');
  assert.equal(el().first('vq-reveal'), null, 'the reveal button is consumed');
  assert.equal(el().all('vq-grade').length, 4);
});

test('grading writes the state of that direction and moves on', async () => {
  const notes = {
    'vocab/a.md': { word: 'gato', translation: 'Katze' },
    'vocab/b.md': { word: 'perro', translation: 'Hund' },
  };
  const { el, app, modal } = await review(notes, { mode: 'classic', directions: [DIR_FORWARD], maxPerSession: 2 });
  const first = el().first('vq-prompt').textContent;
  el().first('vq-reveal').click();
  await el().all('vq-grade')[2].click(); // "Good"

  const path = first === 'gato' ? 'vocab/a.md' : 'vocab/b.md';
  assert.equal(app.notes[path].sr_fwd_reps, 1);
  assert.equal(app.notes[path].sr_rev_reps, undefined);
  assert.equal(modal.index, 1);
  assert.notEqual(el().first('vq-prompt').textContent, first, 'the next card must be shown');
});

test('"Again" puts the card back into the same session', async () => {
  const { el, modal } = await review(single(), { mode: 'classic', directions: [DIR_FORWARD] });
  el().first('vq-reveal').click();
  await el().all('vq-grade')[0].click(); // "Again"
  assert.equal(modal.queue.length, 1);
  assert.equal(el().first('vq-prompt').textContent, 'gato', 'the card comes back');
});

test('a second grade click cannot skip the next card', async () => {
  const notes = {
    'vocab/a.md': { word: 'gato', translation: 'Katze' },
    'vocab/b.md': { word: 'perro', translation: 'Hund' },
  };
  const { el, modal, app } = await review(notes, { mode: 'classic', directions: [DIR_FORWARD], maxPerSession: 2 });
  el().first('vq-reveal').click();

  const grades = el().all('vq-grade');
  await Promise.all([grades[2].click(), grades[3].click()]);
  assert.equal(modal.index, 1, 'the second click must not advance past a card');
  assert.equal(app.writes.length, 1, 'a card must be written once per answer');
});

test('grade buttons lock as soon as one is pressed', async () => {
  const { el } = await review(single(), { mode: 'classic', directions: [DIR_FORWARD] });
  el().first('vq-reveal').click();
  const grades = el().all('vq-grade');
  await grades[2].click();
  assert.ok(grades.every((b) => b.disabled), 'the whole row must lock');
});

test('the session ends with a summary and a working close button', async () => {
  const { el, modal } = await review(single(), { mode: 'classic', directions: [DIR_FORWARD] });
  el().first('vq-reveal').click();
  await el().all('vq-grade')[2].click();

  const items = el().all('vq-summary')[0] || el().first('vq-summary');
  assert.ok(items, 'a summary list is expected');
  assert.match(items.children[0].textContent, /Cards reviewed: 1/);
  const close = el().children.find((c) => c.textContent === 'Close');
  close.click();
  assert.equal(modal.isOpen, false);
});

test('the summary reports accuracy in choice mode only', async () => {
  const notes = {
    'vocab/a.md': { word: 'gato', translation: 'Katze' },
    'vocab/b.md': { word: 'perro', translation: 'Hund' },
  };
  const choice = await review(notes, { directions: [DIR_FORWARD], choiceCount: 2, maxPerSession: 1 });
  const answer = choice.el().first('vq-prompt').textContent === 'gato' ? 'Katze' : 'Hund';
  choice.el().all('vq-choice').find((b) => b.textContent === answer).click();
  await choice.el().all('vq-grade')[2].click();
  const lines = choice.el().first('vq-summary').children.map((c) => c.textContent);
  assert.match(lines.join('\n'), /Correct: 1 \(100%\)/);

  const classic = await review(single(), { mode: 'classic', directions: [DIR_FORWARD] });
  classic.el().first('vq-reveal').click();
  await classic.el().all('vq-grade')[2].click();
  const classicLines = classic.el().first('vq-summary').children.map((c) => c.textContent);
  assert.ok(!classicLines.join('\n').includes('Correct:'), 'accuracy is meaningless without options');
});

test('the note link closes the modal and opens the note', async () => {
  const { el, app, modal } = await review(single(), { mode: 'classic', directions: [DIR_FORWARD] });
  el().first('vq-reveal').click();
  const link = el().first('vq-hint').children[0];
  assert.equal(link.textContent, 'Open note');
  link.click();
  assert.equal(modal.isOpen, false);
  assert.deepEqual(app.opened[0], ['vocab/a.md', '', false]);
});

test('closing the modal clears its content', async () => {
  const { el, modal } = await review(single());
  modal.close();
  assert.equal(el().children.length, 0);
});

test('both directions of one note are graded independently in a session', async () => {
  const { el, app, modal } = await review(single(), { mode: 'classic', maxPerSession: 10 });
  assert.equal(modal.queue.length, 2);
  for (let i = 0; i < 2; i++) {
    el().first('vq-reveal').click();
    await el().all('vq-grade')[3].click(); // "Easy"
  }
  const fm = app.notes['vocab/a.md'];
  assert.equal(fm.sr_fwd_reps, 1);
  assert.equal(fm.sr_rev_reps, 1);
  assert.equal(fm.sr_fwd_interval, fm.sr_rev_interval);
  assert.ok(fm.sr_fwd_interval > 0, 'an easy answer must schedule ahead');
});
