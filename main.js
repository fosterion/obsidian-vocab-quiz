'use strict';

const {
  Plugin,
  PluginSettingTab,
  Setting,
  Modal,
  Notice,
  TFile,
  normalizePath,
} = require('obsidian');

/* ─────────── FSRS ─────────── */

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

/* ─────────── Deck and distractors ─────────── */

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
    if (!settings.statusFilter.includes(statusOf(fm))) return null;
  }

  return {
    path: file.path,
    term,
    translation,
    transcription: String(fm[settings.transcriptionField] || '').trim(),
    status: statusOf(fm),
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

/** An unmarked note counts as new, so a missing status never hides a word. */
function statusOf(fm) {
  return String(fm.status || '').trim() || 'new';
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

/* ─────────── Plugin ─────────── */

const DEFAULTS = {
  folders: ['vocabulary'],
  termField: 'word',
  translationField: 'translation',
  transcriptionField: 'transcription',
  termLabel: '',
  translationLabel: '',
  fieldPrefix: 'sr_',
  statusFilter: ['new', 'learning', 'known'],
  directions: [DIR_FORWARD, DIR_REVERSE],
  mode: 'choice',
  choiceCount: 4,
  newPerDay: 10,
  maxPerSession: 40,
  requestRetention: 0.9,
  autoPromote: true,
};

const GRADE_LABELS = {
  1: 'Again',
  2: 'Hard',
  3: 'Good',
  4: 'Easy',
};

/**
 * Label for a direction. The language pair is set by the user in settings;
 * the plugin itself knows nothing about specific languages.
 */
function directionLabel(settings, direction) {
  const term = String(settings.termLabel || '').trim() || 'Term';
  const translation =
    String(settings.translationLabel || '').trim() || 'Translation';
  return direction === DIR_FORWARD
    ? `${term} → ${translation}`
    : `${translation} → ${term}`;
}

/** Vault-relative folder paths, free of stray slashes and blank entries. */
function cleanFolders(folders) {
  return folders
    .map((f) => String(f).trim())
    .filter(Boolean)
    .map((f) => normalizePath(f))
    .filter((f) => f !== '/');
}

/** Brings stored settings in line with the current schema. */
function normalizeSettings(loaded) {
  if (!loaded) return {};
  const out = Object.assign({}, loaded);
  if (Array.isArray(out.folders)) out.folders = cleanFolders(out.folders);
  if (Array.isArray(out.directions)) {
    const known = out.directions.filter(
      (d) => d === DIR_FORWARD || d === DIR_REVERSE
    );
    out.directions = known.length
      ? known
      : [DIR_FORWARD, DIR_REVERSE];
  }
  return out;
}

class VocabQuizPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign(
      {},
      DEFAULTS,
      normalizeSettings(await this.loadData())
    );

    this.addCommand({
      id: 'start-review',
      name: 'Start review',
      callback: () => this.startReview(),
    });

    this.addCommand({
      id: 'start-review-choice',
      name: 'Review: multiple choice',
      callback: () => this.startReview('choice'),
    });

    this.addCommand({
      id: 'start-review-classic',
      name: 'Review: show answer',
      callback: () => this.startReview('classic'),
    });

    this.addCommand({
      id: 'show-stats',
      name: 'Statistics',
      callback: () => this.showStats(),
    });

    this.addRibbonIcon('graduation-cap', 'Vocab Quiz', () => this.startReview());
    this.addSettingTab(new VocabQuizSettingTab(this.app, this));
  }

  startReview(modeOverride) {
    const entries = collect(this.app, this.settings);
    if (!entries.length) {
      new Notice(
        'No cards found. Check the folders and frontmatter fields in Vocab Quiz settings.'
      );
      return;
    }
    const now = new Date();
    const queue = buildQueue(entries, this.settings, now);
    if (!queue.length) {
      new Notice('Everything is reviewed for today.');
      return;
    }
    const mode = modeOverride || this.settings.mode;
    new ReviewModal(this.app, this, queue, entries, mode).open();
  }

  showStats() {
    const entries = collect(this.app, this.settings);
    const now = new Date();
    let fresh = 0;
    let due = 0;
    let later = 0;
    for (const e of entries) {
      for (const direction of this.settings.directions) {
        const state = e.sr[direction];
        if (!state || !state.due) fresh++;
        else if (new Date(state.due) <= now) due++;
        else later++;
      }
    }
    new Notice(
      `Notes: ${entries.length}\nNew: ${fresh}\nDue: ${due}\nLater: ${later}`,
      8000
    );
  }

  /** Writes FSRS state for one direction into the note's frontmatter. */
  async saveState(path, direction, state) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const p = statePrefix(this.settings, direction);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm[p + 'due'] = toDateString(state.due);
      fm[p + 'stability'] = state.stability;
      fm[p + 'difficulty'] = state.difficulty;
      fm[p + 'interval'] = state.interval;
      fm[p + 'reps'] = state.reps;
      fm[p + 'lapses'] = state.lapses;

      if (this.settings.autoPromote) {
        // a word is known only once every direction in use has matured
        const dirs = this.settings.directions;
        const mature =
          dirs.length > 0 &&
          dirs.every(
            (d) =>
              (Number(fm[statePrefix(this.settings, d) + 'interval']) ||
                0) >= 21
          );
        const status = statusOf(fm);
        if (mature && status !== 'known') fm.status = 'known';
        else if (state.reps > 0 && status === 'new') fm.status = 'learning';
      }
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

function toDateString(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${m}-${day}`;
}

class ReviewModal extends Modal {
  constructor(app, plugin, queue, pool, mode) {
    super(app);
    this.plugin = plugin;
    this.queue = queue;
    this.pool = pool;
    this.mode = mode;
    this.index = 0;
    this.answered = 0;
    this.correct = 0;
    this.again = [];
  }

  onOpen() {
    this.modalEl.addClass('vocab-quiz-modal');
    this.renderCard();
  }

  current() {
    return this.queue[this.index];
  }

  renderCard() {
    const { contentEl } = this;
    contentEl.empty();

    if (this.index >= this.queue.length) {
      if (this.again.length) {
        this.queue = this.again;
        this.again = [];
        this.index = 0;
      } else {
        return this.renderSummary();
      }
    }

    const card = this.current();
    const total = this.queue.length;

    const head = contentEl.createDiv({ cls: 'vq-head' });
    head.createSpan({
      text: `${this.index + 1} / ${total}`,
      cls: 'vq-counter',
    });
    head.createSpan({
      text: directionLabel(this.plugin.settings, card.direction),
      cls: 'vq-direction',
    });

    contentEl.createEl('div', {
      text: promptOf(card),
      cls: 'vq-prompt',
    });

    if (card.direction === DIR_FORWARD && card.entry.transcription) {
      contentEl.createEl('div', {
        text: card.entry.transcription,
        cls: 'vq-transcription',
      });
    }

    if (this.mode === 'choice') this.renderChoices(contentEl, card);
    else this.renderClassic(contentEl, card);
  }

  renderChoices(contentEl, card) {
    const choices = buildChoices(
      card,
      this.pool,
      this.plugin.settings.choiceCount
    );
    const correct = answerOf(card);
    const box = contentEl.createDiv({ cls: 'vq-choices' });

    choices.forEach((choice) => {
      const btn = box.createEl('button', { text: choice, cls: 'vq-choice' });
      btn.onclick = () => {
        const isRight = choice === correct;
        Array.from(box.children).forEach((el) => {
          el.setAttribute('disabled', 'true');
          const t = el.textContent;
          if (t === correct) el.addClass('vq-right');
          else if (t === choice) el.addClass('vq-wrong');
        });
        this.answered++;
        if (isRight) this.correct++;
        this.showGrades(contentEl, card, isRight);
      };
    });
  }

  renderClassic(contentEl, card) {
    const reveal = contentEl.createEl('button', {
      text: 'Show answer',
      cls: 'mod-cta vq-reveal',
    });
    reveal.onclick = () => {
      reveal.remove();
      contentEl.createEl('div', {
        text: answerOf(card),
        cls: 'vq-answer',
      });
      this.answered++;
      this.showGrades(contentEl, card, null);
    };
  }

  showGrades(contentEl, card, wasCorrect) {
    const old = contentEl.querySelector('.vq-grades');
    if (old) old.remove();

    const box = contentEl.createDiv({ cls: 'vq-grades' });
    const grades = wasCorrect === false ? [1, 2, 3, 4] : [1, 2, 3, 4];

    grades.forEach((g) => {
      const btn = box.createEl('button', {
        text: GRADE_LABELS[g],
        cls: 'vq-grade vq-grade-' + g,
      });
      if (wasCorrect === true && g === 3) btn.addClass('mod-cta');
      if (wasCorrect === false && g === 1) btn.addClass('mod-cta');
      btn.onclick = () => {
        // grade() is async, so lock the row before a second click can land
        for (const el of Array.from(box.children)) el.setAttribute('disabled', 'true');
        return this.grade(card, g);
      };
    });

    const note = contentEl.createDiv({ cls: 'vq-hint' });
    note.createEl('a', { text: 'Open note', href: '#' }).onclick = (e) => {
      e.preventDefault();
      this.close();
      this.app.workspace.openLinkText(card.entry.path, '', false);
    };
  }

  async grade(card, g) {
    const state = schedule(
      card.entry.sr[card.direction],
      g,
      this.plugin.settings.requestRetention,
      new Date()
    );
    card.entry.sr[card.direction] = {
      due: toDateString(state.due),
      stability: state.stability,
      difficulty: state.difficulty,
      interval: state.interval,
      reps: state.reps,
      lapses: state.lapses,
    };
    await this.plugin.saveState(card.entry.path, card.direction, state);

    if (g === 1) this.again.push(card);
    this.index++;
    this.renderCard();
  }

  renderSummary() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Session complete' });
    const pct =
      this.answered > 0 ? Math.round((this.correct / this.answered) * 100) : 0;
    const list = contentEl.createEl('ul', { cls: 'vq-summary' });
    list.createEl('li', { text: `Cards reviewed: ${this.answered}` });
    if (this.mode === 'choice') {
      list.createEl('li', { text: `Correct: ${this.correct} (${pct}%)` });
    }
    const done = contentEl.createEl('button', {
      text: 'Close',
      cls: 'mod-cta',
    });
    done.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class VocabQuizSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('Card source').setHeading();

    new Setting(containerEl)
      .setName('Folders')
      .setDesc('Comma-separated. Notes inside are collected recursively.')
      .addText((t) =>
        t
          .setPlaceholder('vocabulary')
          .setValue(this.plugin.settings.folders.join(', '))
          .onChange(async (v) => {
            this.plugin.settings.folders = cleanFolders(v.split(','));
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Term field')
      .setDesc('Frontmatter property holding the word being learned.')
      .addText((t) =>
        t.setValue(this.plugin.settings.termField).onChange(async (v) => {
          this.plugin.settings.termField = v.trim() || 'word';
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Translation field')
      .addText((t) =>
        t.setValue(this.plugin.settings.translationField).onChange(async (v) => {
          this.plugin.settings.translationField = v.trim() || 'translation';
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Transcription field')
      .addText((t) =>
        t
          .setValue(this.plugin.settings.transcriptionField)
          .onChange(async (v) => {
            this.plugin.settings.transcriptionField = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Statuses to review')
      .setDesc(
        'Comma-separated; empty means every note. A status left out here is never asked again, even when it comes due.'
      )
      .addText((t) =>
        t
          .setPlaceholder('new, learning')
          .setValue(this.plugin.settings.statusFilter.join(', '))
          .onChange(async (v) => {
            this.plugin.settings.statusFilter = v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName('Mode').setHeading();

    new Setting(containerEl)
      .setName('Default mode')
      .addDropdown((d) =>
        d
          .addOption('choice', 'Multiple choice')
          .addOption('classic', 'Show answer')
          .setValue(this.plugin.settings.mode)
          .onChange(async (v) => {
            this.plugin.settings.mode = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Answer options')
      .setDesc('Including the correct one. Between 2 and 6.')
      .addSlider((s) =>
        s
          .setLimits(2, 6, 1)
          .setValue(this.plugin.settings.choiceCount)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.choiceCount = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Term side label')
      .setDesc(
        'Shown on the card, e.g. EN. Any language pair works; leave empty for "Term".'
      )
      .addText((t) =>
        t
          .setPlaceholder('Term')
          .setValue(this.plugin.settings.termLabel)
          .onChange(async (v) => {
            this.plugin.settings.termLabel = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Translation side label')
      .setDesc('Shown on the card, e.g. RU. Leave empty for "Translation".')
      .addText((t) =>
        t
          .setPlaceholder('Translation')
          .setValue(this.plugin.settings.translationLabel)
          .onChange(async (v) => {
            this.plugin.settings.translationLabel = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Directions')
      .setDesc('Which side to ask. Labels above refresh when settings reopen.')
      .addDropdown((d) =>
        d
          .addOption('both', 'Both directions')
          .addOption(
            DIR_FORWARD,
            directionLabel(this.plugin.settings, DIR_FORWARD) + ' only'
          )
          .addOption(
            DIR_REVERSE,
            directionLabel(this.plugin.settings, DIR_REVERSE) + ' only'
          )
          .setValue(
            this.plugin.settings.directions.length === 2
              ? 'both'
              : this.plugin.settings.directions[0]
          )
          .onChange(async (v) => {
            this.plugin.settings.directions =
              v === 'both' ? [DIR_FORWARD, DIR_REVERSE] : [v];
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName('Scheduling').setHeading();

    new Setting(containerEl)
      .setName('New cards per day')
      .addSlider((s) =>
        s
          .setLimits(0, 50, 5)
          .setValue(this.plugin.settings.newPerDay)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.newPerDay = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Maximum per session')
      .addSlider((s) =>
        s
          .setLimits(10, 200, 10)
          .setValue(this.plugin.settings.maxPerSession)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxPerSession = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Target retention')
      .setDesc(
        'Probability of recall at review time. Higher means more frequent reviews.'
      )
      .addSlider((s) =>
        s
          .setLimits(0.7, 0.97, 0.01)
          .setValue(this.plugin.settings.requestRetention)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.requestRetention = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Update status automatically')
      .setDesc(
        'new → learning after the first answer, learning → known once the interval reaches 21 days.'
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoPromote).onChange(async (v) => {
          this.plugin.settings.autoPromote = v;
          await this.plugin.saveSettings();
        })
      );
  }
}

module.exports = VocabQuizPlugin;
