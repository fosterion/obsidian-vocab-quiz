'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { build, BUNDLE, PARTS, ROOT } = require('../scripts/build');
const path = require('node:path');

test('the committed main.js matches a fresh build of src/', () => {
  assert.equal(
    fs.readFileSync(BUNDLE, 'utf8'),
    build(),
    'main.js is stale — run `npm run build` after editing src/'
  );
});

test('the bundle resolves the module wiring away', () => {
  const bundle = fs.readFileSync(BUNDLE, 'utf8');
  assert.ok(!/require\('\.\/(fsrs|deck)'\)/.test(bundle), 'relative requires must be inlined');
  assert.ok(!/\bdeck\./.test(bundle), 'the deck namespace must be flattened');
  assert.equal((bundle.match(/require\('obsidian'\)/g) || []).length, 1);
  assert.ok(bundle.trimEnd().endsWith('module.exports = VocabQuizPlugin;'));
});

test('every source module ends up in the bundle', () => {
  const bundle = fs.readFileSync(BUNDLE, 'utf8');
  for (const [file] of PARTS) {
    const marker = fs
      .readFileSync(path.join(ROOT, file), 'utf8')
      .split('\n')
      .find((line) => line.startsWith('function ') || line.startsWith('class '));
    assert.ok(bundle.includes(marker), `${file} is missing from the bundle`);
  }
});

test('the repository carries every file the plugin directory requires', () => {
  for (const file of ['README.md', 'LICENSE', 'manifest.json', 'main.js', 'styles.css']) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is required for submission`);
  }
});

test('styles lean on theme variables instead of fixed colours', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  assert.deepEqual(
    css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) || [],
    [],
    'hardcoded colours break user themes and fail review'
  );
});

test('the bundle avoids the APIs the guidelines forbid', () => {
  const bundle = fs.readFileSync(BUNDLE, 'utf8');
  for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'window.app']) {
    assert.ok(!bundle.includes(banned), `${banned} is not allowed in community plugins`);
  }
  assert.ok(!/\(\?<[=!]/.test(bundle), 'lookbehind regex is unsupported on mobile');
});

test('the manifest points at a bundle that exists and parses', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'vocab-quiz');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.minAppVersion, 'minAppVersion is required by Obsidian');
  assert.equal(typeof manifest.isDesktopOnly, 'boolean');
  assert.ok(fs.existsSync(BUNDLE));
});
