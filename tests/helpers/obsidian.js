'use strict';

/** Stub of the `obsidian` module: just enough surface for the plugin to run. */

const { FakeEl } = require('./dom');

class TFile {
  constructor(path) {
    this.path = path;
    this.basename = path.split('/').pop().replace(/\.md$/, '');
    this.extension = 'md';
  }
}

class TFolder {
  constructor(path) { this.path = path; }
}

/** Mirrors Obsidian's normalizePath: vault-relative, no stray or duplicate slashes. */
function normalizePath(path) {
  const cleaned = String(path)
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .normalize('NFC');
  return cleaned === '' ? '/' : cleaned;
}

class Plugin {
  constructor(app) {
    this.app = app;
    this.commands = [];
    this.ribbons = [];
    this.settingTabs = [];
    this.data = null;
  }
  addCommand(cmd) { this.commands.push(cmd); }
  addRibbonIcon(icon, title, callback) { this.ribbons.push({ icon, title, callback }); }
  addSettingTab(tab) { this.settingTabs.push(tab); }
  async loadData() { return this.data; }
  async saveData(data) { this.data = data; }
  command(id) { return this.commands.find((c) => c.id === id); }
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = new FakeEl();
  }
}

class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = new FakeEl();
    this.modalEl = new FakeEl();
    this.isOpen = false;
    Modal.instances.push(this);
  }
  open() { this.isOpen = true; if (this.onOpen) this.onOpen(); }
  close() { this.isOpen = false; if (this.onClose) this.onClose(); }
  static reset() { Modal.instances = []; }
  static get last() { return Modal.instances[Modal.instances.length - 1]; }
}
Modal.instances = [];

class Notice {
  constructor(message, timeout) {
    this.message = String(message);
    this.timeout = timeout;
    Notice.messages.push(this.message);
  }
  static reset() { Notice.messages = []; }
  static get last() { return Notice.messages[Notice.messages.length - 1]; }
}
Notice.messages = [];

function component(type, extra = {}) {
  const c = Object.assign(
    {
      type,
      value: undefined,
      handler: null,
      setValue(v) { c.value = v; return c; },
      onChange(fn) { c.handler = fn; return c; },
      /** Simulates the user editing the control. */
      async set(v) { c.value = v; if (c.handler) await c.handler(v); return c; },
    },
    extra
  );
  return c;
}

class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.name = '';
    this.desc = '';
    this.components = [];
    Setting.created.push(this);
  }
  setName(v) { this.name = v; return this; }
  setDesc(v) { this.desc = v; return this; }
  setHeading() { this.heading = true; return this; }

  add(type, extra, cb) {
    const c = component(type, extra);
    this.components.push(c);
    cb(c);
    return this;
  }
  addText(cb) {
    return this.add('text', { setPlaceholder(v) { this.placeholder = v; return this; } }, cb);
  }
  addDropdown(cb) {
    return this.add(
      'dropdown',
      { options: [], addOption(value, label) { this.options.push({ value, label }); return this; } },
      cb
    );
  }
  addSlider(cb) {
    return this.add(
      'slider',
      {
        setLimits(min, max, step) { Object.assign(this, { min, max, step }); return this; },
        setDynamicTooltip() { return this; },
      },
      cb
    );
  }
  addToggle(cb) { return this.add('toggle', {}, cb); }

  static reset() { Setting.created = []; }
  static byName(name) { return Setting.created.find((s) => s.name === name); }
}
Setting.created = [];

module.exports = {
  Plugin,
  PluginSettingTab,
  Setting,
  Modal,
  Notice,
  TFile,
  TFolder,
  normalizePath,
  FakeEl,
};
