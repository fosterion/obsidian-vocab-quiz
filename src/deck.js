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
    sr: {
      // fall back to the shared fields so existing scheduling data is not lost
      [DIR_FORWARD]:
        readState(fm, statePrefix(settings, DIR_FORWARD)) ||
        readState(fm, settings.fieldPrefix),
      [DIR_REVERSE]:
        readState(fm, statePrefix(settings, DIR_REVERSE)) ||
        readState(fm, settings.fieldPrefix),
    },
  };
}

/** Frontmatter prefix holding the scheduling state of one direction. */
function statePrefix(settings, direction) {
  return settings.fieldPrefix + (direction === DIR_FORWARD ? 'fwd_' : 'rev_');
}

function readState(fm, prefix) {
  if (!fm[prefix + 'due']) return null;
  return {
    due: fm[prefix + 'due'],
    stability: Number(fm[prefix + 'stability']) || 0,
    difficulty: Number(fm[prefix + 'difficulty']) || 5,
    interval: Number(fm[prefix + 'interval']) || 0,
    reps: Number(fm[prefix + 'reps']) || 0,
    lapses: Number(fm[prefix + 'lapses']) || 0,
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

function isDue(card, now) {
  const state = card.entry.sr[card.direction];
  if (!state || !state.due) return true; // a new card
  return new Date(state.due) <= now;
}

/** Today's queue: due cards first, then new ones, capped by the session limit. */
function buildQueue(entries, settings, now) {
  const due = [];
  const fresh = [];
  for (const entry of entries) {
    for (const direction of settings.directions) {
      const card = { entry, direction };
      if (isDue(card, now)) {
        const state = entry.sr[direction];
        (state && state.due ? due : fresh).push(card);
      }
    }
  }
  // oldest first, so the session limit never silently drops the worst backlog
  due.sort(
    (a, b) =>
      new Date(a.entry.sr[a.direction].due) -
      new Date(b.entry.sr[b.direction].due)
  );
  shuffle(fresh);

  const limit = settings.maxPerSession > 0 ? settings.maxPerSession : Infinity;
  const selected = due.slice(0, limit);
  const room = Math.min(settings.newPerDay, limit - selected.length);
  if (room > 0) selected.push(...fresh.slice(0, room));
  // selection is by priority, presentation order is not
  return shuffle(selected);
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
  statePrefix,
  buildQueue,
  buildChoices,
  promptOf,
  answerOf,
  isDue,
  shuffle,
  DIR_FORWARD,
  DIR_REVERSE,
};
