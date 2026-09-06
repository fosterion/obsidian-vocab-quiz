'use strict';

/**
 * FSRS v4 — a trimmed-down implementation covering what this plugin needs.
 * Card state: stability (days), difficulty (1..10), reps, lapses, due.
 * Grades: 1 = again, 2 = hard, 3 = good, 4 = easy.
 */

const W = [
  0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616,
  0.1544, 1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034, 0.6567,
];

const DECAY = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;

function clampD(d) {
  return Math.min(Math.max(d, 1), 10);
}

function initStability(grade) {
  return Math.max(W[grade - 1], 0.1);
}

function initDifficulty(grade) {
  return clampD(W[4] - Math.exp(W[5] * (grade - 1)) + 1);
}

function nextDifficulty(d, grade) {
  const delta = d - W[6] * (grade - 3);
  const mean = W[7] * initDifficulty(4) + (1 - W[7]) * delta;
  return clampD(mean);
}

function retrievability(elapsedDays, stability) {
  if (stability <= 0) return 0;
  return Math.pow(1 + FACTOR * (elapsedDays / stability), DECAY);
}

function nextStabilityRecall(d, s, r, grade) {
  const hardPenalty = grade === 2 ? W[15] : 1;
  const easyBonus = grade === 4 ? W[16] : 1;
  return (
    s *
    (1 +
      Math.exp(W[8]) *
        (11 - d) *
        Math.pow(s, -W[9]) *
        (Math.exp(W[10] * (1 - r)) - 1) *
        hardPenalty *
        easyBonus)
  );
}

function nextStabilityForget(d, s, r) {
  return (
    W[11] *
    Math.pow(d, -W[12]) *
    (Math.pow(s + 1, W[13]) - 1) *
    Math.exp(W[14] * (1 - r))
  );
}

function intervalFromStability(stability, requestRetention) {
  const ivl = (stability / FACTOR) * (Math.pow(requestRetention, 1 / DECAY) - 1);
  return Math.max(1, Math.round(ivl));
}

/**
 * Recomputes card state after an answer.
 * @param {object|null} state — previous state, or null for a new card
 * @param {number} grade — 1..4
 * @param {number} requestRetention — target probability of recall (0.9)
 * @param {Date} now
 */
function schedule(state, grade, requestRetention, now) {
  const today = now || new Date();
  let stability;
  let difficulty;
  let reps = state && state.reps ? state.reps : 0;
  let lapses = state && state.lapses ? state.lapses : 0;

  const isNew = !state || !state.stability || !state.due;

  if (isNew) {
    stability = initStability(grade);
    difficulty = initDifficulty(grade);
  } else {
    const elapsed = Math.max(
      0,
      (today - new Date(state.due)) / 86400000 + (state.interval || 0)
    );
    const r = retrievability(elapsed, state.stability);
    difficulty = nextDifficulty(state.difficulty || 5, grade);

    if (grade === 1) {
      stability = nextStabilityForget(difficulty, state.stability, r);
      lapses += 1;
    } else {
      stability = nextStabilityRecall(difficulty, state.stability, r, grade);
    }
  }

  reps += 1;

  // "again" always brings the card back the same day
  const interval = grade === 1 ? 0 : intervalFromStability(stability, requestRetention);
  const due = new Date(today.getTime() + interval * 86400000);

  return {
    stability: Math.round(stability * 10000) / 10000,
    difficulty: Math.round(difficulty * 10000) / 10000,
    interval,
    reps,
    lapses,
    due,
  };
}

module.exports = { schedule, retrievability };
