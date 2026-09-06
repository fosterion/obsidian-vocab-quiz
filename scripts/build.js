'use strict';

/**
 * Builds main.js from src/: strips the CommonJS wrapper from each module and
 * concatenates them, since Obsidian loads a single file.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'main.js');
const PARTS = [
  ['src/fsrs.js', 'FSRS'],
  ['src/deck.js', 'Deck and distractors'],
  ['src/main.js', 'Plugin'],
];

function build() {
  const out = [
    "'use strict';",
    '',
    "const { Plugin, PluginSettingTab, Setting, Modal, Notice } = require('obsidian');",
    '',
  ];

  for (const [file, title] of PARTS) {
    let body = fs.readFileSync(path.join(ROOT, file), 'utf8');
    body = body.replace("'use strict';\n", '');
    // drop require lines and exports — the bundle is a single scope
    body = body.replace(/^const \{[^}]*\} = require\('obsidian'\);\n/gm, '');
    body = body.replace(/^const \{ schedule \} = require\('\.\/fsrs'\);\n/gm, '');
    body = body.replace(/^const deck = require\('\.\/deck'\);\n/gm, '');
    body = body.replace(/^module\.exports = \{[^}]*\};\n/gm, '');
    body = body.replace(/^module\.exports = VocabQuizPlugin;\n/gm, '');
    body = body.replace(/\bdeck\./g, '');
    out.push(`/* ─────────── ${title} ─────────── */`, '');
    out.push(body.replace(/^\n+/, '').replace(/\n+$/, ''), '');
  }

  out.push('module.exports = VocabQuizPlugin;');
  return out.join('\n') + '\n';
}

module.exports = { build, BUNDLE, PARTS, ROOT };

if (require.main === module) {
  fs.writeFileSync(BUNDLE, build());
  console.log('main.js built from ' + PARTS.map(([f]) => f).join(', '));
}
