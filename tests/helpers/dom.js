'use strict';

/**
 * Minimal stand-in for the DOM elements Obsidian hands to plugins, including
 * the createEl/addClass helpers Obsidian adds to HTMLElement.
 */
class FakeEl {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.classes = new Set();
    this.attrs = {};
    this.textContent = '';
    this.onclick = null;
  }

  append(tag, opts = {}) {
    const el = new FakeEl(tag);
    if (opts.text !== undefined) el.textContent = String(opts.text);
    if (opts.cls) {
      for (const c of String(opts.cls).split(/\s+/).filter(Boolean)) el.classes.add(c);
    }
    if (opts.href !== undefined) el.attrs.href = opts.href;
    el.parent = this;
    this.children.push(el);
    return el;
  }

  createEl(tag, opts) { return this.append(tag, opts); }
  createDiv(opts) { return this.append('div', opts); }
  createSpan(opts) { return this.append('span', opts); }

  empty() { this.children.length = 0; return this; }
  addClass(c) { this.classes.add(c); return this; }
  removeClass(c) { this.classes.delete(c); return this; }
  hasClass(c) { return this.classes.has(c); }
  setAttribute(k, v) { this.attrs[k] = String(v); return this; }
  getAttribute(k) { return this.attrs[k]; }

  get disabled() { return this.attrs.disabled !== undefined; }

  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }

  /** Only class selectors are used by the plugin. */
  querySelector(selector) {
    const cls = selector.replace(/^\./, '');
    for (const child of this.children) {
      if (child.classes.has(cls)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  /** Every descendant carrying the class, in document order. */
  all(cls) {
    const found = [];
    for (const child of this.children) {
      if (child.classes.has(cls)) found.push(child);
      found.push(...child.all(cls));
    }
    return found;
  }

  first(cls) { return this.all(cls)[0] || null; }
  text(cls) { return this.all(cls).map((el) => el.textContent); }

  /** Fires the handler the plugin attached, mirroring a browser's disabled check. */
  click() {
    if (this.disabled || !this.onclick) return undefined;
    return this.onclick({ preventDefault() {} });
  }
}

module.exports = { FakeEl };
