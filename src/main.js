'use strict';

const { Plugin, PluginSettingTab, Setting, Modal, Notice } = require('obsidian');
const { schedule } = require('./fsrs');
const deck = require('./deck');

const DEFAULTS = {
  folders: ['vocabulary'],
  termField: 'word',
  translationField: 'translation',
  transcriptionField: 'transcription',
  termLabel: '',
  translationLabel: '',
  fieldPrefix: 'sr_',
  statusFilter: ['new', 'learning', 'known'],
  directions: [deck.DIR_FORWARD, deck.DIR_REVERSE],
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
  return direction === deck.DIR_FORWARD
    ? `${term} → ${translation}`
    : `${translation} → ${term}`;
}

/** Brings stored settings in line with the current schema. */
function normalizeSettings(loaded) {
  if (!loaded) return {};
  const out = Object.assign({}, loaded);
  if (Array.isArray(out.directions)) {
    const known = out.directions.filter(
      (d) => d === deck.DIR_FORWARD || d === deck.DIR_REVERSE
    );
    out.directions = known.length
      ? known
      : [deck.DIR_FORWARD, deck.DIR_REVERSE];
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
    const entries = deck.collect(this.app, this.settings);
    if (!entries.length) {
      new Notice(
        'No cards found. Check the folders and frontmatter fields in Vocab Quiz settings.'
      );
      return;
    }
    const now = new Date();
    const queue = deck.buildQueue(entries, this.settings, now);
    if (!queue.length) {
      new Notice('Everything is reviewed for today.');
      return;
    }
    const mode = modeOverride || this.settings.mode;
    new ReviewModal(this.app, this, queue, entries, mode).open();
  }

  showStats() {
    const entries = deck.collect(this.app, this.settings);
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
    if (!file) return;
    const p = deck.statePrefix(this.settings, direction);
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
              (Number(fm[deck.statePrefix(this.settings, d) + 'interval']) ||
                0) >= 21
          );
        const status = deck.statusOf(fm);
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
      text: deck.promptOf(card),
      cls: 'vq-prompt',
    });

    if (card.direction === deck.DIR_FORWARD && card.entry.transcription) {
      contentEl.createEl('div', {
        text: card.entry.transcription,
        cls: 'vq-transcription',
      });
    }

    if (this.mode === 'choice') this.renderChoices(contentEl, card);
    else this.renderClassic(contentEl, card);
  }

  renderChoices(contentEl, card) {
    const choices = deck.buildChoices(
      card,
      this.pool,
      this.plugin.settings.choiceCount
    );
    const correct = deck.answerOf(card);
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
        text: deck.answerOf(card),
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

    containerEl.createEl('h3', { text: 'Card source' });

    new Setting(containerEl)
      .setName('Folders')
      .setDesc('Comma-separated. Notes inside are collected recursively.')
      .addText((t) =>
        t
          .setPlaceholder('vocabulary')
          .setValue(this.plugin.settings.folders.join(', '))
          .onChange(async (v) => {
            this.plugin.settings.folders = v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
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

    containerEl.createEl('h3', { text: 'Mode' });

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
            deck.DIR_FORWARD,
            directionLabel(this.plugin.settings, deck.DIR_FORWARD) + ' only'
          )
          .addOption(
            deck.DIR_REVERSE,
            directionLabel(this.plugin.settings, deck.DIR_REVERSE) + ' only'
          )
          .setValue(
            this.plugin.settings.directions.length === 2
              ? 'both'
              : this.plugin.settings.directions[0]
          )
          .onChange(async (v) => {
            this.plugin.settings.directions =
              v === 'both' ? [deck.DIR_FORWARD, deck.DIR_REVERSE] : [v];
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h3', { text: 'Scheduling' });

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
