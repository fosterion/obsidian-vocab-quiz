'use strict';

/**
 * Collecting cards from notes and picking distractors.
 * Data comes from frontmatter only — the note body is never parsed.
 */

// Directions are not tied to any particular language pair:
// forward — show the term, ask for the translation; reverse — the other way round.
const DIR_FORWARD = 'forward';
const DIR_REVERSE = 'reverse';

/** A word taken from a note. Returns null when the note cannot become a card. */
function noteToEntry(app, file, settings) {
  const cache = app.metadataCache.getFileCache(file);
  const fm = cache && cache.frontmatter;
  if (!fm) return null;

  const term = String(fm[settings.termField] || file.basename || '').trim();
  const translation = String(fm[settings.translationField] || '').trim();
  if (!term || !translation) return null;

  if (settings.statusFilter && settings.statusFilter.length) {
    const status = String(fm.status || '').trim();
    if (!settings.statusFilter.includes(status)) return null;
  }

  return {
    path: file.path,
    term,
    translation,
    transcription: String(fm[settings.transcriptionField] || '').trim(),
    status: String(fm.status || '').trim(),
    level: String(fm.level || '').trim(),
    sr: readState(fm, settings),
  };
}

function readState(fm, settings) {
  const p = settings.fieldPrefix;
  if (!fm[p + 'due']) return null;
  return {
    due: fm[p + 'due'],
    stability: Number(fm[p + 'stability']) || 0,
    difficulty: Number(fm[p + 'difficulty']) || 5,
    interval: Number(fm[p + 'interval']) || 0,
    reps: Number(fm[p + 'reps']) || 0,
    lapses: Number(fm[p + 'lapses']) || 0,
  };
}

/** Every card found in the configured folders. */
function collect(app, settings) {
  const folders = settings.folders.filter(Boolean);
  const out = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const inScope = folders.some(
      (f) => file.path === f || file.path.startsWith(f.replace(/\/$/, '') + '/')
    );
    if (!inScope) continue;
    const entry = noteToEntry(app, file, settings);
    if (entry) out.push(entry);
  }
  return out;
}

function isDue(entry, now) {
  if (!entry.sr || !entry.sr.due) return true; // a new card
  return new Date(entry.sr.due) <= now;
}

/** Today's queue: due cards first, then new ones, capped by the session limit. */
function buildQueue(entries, settings, now) {
  const due = [];
  const fresh = [];
  for (const e of entries) {
    if (!e.sr || !e.sr.due) fresh.push(e);
    else if (new Date(e.sr.due) <= now) due.push(e);
  }
  due.sort((a, b) => new Date(a.sr.due) - new Date(b.sr.due));
  shuffle(fresh);

  const queue = due.concat(fresh.slice(0, settings.newPerDay));
  const cards = [];
  for (const entry of queue) {
    if (settings.directions.includes(DIR_FORWARD)) {
      cards.push({ entry, direction: DIR_FORWARD });
    }
    if (settings.directions.includes(DIR_REVERSE)) {
      cards.push({ entry, direction: DIR_REVERSE });
    }
  }
  shuffle(cards);
  return cards.slice(0, settings.maxPerSession || cards.length);
}

/**
 * Answer options: the correct one plus N distractors from the same pool.
 * Distractors come from neighbouring words; if there are too few, use what exists.
 */
function buildChoices(card, pool, count) {
  const correct = answerOf(card);
  const seen = new Set([correct.toLowerCase()]);
  const candidates = [];

  for (const e of pool) {
    if (e.path === card.entry.path) continue;
    const val = card.direction === DIR_FORWARD ? e.translation : e.term;
    const key = val.toLowerCase();
    if (!val || seen.has(key)) continue;
    seen.add(key);
    candidates.push(val);
  }

  shuffle(candidates);
  const choices = candidates.slice(0, Math.max(0, count - 1));
  choices.push(correct);
  shuffle(choices);
  return choices;
}

function promptOf(card) {
  return card.direction === DIR_FORWARD ? card.entry.term : card.entry.translation;
}

function answerOf(card) {
  return card.direction === DIR_FORWARD ? card.entry.translation : card.entry.term;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

module.exports = {
  collect,
  buildQueue,
  buildChoices,
  promptOf,
  answerOf,
  isDue,
  shuffle,
  DIR_FORWARD,
  DIR_REVERSE,
};
