"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const scheduler = require("./preview/memory-scheduler.js");

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

function local(y, m, d, h, min) {
  return new Date(y, m - 1, d, h || 0, min || 0, 0, 0);
}

function approx(actual, expected, epsilon) {
  assert.ok(Math.abs(actual - expected) <= (epsilon || 1e-9),
    "expected " + expected + ", got " + actual);
}

function read(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

test("首次熟记：S=3，下次为本地三天后", function () {
  const now = local(2026, 5, 1, 9, 0);
  const entry = scheduler.applyReview(null, "known", now);
  assert.equal(entry.stability, 3);
  assert.equal(entry.knownCount, 1);
  assert.equal(entry.lapses, 0);
  assert.equal(entry.forcedDueDate, null);
  assert.equal(entry.nextDue, "2026-05-04");
  assert.equal(entry.lastReviewedAt, now.toISOString());
  assert.equal(entry.lastGrowthAt, now.toISOString());
  assert.equal(entry.lastSuccessDate, "2026-05-01");
  assert.equal(entry.legacy, false);
});

test("跨日熟记增长：间隔递增", function () {
  const first = scheduler.applyReview(null, "known", local(2026, 5, 1, 9, 0));
  const second = scheduler.applyReview(first, "known", local(2026, 5, 2, 9, 0));
  assert.equal(second.stability, 5);
  assert.equal(second.knownCount, 2);
  assert.equal(second.lastGrowthAt, local(2026, 5, 2, 9, 0).toISOString());
  assert.equal(second.nextDue, "2026-05-07");
});

test("同日重复熟知不增长", function () {
  const first = scheduler.applyReview(null, "known", local(2026, 5, 1, 9, 0));
  const second = scheduler.applyReview(first, "known", local(2026, 5, 1, 20, 0));
  assert.equal(second.stability, 3);
  assert.equal(second.knownCount, 1);
  assert.equal(second.lastGrowthAt, first.lastGrowthAt);
  assert.equal(second.lastReviewedAt, local(2026, 5, 1, 20, 0).toISOString());
  assert.equal(second.nextDue, "2026-05-04");
});

test("遗忘后同日熟知：仍保留次日强制且不增长", function () {
  const forgot = scheduler.applyReview(null, "forgot", local(2026, 5, 1, 9, 0));
  assert.equal(forgot.stability, 0.5);
  assert.equal(forgot.forcedDueDate, "2026-05-02");
  assert.equal(forgot.nextDue, "2026-05-02");
  assert.equal(forgot.lapses, 1);
  const known = scheduler.applyReview(forgot, "known", local(2026, 5, 1, 10, 0));
  assert.equal(known.stability, 0.5);
  assert.equal(known.forcedDueDate, "2026-05-02");
  assert.equal(known.nextDue, "2026-05-02");
  assert.equal(known.lastGrowthAt, "");
  assert.equal(known.lastSuccessDate, "2026-05-01");
});

test("同日连续遗忘：稳定度只削减一次，lapses 每次累计", function () {
  const first = scheduler.applyReview(null, "forgot", local(2026, 5, 1, 9, 0));
  const second = scheduler.applyReview(first, "forgot", local(2026, 5, 1, 10, 0));
  const third = scheduler.applyReview(second, "forgot", local(2026, 5, 1, 11, 0));
  assert.equal(first.stability, 0.5);
  assert.equal(second.stability, 0.5);
  assert.equal(third.stability, 0.5);
  assert.equal(third.lapses, 3);
  assert.equal(third.forcedDueDate, "2026-05-02");
});

test("后续日期已到 forcedDue 且熟知时解除旧强制日期", function () {
  const forgot = scheduler.applyReview(null, "forgot", local(2026, 5, 1, 9, 0));
  const known = scheduler.applyReview(forgot, "known", local(2026, 5, 2, 10, 0));
  assert.equal(known.forcedDueDate, null);
  assert.equal(known.lastForgotDate, "2026-05-01");
  assert.ok(known.nextDue > "2026-05-02", "nextDue should move past the forced date");
});

test("本地 23:59 跨午夜：nextDue 使用本地日历次日", function () {
  const now = local(2026, 4, 30, 23, 59);
  assert.equal(scheduler.localDateKey(now), "2026-04-30");
  const entry = scheduler.applyReview(null, "known", now);
  assert.equal(entry.nextDue, "2026-05-03");
});

test("旧 schedule 迁移：稳定度按 knownCount 初始化，旧 due 与历史字段保留", function () {
  const updatedAt = local(2026, 4, 30, 20, 0).toISOString();
  const raw = {
    knownCount: 3,
    lapses: 2,
    nextDue: "2026-05-10",
    lastRating: "forgot",
    updatedAt: updatedAt
  };
  const migrated = scheduler.migrateLegacyEntry(raw);
  assert.equal(migrated.stability, 7);
  assert.equal(migrated.legacy, true);
  assert.equal(migrated.nextDue, "2026-05-10");
  assert.equal(migrated.knownCount, 3);
  assert.equal(migrated.lapses, 2);
  assert.equal(migrated.lastRating, "forgot");
  assert.equal(migrated.lastForgotDate, "2026-04-30");
  assert.equal(migrated.updatedAt, updatedAt);

  const dueDateOnly = scheduler.migrateLegacyEntry({ knownCount: 2, dueDate: "2026-06-01" });
  assert.equal(dueDateOnly.stability, 3);
  assert.equal(dueDateOnly.nextDue, "2026-06-01");
  assert.equal(dueDateOnly.legacy, true);
});

test("推荐间隔公式与边界", function () {
  assert.equal(scheduler.recommendIntervalDays(1, 0.9), 1);
  assert.equal(scheduler.recommendIntervalDays(0.5, 0.9), 1);
  assert.equal(scheduler.recommendIntervalDays(2, 0.9), 2);
  assert.equal(scheduler.recommendIntervalDays(365, 0.9), 365);
  assert.equal(scheduler.recommendIntervalDays(1, 0.95), 1);
  assert.equal(scheduler.recommendIntervalDays(1000, 0.9), 365);
});

test("R(t) 计算与稳定度夹取", function () {
  const now = local(2026, 5, 10, 12, 0);
  const oneDayAgo = new Date(now.getTime() - scheduler.MS_PER_DAY).toISOString();
  approx(scheduler.calculateRecall({ stability: 1, lastReviewedAt: oneDayAgo }, now), 0.9, 1e-12);
  approx(scheduler.calculateRecall({ stability: 2, lastReviewedAt: oneDayAgo }, now), Math.sqrt(0.9), 1e-12);
  assert.equal(scheduler.clampStability(0.01), 0.5);
  assert.equal(scheduler.clampStability(9999), 365);
});

test("到期题数量超过每日目标时 rankDue 不丢弃任何一条", function () {
  const now = local(2026, 5, 10, 12, 0);
  const entries = Array.from({ length: 12 }, function (_, index) {
    return {
      id: index + 1,
      stability: 1,
      lastReviewedAt: new Date(now.getTime() - (index + 1) * scheduler.MS_PER_DAY).toISOString(),
      nextDue: "2026-05-10",
      forcedDueDate: index === 5 ? "2026-05-10" : null,
      lastRating: "known"
    };
  });
  const ranked = scheduler.rankDue(entries, now);
  assert.equal(ranked.length, 12);
  assert.equal(ranked[0].id, 6, "forced entry must rank first");
  assert.equal(scheduler.dueEntries(entries, now).length, 12);
});

function makeFakeDocument() {
  class FakeNode {
    constructor(tag) {
      this.tagName = String(tag || "").toUpperCase();
      this.children = [];
      this.attributes = {};
      this.listeners = {};
      this.parentNode = null;
      this.className = "";
      this.id = "";
      this.value = "";
      this.textContentValue = "";
      this.checked = false;
      this.disabled = false;
      this.hidden = false;
      this.selected = false;
      this.open = false;
    }

    appendChild(child) {
      if (child === null || child === undefined) {
        return child;
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    replaceChildren() {
      this.children.forEach(function (child) { child.parentNode = null; });
      this.children = [];
      this.textContentValue = "";
      Array.prototype.slice.call(arguments).forEach((child) => this.appendChild(child));
    }

    setAttribute(name, value) {
      this.attributes[String(name)] = String(value);
      if (name === "id") {
        this.id = String(value);
      }
    }

    getAttribute(name) {
      return this.attributes[String(name)];
    }

    removeAttribute(name) {
      delete this.attributes[String(name)];
    }

    addEventListener(type, handler) {
      if (!this.listeners[type]) {
        this.listeners[type] = [];
      }
      this.listeners[type].push(handler);
    }

    dispatch(type, event) {
      (this.listeners[type] || []).forEach((handler) => handler(event || { target: this }));
    }

    focus() {
      this.focused = true;
    }

    set textContent(value) {
      this.children.forEach(function (child) { child.parentNode = null; });
      this.children = [];
      this.textContentValue = String(value);
    }

    get textContent() {
      if (this.children.length) {
        return this.children.map(function (child) { return child.textContent; }).join("");
      }
      return this.textContentValue;
    }
  }

  function findById(node, id) {
    if (node.id === id) {
      return node;
    }
    for (const child of node.children) {
      if (child && child.children) {
        const found = findById(child, id);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  const body = new FakeNode("body");
  return {
    body: body,
    createElement: function (tag) { return new FakeNode(tag); },
    createTextNode: function (text) { return { textContent: String(text), nodeType: 3 }; },
    getElementById: function (id) { return findById(body, id); }
  };
}

test("AI 设置：BaseURL 校验收紧，密钥不持久化、不输出", function () {
  const document = makeFakeDocument();
  const writes = [];
  const store = new Map();
  const localStorage = {
    getItem: function (key) { return store.has(key) ? store.get(key) : null; },
    setItem: function (key, value) {
      writes.push({ key: key, value: String(value) });
      store.set(key, String(value));
    }
  };
  const sandbox = {
    console: console,
    URL: URL,
    localStorage: localStorage,
    document: document,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("preview/ai-settings.js"), sandbox, { filename: "ai-settings.js" });
  const api = sandbox.StudyAISettings;
  assert.ok(api && typeof api.render === "function");

  assert.equal(api.validateBaseUrl("https://api.deepseek.com/v1/").value,
    "https://api.deepseek.com/v1");
  assert.equal(api.validateBaseUrl("https://api.deepseek.com/v1/chat/completions").value,
    "https://api.deepseek.com/v1");
  assert.equal(api.validateBaseUrl("http://localhost:11434/v1").value,
    "http://localhost:11434/v1");
  assert.equal(api.validateBaseUrl("http://127.0.0.1:8080").value,
    "http://127.0.0.1:8080");
  assert.equal(api.validateBaseUrl("http://example.com/v1").ok, false);
  assert.equal(api.validateBaseUrl("https://user:pass@example.com/v1").ok, false);
  assert.equal(api.validateBaseUrl("https://example.com/v1?x=1").ok, false);
  assert.equal(api.validateBaseUrl("https://example.com/v1#x").ok, false);
  assert.equal(api.validateBaseUrl("javascript:alert(1)").ok, false);

  const details = api.render();
  document.body.appendChild(details);
  const baseInput = document.getElementById("ai-base-url");
  const keyInput = document.getElementById("ai-api-key");
  const modelInput = document.getElementById("ai-model");
  const saveButton = document.getElementById("ai-save");
  const status = document.getElementById("ai-status");
  assert.ok(baseInput && keyInput && modelInput && saveButton && status);
  assert.equal(document.getElementById("ai-test-connection").disabled, true);

  baseInput.value = "http://example.com/v1";
  saveButton.dispatch("click");
  const baseError = document.getElementById("ai-base-url-error");
  assert.equal(baseError.hidden, false);
  assert.ok(baseError.textContent.includes("HTTP"));
  assert.equal(api.getSafeSettings().baseUrl, "");

  baseInput.value = "https://api.deepseek.com/v1/";
  modelInput.value = "user-chosen-model";
  keyInput.value = "sk-test-SECRET-123";
  keyInput.dispatch("input");
  assert.equal(api.hasRuntimeKey(), true);
  saveButton.dispatch("click");

  const safe = api.getSafeSettings();
  assert.equal(safe.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(safe.model, "user-chosen-model");
  assert.equal(Object.prototype.hasOwnProperty.call(safe, "apiKey"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(safe, "key"), false);
  assert.ok(writes.length > 0);
  writes.forEach(function (write) {
    assert.ok(!write.value.includes("sk-test-SECRET-123"), "key must never be persisted");
  });
  assert.ok(status.textContent.includes("API Key 未保存"));
  assert.ok(!status.textContent.includes("sk-test-SECRET-123"));
  assert.equal(api.hasRuntimeKey(), true);
  api.clearRuntimeKey();
  assert.equal(api.hasRuntimeKey(), false);
});

function loadAppForTests() {
  const document = undefined;
  const appStore = new Map();
  const appStorage = {
    getItem: function (key) { return appStore.has(key) ? appStore.get(key) : null; },
    setItem: function (key, value) { appStore.set(key, String(value)); },
    removeItem: function (key) { appStore.delete(key); }
  };
  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: function () { return 0; },
    URL: URL,
    Blob: Blob,
    crypto: { randomUUID: function () { return "test-uuid"; } },
    localStorage: appStorage,
    document: document
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  ["preview/study-data.js", "preview/generated-answers.js", "preview/memory-scheduler.js"].forEach(function (file) {
    vm.runInContext(read(file), sandbox, { filename: file });
  });
  let source = read("preview/app.js");
  const injection = [
    "",
    "if (typeof window !== \"undefined\") {",
    "  window.__studyTestHooks = {",
    "    makeDefaultState: makeDefaultState,",
    "    replaceState: function (next) { state = next; },",
    "    ensureTodaySession: ensureTodaySession,",
    "    getPlanPreview: getPlanPreview,",
    "    getScheduledDueIds: getScheduledDueIds",
    "  };",
    "}",
    ""
  ].join("\n");
  const end = source.lastIndexOf("})();");
  assert.ok(end > 0, "app IIFE should end with })();");
  source = source.slice(0, end) + injection + source.slice(end);
  vm.runInContext(source, sandbox, { filename: "app.js" });
  return sandbox;
}

test("到期数超过 dailyTarget 时，app 计划保留全部必选", function () {
  const app = loadAppForTests();
  const hooks = app.__studyTestHooks;
  const debug = app.StudyApp.debug;
  const now = new Date();
  const today = app.MemoryScheduler.localDateKey(now.toISOString());
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 9, 0, 0, 0);
  const candidates = app.STUDY_DATA.questions.filter(function (question) {
    return debug.isAnswerable(question);
  }).slice(0, 12);
  assert.equal(candidates.length, 12);
  const base = hooks.makeDefaultState();
  base.settings.dailyTarget = 5;
  base.selectedIds = candidates.map(function (question) { return question.id; });
  candidates.forEach(function (question, index) {
    let entry = app.MemoryScheduler.applyReview(
      null,
      "known",
      new Date(yesterday.getTime() + index * 60000).toISOString()
    );
    if (index === 0) {
      entry = app.MemoryScheduler.applyReview(
        entry,
        "forgot",
        new Date(yesterday.getTime() + 3600000).toISOString()
      );
    } else {
      entry.nextDue = today;
    }
    base.schedule[String(question.id)] = entry;
  });
  hooks.replaceState(base);
  hooks.ensureTodaySession();
  const state = app.StudyApp.getState();
  const preview = hooks.getPlanPreview();
  assert.equal(state.settings.dailyTarget, 5);
  assert.equal(preview.mandatory.length, 12);
  assert.equal(preview.effectiveTarget, 12);
  assert.equal(preview.total, 12);
  assert.equal(state.session.planIds.length, 12);
  assert.equal(state.session.mandatoryIds.length, 12);
  assert.equal(state.session.planIds[0], candidates[0].id, "forced due question should be first");
  assert.equal(hooks.getScheduledDueIds(today).length, 12);
});

test("熟记后的未到期题不会再次进入当天新计划", function () {
  const app = loadAppForTests();
  const hooks = app.__studyTestHooks;
  const debug = app.StudyApp.debug;
  const candidates = app.STUDY_DATA.questions.filter(function (question) {
    return debug.isAnswerable(question);
  }).slice(0, 4);
  const base = hooks.makeDefaultState();
  base.settings.dailyTarget = 4;
  base.selectedIds = candidates.map(function (question) { return question.id; });
  const now = new Date();
  candidates.forEach(function (question, index) {
    base.schedule[String(question.id)] = {
      stability: 5, knownCount: 2, lapses: 0,
      nextDue: app.MemoryScheduler.localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3).toISOString()),
      forcedDueDate: null, lastReviewedAt: now.toISOString(), lastGrowthAt: now.toISOString(),
      lastForgotDate: null, lastSuccessDate: app.MemoryScheduler.localDateKey(now.toISOString()),
      lastRating: "known", updatedAt: now.toISOString(), legacy: false
    };
  });
  hooks.replaceState(base);
  hooks.ensureTodaySession();
  const ids = app.StudyApp.getState().session.planIds;
  candidates.forEach(function (q) { assert.ok(!ids.includes(q.id)); });
  assert.equal(ids.length, 4);
});

test("搜索别名、多关键词 AND 与章节映射", function () {
  const app = loadAppForTests();
  const debug = app.StudyApp.debug;
  const byId = new Map(app.STUDY_DATA.questions.map(function (question) {
    return [question.id, question];
  }));
  const chapter3 = debug.searchQuestionIds("第3章");
  assert.ok(chapter3.length > 0);
  assert.deepEqual(debug.searchQuestionIds("第三章"), chapter3);
  assert.deepEqual(debug.searchQuestionIds("3章"), chapter3);
  assert.ok(debug.searchQuestionIds("重力坝").length > 0);
  assert.ok(debug.searchQuestionIds("泄洪").length > 0);
  const andResult = debug.searchQuestionIds("第3章 重力坝");
  assert.ok(andResult.length > 0);
  andResult.forEach(function (id) {
    assert.ok(chapter3.includes(id));
    assert.ok(debug.chapterNamesFor(byId.get(id).chapter).includes("重力坝"));
  });
  assert.equal(debug.searchQuestionIds("第3章 第4章").length, 0);
});

test("app normalizeScheduleEntry 保留新增字段并标 legacy", function () {
  const app = loadAppForTests();
  const raw = {
    knownCount: 4,
    lapses: 1,
    nextDue: "2026-05-10",
    lastRating: "known",
    updatedAt: local(2026, 5, 1, 9, 0).toISOString()
  };
  const normalized = app.StudyApp.debug.normalizeScheduleEntry(raw);
  assert.equal(normalized.stability, 14);
  assert.equal(normalized.legacy, true);
  assert.equal(normalized.nextDue, "2026-05-10");
  assert.equal(normalized.knownCount, 4);
  assert.equal(normalized.lapses, 1);
  assert.equal(normalized.lastRating, "known");
  assert.equal(normalized.lastReviewedAt, raw.updatedAt);
  ["stability", "knownCount", "lapses", "nextDue", "forcedDueDate", "lastReviewedAt",
    "lastGrowthAt", "lastForgotDate", "lastSuccessDate", "lastRating", "updatedAt", "legacy"]
    .forEach(function (field) {
      assert.ok(Object.prototype.hasOwnProperty.call(normalized, field), "missing " + field);
    });
});

test("导出过滤 key/token，state 根对象不含 API Key，没有网络调用或 innerHTML", function () {
  const app = loadAppForTests();
  const debug = app.StudyApp.debug;
  const stateText = JSON.stringify(app.StudyApp.getState());
  assert.ok(!/api[-_]?key|access[-_]?token|refresh[-_]?token/i.test(stateText));
  const cleaned = debug.sanitizeForExport({
    apiKey: "SECRET",
    token: "SECRET",
    authToken: "SECRET",
    nested: { accessToken: "SECRET", keep: "yes" },
    keyPoints: ["not a secret field"]
  });
  assert.equal(cleaned.apiKey, undefined);
  assert.equal(cleaned.token, undefined);
  assert.equal(cleaned.authToken, undefined);
  assert.equal(cleaned.nested.accessToken, undefined);
  assert.equal(cleaned.nested.keep, "yes");
  assert.deepEqual(cleaned.keyPoints, ["not a secret field"]);

  const appSource = read("preview/app.js");
  const aiSource = read("preview/ai-settings.js");
  const indexSource = read("preview/index.html");
  [appSource, aiSource, indexSource].forEach(function (source) {
    assert.ok(!/innerHTML\s*=/.test(source), "must not assign innerHTML");
    assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/.test(source), "must not make network calls");
  });
  assert.ok(!appSource.includes("[1, 3, 7, 14, 30]"));
  assert.ok(!appSource.includes("[1,3,7,14,30]"));
});

console.log("\n" + passed + " tests passed.");
