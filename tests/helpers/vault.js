'use strict';

/** Fake vault: notes are plain frontmatter objects that the plugin edits in place. */

const Module = require('node:module');
const path = require('node:path');

const stub = require('./obsidian');

// Route the plugin's `require('obsidian')` to the stub above.
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return stub;
  return load.apply(this, arguments);
};

const VocabQuizPlugin = require(path.join(__dirname, '..', '..', 'src', 'main.js'));
const deck = require(path.join(__dirname, '..', '..', 'src', 'deck.js'));

const BASE_SETTINGS = {
  folders: ['vocab'],
  termField: 'word',
  translationField: 'translation',
  transcriptionField: 'transcription',
  termLabel: '',
  translationLabel: '',
  fieldPrefix: 'sr_',
  statusFilter: [],
  directions: [deck.DIR_FORWARD, deck.DIR_REVERSE],
  mode: 'choice',
  choiceCount: 4,
  newPerDay: 10,
  maxPerSession: 40,
  requestRetention: 0.9,
  autoPromote: true,
};

/** @param notes — map of note path to its frontmatter (null means no frontmatter) */
function makeApp(notes) {
  const files = Object.entries(notes).map(([p, fm]) => Object.assign(new stub.TFile(p), { fm }));
  const app = {
    metadataCache: { getFileCache: (f) => (f.fm ? { frontmatter: f.fm } : {}) },
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (p) =>
        files.find((f) => f.path === p) || (p.endsWith('.md') ? null : new stub.TFolder(p)),
    },
    fileManager: {
      processFrontMatter: async (file, fn) => {
        app.writes.push(file.path);
        fn(file.fm);
      },
    },
    workspace: { openLinkText: (...args) => app.opened.push(args) },
    notes,
    writes: [],
    opened: [],
  };
  return app;
}

/** Loads a plugin instance over `notes`, with `overrides` merged into the settings. */
async function makePlugin(notes, overrides = {}) {
  stub.Notice.reset();
  stub.Setting.reset();
  stub.Modal.reset();
  const app = makeApp(notes);
  const plugin = new VocabQuizPlugin(app);
  plugin.data = Object.assign({}, BASE_SETTINGS, overrides);
  await plugin.onload();
  return { plugin, app };
}

module.exports = { makeApp, makePlugin, BASE_SETTINGS, VocabQuizPlugin, stub };
