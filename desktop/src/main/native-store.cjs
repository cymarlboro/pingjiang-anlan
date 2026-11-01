"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { UserError } = require("./errors.cjs");
const { APP_ID } = require("./security.cjs");
const { normalizeApiBase, normalizeUpdateManifestUrl } = require("./url-rules.cjs");
const { isValidReminderTime } = require("./text-rules.cjs");
const { normalize: normalizeType, isCanonical } = require("./question-types.cjs");

const MAX_STORE_BYTES = 64 * 1024 * 1024;
const FIRST_QUESTION_ID = 1_000_000;
const FIRST_SOURCE_ID = 900_000;
const FIRST_IMPORT_ID = 100_000;
const MAX_JS_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

// Cross-device IDs must not collide just because both clients imported their
// first file. Every NEW native import/source/question id therefore comes from
// a cryptographically random safe integer in [10^12, 2^52).
const NEW_ID_MIN = 10 ** 12;
const NEW_ID_LIMIT = 2 ** 52;
const NEW_ID_SPAN_BIG = BigInt(NEW_ID_LIMIT) - BigInt(NEW_ID_MIN);
const NEW_ID_SAMPLE_BIG = (BigInt(NEW_ID_LIMIT) / NEW_ID_SPAN_BIG) * NEW_ID_SPAN_BIG;
const NEW_ID_MASK_BIG = (BigInt(1) << 52n) - 1n;

const QUESTION_FIELDS = [
  "id", "chapter", "question", "options", "answer", "explanation",
  "source_id", "locator", "type", "metadata"
];
const SOURCE_FIELDS = ["id", "name", "format", "importId"];
const ANSWER_FIELDS = [
  "question_id", "answer", "key_points", "status", "references", "caveat",
  "sourceQuote", "pageIndex", "locator", "sourceName", "type", "chapter",
  "userEdited", "origin"
];
const IMPORT_FIELDS = [
  "id", "name", "format", "size", "createdAt", "pages", "needsOcr",
  "truncated", "note"
];
const PAGE_FIELDS = [
  "pageIndex", "locator", "text", "paragraphIndex", "ocr", "needsOcr"
];
const FORMATS = new Set(["pdf", "docx", "md", "html", "txt"]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pick(value, fields) {
  const result = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      result[field] = clone(value[field]);
    }
  }
  return result;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sameContent(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

/** Cryptographically random safe integer in [10^12, 2^52). */
function randomNativeId() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const sample = crypto.randomBytes(8).readBigUInt64BE(0) & NEW_ID_MASK_BIG;
    if (sample < NEW_ID_SAMPLE_BIG) {
      return Number(BigInt(NEW_ID_MIN) + sample);
    }
  }
  throw new UserError("无法生成安全的本机编号，请重试");
}

function allocateNativeId(usedIds, label) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const id = randomNativeId();
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
  throw new UserError(`无法生成不重复的本机${label}编号，请重试`);
}

function immutableQuestion(question) {
  return {
    id: Number(question.id),
    chapter: typeof question.chapter === "string" ? question.chapter : "",
    question: typeof question.question === "string" ? question.question : "",
    options: typeof question.options === "string" ? question.options : "",
    answer: typeof question.answer === "string" ? question.answer : "",
    explanation: typeof question.explanation === "string" ? question.explanation : "",
    source_id: Number(question.source_id),
    locator: typeof question.locator === "string" ? question.locator : "",
    metadata: question.metadata === undefined ? null : question.metadata
  };
}

function immutableSource(source) {
  return {
    id: Number(source.id),
    name: typeof source.name === "string" ? source.name : "",
    format: typeof source.format === "string" ? source.format.toLowerCase() : "",
    importId: Number.isSafeInteger(Number(source.importId)) ? Number(source.importId) : null
  };
}

function immutableImport(item) {
  return {
    id: Number(item.id),
    name: typeof item.name === "string" ? item.name : "",
    format: typeof item.format === "string" ? item.format.toLowerCase() : "",
    pages: (Array.isArray(item.pages) ? item.pages : []).map((page) => ({
      pageIndex: Number(page.pageIndex),
      locator: typeof page.locator === "string" ? page.locator : "",
      text: typeof page.text === "string" ? page.text : "",
      paragraphIndex: Number.isSafeInteger(Number(page.paragraphIndex))
        ? Number(page.paragraphIndex)
        : null,
      ocr: page.ocr === true,
      needsOcr: page.needsOcr === true
    })),
    needsOcr: item.needsOcr === true,
    truncated: item.truncated === true,
    note: typeof item.note === "string" ? item.note : ""
  };
}

/**
 * Deterministic, commutative ordering for the same customAnswers question id.
 * This must match preview/cloud-sync.js and Android NativeStore.chooseAnswer:
 * a user-edited answer wins over a non-edited one; otherwise the stable
 * canonical JSON comparison decides. There is no per-answer timestamp.
 */
function compareAnswers(left, right) {
  const leftEdited = Boolean(left && left.userEdited === true);
  const rightEdited = Boolean(right && right.userEdited === true);
  if (leftEdited !== rightEdited) {
    return leftEdited ? 1 : -1;
  }
  const leftText = canonicalJson(left);
  const rightText = canonicalJson(right);
  if (leftText === rightText) {
    return 0;
  }
  return leftText > rightText ? 1 : -1;
}

function idKey(value) {
  return String(Number(value));
}

function cloudConflict() {
  return new UserError("云端自定义内容与本地内容冲突，已停止合并并保留本地内容");
}

function nonEmptyString(value, max) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : "";
}

function emptyData() {
  return {
    schemaVersion: 1,
    nextQuestionId: FIRST_QUESTION_ID,
    nextSourceId: FIRST_SOURCE_ID,
    nextImportId: FIRST_IMPORT_ID,
    customQuestions: [],
    customSources: [],
    customTypes: {},
    customAnswers: [],
    imports: [],
    apiConfig: {
      serviceName: "",
      baseUrl: "",
      model: "",
      maxQuestions: 5
    },
    reminder: { enabled: false, time: "20:30" },
    updateConfig: { manifestUrl: "", customized: false },
    meta: { lastUpdateCheckAt: 0, lastNotifiedDate: "" }
  };
}

function ensureShape(root) {
  if (!isPlainObject(root)) {
    throw new Error("shape");
  }
  for (const key of ["customQuestions", "customSources", "customAnswers", "imports"]) {
    if (root[key] !== undefined && !Array.isArray(root[key])) {
      throw new Error("shape");
    }
    if (!Array.isArray(root[key])) {
      root[key] = [];
    }
  }
  for (const key of ["customTypes", "apiConfig", "reminder", "updateConfig", "meta"]) {
    if (root[key] !== undefined && !isPlainObject(root[key])) {
      throw new Error("shape");
    }
  }
  if (!isPlainObject(root.customTypes)) {
    root.customTypes = {};
  }
  if (!isPlainObject(root.apiConfig)) {
    root.apiConfig = { serviceName: "", baseUrl: "", model: "", maxQuestions: 5 };
  }
  if (!isPlainObject(root.reminder)) {
    root.reminder = { enabled: false, time: "20:30" };
  }
  if (!isPlainObject(root.updateConfig)) {
    root.updateConfig = { manifestUrl: "", customized: false };
  }
  if (!isPlainObject(root.meta)) {
    root.meta = { lastUpdateCheckAt: 0, lastNotifiedDate: "" };
  }
  root.schemaVersion = 1;
  root.nextQuestionId = Math.max(
    Number(root.nextQuestionId) || FIRST_QUESTION_ID,
    maxId(root.customQuestions) + 1,
    FIRST_QUESTION_ID
  );
  root.nextSourceId = Math.max(
    Number(root.nextSourceId) || FIRST_SOURCE_ID,
    maxId(root.customSources) + 1,
    FIRST_SOURCE_ID
  );
  root.nextImportId = Math.max(
    Number(root.nextImportId) || FIRST_IMPORT_ID,
    maxId(root.imports) + 1,
    FIRST_IMPORT_ID
  );
  return root;
}

function maxId(items) {
  let max = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (item && Number.isSafeInteger(Number(item.id))) {
      max = Math.max(max, Number(item.id));
    }
  }
  return max;
}

function sanitizeBootstrap(data) {
  const customQuestions = [];
  for (const item of data.customQuestions) {
    if (!isPlainObject(item) || !Number.isSafeInteger(Number(item.id))) {
      continue;
    }
    const question = nonEmptyString(item.question, 20000);
    if (!question) {
      continue;
    }
    const clean = pick(item, QUESTION_FIELDS);
    clean.id = Number(item.id);
    clean.question = question;
    customQuestions.push(clean);
  }
  const customSources = [];
  for (const item of data.customSources) {
    if (!isPlainObject(item) || !Number.isSafeInteger(Number(item.id))) {
      continue;
    }
    const name = nonEmptyString(item.name, 300);
    if (!name) {
      continue;
    }
    const clean = pick(item, SOURCE_FIELDS);
    clean.id = Number(item.id);
    clean.name = name;
    customSources.push(clean);
  }
  const customTypes = {};
  for (const key of Object.keys(data.customTypes)) {
    if (!/^\d{1,16}$/.test(key)) {
      continue;
    }
    const type = nonEmptyString(data.customTypes[key], 40);
    if (type) {
      customTypes[key] = type;
    }
  }
  const customAnswers = [];
  for (const item of data.customAnswers) {
    if (!isPlainObject(item)) {
      continue;
    }
    const id = Number(item.question_id !== undefined ? item.question_id : item.id);
    if (!Number.isSafeInteger(id) || !nonEmptyString(item.answer, 20000)) {
      continue;
    }
    const clean = pick(item, ANSWER_FIELDS);
    clean.question_id = id;
    clean.answer = String(item.answer).slice(0, 40000);
    customAnswers.push(clean);
  }
  return { customQuestions, customSources, customTypes, customAnswers };
}

class NativeStore {
  constructor({ userDataDir, versionCode = 1, versionName = "1.0.0", appId = APP_ID }) {
    if (!userDataDir || typeof userDataDir !== "string") {
      throw new Error("userDataDir");
    }
    this.versionCode = versionCode;
    this.versionName = versionName;
    this.appId = appId;
    this.directory = path.join(userDataDir, "native");
    this.storeFile = path.join(this.directory, "native-store.json");
    this.backupDirectory = path.join(this.directory, "backup-imports");
    this.writeBlocked = false;
    this.recoveryNotice = "";
    this.data = this.load();
    this.writeChain = Promise.resolve();
  }

  load() {
    try {
      if (!fs.existsSync(this.storeFile)) {
        return emptyData();
      }
      const stat = fs.statSync(this.storeFile);
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) {
        return this.quarantineCorrupt();
      }
      const raw = fs.readFileSync(this.storeFile, "utf8");
      const parsed = JSON.parse(raw);
      return ensureShape(parsed);
    } catch {
      return this.quarantineCorrupt();
    }
  }

  quarantineCorrupt() {
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      if (fs.existsSync(this.storeFile)) {
        const preserved = path.join(
          this.directory,
          `native-store.recovered-${Date.now()}.json`
        );
        fs.copyFileSync(this.storeFile, preserved, fs.constants.COPYFILE_EXCL);
      }
      this.recoveryNotice = "本机原生数据文件损坏，已保留副本并从空数据继续。";
      this.writeBlocked = false;
    } catch {
      this.writeBlocked = true;
      this.recoveryNotice = "本机原生数据文件损坏且副本保留失败，已停止写入。";
    }
    return emptyData();
  }

  async writeSnapshot(snapshot) {
    if (this.writeBlocked) {
      throw new UserError("本地数据文件异常且无法保留旧副本，已停止写入");
    }
    const text = JSON.stringify(snapshot);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_STORE_BYTES) {
      throw new UserError("本地数据超过存储上限，请先导出备份并清理导入资料");
    }
    await fs.promises.mkdir(this.directory, { recursive: true });
    const temporary = path.join(
      this.directory,
      `native-store-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`
    );
    let handle;
    try {
      handle = await fs.promises.open(temporary, "wx", 0o600);
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.promises.rename(temporary, this.storeFile);
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch { /* best effort */ }
      }
      try { fs.unlinkSync(temporary); } catch { /* best effort */ }
      throw new UserError("本地数据写入失败");
    }
  }

  mutate(mutator) {
    const run = this.writeChain.then(async () => {
      const next = clone(this.data);
      const result = mutator(next);
      await this.writeSnapshot(next);
      this.data = next;
      return result;
    });
    this.writeChain = run.catch(() => {});
    return run;
  }

  bootstrapJson() {
    try {
      return JSON.stringify(sanitizeBootstrap(this.data));
    } catch {
      return JSON.stringify({
        customQuestions: [],
        customSources: [],
        customTypes: {},
        customAnswers: []
      });
    }
  }

  getApiConfig() {
    const config = this.data.apiConfig || {};
    return {
      serviceName: typeof config.serviceName === "string" ? config.serviceName : "",
      baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : "",
      model: typeof config.model === "string" ? config.model : "",
      maxQuestions: Math.min(10, Math.max(1, Number(config.maxQuestions) || 5))
    };
  }

  saveApiConfig(config) {
    return this.mutate((next) => {
      next.apiConfig = {
        serviceName: nonEmptyString(config.serviceName, 60),
        baseUrl: config.baseUrl ? normalizeApiBase(config.baseUrl) : "",
        model: typeof config.model === "string" ? config.model.trim().slice(0, 200) : "",
        maxQuestions: Math.min(10, Math.max(1, Number(config.maxQuestions) || 5))
      };
      return clone(next.apiConfig);
    });
  }

  getReminder() {
    const reminder = this.data.reminder || {};
    return {
      enabled: reminder.enabled === true,
      time: isValidReminderTime(reminder.time) ? reminder.time : "20:30"
    };
  }

  saveReminder(enabled, time) {
    if (!isValidReminderTime(time)) {
      throw new UserError("提醒时间格式应为 HH:mm");
    }
    return this.mutate((next) => {
      next.reminder = { enabled: enabled === true, time };
      return clone(next.reminder);
    });
  }

  getMeta() {
    return clone(this.data.meta || { lastUpdateCheckAt: 0, lastNotifiedDate: "" });
  }

  setLastUpdateCheckAt(millis) {
    return this.mutate((next) => {
      next.meta = next.meta || {};
      next.meta.lastUpdateCheckAt = Math.max(0, Number(millis) || 0);
    });
  }

  getLastNotifiedDate() {
    const meta = this.data.meta || {};
    return typeof meta.lastNotifiedDate === "string" ? meta.lastNotifiedDate : "";
  }

  setLastNotifiedDate(dateKey) {
    return this.mutate((next) => {
      next.meta = next.meta || {};
      next.meta.lastNotifiedDate = String(dateKey || "").slice(0, 10);
    });
  }

  effectiveUpdateManifestUrl() {
    const config = this.data.updateConfig;
    if (!config) {
      return require("./update-policy.cjs").DEFAULT_UPDATE_MANIFEST_URL;
    }
    if (config.manifestUrl) {
      return config.manifestUrl;
    }
    return config.customized === true
      ? ""
      : require("./update-policy.cjs").DEFAULT_UPDATE_MANIFEST_URL;
  }

  usingDefaultUpdateManifest() {
    const config = this.data.updateConfig;
    if (!config) {
      return true;
    }
    return !config.manifestUrl && config.customized !== true;
  }

  saveUpdateManifestUrl(raw) {
    const normalized = normalizeUpdateManifestUrl(raw);
    return this.mutate((next) => {
      next.updateConfig = { manifestUrl: normalized, customized: true };
      return { manifestUrl: normalized, usingDefault: false };
    });
  }

  listImports() {
    return this.data.imports.map((item) => ({
      id: item.id,
      name: item.name,
      format: item.format,
      size: item.size || 0,
      createdAt: item.createdAt || "",
      pageCount: Array.isArray(item.pages) ? item.pages.length : 0,
      pages: Array.isArray(item.pages) ? item.pages.length : 0,
      needsOcr: item.needsOcr === true,
      truncated: item.truncated === true
    }));
  }

  getImport(id) {
    const value = Number(id);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new UserError("导入资料编号无效");
    }
    const found = this.data.imports.find((item) => Number(item.id) === value);
    if (!found) {
      throw new UserError("找不到该导入资料");
    }
    return clone(found);
  }

  addImport(document) {
    if (!isPlainObject(document) || !Array.isArray(document.pages) || !document.pages.length) {
      throw new UserError("没有读到可用的文件内容");
    }
    return this.mutate((next) => {
      const usedImportIds = new Set(
        next.imports
          .filter((item) => Number.isSafeInteger(Number(item.id)))
          .map((item) => Number(item.id))
      );
      const id = allocateNativeId(usedImportIds, "导入资料");
      const stored = {
        id,
        name: nonEmptyString(document.name, 240) || "导入资料",
        format: FORMATS.has(document.format) ? document.format : "txt",
        size: Math.max(0, Number(document.size) || 0),
        createdAt: new Date().toISOString(),
        pages: document.pages.map((page) => ({
          pageIndex: Number(page.pageIndex),
          locator: typeof page.locator === "string" ? page.locator.slice(0, 300) : "",
          text: typeof page.text === "string" ? page.text : "",
          ...(Number.isSafeInteger(Number(page.paragraphIndex))
            ? { paragraphIndex: Number(page.paragraphIndex) }
            : {}),
          ...(page.needsOcr === true ? { needsOcr: true } : {}),
          ...(page.ocr === true ? { ocr: true } : {})
        })),
        needsOcr: document.needsOcr === true,
        truncated: document.truncated === true,
        ...(typeof document.note === "string" && document.note
          ? { note: document.note.slice(0, 500) }
          : {})
      };
      next.imports.push(stored);
      next.nextImportId = Math.max(
        Number(next.nextImportId) || FIRST_IMPORT_ID,
        id + 1
      );
      return clone(stored);
    });
  }

  /**
   * Validates every user-approved draft again, including exact quote membership
   * and page identity, then writes questions/source/answers/types atomically.
   */
  acceptQuestions(payload) {
    if (!isPlainObject(payload)) {
      throw new UserError("请求参数格式错误");
    }
    const importId = Number(payload.importId);
    if (!Number.isSafeInteger(importId) || importId < 0) {
      throw new UserError("导入资料编号无效");
    }
    const importDocument = this.getImport(importId);
    const drafts = payload.questions;
    if (!Array.isArray(drafts) || drafts.length < 1) {
      throw new UserError("没有可保存的题目");
    }
    if (drafts.length > 30) {
      throw new UserError("一次最多保存 30 道题");
    }
    const pages = new Map();
    for (const page of importDocument.pages) {
      pages.set(Number(page.pageIndex), page);
    }
    const seen = new Set();
    return this.mutate((next) => {
      const usedSourceIds = new Set(
        next.customSources
          .filter((source) => Number.isSafeInteger(Number(source.id)))
          .map((source) => Number(source.id))
      );
      let sourceId = next.customSources.find(
        (source) => Number(source.importId) === importId
      )?.id;
      if (Number.isSafeInteger(Number(sourceId))) {
        sourceId = Number(sourceId);
      } else {
        sourceId = allocateNativeId(usedSourceIds, "来源");
        next.customSources.push({
          id: sourceId,
          name: importDocument.name,
          format: importDocument.format,
          importId
        });
      }
      const usedQuestionIds = new Set();
      for (const question of next.customQuestions) {
        if (Number.isSafeInteger(Number(question.id))) {
          usedQuestionIds.add(Number(question.id));
        }
      }
      for (const answer of next.customAnswers) {
        if (Number.isSafeInteger(Number(answer.question_id))) {
          usedQuestionIds.add(Number(answer.question_id));
        }
      }
      let nextQuestionId = Math.max(
        FIRST_QUESTION_ID,
        Number(next.nextQuestionId) || FIRST_QUESTION_ID
      );
      for (const draft of drafts) {
        if (!isPlainObject(draft)) {
          throw new UserError("题目列表格式错误");
        }
        const questionText = nonEmptyString(draft.question, 4000);
        const answerText = nonEmptyString(draft.answer, 30000);
        if (!questionText) {
          throw new UserError("题干不能为空");
        }
        if (!answerText) {
          throw new UserError("答案不能为空");
        }
        const type = normalizeType(draft.type);
        if (!type || !isCanonical(type)) {
          throw new UserError("题型不在允许范围内");
        }
        const chapter = nonEmptyString(draft.chapter, 120) || "导入资料";
        const sourceQuote = typeof draft.sourceQuote === "string"
          ? draft.sourceQuote.slice(0, 10000)
          : "";
        let page = null;
        if (draft.pageIndex !== undefined && draft.pageIndex !== null) {
          const pageIndex = Number(draft.pageIndex);
          if (!Number.isSafeInteger(pageIndex) || !pages.has(pageIndex)) {
            throw new UserError("页码不在该导入资料中");
          }
          page = pages.get(pageIndex);
        }
        if (sourceQuote && !page) {
          throw new UserError("引用原文缺少对应页码");
        }
        if (sourceQuote && !String(page.text || "").includes(sourceQuote)) {
          throw new UserError("引用未能在对应页原文中精确匹配，已拒绝保存");
        }
        const locator = page
          ? page.locator || "导入资料"
          : nonEmptyString(draft.locator, 200) || importDocument.name;
        const dedupe = questionText.replace(/\s+/g, " ").trim();
        if (seen.has(dedupe)) {
          throw new UserError("本次提交包含重复题目");
        }
        seen.add(dedupe);
        const questionId = allocateNativeId(usedQuestionIds, "题目");
        next.customQuestions.push({
          id: questionId,
          chapter,
          question: questionText,
          options: "",
          answer: "",
          explanation: "",
          source_id: sourceId,
          locator,
          metadata: { importId, userConfirmed: true }
        });
        next.customAnswers.push({
          question_id: questionId,
          answer: answerText,
          key_points: [],
          status: "draft",
          references: [],
          caveat: `用户确认/编辑的导入草稿，未经学科审定；原文位置：${locator}`,
          sourceQuote,
          ...(page ? { pageIndex: Number(page.pageIndex) } : {}),
          locator,
          sourceName: importDocument.name,
          type,
          chapter,
          userEdited: true,
          origin: "import"
        });
        next.customTypes[String(questionId)] = type;
        nextQuestionId = Math.max(nextQuestionId, questionId + 1);
      }
      next.nextQuestionId = nextQuestionId;
      next.nextSourceId = Math.max(Number(next.nextSourceId) || FIRST_SOURCE_ID, sourceId + 1);
      return drafts.length;
    });
  }

  cloudNativeSnapshot() {
    // Strip unknown fields but keep every accepted string intact. CloudSync
    // validates this snapshot and rejects (rather than truncates) anything that
    // no longer fits the shared contract.
    const imports = this.data.imports
      .filter((item) => isPlainObject(item))
      .map((item) => {
        const clean = pick(item, IMPORT_FIELDS);
        if (Array.isArray(item.pages)) {
          clean.pages = item.pages
            .filter((page) => isPlainObject(page))
            .map((page) => pick(page, PAGE_FIELDS));
        }
        return clean;
      });
    return {
      customContent: {
        schemaVersion: 1,
        customQuestions: this.data.customQuestions
          .filter((item) => isPlainObject(item))
          .map((item) => pick(item, QUESTION_FIELDS)),
        customSources: this.data.customSources
          .filter((item) => isPlainObject(item))
          .map((item) => pick(item, SOURCE_FIELDS)),
        customTypes: clone(this.data.customTypes),
        customAnswers: this.data.customAnswers
          .filter((item) => isPlainObject(item))
          .map((item) => pick(item, ANSWER_FIELDS))
      },
      imports
    };
  }

  /**
   * Atomically merges a validated cloud native snapshot into the local store.
   * Immutable items keep their local copy unless the incoming copy is byte-for-
   * byte equivalent; any conflicting id aborts the whole merge. Same-id custom
   * answers use a deterministic preference instead of silent replacement.
   */
  mergeCloudNative(native) {
    if (!isPlainObject(native) || !isPlainObject(native.customContent)) {
      throw new UserError("云端自定义内容格式错误");
    }
    return this.mutate((next) => {
      const custom = native.customContent;
      const incomingQuestions = Array.isArray(custom.customQuestions) ? custom.customQuestions : [];
      const incomingSources = Array.isArray(custom.customSources) ? custom.customSources : [];
      const incomingAnswers = Array.isArray(custom.customAnswers) ? custom.customAnswers : [];
      const incomingImports = Array.isArray(native.imports) ? native.imports : [];
      const incomingTypes = isPlainObject(custom.customTypes) ? custom.customTypes : {};

      const localQuestions = new Map();
      for (const item of next.customQuestions) {
        localQuestions.set(idKey(item.id), item);
      }
      const localSources = new Map();
      for (const item of next.customSources) {
        localSources.set(idKey(item.id), item);
      }
      const localImports = new Map();
      for (const item of next.imports) {
        localImports.set(idKey(item.id), item);
      }
      const localAnswers = new Map();
      for (const item of next.customAnswers) {
        localAnswers.set(idKey(item.question_id), item);
      }

      const incomingQuestionIds = new Set();
      const addedQuestions = [];
      for (const item of incomingQuestions) {
        const key = idKey(item.id);
        if (incomingQuestionIds.has(key)) {
          throw cloudConflict();
        }
        incomingQuestionIds.add(key);
        const existing = localQuestions.get(key);
        if (!existing) {
          addedQuestions.push(item);
        } else if (!sameContent(immutableQuestion(existing), immutableQuestion(item))) {
          throw cloudConflict();
        }
      }

      const incomingSourceIds = new Set();
      const addedSources = [];
      for (const item of incomingSources) {
        const key = idKey(item.id);
        if (incomingSourceIds.has(key)) {
          throw cloudConflict();
        }
        incomingSourceIds.add(key);
        const existing = localSources.get(key);
        if (!existing) {
          addedSources.push(item);
        } else if (!sameContent(immutableSource(existing), immutableSource(item))) {
          throw cloudConflict();
        }
      }

      const incomingImportIds = new Set();
      const addedImports = [];
      for (const item of incomingImports) {
        const key = idKey(item.id);
        if (incomingImportIds.has(key)) {
          throw cloudConflict();
        }
        incomingImportIds.add(key);
        const existing = localImports.get(key);
        if (!existing) {
          addedImports.push(item);
        } else if (!sameContent(immutableImport(existing), immutableImport(item))) {
          throw cloudConflict();
        }
      }

      const nextTypes = Object.assign({}, next.customTypes);
      let typesChanged = false;
      for (const key of Object.keys(incomingTypes)) {
        // Incoming values were normalized by CloudSync.validateNative. Normalize
        // the local value too so aliases cannot cause a false conflict, then use
        // the same lexicographic choice as preview and Android.
        const normalizedIncoming = normalizeType(incomingTypes[key]);
        if (!normalizedIncoming) {
          throw cloudConflict();
        }
        if (Object.prototype.hasOwnProperty.call(nextTypes, key)) {
          const normalizedLocal = normalizeType(nextTypes[key]);
          const chosen = normalizedLocal && normalizedLocal >= normalizedIncoming
            ? normalizedLocal
            : normalizedIncoming;
          if (nextTypes[key] !== chosen) {
            nextTypes[key] = chosen;
            typesChanged = true;
          }
        } else {
          nextTypes[key] = normalizedIncoming;
          typesChanged = true;
        }
      }

      const addedAnswers = [];
      const replacedAnswers = new Map();
      for (const item of incomingAnswers) {
        const key = idKey(item.question_id);
        const existing = localAnswers.get(key);
        if (!existing) {
          addedAnswers.push(item);
        } else if (!sameContent(existing, item) && compareAnswers(item, existing) > 0) {
          replacedAnswers.set(key, item);
        }
      }

      const allSourceIds = new Set();
      for (const item of next.customSources) {
        allSourceIds.add(Number(item.id));
      }
      for (const item of incomingSources) {
        allSourceIds.add(Number(item.id));
      }
      for (const item of incomingQuestions) {
        if (!allSourceIds.has(Number(item.source_id))) {
          throw new UserError("云端自定义题指向了不存在的来源，已停止合并");
        }
      }
      const allQuestionIds = new Set();
      for (const item of next.customQuestions) {
        allQuestionIds.add(Number(item.id));
      }
      for (const item of incomingQuestions) {
        allQuestionIds.add(Number(item.id));
      }
      for (const item of incomingAnswers) {
        if (!allQuestionIds.has(Number(item.question_id))) {
          throw new UserError("云端自定义答案指向了不存在的题目，已停止合并");
        }
      }
      for (const key of Object.keys(incomingTypes)) {
        if (!allQuestionIds.has(Number(key))) {
          throw new UserError("云端自定义题型指向了不存在的题目，已停止合并");
        }
      }

      const mergedAnswers = next.customAnswers.map((item) => {
        return replacedAnswers.get(idKey(item.question_id)) || item;
      });
      addedAnswers.sort((left, right) => Number(left.question_id) - Number(right.question_id));
      mergedAnswers.push(...addedAnswers);
      addedQuestions.sort((left, right) => Number(left.id) - Number(right.id));
      addedSources.sort((left, right) => Number(left.id) - Number(right.id));
      addedImports.sort((left, right) => Number(left.id) - Number(right.id));

      const changed = addedQuestions.length > 0 ||
        addedSources.length > 0 ||
        addedImports.length > 0 ||
        addedAnswers.length > 0 ||
        replacedAnswers.size > 0 ||
        typesChanged;

      if (!changed) {
        return { changed: false };
      }
      next.customQuestions = next.customQuestions.concat(addedQuestions);
      next.customSources = next.customSources.concat(addedSources);
      next.customAnswers = mergedAnswers;
      next.customTypes = nextTypes;
      next.imports = next.imports.concat(addedImports);
      next.nextQuestionId = Math.min(
        MAX_JS_SAFE_INTEGER,
        Math.max(
          FIRST_QUESTION_ID,
          Number(next.nextQuestionId) || FIRST_QUESTION_ID,
          maxId(next.customQuestions) + 1
        )
      );
      next.nextSourceId = Math.min(
        MAX_JS_SAFE_INTEGER,
        Math.max(
          FIRST_SOURCE_ID,
          Number(next.nextSourceId) || FIRST_SOURCE_ID,
          maxId(next.customSources) + 1
        )
      );
      next.nextImportId = Math.min(
        MAX_JS_SAFE_INTEGER,
        Math.max(
          FIRST_IMPORT_ID,
          Number(next.nextImportId) || FIRST_IMPORT_ID,
          maxId(next.imports) + 1
        )
      );
      return { changed: true };
    });
  }

  backupNativePart() {
    return {
      customContent: {
        schemaVersion: 1,
        customQuestions: clone(this.data.customQuestions),
        customSources: clone(this.data.customSources),
        customTypes: clone(this.data.customTypes),
        customAnswers: clone(this.data.customAnswers)
      },
      imports: clone(this.data.imports),
      apiConfig: clone(this.data.apiConfig),
      reminder: clone(this.data.reminder),
      updateConfig: clone(this.data.updateConfig)
    };
  }

  /**
   * Replaces native study content from a validated backup while keeping this
   * device's reminder/update settings. API key and cloud token live in separate
   * encrypted files and are never part of this replacement.
   */
  replaceFromBackup(validatedNative) {
    return this.mutate((next) => {
      const custom = validatedNative.customContent;
      next.customQuestions = clone(custom.customQuestions);
      next.customSources = clone(custom.customSources);
      next.customTypes = clone(custom.customTypes);
      next.customAnswers = clone(custom.customAnswers);
      next.imports = clone(validatedNative.imports);
      if (validatedNative.apiConfig) {
        next.apiConfig = clone(validatedNative.apiConfig);
      }
      // reminder/updateConfig are device-specific and intentionally preserved.
      next.nextQuestionId = Math.max(
        FIRST_QUESTION_ID,
        maxId(next.customQuestions) + 1
      );
      next.nextSourceId = Math.max(FIRST_SOURCE_ID, maxId(next.customSources) + 1);
      next.nextImportId = Math.max(FIRST_IMPORT_ID, maxId(next.imports) + 1);
    });
  }

  async saveBackupCopy(bytes) {
    try {
      await fs.promises.mkdir(this.backupDirectory, { recursive: true });
      const target = path.join(
        this.backupDirectory,
        `import-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`
      );
      const temporary = path.join(
        this.backupDirectory,
        `backup-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`
      );
      await fs.promises.writeFile(temporary, bytes, { mode: 0o600 });
      await fs.promises.rename(temporary, target);
      const files = (await fs.promises.readdir(this.backupDirectory))
        .filter((name) => name.startsWith("import-") && name.endsWith(".json"))
        .sort();
      while (files.length > 10) {
        const oldest = files.shift();
        try { await fs.promises.unlink(path.join(this.backupDirectory, oldest)); } catch { /* best effort */ }
      }
    } catch {
      throw new UserError("导入备份副本保存失败，未恢复任何内容");
    }
  }
}

module.exports = {
  NativeStore,
  MAX_STORE_BYTES,
  FIRST_QUESTION_ID,
  FIRST_SOURCE_ID,
  FIRST_IMPORT_ID,
  NEW_ID_MIN,
  NEW_ID_LIMIT,
  randomNativeId,
  sanitizeBootstrap,
  emptyData
};
