# Vocab Quiz

An Obsidian plugin for vocabulary review where cards are built from
**frontmatter properties** rather than from inline syntax in the note body.

## Why

Existing spaced-repetition plugins make you duplicate your data: properties in
frontmatter for tables and queries, plus a `word::translation` line in the body
for the card itself. Here frontmatter is the single source of truth.

The second difference is the **multiple-choice** mode: wrong answers are filled
in with random words drawn from the same set of notes.

## Note format

```markdown
---
word: reluctant
transcription: /rɪˈlʌktənt/
translation: unwilling, doing something without enthusiasm
status: learning
---

## In context
> Managers remain **reluctant to** abandon the office entirely.
```

No tags or separators are required. The search scope is set by folder in the
settings.

## Language pairs

The plugin is not tied to any particular language pair. It only knows two sides
of a card — the **term** and its **translation** — and two directions:

- `forward` — the term is shown, the translation is asked
- `reverse` — the translation is shown, the term is asked

Which languages those sides hold is up to you. The **Term side label** and
**Translation side label** settings control what appears on the card, so a
Spanish–German deck simply reads `ES → DE`. Left empty, the card shows
`Term → Translation`.

Property names (`word`, `translation`, `transcription`) are configurable too, so
notes in any language work without renaming anything.

## Features

- Two modes: multiple choice with 2–6 options, and classic reveal-the-answer
- Both directions, independently toggleable
- FSRS scheduler with independent state per direction, stored in the
  `sr_fwd_*` and `sr_rev_*` properties
- Filter by `status` — for example, review only `new` and `learning`
- Automatic `new → learning → known` promotion as the interval grows
- Configurable property names and side labels

## Installation

Copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/vocab-quiz/` and enable the plugin in settings.

## Commands

- `Vocab Quiz: Start review`
- `Vocab Quiz: Review: multiple choice`
- `Vocab Quiz: Review: show answer`
- `Vocab Quiz: Statistics`

## Development

Sources live in `src/` as separate modules; the `main.js` at the repository root
is the built bundle, since Obsidian loads only that file.

```
src/        plugin modules
scripts/    build.js — concatenates src/ into main.js
tests/      node:test suites, plus helpers/ stubbing the Obsidian API
```

```sh
npm run build   # regenerate main.js after editing src/
npm test        # run the suite (no dependencies, uses node --test)
```

The suite has no third-party dependencies. `tests/bundle.test.js` fails if
`main.js` is out of date, so run the build before committing. Findings that are
known but unfixed live in `tests/known-issues.test.js`, marked `todo` so they
are on record without breaking the suite.
