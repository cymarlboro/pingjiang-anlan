"use strict";

/*
 * 山月记 · 安卓 UI 模拟验证
 *
 * 不下载 SDK、不调用真实 API、不安装 APK。使用进程内假桥与假 DOM 验证：
 * - AndroidBridge 引导数据合并、Promise/超时/取消/重复回调
 * - AI 设置保存时密钥只交给安装版，不进入网页存储/state/导出
 * - 连接测试成功、失败与手动模型提示
 * - pickImport 取消/成功、原文校验、草稿编辑后的 accept payload
 * - 备份恢复 shape 校验、更新未配置/有新版
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = __dirname;
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("ok " + passed + " - " + name);
  } catch (error) {
    console.error("FAIL - " + name);
    throw error;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("ok " + passed + " - " + name);
  } catch (error) {
    console.error("FAIL - " + name);
    throw error;
  }
}

function flush() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function adapterPath() {
  return path.join(ROOT, "preview", "native-adapter.js");
}

function loadAdapter(bridge, options) {
  const settings = options || {};
  delete require.cache[require.resolve(adapterPath())];
  global.AndroidBridge = bridge;
  global.STUDY_DATA = settings.studyData || { sources: [], questions: [], edition: "test" };
  global.GENERATED_ANSWERS = settings.generated || [];
  global.QUESTION_TYPES = settings.types || {};
  global.QUESTION_IMAGES = {};
  delete global.document;
  return require(adapterPath());
}

function makeBridge(handler, options) {
  const bridge = {
    bootstrap: options && options.bootstrap !== undefined
      ? options.bootstrap
      : JSON.stringify({ customQuestions: [], customSources: [], customTypes: {}, customAnswers: [] }),
    requests: [],
    getBootstrap: function () {
      if (options && options.bootstrapThrows) {
        throw new Error("bootstrap failed");
      }
      return bridge.bootstrap;
    },
    request: function (id, method, payloadJson) {
      const payload = payloadJson ? JSON.parse(payloadJson) : {};
      bridge.requests.push({ id: id, method: method, payload: payload });
      return handler(id, method, payload);
    }
  };
  return bridge;
}

function reply(bridge, id, result) {
  bridge.lastCallback = { id: id, result: result };
  if (typeof global.__nativeResult === "function") {
    return global.__nativeResult(id, result);
  }
  return false;
}

/* ------------------------------------------------------------------------- */
/* Fake DOM for ai-settings.js only                                          */
/* ------------------------------------------------------------------------- */

class FakeClassList {
  constructor(node) {
    this.node = node;
    this.values = new Set();
  }
  add(value) { this.values.add(String(value)); }
  remove(value) { this.values.delete(String(value)); }
  contains(value) { return this.values.has(String(value)); }
  toggle(value, force) {
    if (force === undefined) {
      if (this.values.has(String(value))) {
        this.values.delete(String(value));
        return false;
      }
      this.values.add(String(value));
      return true;
    }
    if (force) {
      this.values.add(String(value));
      return true;
    }
    this.values.delete(String(value));
    return false;
  }
}

class FakeNode {
  constructor(tagName, documentRef) {
    this.tagName = String(tagName || "#text").toUpperCase();
    this.ownerDocument = documentRef || null;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this.classList = new FakeClassList(this);
    this._text = "";
    this.id = "";
    this.className = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.selected = false;
    this.open = false;
  }
  get firstChild() {
    return this.children.length ? this.children[0] : null;
  }
  get lastChild() {
    return this.children.length ? this.children[this.children.length - 1] : null;
  }
  appendChild(child) {
    if (!child) {
      return child;
    }
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.children.push(child);
    if (this.ownerDocument) {
      this.ownerDocument._register(child);
    }
    return child;
  }
  insertBefore(child, reference) {
    if (!reference) {
      return this.appendChild(child);
    }
    const index = this.children.indexOf(reference);
    if (index < 0) {
      return this.appendChild(child);
    }
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.children.splice(index, 0, child);
    if (this.ownerDocument) {
      this.ownerDocument._register(child);
    }
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, String(name))
      ? this.attributes[String(name)]
      : null;
  }
  matches(selector) {
    const raw = String(selector || "").trim();
    if (!raw || this.tagName === "#TEXT") {
      return false;
    }
    const parts = raw.split(",").map(function (part) { return part.trim(); }).filter(Boolean);
    return parts.some((part) => {
      let rest = part;
      let tag = "";
      const tagMatch = rest.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
      if (tagMatch) {
        tag = tagMatch[1].toUpperCase();
        rest = rest.slice(tagMatch[0].length);
      }
      if (tag && this.tagName !== tag) {
        return false;
      }
      const idMatch = rest.match(/#([A-Za-z0-9_-]+)/);
      if (idMatch && this.id !== idMatch[1]) {
        return false;
      }
      const classMatches = rest.match(/\.([A-Za-z0-9_-]+)/g) || [];
      const classes = String(this.className || "").split(/\s+/).filter(Boolean);
      for (let index = 0; index < classMatches.length; index += 1) {
        if (!classes.includes(classMatches[index].slice(1))) {
          return false;
        }
      }
      const attrMatches = rest.match(/\[([A-Za-z0-9_-]+)(?:=(["'])(.*?)\2)?\]/g) || [];
      for (let index = 0; index < attrMatches.length; index += 1) {
        const match = attrMatches[index].match(/^\[([A-Za-z0-9_-]+)(?:=(["'])(.*?)\2)?\]$/);
        if (!match) {
          continue;
        }
        const value = this.dataset[match[1]] !== undefined
          ? String(this.dataset[match[1]])
          : this.getAttribute(match[1]);
        if (match[3] !== undefined && String(value) !== match[3]) {
          return false;
        }
        if (match[3] === undefined && value === null) {
          return false;
        }
      }
      return true;
    });
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches && node.matches(selector)) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }
  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length ? all[0] : null;
  }
  querySelectorAll(selector) {
    const result = [];
    const visit = (node) => {
      node.children.forEach((child) => {
        if (child.matches && child.matches(selector)) {
          result.push(child);
        }
        visit(child);
      });
    };
    visit(this);
    return result;
  }
  replaceChildren() {
    this.children.forEach(function (child) { child.parentNode = null; });
    this.children = [];
    const appendAny = (item) => {
      if (Array.isArray(item)) {
        item.forEach(appendAny);
      } else if (typeof item === "string" || typeof item === "number") {
        this.appendChild(this.ownerDocument.createTextNode(String(item)));
      } else if (item !== null && item !== undefined) {
        this.appendChild(item);
      }
    };
    Array.prototype.slice.call(arguments).forEach(appendAny);
  }
  setAttribute(name, value) {
    const key = String(name);
    this.attributes[key] = String(value);
    if (key === "id") {
      this.id = String(value);
      if (this.ownerDocument) {
        this.ownerDocument._register(this);
      }
    } else if (key === "class") {
      this.className = String(value);
    } else if (key === "value") {
      this.value = String(value);
    } else if (key === "disabled") {
      this.disabled = true;
    } else if (key === "hidden") {
      this.hidden = true;
    } else if (key === "selected") {
      this.selected = true;
    }
  }
  removeAttribute(name) {
    delete this.attributes[String(name)];
    if (String(name) === "id") {
      this.id = "";
    }
  }
  addEventListener(type, handler) {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(handler);
  }
  fireEvent(type) {
    const event = {
      type: type,
      target: this,
      defaultPrevented: false,
      preventDefault: function () { this.defaultPrevented = true; },
      stopPropagation: function () {}
    };
    const handlers = this.listeners[type] || [];
    handlers.forEach((handler) => handler(event));
    return event;
  }
  click() {
    if (this.disabled) {
      return false;
    }
    this.fireEvent("click");
    return true;
  }
  focus() {}
  scrollIntoView() {}
  get textContent() {
    if (this._text) {
      return this._text;
    }
    return this.children.map(function (child) {
      return child.textContent || "";
    }).join("");
  }
  set textContent(value) {
    this.children.forEach(function (child) { child.parentNode = null; });
    this.children = [];
    this._text = String(value === null || value === undefined ? "" : value);
  }
}

class FakeDocument {
  constructor() {
    this.byId = new Map();
    this._nodes = [];
    this.documentElement = new FakeNode("html", this);
    this.body = new FakeNode("body", this);
    this.documentElement.appendChild(this.body);
    this.readyState = "complete";
    this.title = "";
  }
  createElement(tag) { return new FakeNode(tag, this); }
  createTextNode(text) {
    const node = new FakeNode("#text", this);
    node._text = String(text);
    return node;
  }
  createElementNS(_namespace, tag) { return new FakeNode(tag, this); }
  _register(node) {
    if (node.id) {
      this.byId.set(node.id, node);
    }
    if (node !== this.documentElement && node !== this.body && !this._nodes.includes(node)) {
      this._nodes.push(node);
    }
  }
  getElementById(id) {
    return this.byId.get(String(id)) || null;
  }
  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length ? all[0] : null;
  }
  querySelectorAll(selector) {
    const result = [];
    const visit = (node) => {
      node.children.forEach((child) => {
        if (child.matches && child.matches(selector)) {
          result.push(child);
        }
        visit(child);
      });
    };
    visit(this.documentElement);
    return result;
  }
}

function makeStorage() {
  const map = new Map();
  return {
    map: map,
    getItem: function (key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    setItem: function (key, value) { map.set(String(key), String(value)); },
    removeItem: function (key) { map.delete(String(key)); }
  };
}

function loadAISettings(nativeApp, storage) {
  const documentValue = new FakeDocument();
  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    URL: URL,
    Promise: Promise,
    JSON: JSON,
    Date: Date,
    Math: Math,
    Object: Object,
    Array: Array,
    String: String,
    Number: Number,
    Boolean: Boolean,
    Error: Error,
    RegExp: RegExp,
    Map: Map,
    Set: Set,
    document: documentValue,
    localStorage: storage || makeStorage(),
    dispatchEvent: function () {},
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  if (nativeApp) {
    sandbox.NativeApp = nativeApp;
  }
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "preview", "ai-settings.js"), "utf8"), sandbox, {
    filename: "ai-settings.js"
  });
  return {
    api: sandbox.StudyAISettings,
    document: documentValue,
    storage: sandbox.localStorage,
    sandbox: sandbox
  };
}

function makeFakeNative(handler) {
  const calls = [];
  return {
    hasBridge: true,
    isNative: true,
    calls: calls,
    call: function (method, payload, options) {
      calls.push({ method: method, payload: payload, options: options });
      return Promise.resolve(handler(method, payload, options, calls));
    }
  };
}

function loadApp(options) {
  const settings = options || {};
  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: function () { return 1; },
    clearInterval: function () {},
    URL: URL,
    Date: Date,
    Math: Math,
    JSON: JSON,
    Promise: Promise,
    Map: Map,
    Set: Set,
    Object: Object,
    Array: Array,
    String: String,
    Number: Number,
    Boolean: Boolean,
    Error: Error,
    RegExp: RegExp,
    localStorage: settings.storage || makeStorage(),
    STUDY_DATA: settings.studyData || {
      sources: [{ id: 1, name: "测试资料", format: ".pdf" }],
      questions: [
        { id: 1, chapter: "第1章", question: "测试题", answer: "测试答案", source_id: 1, locator: "第1页" }
      ],
      edition: "test"
    },
    GENERATED_ANSWERS: [],
    QUESTION_IMAGES: {},
    QUESTION_TYPES: { "1": "简答题" }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "preview", "app.js"), "utf8"), sandbox, {
    filename: "app.js"
  });
  return sandbox.StudyApp;
}

function makeElement(documentRef, tag, attributes) {
  const node = documentRef.createElement(tag);
  Object.keys(attributes || {}).forEach(function (key) {
    if (key === "dataset") {
      Object.assign(node.dataset, attributes[key]);
    } else {
      node.setAttribute(key, attributes[key]);
    }
  });
  return node;
}

function installPageShell(documentRef) {
  const shell = makeElement(documentRef, "div", { id: "app-shell", class: "app-shell" });
  const scroll = makeElement(documentRef, "div", { id: "app-scroll", class: "app-scroll" });
  const main = makeElement(documentRef, "main", { id: "main-content", tabindex: "-1" });
  const rating = makeElement(documentRef, "div", { id: "rating-dock", class: "rating-dock" });
  const storage = makeElement(documentRef, "div", { id: "storage-warning", hidden: "" });
  const toast = makeElement(documentRef, "div", { id: "toast", hidden: "" });
  const tabbar = makeElement(documentRef, "nav", { class: "tabbar" });
  ["review", "select", "stats", "me"].forEach(function (tab) {
    const button = makeElement(documentRef, "button", {
      class: "tab-button",
      "data-tab": tab
    });
    button.dataset.tab = tab;
    button.textContent = tab;
    tabbar.appendChild(button);
  });
  scroll.appendChild(main);
  shell.appendChild(scroll);
  shell.appendChild(rating);
  shell.appendChild(tabbar);
  shell.appendChild(storage);
  shell.appendChild(toast);
  documentRef.body.appendChild(shell);
  return { shell: shell, scroll: scroll, main: main, rating: rating, tabbar: tabbar };
}

function makeNativeForApp() {
  const state = {
    manifestConfigured: false,
    generateCalls: 0,
    acceptCalls: [],
    installCalls: [],
    exportCalls: [],
    reloads: 0
  };
  const documentForImport = {
    id: 42,
    name: "自然地理学笔记.pdf",
    format: "pdf",
    needsOcr: true,
    pages: [
      { pageIndex: 0, locator: "PDF 第1页 · 第一段", text: "甲".repeat(300) },
      { pageIndex: 1, locator: "PDF 第2页 · 第二段", text: "乙".repeat(300) }
    ]
  };
  const native = {
    hasBridge: true,
    isNative: true,
    calls: [],
    state: state,
    call: function (method, payload) {
      native.calls.push({ method: method, payload: payload });
      if (method === "getReminder") {
        return Promise.resolve({ enabled: false, time: "20:30", permissionGranted: false });
      }
      if (method === "saveReminder") {
        return Promise.resolve({ enabled: Boolean(payload.enabled), time: payload.time, permissionGranted: true });
      }
      if (method === "listImports") {
        return Promise.resolve([{ id: 42, name: "自然地理学笔记.pdf", format: "pdf", pageCount: 2 }]);
      }
      if (method === "getImport") {
        return Promise.resolve(documentForImport);
      }
      if (method === "pickImport") {
        return Promise.resolve(documentForImport);
      }
      if (method === "getUpdateConfig") {
        return Promise.resolve({ manifestUrl: state.manifestConfigured ? "https://example.com/update.json" : "" });
      }
      if (method === "saveUpdateConfig") {
        state.manifestConfigured = Boolean(payload.manifestUrl);
        return Promise.resolve({ manifestUrl: payload.manifestUrl });
      }
      if (method === "checkUpdate") {
        if (!state.manifestConfigured) {
          return Promise.reject(new Error("尚未设置发布地址"));
        }
        return Promise.resolve({
          available: true,
          versionCode: 4,
          versionName: "0.3.1",
          notes: "修复提醒与导入流程",
          apkUrl: "https://example.com/shanchuanji-0.3.1.apk",
          sha256: "b".repeat(64)
        });
      }
      if (method === "installUpdate") {
        state.installCalls.push(payload);
        return Promise.resolve({});
      }
      if (method === "appInfo") {
        return Promise.resolve({ versionName: "0.3.0", versionCode: 1, packageName: "cn.pingjianganlan.study" });
      }
      if (method === "getApiConfig") {
        return Promise.resolve({
          serviceName: "测试服务",
          baseUrl: "https://api.example.com/v1",
          model: "manual-model",
          maxQuestions: 5,
          hasKey: true
        });
      }
      if (method === "generate") {
        state.generateCalls += 1;
        return Promise.resolve({
          importId: 42,
          sourceName: "自然地理学笔记.pdf",
          questions: [
            {
              question: "生成的题干一？",
              answer: "生成的答案一。",
              type: "简答题",
              chapter: "第1章",
              sourceQuote: "原文引用一",
              pageIndex: 0,
              locator: "PDF 第1页 · 第一段"
            },
            {
              question: "生成的题干二？",
              answer: "生成的答案二。",
              type: "名词解释",
              chapter: "第2章",
              sourceQuote: "原文引用二",
              pageIndex: 1,
              locator: "PDF 第2页 · 第二段"
            }
          ]
        });
      }
      if (method === "acceptQuestions") {
        state.acceptCalls.push(payload);
        return Promise.resolve({ count: payload.questions.length });
      }
      if (method === "exportBackup") {
        state.exportCalls.push(payload);
        return Promise.resolve({});
      }
      if (method === "importBackup") {
        return Promise.resolve({
          state: {
            schemaVersion: 1,
            settings: { dailyTarget: 5, accountName: "恢复同学", reminder: { enabled: false, time: "21:00" } },
            referenceIds: [],
            selectedIds: [],
            answerEdits: {},
            session: null,
            history: [],
            imports: [],
            schedule: {},
            lastUpdated: null
          }
        });
      }
      return Promise.resolve({});
    }
  };
  return native;
}

function loadAppDOM(nativeApp, storageOverride) {
  const documentValue = new FakeDocument();
  installPageShell(documentValue);
  const storage = storageOverride || makeStorage();
  const reloadState = { count: 0 };
  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: function () { return 1; },
    clearInterval: function () {},
    URL: URL,
    Date: Date,
    Math: Math,
    JSON: JSON,
    Promise: Promise,
    Map: Map,
    Set: Set,
    Object: Object,
    Array: Array,
    String: String,
    Number: Number,
    Boolean: Boolean,
    Error: Error,
    RegExp: RegExp,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isFinite: isFinite,
    isNaN: isNaN,
    Node: FakeNode,
    document: documentValue,
    localStorage: storage,
    confirm: function () { return true; },
    addEventListener: function () {},
    removeEventListener: function () {},
    dispatchEvent: function () {},
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    location: { reload: function () { reloadState.count += 1; } },
    innerWidth: 390,
    innerHeight: 844
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  if (nativeApp) {
    sandbox.NativeApp = nativeApp;
  }
  sandbox.STUDY_DATA = {
    sources: [{ id: 1, name: "测试资料", format: ".pdf" }],
    questions: [
      {
        id: 1,
        chapter: "第1章",
        question: "测试题？",
        options: "A. 甲 B. 乙",
        answer: "A 甲",
        explanation: "测试解析",
        source_id: 1,
        locator: "第1页"
      },
      {
        id: 2,
        chapter: "第2章",
        question: "第二题？",
        answer: "第二答案",
        source_id: 1,
        locator: "第2页"
      }
    ],
    edition: "test"
  };
  sandbox.GENERATED_ANSWERS = [];
  sandbox.QUESTION_IMAGES = {};
  sandbox.QUESTION_TYPES = { "1": "选择题", "2": "简答题" };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "preview", "ai-settings.js"), "utf8"), sandbox, {
    filename: "ai-settings.js"
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "preview", "app.js"), "utf8"), sandbox, {
    filename: "app.js"
  });
  return {
    app: sandbox.StudyApp,
    document: documentValue,
    storage: storage,
    reloadState: reloadState,
    sandbox: sandbox
  };
}

function bodyText(documentRef) {
  return documentRef.body.textContent;
}

/* ------------------------------------------------------------------------- */
/* Tests                                                                     */
/* ------------------------------------------------------------------------- */

async function run() {
  await testAsync("getBootstrap 合并新增来源/题目/题型/答案且不覆盖内置题", async function () {
    const bridge = makeBridge(function () {}, {
      bootstrap: JSON.stringify({
        customSources: [
          { id: 900, name: "用户导入资料.pdf", format: ".pdf" },
          { id: 1, name: "不应覆盖内置来源" }
        ],
        customQuestions: [
          { id: 900, chapter: "第9章", question: "自定义题？", answer: "自定义答案", source_id: 900, locator: "第3页" },
          { id: 1, question: "不应覆盖内置题" }
        ],
        customTypes: { "900": "论述题", "1": "选择题" },
        customAnswers: [
          { question_id: 901, answer: "补充答案", status: "draft" }
        ]
      })
    });
    const studyData = {
      sources: [{ id: 1, name: "内置资料", format: ".pdf" }],
      questions: [{ id: 1, chapter: "第1章", question: "内置题", answer: "内置答案", source_id: 1 }],
      edition: "built-in"
    };
    const adapter = loadAdapter(bridge, {
      studyData: studyData,
      generated: [{ question_id: 1, answer: "内置初稿", status: "draft" }],
      types: { "1": "简答题" }
    });
    assert.equal(adapter.hasBridge, true);
    assert.equal(adapter.isPreview, false);
    assert.equal(studyData.sources.length, 2);
    assert.equal(studyData.sources[0].name, "内置资料");
    assert.equal(studyData.sources[1].name, "用户导入资料.pdf");
    assert.equal(studyData.questions.length, 2);
    assert.equal(studyData.questions[0].question, "内置题");
    assert.equal(studyData.questions[1].id, 900);
    assert.equal(studyData.questions[1].answer, "自定义答案");
    assert.equal(global.QUESTION_TYPES["1"], "简答题");
    assert.equal(global.QUESTION_TYPES["900"], "论述题");
    assert.equal(global.GENERATED_ANSWERS.length, 2);
    assert.equal(global.GENERATED_ANSWERS[1].question_id, 901);
    assert.equal(adapter.mergeSummary.sources, 1);
    assert.equal(adapter.mergeSummary.questions, 1);
    assert.equal(adapter.mergeSummary.types, 1);
    assert.equal(adapter.mergeSummary.answers, 1);
    assert.equal(adapter.bootstrapError, "");
  });

  await testAsync("getBootstrap 抛错时保留原题库并给出提示", async function () {
    const studyData = {
      sources: [{ id: 1, name: "内置资料", format: ".pdf" }],
      questions: [{ id: 1, question: "内置题", answer: "内置答案", source_id: 1 }],
      edition: "built-in"
    };
    const bridge = makeBridge(function () {}, { bootstrapThrows: true });
    const adapter = loadAdapter(bridge, { studyData: studyData, types: { "1": "简答题" } });
    assert.equal(adapter.bootstrapError.length > 0, true);
    assert.equal(studyData.questions.length, 1);
    assert.equal(studyData.questions[0].question, "内置题");
    assert.equal(global.QUESTION_TYPES["1"], "简答题");
  });

  await testAsync("call 成功与失败：严格读取 {ok,data,error}", async function () {
    const bridge = makeBridge(function (id, method) {
      if (method === "testApi") {
        reply(bridge, id, { ok: true, data: { models: ["m-a", "m-b"] } });
      } else if (method === "failMethod") {
        reply(bridge, id, { ok: false, error: "服务返回 HTTP 401" });
      }
    });
    const adapter = loadAdapter(bridge);
    const result = await adapter.call("testApi", {}, { timeoutMs: 500 });
    assert.deepEqual(result.models, ["m-a", "m-b"]);
    let failure = null;
    try {
      await adapter.call("failMethod", {}, { timeoutMs: 500 });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.equal(failure.code, "native");
    assert.equal(failure.message, "服务返回 HTTP 401");
    assert.equal(adapter.pendingCount(), 0);
  });

  await testAsync("call 超时后忽略迟到的重复回调", async function () {
    let slowId = "";
    const bridge = makeBridge(function (id, method) {
      if (method === "slow") {
        slowId = id;
      }
    });
    const adapter = loadAdapter(bridge);
    let error = null;
    try {
      await adapter.call("slow", {}, { timeoutMs: 35 });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.equal(error.code, "timeout");
    assert.equal(adapter.pendingCount(), 0);
    assert.equal(reply(bridge, slowId, { ok: true, data: { late: true } }), false);
  });

  await testAsync("cancel 只结算一次，迟到回调不会二次 resolve/reject", async function () {
    let slowId = "";
    const bridge = makeBridge(function (id, method) {
      if (method === "slow") {
        slowId = id;
      }
    });
    const adapter = loadAdapter(bridge);
    let settlements = 0;
    const promise = adapter.call("slow", {}, { timeoutMs: 500 }).then(function () {
      settlements += 1;
      return "resolved";
    }).catch(function (error) {
      settlements += 1;
      assert.equal(error.code, "canceled");
      return "canceled";
    });
    await flush();
    assert.equal(adapter.isPending(slowId), true);
    assert.equal(adapter.cancel(slowId), true);
    assert.equal(await promise, "canceled");
    assert.equal(reply(bridge, slowId, { ok: true, data: {} }), false);
    assert.equal(settlements, 1);
    assert.equal(adapter.pendingCount(), 0);
  });

  await testAsync("无桥时明确失败，不伪装已连接", async function () {
    const adapter = loadAdapter(null);
    assert.equal(adapter.hasBridge, false);
    assert.equal(adapter.isPreview, true);
    let error = null;
    try {
      await adapter.call("testApi", {});
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.equal(error.code, "unavailable");
  });

  await testAsync("pickImport 取消/成功与 true locator、12000 字默认范围", async function () {
    const app = loadApp();
    const native = app.debug.native;
    const cancelled = await (async function () {
      const bridge = makeBridge(function (id) {
        reply(bridge, id, { ok: false, error: "用户取消选择" });
      });
      const adapter = loadAdapter(bridge);
      try {
        await adapter.call("pickImport", {}, { timeoutMs: 500 });
        return null;
      } catch (error) {
        return error;
      }
    })();
    assert.ok(cancelled);
    assert.match(cancelled.message, /取消/);

    const documentValue = native.normalizeImportDocument({
      id: 42,
      name: "自然地理学笔记.pdf",
      format: "pdf",
      needsOcr: true,
      pages: [
        { pageIndex: 0, locator: "PDF 第1页 · 第一段", text: "甲".repeat(6000) },
        { pageIndex: 1, locator: "PDF 第2页 · 第二段", text: "乙".repeat(6000) },
        { pageIndex: 2, locator: "PDF 第3页 · 第三段", text: "丙".repeat(1000) }
      ]
    });
    assert.equal(documentValue.pages.length, 3);
    assert.equal(documentValue.pages[0].locator, "PDF 第1页 · 第一段");
    assert.deepEqual(native.defaultImportPageIndexes(documentValue), [0, 1]);
    assert.equal(native.importCharLimit, 12000);
    const tooLarge = native.normalizeImportDocument({
      id: 43,
      name: "超大页.pdf",
      format: "pdf",
      pages: [{ pageIndex: 0, locator: "第1页", text: "字".repeat(13000) }]
    });
    assert.deepEqual(native.defaultImportPageIndexes(tooLarge), []);
  });

  await testAsync("草稿编辑后 accept payload 使用用户修订且不含密钥字段", async function () {
    const app = loadApp();
    const native = app.debug.native;
    const payload = native.buildAcceptQuestionsPayload([
      {
        question: "  修改后的题干？ ",
        answer: "  修改后的答案。 ",
        type: "论述题",
        chapter: "第9章",
        sourceQuote: "原文引用",
        pageIndex: 2,
        locator: "PDF 第3页",
        selected: true,
        apiKey: "never-export-me"
      },
      {
        question: "第二题",
        answer: "第二答案",
        type: "读图分析题",
        chapter: "第4章",
        sourceQuote: "",
        pageIndex: 4,
        locator: "第5页"
      }
    ]);
    assert.deepEqual(payload, [
      {
        question: "修改后的题干？",
        answer: "修改后的答案。",
        type: "论述题",
        chapter: "第9章",
        sourceQuote: "原文引用",
        pageIndex: 2,
        locator: "PDF 第3页"
      },
      {
        question: "第二题",
        answer: "第二答案",
        type: "读图分析题",
        chapter: "第4章",
        sourceQuote: "",
        pageIndex: 4,
        locator: "第5页"
      }
    ]);
    assert.equal(JSON.stringify(payload).includes("never-export-me"), false);
    assert.equal(JSON.stringify(payload).includes("apiKey"), false);
  });

  await testAsync("备份恢复只接受基础 shape，并清理未知字段", async function () {
    const app = loadApp();
    const native = app.debug.native;
    const valid = native.validateRestoredState({
      settings: { accountName: "恢复同学" },
      referenceIds: [1],
      selectedIds: [1],
      answerEdits: { "1": { text: "修订" } },
      session: null,
      history: [{ id: 1, date: "2026-10-20", rating: "known" }],
      imports: [],
      schedule: { "1": { nextDue: "2026-10-21" } },
      lastUpdated: "2026-10-20T00:00:00.000Z",
      schemaVersion: 1,
      maliciousField: "drop"
    });
    assert.ok(valid);
    assert.equal(valid.schemaVersion, 2);
    assert.equal(valid.settings.accountName, "恢复同学");
    assert.equal(valid.maliciousField, undefined);
    assert.equal(valid.history.length, 1);
    assert.equal(native.validateRestoredState({ settings: "bad" }), null);
    assert.equal(native.validateRestoredState({ history: "bad", settings: {} }), null);
    assert.equal(native.validateRestoredState({}), null);
    assert.equal(native.validateRestoredState(null), null);
    assert.equal(native.validateRestoredState([1, 2, 3]), null);
  });

  await testAsync("更新地址未配置/有新版检查接口语义", async function () {
    let configured = false;
    const bridge = makeBridge(function (id, method) {
      if (method === "checkUpdate") {
        if (!configured) {
          reply(bridge, id, { ok: false, error: "尚未设置发布地址" });
        } else {
          reply(bridge, id, {
            ok: true,
            data: {
              available: true,
              versionCode: 4,
              versionName: "0.3.1",
              notes: "修复提醒与导入",
              apkUrl: "https://example.com/shanchuanji-0.3.1.apk",
              sha256: "a".repeat(64)
            }
          });
        }
      } else if (method === "saveUpdateConfig") {
        configured = true;
        reply(bridge, id, { ok: true, data: { manifestUrl: "https://example.com/update.json" } });
      }
    });
    const adapter = loadAdapter(bridge);
    let failure = null;
    try {
      await adapter.call("checkUpdate", {}, { timeoutMs: 500 });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.match(failure.message, /发布地址/);
    await adapter.call("saveUpdateConfig", { manifestUrl: "https://example.com/update.json" }, { timeoutMs: 500 });
    const result = await adapter.call("checkUpdate", {}, { timeoutMs: 500 });
    assert.equal(result.available, true);
    assert.equal(result.versionCode, 4);
    assert.equal(result.versionName, "0.3.1");
    assert.match(result.notes, /提醒/);
    const manifest = appManifestValidation();
    assert.equal(nativeUpdateUrl(manifest, "https://example.com/update.json").ok, true);
    assert.equal(nativeUpdateUrl(manifest, "http://example.com/update.json").ok, false);
    assert.equal(nativeUpdateUrl(manifest, "").ok, true);
  });

  await testAsync("安装版默认官方更新清单可见并说明可覆盖", async function () {
    const native = makeNativeForApp();
    const fallback = native.call;
    const defaultUrl =
      "https://raw.githubusercontent.com/cymarlboro/pingjiang-anlan/main/update.json";
    native.call = function (method, payload, options) {
      if (method === "getUpdateConfig") {
        return Promise.resolve({ manifestUrl: defaultUrl, usingDefault: true });
      }
      return fallback.call(native, method, payload, options);
    };
    const env = loadAppDOM(native);
    await flush();
    env.app.navigate("me");
    await flush();
    await flush();
    await flush();
    const input = env.document.getElementById("native-update-manifest");
    assert.ok(input);
    assert.equal(input.value, defaultUrl);
    assert.match(bodyText(env.document), /当前使用官方默认清单/);
    assert.match(bodyText(env.document), /清空输入并保存可关闭自动检查/);
  });

  await testAsync("安装版启动/恢复更新事件显示横幅并复用已验证安装器", async function () {
    const native = makeNativeForApp();
    native.state.manifestConfigured = true;
    const env = loadAppDOM(native);
    await flush();
    const shown = env.sandbox.__nativeUpdateAvailable({
      available: true,
      versionCode: 5,
      versionName: "0.3.2",
      notes: "修复提醒并增加更新提示",
      apkUrl: "https://example.com/shanchuanji-0.3.2.apk",
      sha256: "c".repeat(64)
    });
    assert.equal(shown, true);
    await flush();
    const banner = env.document.getElementById("native-update-banner");
    assert.ok(banner);
    assert.match(banner.textContent, /发现新版本 0\.3\.2/);
    assert.match(banner.textContent, /校验 SHA256、包名、签名和版本/);
    const install = env.document.getElementById("native-update-banner-install");
    assert.ok(install);
    install.click();
    await flush();
    await flush();
    assert.equal(native.state.installCalls.length, 1);
    assert.equal(native.state.installCalls[0].versionCode, 5);
    assert.equal(native.state.installCalls[0].apkUrl,
      "https://example.com/shanchuanji-0.3.2.apk");
    const dismiss = env.document.getElementById("native-update-banner-dismiss");
    assert.ok(dismiss);
    dismiss.click();
    await flush();
    assert.equal(env.document.querySelector("#native-update-banner"), null);
  });

  await testAsync("AI 原生保存：密钥只进 saveApiConfig，保存后输入清空且不进入网页存储", async function () {
    const storage = makeStorage();
    let savedConfig = {
      serviceName: "兼容接口",
      baseUrl: "https://api.example.com/v1",
      model: "manual-model",
      maxQuestions: 5,
      hasKey: false
    };
    const native = makeFakeNative(function (method, payload) {
      if (method === "getApiConfig") {
        return savedConfig;
      }
      if (method === "saveApiConfig") {
        if (payload.clearKey) {
          savedConfig = Object.assign({}, savedConfig, { hasKey: false });
        } else {
          savedConfig = {
            serviceName: payload.serviceName,
            baseUrl: payload.baseUrl,
            model: payload.model,
            maxQuestions: payload.maxQuestions,
            hasKey: Boolean(payload.apiKey) || savedConfig.hasKey
          };
        }
        return savedConfig;
      }
      if (method === "testApi") {
        return {
          models: ["model-from-service-a", "model-from-service-b"],
          configuredModel: "manual-model",
          modelListed: false,
          connectionScope: "model-list-only"
        };
      }
      return {};
    });
    const loaded = loadAISettings(native, storage);
    const details = loaded.api.render();
    assert.ok(details);
    await flush();
    await flush();
    const base = loaded.document.getElementById("ai-base-url");
    const model = loaded.document.getElementById("ai-model");
    const key = loaded.document.getElementById("ai-api-key");
    const save = loaded.document.getElementById("ai-save");
    const testButton = loaded.document.getElementById("ai-test-connection");
    const clear = loaded.document.getElementById("ai-clear-key");
    const status = loaded.document.getElementById("ai-status");
    assert.ok(base && model && key && save);
    assert.equal(base.value, "https://api.example.com/v1");
    assert.equal(model.value, "manual-model");

    const secret = "sk-test-should-not-persist-9f2a";
    key.value = secret;
    key.fireEvent("input");
    save.click();
    await flush();
    await flush();

    const saveCall = native.calls.find(function (call) { return call.method === "saveApiConfig"; });
    assert.ok(saveCall);
    assert.equal(saveCall.payload.apiKey, secret);
    assert.equal(key.value, "");
    assert.equal(JSON.stringify(savedConfig).includes(secret), false);
    assert.equal(JSON.stringify(storage.map).includes(secret), false);
    assert.equal(JSON.stringify(loaded.api.getNativeConfig()).includes(secret), false);
    assert.equal(JSON.stringify(loaded.api.getNativeConfig()).includes("apiKey"), false);
    assert.equal(loaded.api.getNativeConfig().hasKey, true);
    assert.equal(status.textContent.includes(secret), false);
    assert.equal(testButton.disabled, false);

    testButton.click();
    await flush();
    await flush();
    const modelsBox = loaded.document.getElementById("ai-models");
    assert.equal(modelsBox.hidden, false);
    assert.match(modelsBox.textContent, /model-from-service-a/);
    assert.match(status.textContent, /连接成功/);
    assert.match(status.textContent, /manual-model/);
    assert.match(status.textContent, /不在服务返回的模型列表中/);
    assert.match(status.textContent, /不会自动替换/);
    assert.match(status.textContent, /不代表.*生成|未通过生成/);
    assert.equal(model.value, "manual-model");

    native.call = function (method, payload, options) {
      native.calls.push({ method: method, payload: payload, options: options });
      if (method === "testApi") {
        return Promise.reject(new Error("服务不支持 /models（HTTP 404）"));
      }
      if (method === "saveApiConfig") {
        savedConfig = Object.assign({}, savedConfig, { hasKey: false, clearKey: undefined });
        return Promise.resolve(savedConfig);
      }
      return Promise.resolve({});
    };
    testButton.click();
    await flush();
    await flush();
    assert.match(status.textContent, /连接测试未成功/);
    assert.match(status.textContent, /手动填写模型名称/);
    assert.equal(modelsBox.hidden, true);

    clear.click();
    await flush();
    await flush();
    const clearCall = native.calls.filter(function (call) { return call.method === "saveApiConfig"; }).pop();
    assert.equal(clearCall.payload.clearKey, true);
    assert.equal(Object.prototype.hasOwnProperty.call(clearCall.payload, "apiKey"), false);
    assert.equal(loaded.api.getNativeConfig().hasKey, false);
    assert.equal(key.value, "");
  });

  await testAsync("网页预览 AI 设置保持只存非敏感项、密钥仅内存、连接测试禁用", async function () {
    const storage = makeStorage();
    const loaded = loadAISettings(null, storage);
    loaded.api.render();
    await flush();
    const key = loaded.document.getElementById("ai-api-key");
    const base = loaded.document.getElementById("ai-base-url");
    const model = loaded.document.getElementById("ai-model");
    const save = loaded.document.getElementById("ai-save");
    const testButton = loaded.document.getElementById("ai-test-connection");
    assert.equal(testButton.disabled, true);
    const secret = "sk-preview-memory-only";
    key.value = secret;
    key.fireEvent("input");
    assert.equal(loaded.api.hasRuntimeKey(), true);
    base.value = "https://api.example.com/v1";
    model.value = "manual-model";
    save.click();
    await flush();
    assert.equal(JSON.stringify(storage.map).includes(secret), false);
    assert.equal(JSON.stringify(loaded.api.getSafeSettings()).includes(secret), false);
    assert.equal(testButton.disabled, true);
    assert.match(loaded.document.getElementById("ai-status").textContent, /网页/);
  });

  await testAsync("浏览器预览 DOM 渲染保持诚实预览状态", async function () {
    const env = loadAppDOM(null);
    assert.match(bodyText(env.document), /今日复习/);
    env.app.navigate("select");
    await flush();
    assert.match(bodyText(env.document), /选题/);
    env.app.navigate("stats");
    await flush();
    assert.match(bodyText(env.document), /记忆曲线/);
    env.app.navigate("me");
    await flush();
    assert.match(bodyText(env.document), /待安装版实现/);
    assert.match(bodyText(env.document), /当前是网页预览/);
    assert.equal(env.document.getElementById("browser-restore-disabled").disabled, true);
    const previewTest = env.document.getElementById("ai-test-connection");
    assert.ok(previewTest);
    assert.equal(previewTest.disabled, true);
    assert.match(previewTest.textContent, /需安卓安装版/);
  });

  await testAsync("安装版 DOM 流程：预览/显式生成/编辑草稿/确认/恢复/更新", async function () {
    const native = makeNativeForApp();
    const env = loadAppDOM(native);
    await flush();
    env.app.navigate("me");
    await flush();
    await flush();
    await flush();
    const text = bodyText(env.document);
    assert.match(text, /山月记 v0\.3\.0/);
    assert.match(text, /离线复习 · AI 解析联网/);
    assert.doesNotMatch(text, /当前是网页预览/);
    assert.match(text, /尚未设置发布地址/);

    const pick = env.document.getElementById("native-pick-import");
    assert.ok(pick);
    assert.equal(pick.disabled, false);
    pick.click();
    await flush();
    await flush();
    assert.match(bodyText(env.document), /自然地理学笔记\.pdf/);
    assert.match(bodyText(env.document), /PDF 第1页 · 第一段/);
    assert.match(bodyText(env.document), /测试服务/);
    assert.equal(native.state.generateCalls, 0);
    const generate = env.document.getElementById("native-generate-import");
    assert.ok(generate);
    assert.equal(generate.disabled, false);
    const generateText = generate.textContent;
    assert.equal(generateText, "发送所选原文并生成问答");

    generate.click();
    await flush();
    await flush();
    assert.equal(native.state.generateCalls, 1);
    assert.match(bodyText(env.document), /待确认草稿 · 2 道/);
    assert.match(bodyText(env.document), /原文引用一/);

    const questionFields = env.document.querySelectorAll('[data-draft-field="question"]');
    const answerFields = env.document.querySelectorAll('[data-draft-field="answer"]');
    const typeFields = env.document.querySelectorAll('[data-draft-field="type"]');
    const chapterFields = env.document.querySelectorAll('[data-draft-field="chapter"]');
    assert.equal(questionFields.length, 2);
    assert.equal(questionFields[0].value, "生成的题干一？");
    assert.equal(answerFields[0].value, "生成的答案一。");
    questionFields[0].value = "用户改后的题干？";
    questionFields[0].fireEvent("input");
    questionFields[0].fireEvent("change");
    answerFields[0].value = "用户改后的答案。";
    answerFields[0].fireEvent("input");
    answerFields[0].fireEvent("change");
    typeFields[0].value = "论述题";
    typeFields[0].fireEvent("change");
    chapterFields[0].value = "第9章";
    chapterFields[0].fireEvent("input");
    chapterFields[0].fireEvent("change");
    const accept = env.document.getElementById("native-accept-drafts");
    assert.ok(accept);
    assert.match(accept.textContent, /确认加入题库 · 2 道/);
    accept.click();
    await flush();
    await flush();
    await new Promise(function (resolve) { setTimeout(resolve, 600); });
    assert.equal(native.state.acceptCalls.length, 1);
    const accepted = native.state.acceptCalls[0];
    assert.equal(accepted.importId, 42);
    assert.equal(accepted.questions[0].question, "用户改后的题干？");
    assert.equal(accepted.questions[0].answer, "用户改后的答案。");
    assert.equal(accepted.questions[0].type, "论述题");
    assert.equal(accepted.questions[0].chapter, "第9章");
    assert.equal(JSON.stringify(accepted).includes("apiKey"), false);
    assert.equal(accepted.questions.length, 2);
    assert.equal(env.reloadState.count > 0, true);

    const restore = env.document.getElementById("native-restore-backup");
    assert.ok(restore);
    restore.click();
    await flush();
    const confirm = env.document.getElementById("native-confirm-restore");
    assert.ok(confirm);
    confirm.click();
    await new Promise(function (resolve) { setTimeout(resolve, 600); });
    const stored = JSON.parse(env.storage.getItem("pingjianganlan.preview.v2"));
    assert.equal(stored.settings.accountName, "恢复同学");
    assert.equal(stored.schemaVersion, 2);
    assert.equal(env.reloadState.count > 1, true);

    const check = env.document.getElementById("native-check-update");
    assert.ok(check);
    check.click();
    await flush();
    await flush();
    assert.match(bodyText(env.document), /尚未设置发布地址/);
    const manifest = env.document.getElementById("native-update-manifest");
    manifest.value = "https://example.com/update.json";
    env.document.getElementById("native-save-update-config").click();
    await flush();
    await flush();
    const checkAgain = env.document.getElementById("native-check-update");
    checkAgain.click();
    await flush();
    await flush();
    assert.match(bodyText(env.document), /发现新版本 0\.3\.1/);
    assert.match(bodyText(env.document), /修复提醒与导入流程/);
    const install = env.document.getElementById("native-install-update");
    assert.ok(install);
    install.click();
    await flush();
    await flush();
    assert.equal(native.state.installCalls.length, 1);
    assert.equal(native.state.installCalls[0].versionCode, 4);
    assert.equal(native.state.installCalls[0].apkUrl, "https://example.com/shanchuanji-0.3.1.apk");
  });

  await testAsync("未确认草稿写入独立本机存储，重载后可恢复且不含密钥", async function () {
    const storage = makeStorage();
    const native = makeNativeForApp();
    const first = loadAppDOM(native, storage);
    await flush();
    first.app.navigate("me");
    await flush();
    await flush();
    await flush();
    first.document.getElementById("native-pick-import").click();
    await flush();
    await flush();
    first.document.getElementById("native-generate-import").click();
    await flush();
    await flush();
    const raw = storage.getItem("pingjianganlan.preview.import-drafts.v1");
    assert.ok(raw);
    assert.equal(raw.includes("apiKey"), false);
    assert.equal(raw.includes("sk-"), false);
    const stored = JSON.parse(raw);
    assert.equal(stored.importId, 42);
    assert.equal(stored.drafts.length, 2);

    const second = loadAppDOM(native, storage);
    await flush();
    second.app.navigate("me");
    await flush();
    await flush();
    await flush();
    assert.match(bodyText(second.document), /已从本机恢复上次未确认的草稿/);
    const restoredQuestions = second.document.querySelectorAll('[data-draft-field="question"]');
    assert.equal(restoredQuestions.length, 2);
    assert.equal(restoredQuestions[0].value, "生成的题干一？");
    const acceptRestored = second.document.getElementById("native-accept-drafts");
    assert.ok(acceptRestored);
    assert.match(acceptRestored.textContent, /确认加入题库 · 2 道/);
  });

  await testAsync("安装版提醒未授权时不显示启用成功，时间仍可保存", async function () {
    const native = makeNativeForApp();
    native.call = function (method, payload) {
      native.calls.push({ method: method, payload: payload });
      if (method === "getReminder") {
        return Promise.resolve({ enabled: false, time: "20:30", permissionGranted: false });
      }
      if (method === "saveReminder") {
        return Promise.resolve({ enabled: payload.enabled, time: payload.time, permissionGranted: false });
      }
      if (method === "listImports") {
        return Promise.resolve([]);
      }
      if (method === "getUpdateConfig") {
        return Promise.resolve({ manifestUrl: "" });
      }
      if (method === "appInfo") {
        return Promise.resolve({ versionName: "0.3.0", versionCode: 1, packageName: "cn.pingjianganlan.study" });
      }
      if (method === "getApiConfig") {
        return Promise.resolve({ serviceName: "", baseUrl: "", model: "", maxQuestions: 5, hasKey: false });
      }
      return Promise.resolve({});
    };
    const env = loadAppDOM(native);
    await flush();
    env.app.navigate("me");
    await flush();
    await flush();
    await flush();
    assert.match(bodyText(env.document), /提醒已关闭/);
    const switchButton = env.document.querySelector(".switch");
    assert.ok(switchButton);
    switchButton.click();
    await flush();
    await flush();
    assert.match(bodyText(env.document), /系统尚未允许通知/);
    assert.doesNotMatch(bodyText(env.document), /提醒已启用。/);
    const reminderCalls = native.calls.filter(function (call) { return call.method === "saveReminder"; });
    assert.equal(reminderCalls.length, 1);
    const time = env.document.getElementById("reminder-time");
    time.value = "21:10";
    time.fireEvent("change");
    await flush();
    await flush();
    const saves = native.calls.filter(function (call) { return call.method === "saveReminder"; });
    assert.equal(saves[saves.length - 1].payload.time, "21:10");
    assert.equal(saves[saves.length - 1].payload.enabled, true);
  });

  await testAsync("安装版提醒在未允许精确闹钟时提示可能延迟并可打开系统设置", async function () {
    const native = makeNativeForApp();
    let exactAllowed = false;
    native.call = function (method, payload) {
      native.calls.push({ method: method, payload: payload });
      if (method === "getReminder") {
        return Promise.resolve({
          enabled: true,
          time: "20:30",
          permissionGranted: true,
          channelEnabled: true,
          exactAlarmAllowed: exactAllowed
        });
      }
      if (method === "requestExactAlarmPermission") {
        exactAllowed = true;
        return Promise.resolve({
          enabled: true,
          time: "20:30",
          permissionGranted: true,
          channelEnabled: true,
          exactAlarmAllowed: true
        });
      }
      if (method === "listImports") {
        return Promise.resolve([]);
      }
      if (method === "getUpdateConfig") {
        return Promise.resolve({ manifestUrl: "" });
      }
      if (method === "appInfo") {
        return Promise.resolve({ versionName: "0.3.0", versionCode: 1, packageName: "cn.pingjianganlan.study" });
      }
      if (method === "getApiConfig") {
        return Promise.resolve({ serviceName: "", baseUrl: "", model: "", maxQuestions: 5, hasKey: false });
      }
      return Promise.resolve({});
    };
    const env = loadAppDOM(native);
    await flush();
    env.app.navigate("me");
    await flush();
    await flush();
    await flush();
    const status = env.document.getElementById("native-reminder-status");
    assert.ok(status);
    assert.match(status.textContent, /可能延迟/);
    assert.match(bodyText(env.document), /打开精确提醒设置/);
    const exactButton = env.document.getElementById("native-exact-alarm-settings");
    assert.ok(exactButton);
    exactButton.click();
    await flush();
    await flush();
    const exactCalls = native.calls.filter(function (call) {
      return call.method === "requestExactAlarmPermission";
    });
    assert.equal(exactCalls.length, 1);
    assert.doesNotMatch(bodyText(env.document), /打开精确提醒设置/);
    assert.match(env.document.getElementById("native-reminder-status").textContent, /已允许精确提醒/);
  });

  console.log("\nAll " + passed + " simulated native UI tests passed.");
  console.log("未在真实 Android 设备或模拟器上安装验证；这些测试不代表 APK 已验收。");
}

function appManifestValidation() {
  const app = loadApp();
  return app.debug.native.validateManifestUrl;
}

function nativeUpdateUrl(validate, value) {
  return validate(value);
}

run().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
