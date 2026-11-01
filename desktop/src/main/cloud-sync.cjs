"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { UserError } = require("./errors.cjs");
const { requestOnce } = require("./http-request.cjs");
const {
  AuthRequiredError,
  PROJECT_URL,
  PROJECT_HOST,
  PUBLISHABLE_KEY,
  CONFIGURED
} = require("./cloud-auth.cjs");
const { isSensitiveKey, validateState } = require("./backup.cjs");
const { isValidReminderTime } = require("./text-rules.cjs");
const { normalize: normalizeType } = require("./question-types.cjs");

const STATE_PATH = "/rest/v1/pja_learning_state";
const COMMIT_PATH = "/rest/v1/rpc/pja_sync_commit";
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_JS_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const REQUEST_TIMEOUT_MS = 30000;
const BINDING_FILE = "cloud-sync-owner.json";

const NETWORK_ERROR = "无法连接云端，请检查网络后重试";
const SERVICE_ERROR = "云端服务暂时不可用，请稍后再试";
const RESPONSE_ERROR = "云端响应异常，请稍后重试";
const INVALID_SESSION_ERROR = "登录已失效，请重新登录";
const RATE_LIMIT_ERROR = "操作过于频繁，请稍后再试";
const TOO_LARGE_ERROR = "同步内容过大，请减少导入资料后再试";
const INVALID_BUNDLE_ERROR = "同步内容格式不正确，已拒绝";
const SENSITIVE_ERROR = "同步内容包含不支持的密钥或令牌字段，已拒绝";
const OWNER_INVALID_ERROR = "云端账户标识异常，已停止同步";
const OWNER_MISMATCH_ERROR = "云端账户与本机当前登录账户不一致，已停止同步";
const ACCOUNT_SWITCH_ERROR =
  "本机学习数据已绑定其他云端账户。请退出登录后重新登录原绑定账户继续同步；如需改用新账户，请先导出学习数据备份，再清除本机应用数据后重新登录。退出登录不会删除本机学习记录。";
const BINDING_ERROR = "本机云端同步账户绑定读取或保存失败，已停止同步";
const BINDING_CORRUPT_ERROR =
  "本机云端同步账户绑定信息损坏。请先导出学习数据备份；如仍无法同步，需清除本机应用数据后重新登录。";

const BUNDLE_FIELDS = new Set(["schemaVersion", "state", "native"]);
const NATIVE_FIELDS = new Set(["customContent", "imports"]);
const CUSTOM_FIELDS = new Set([
  "schemaVersion", "customQuestions", "customSources", "customTypes", "customAnswers"
]);
const QUESTION_FIELDS = new Set([
  "id", "chapter", "question", "options", "answer", "explanation",
  "source_id", "locator", "type", "metadata"
]);
const SOURCE_FIELDS = new Set(["id", "name", "format", "importId"]);
const ANSWER_FIELDS = new Set([
  "question_id", "answer", "key_points", "status", "references", "caveat",
  "sourceQuote", "pageIndex", "locator", "sourceName", "type", "chapter",
  "userEdited", "origin"
]);
const IMPORT_FIELDS = new Set([
  "id", "name", "format", "size", "createdAt", "pages", "needsOcr",
  "truncated", "note"
]);
const PAGE_FIELDS = new Set([
  "pageIndex", "locator", "text", "paragraphIndex", "ocr", "needsOcr"
]);
const SETTINGS_FIELDS = new Set(["dailyTarget", "accountName", "reminder"]);
const REMINDER_FIELDS = new Set(["enabled", "time"]);
const ANSWER_STATUSES = new Set(["draft", "needs_figure_review", "needs_source_review"]);
const FORMATS = new Set(["pdf", "docx", "md", "html", "txt"]);
const EXTRA_SENSITIVE = new Set([
  "role", "roles", "servicerole", "usermetadata", "appmetadata",
  "apiconfig", "updateconfig", "baseurl"
]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
}

function normalizedKey(key) {
  return String(key || "").toLowerCase().replace(/[\s_-]/g, "");
}

function assertNoSensitiveKeys(value, seen = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoSensitiveKeys(item, seen);
    }
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const key of Object.keys(value)) {
    const normalized = normalizedKey(key);
    if (DANGEROUS_KEYS.has(key) ||
        isSensitiveKey(key) ||
        normalized.includes("role") ||
        EXTRA_SENSITIVE.has(normalized)) {
      throw new UserError(SENSITIVE_ERROR);
    }
    assertNoSensitiveKeys(value[key], seen);
  }
}

function rejectUnknown(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key) || DANGEROUS_KEYS.has(key)) {
      // Do not reflect attacker-controlled field names in a user-visible error.
      throw new UserError(`${label}包含不支持的字段`.slice(0, 120));
    }
  }
}

function requiredString(value, max, label) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new UserError(`${label}格式错误`.slice(0, 120));
  }
  return value;
}

function optionalString(value, max, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string" || value.length > max) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  return value;
}

function requiredId(value, min, label) {
  if (typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > MAX_JS_SAFE_INTEGER) {
    throw new UserError(`${label}编号无效`.slice(0, 120));
  }
  return value;
}

function optionalId(value, min) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requiredId(value, min, "同步内容");
}

function optionalInteger(value, min, max) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  return value;
}

function optionalBoolean(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  return value;
}

function validateSettings(raw) {
  if (!isPlainObject(raw)) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  rejectUnknown(raw, SETTINGS_FIELDS, "同步设置");
  const result = {};
  if (Object.prototype.hasOwnProperty.call(raw, "dailyTarget")) {
    if (typeof raw.dailyTarget !== "number" ||
        !Number.isSafeInteger(raw.dailyTarget) ||
        raw.dailyTarget < 1 ||
        raw.dailyTarget > 100000) {
      throw new UserError(INVALID_BUNDLE_ERROR);
    }
    result.dailyTarget = raw.dailyTarget;
  }
  if (Object.prototype.hasOwnProperty.call(raw, "accountName")) {
    if (typeof raw.accountName !== "string" || raw.accountName.length > 200) {
      throw new UserError(INVALID_BUNDLE_ERROR);
    }
    result.accountName = raw.accountName;
  }
  if (Object.prototype.hasOwnProperty.call(raw, "reminder")) {
    if (!isPlainObject(raw.reminder)) {
      throw new UserError(INVALID_BUNDLE_ERROR);
    }
    rejectUnknown(raw.reminder, REMINDER_FIELDS, "同步提醒设置");
    const reminder = {};
    if (Object.prototype.hasOwnProperty.call(raw.reminder, "enabled")) {
      if (typeof raw.reminder.enabled !== "boolean") {
        throw new UserError(INVALID_BUNDLE_ERROR);
      }
      reminder.enabled = raw.reminder.enabled;
    }
    if (Object.prototype.hasOwnProperty.call(raw.reminder, "time")) {
      if (!isValidReminderTime(raw.reminder.time)) {
        throw new UserError(INVALID_BUNDLE_ERROR);
      }
      reminder.time = raw.reminder.time;
    }
    result.reminder = reminder;
  }
  return result;
}

function validateCloudState(raw) {
  const state = validateState(raw);
  if (Object.prototype.hasOwnProperty.call(state, "settings")) {
    state.settings = validateSettings(state.settings);
  }
  for (const field of ["referenceIds", "selectedIds"]) {
    if (!Object.prototype.hasOwnProperty.call(state, field)) {
      continue;
    }
    for (const id of state[field]) {
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
        throw new UserError(INVALID_BUNDLE_ERROR);
      }
    }
  }
  assertNoSensitiveKeys(state);
  return state;
}

function validateQuestion(raw) {
  if (!isPlainObject(raw)) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  rejectUnknown(raw, QUESTION_FIELDS, "同步自定义题");
  const result = {
    id: requiredId(raw.id, 1_000_000, "同步自定义题"),
    chapter: optionalString(raw.chapter, 120),
    question: requiredString(raw.question, 20000, "同步自定义题题干"),
    options: optionalString(raw.options, 20000),
    answer: optionalString(raw.answer, 50000),
    explanation: optionalString(raw.explanation, 100000),
    source_id: requiredId(raw.source_id, 900_000, "同步自定义题来源"),
    locator: optionalString(raw.locator, 200)
  };
  if (raw.type !== undefined && raw.type !== null) {
    const type = normalizeType(raw.type);
    if (!type) {
      throw new UserError(INVALID_BUNDLE_ERROR);
    }
    result.type = type;
  }
  if (raw.metadata !== undefined && raw.metadata !== null) {
    result.metadata = cloneJson(raw.metadata);
  }
  return result;
}

function validateSource(raw) {
  if (!isPlainObject(raw)) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  rejectUnknown(raw, SOURCE_FIELDS, "同步自定义来源");
  const format = requiredString(raw.format, 20, "同步自定义来源格式").toLowerCase();
  if (!FORMATS.has(format)) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  const result = {
    id: requiredId(raw.id, 900_000, "同步自定义来源"),
    name: requiredString(raw.name, 240, "同步自定义来源名称"),
    format
  };
  const importId = optionalId(raw.importId, 100_000);
  if (importId !== undefined) {
    result.importId = importId;
  }
  return result;
}

function validateAnswer(raw) {
  if (!isPlainObject(raw)) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  rejectUnknown(raw, ANSWER_FIELDS, "同步自定义答案");
  const result = {
    question_id: requiredId(raw.question_id, 1_000_000, "同步自定义答案题号"),
    answer: requiredString(raw.answer, 50000, "同步自定义答案")
  };
  if (raw.key_points !== undefined && raw.key_points !== null) {
    if (!Array.isArray(raw.key_points) || raw.key_points.length > 100) {
      throw new UserError(INVALID_BUNDLE_ERROR);
    }
    result.key_points = raw.key_points.map((point) => {
      if (typeof point !== "string" || point.length > 2000) {
        throw new UserError(INVALID_BUNDLE_ERROR);
      }
      return point;
    });
  }
  if (raw.status !== undefined && raw.status !== null) {
    if (typeof raw.status !== "string" || !ANSWER_STATUSES.has(raw.status)) {
      throw new UserError(INVALID_BUNDLE_ERROR);
    }
    result.status = raw.status;
  }
  if (raw.references !== undefined && raw.references !== null) {
    if (!Array.isArray(raw.references) || raw.references.length > 1000) {
      throw new UserError(INVALID_BUNDLE_ERROR);
    }
    result.references = raw.references.map((reference) => {
      if (!isPlainObject(reference)) {
        throw new UserError(INVALID_BUNDLE_ERROR);
      }
      rejectUnknown(reference, new Set(["unit_id", "pdf_page", "quote"]), "同步自定义答案引用");
      const unitId = requiredId(reference.unit_id, 1, "同步自定义答案引用");
      const pdfPage = requiredId(reference.pdf_page, 1, "同步自定义答案引用");
      const quote = requiredString(reference.quote, 10000, "同步自定义答案引用");
      return { unit_id: unitId, pdf_page: pdfPage, quote };
    });
  }
  const strings = [
    ["caveat", 4000], ["sourceQuote", 10000], ["locator", 200],
    ["sourceName", 240], ["chapter", 120], ["origin", 40]
  ];
  for (const [field, max] of strings) {
    if (raw[field] !== undefined && raw[field] !== null) {
      result[field] = optionalString(raw[field], max);
    }
  }
  const pageIndex = optionalInteger(raw.pageIndex, 0, 100000);
  if (pageIndex !== undefined) {
    result.pageIndex = pageIndex;
  }
  if (raw.type !== undefined && raw.type !== null) {
    const type = normalizeType(raw.type);
    if (!type) {
      throw new UserError(INVALID_BUNDLE_ERROR);
    }
    result.type = type;
  }
  const userEdited = optionalBoolean(raw.userEdited);
  if (userEdited !== undefined) {
    result.userEdited = userEdited;
  }
  return result;
}

function validatePage(raw) {
  if (!isPlainObject(raw)) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  rejectUnknown(raw, PAGE_FIELDS, "同步导入页段");
  const pageIndex = requiredId(raw.pageIndex, 0, "同步导入页段");
  if (pageIndex > 100000) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  const result = {
    pageIndex,
    locator: optionalString(raw.locator, 300),
    text: optionalString(raw.text, 2_000_000)
  };
  const paragraphIndex = optionalInteger(raw.paragraphIndex, 0, MAX_JS_SAFE_INTEGER);
  if (paragraphIndex !== undefined) {
    result.paragraphIndex = paragraphIndex;
  }
  const needsOcr = optionalBoolean(raw.needsOcr);
  if (needsOcr !== undefined) {
    result.needsOcr = needsOcr;
  }
  const ocr = optionalBoolean(raw.ocr);
  if (ocr !== undefined) {
    result.ocr = ocr;
  }
  return result;
}

function validateImport(raw) {
  if (!isPlainObject(raw)) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  rejectUnknown(raw, IMPORT_FIELDS, "同步导入资料");
  const format = requiredString(raw.format, 20, "同步导入资料格式").toLowerCase();
  if (!FORMATS.has(format)) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  if (!Array.isArray(raw.pages) || raw.pages.length > 5000) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  const pageIndexes = new Set();
  let totalChars = 0;
  const pages = raw.pages.map((page) => {
    const clean = validatePage(page);
    if (pageIndexes.has(clean.pageIndex)) {
      throw new UserError(INVALID_BUNDLE_ERROR);
    }
    pageIndexes.add(clean.pageIndex);
    totalChars += clean.text.length;
    if (totalChars > 5_000_000) {
      throw new UserError(TOO_LARGE_ERROR);
    }
    return clean;
  });
  const result = {
    id: requiredId(raw.id, 100_000, "同步导入资料"),
    name: requiredString(raw.name, 240, "同步导入资料名称"),
    format,
    createdAt: optionalString(raw.createdAt, 80),
    pages
  };
  const size = optionalInteger(raw.size, 0, 30 * 1024 * 1024);
  if (size !== undefined) {
    result.size = size;
  }
  const needsOcr = optionalBoolean(raw.needsOcr);
  if (needsOcr !== undefined) {
    result.needsOcr = needsOcr;
  }
  const truncated = optionalBoolean(raw.truncated);
  if (truncated !== undefined) {
    result.truncated = truncated;
  }
  if (raw.note !== undefined && raw.note !== null) {
    result.note = optionalString(raw.note, 1000);
  }
  return result;
}

/**
 * Validates and normalizes the native snapshot. Export, pull and apply all use
 * this one whitelist so apiConfig/reminder/updateConfig/tokens can never enter
 * a synced bundle.
 */
function validateNative(raw) {
  if (!isPlainObject(raw)) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  rejectUnknown(raw, NATIVE_FIELDS, "同步原生内容");
  const custom = raw.customContent;
  if (!isPlainObject(custom)) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  rejectUnknown(custom, CUSTOM_FIELDS, "同步自定义内容");
  if (custom.schemaVersion !== 1) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  for (const field of ["customQuestions", "customSources", "customAnswers"]) {
    if (custom[field] !== undefined && custom[field] !== null && !Array.isArray(custom[field])) {
      throw new UserError(INVALID_BUNDLE_ERROR);
    }
  }
  if (raw.imports !== undefined && raw.imports !== null && !Array.isArray(raw.imports)) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  const questions = (custom.customQuestions || []).map(validateQuestion);
  const sources = (custom.customSources || []).map(validateSource);
  const answers = (custom.customAnswers || []).map(validateAnswer);
  const imports = (raw.imports === undefined || raw.imports === null
    ? []
    : raw.imports).map(validateImport);
  if (questions.length > 10000 || sources.length > 10000 ||
      answers.length > 10000 || imports.length > 500) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  const types = custom.customTypes === undefined || custom.customTypes === null
    ? {}
    : custom.customTypes;
  if (!isPlainObject(types)) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  const cleanTypes = {};
  for (const key of Object.keys(types)) {
    if (!/^\d{1,16}$/.test(key)) {
      throw new UserError(INVALID_BUNDLE_ERROR);
    }
    const type = normalizeType(types[key]);
    if (!type) {
      throw new UserError(INVALID_BUNDLE_ERROR);
    }
    cleanTypes[key] = type;
  }

  const sourceIds = new Set(sources.map((item) => item.id));
  if (sourceIds.size !== sources.length) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  const questionIds = new Set(questions.map((item) => item.id));
  if (questionIds.size !== questions.length) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  if (new Set(answers.map((item) => item.question_id)).size !== answers.length ||
      new Set(imports.map((item) => item.id)).size !== imports.length) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  for (const question of questions) {
    if (!sourceIds.has(question.source_id)) {
      throw new UserError(INVALID_BUNDLE_ERROR);
    }
  }
  for (const answer of answers) {
    if (!questionIds.has(answer.question_id)) {
      throw new UserError(INVALID_BUNDLE_ERROR);
    }
  }
  for (const key of Object.keys(cleanTypes)) {
    if (!questionIds.has(Number(key))) {
      throw new UserError(INVALID_BUNDLE_ERROR);
    }
  }

  const native = {
    customContent: {
      schemaVersion: 1,
      customQuestions: questions,
      customSources: sources,
      customTypes: cleanTypes,
      customAnswers: answers
    },
    imports
  };
  assertNoSensitiveKeys(native);
  if (Buffer.byteLength(JSON.stringify(native), "utf8") > MAX_BUNDLE_BYTES) {
    throw new UserError(TOO_LARGE_ERROR);
  }
  return native;
}

function validateBundle(raw) {
  if (!isPlainObject(raw)) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  rejectUnknown(raw, BUNDLE_FIELDS, "同步包");
  if (raw.schemaVersion !== 1) {
    throw new UserError(INVALID_BUNDLE_ERROR);
  }
  const bundle = {
    schemaVersion: 1,
    state: validateCloudState(raw.state),
    native: validateNative(raw.native)
  };
  assertNoSensitiveKeys(bundle);
  const text = JSON.stringify(bundle);
  if (Buffer.byteLength(text, "utf8") > MAX_BUNDLE_BYTES) {
    throw new UserError(TOO_LARGE_ERROR);
  }
  return bundle;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new UserError(RESPONSE_ERROR);
  }
}

function readRevision(value) {
  const number = typeof value === "number"
    ? value
    : (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new UserError(RESPONSE_ERROR);
  }
  return number;
}

function normalizeOwnerId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new UserError(OWNER_INVALID_ERROR);
  }
  return value.toLowerCase();
}

function parseStateResponse(body) {
  const parsed = parseJson(body);
  if (!Array.isArray(parsed) || parsed.length > 1) {
    throw new UserError(RESPONSE_ERROR);
  }
  if (parsed.length === 0) {
    return null;
  }
  const row = parsed[0];
  if (!isPlainObject(row) || !Object.prototype.hasOwnProperty.call(row, "revision")) {
    throw new UserError(RESPONSE_ERROR);
  }
  const revision = readRevision(row.revision);
  if (!Object.prototype.hasOwnProperty.call(row, "payload")) {
    throw new UserError(RESPONSE_ERROR);
  }
  const payload = row.payload === null ? null : validateBundle(row.payload);
  return { revision, payload };
}

function parseCommitResponse(body) {
  const parsed = parseJson(body);
  if (typeof parsed === "number" ||
      (typeof parsed === "string" && /^\d+$/.test(parsed))) {
    return readRevision(parsed);
  }
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  if (typeof row === "number" ||
      (typeof row === "string" && /^\d+$/.test(row))) {
    return readRevision(row);
  }
  if (!isPlainObject(row) || !Object.prototype.hasOwnProperty.call(row, "revision")) {
    throw new UserError(RESPONSE_ERROR);
  }
  return readRevision(row.revision);
}

class OwnerBinding {
  constructor({ userDataDir }) {
    this.directory = path.join(userDataDir, "native");
    this.file = path.join(this.directory, BINDING_FILE);
  }

  async read() {
    let raw;
    try {
      raw = await fs.promises.readFile(this.file, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return "";
      }
      throw new UserError(BINDING_ERROR);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new UserError(BINDING_CORRUPT_ERROR);
    }
    if (!isPlainObject(parsed) ||
        parsed.schemaVersion !== 1 ||
        typeof parsed.ownerId !== "string" ||
        !UUID_PATTERN.test(parsed.ownerId)) {
      throw new UserError(BINDING_CORRUPT_ERROR);
    }
    return parsed.ownerId.toLowerCase();
  }

  async ensure(ownerId) {
    const existing = await this.read();
    if (existing) {
      if (existing !== ownerId) {
        throw new UserError(ACCOUNT_SWITCH_ERROR);
      }
      return existing;
    }
    await this.write(ownerId);
    return ownerId;
  }

  async write(ownerId) {
    const text = JSON.stringify({ schemaVersion: 1, ownerId });
    const temporary = path.join(
      this.directory,
      `cloud-sync-owner-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`
    );
    let handle;
    try {
      await fs.promises.mkdir(this.directory, { recursive: true });
      // Refuse to replace a binding created by another operation.
      const existing = await this.read();
      if (existing) {
        if (existing !== ownerId) {
          throw new UserError(ACCOUNT_SWITCH_ERROR);
        }
        return;
      }
      handle = await fs.promises.open(temporary, "wx", 0o600);
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.promises.rename(temporary, this.file);
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch { /* best effort */ }
      }
      try { fs.unlinkSync(temporary); } catch { /* best effort */ }
      if (error instanceof UserError) {
        throw error;
      }
      throw new UserError(BINDING_ERROR);
    }
  }
}

class CloudSync {
  constructor({ store, cloudAuth, userDataDir, http = requestOnce }) {
    if (!store || !cloudAuth || typeof userDataDir !== "string" || !userDataDir) {
      throw new Error("CloudSync requires store, cloudAuth and userDataDir");
    }
    this.store = store;
    this.cloudAuth = cloudAuth;
    this.http = http;
    this.binding = new OwnerBinding({ userDataDir });
    this.operationChain = Promise.resolve();
  }

  enqueue(task) {
    const run = this.operationChain.then(task, task);
    this.operationChain = run.then(() => undefined, () => undefined);
    return run;
  }

  stateUrl(ownerId) {
    // ownerId is a validated UUID, so the fixed query string cannot be
    // influenced by caller input.
    const url = new URL(
      `${PROJECT_URL}${STATE_PATH}?select=revision,payload&owner_id=eq.${ownerId}`
    );
    this.assertPinned(url, STATE_PATH);
    return url.href;
  }

  commitUrl() {
    const url = new URL(`${PROJECT_URL}${COMMIT_PATH}`);
    this.assertPinned(url, COMMIT_PATH);
    return url.href;
  }

  assertPinned(url, expectedPath) {
    if (url.protocol !== "https:" ||
        url.hostname !== PROJECT_HOST ||
        (url.port !== "" && url.port !== "443") ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== expectedPath) {
      throw new UserError("云端同步地址不安全");
    }
  }

  async request(method, url, accessToken, body) {
    if (!CONFIGURED) {
      throw new UserError("云端账户尚未配置");
    }
    if (typeof accessToken !== "string" || !accessToken) {
      throw new UserError(INVALID_SESSION_ERROR);
    }
    const parsed = new URL(url);
    this.assertPinned(
      parsed,
      parsed.pathname === COMMIT_PATH ? COMMIT_PATH : STATE_PATH
    );
    const headers = {
      Accept: "application/json",
      apikey: PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`
    };
    if (body !== null && body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }
    let response;
    try {
      response = await this.http({
        method,
        url: parsed.href,
        headers,
        body: body === undefined ? null : body,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES
      });
    } catch (error) {
      if (error instanceof UserError && error.publicMessage.includes("过大")) {
        throw new UserError(TOO_LARGE_ERROR);
      }
      throw new UserError(NETWORK_ERROR);
    }
    if (!response || typeof response.status !== "number") {
      throw new UserError(RESPONSE_ERROR);
    }
    if (response.status >= 300 && response.status < 400) {
      // No redirect is ever followed for credential-bearing requests.
      throw new UserError(RESPONSE_ERROR);
    }
    let text = "";
    if (typeof response.body === "string") {
      text = response.body;
    } else if (response.body !== undefined && response.body !== null) {
      try {
        text = JSON.stringify(response.body);
      } catch {
        throw new UserError(RESPONSE_ERROR);
      }
    }
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new UserError(TOO_LARGE_ERROR);
    }
    return { status: response.status, body: text };
  }

  throwStatus(status) {
    if (status === 401 || status === 403) {
      throw new UserError(INVALID_SESSION_ERROR);
    }
    if (status === 429) {
      throw new UserError(RATE_LIMIT_ERROR);
    }
    if (status === 413) {
      throw new UserError(TOO_LARGE_ERROR);
    }
    if (status >= 500) {
      throw new UserError(SERVICE_ERROR);
    }
    throw new UserError(RESPONSE_ERROR);
  }

  async activeOwner() {
    const credentials = await this.cloudAuth.verifiedCredentials();
    const ownerId = normalizeOwnerId(credentials.userId);
    const boundOwnerId = await this.binding.read();
    if (boundOwnerId && boundOwnerId !== ownerId) {
      throw new UserError(ACCOUNT_SWITCH_ERROR);
    }
    return {
      accessToken: credentials.accessToken,
      ownerId,
      boundOwnerId
    };
  }

  status() {
    return this.enqueue(async () => {
      const boundOwnerId = await this.binding.read();
      let credentials;
      try {
        credentials = await this.cloudAuth.verifiedCredentials();
      } catch (error) {
        if (error instanceof AuthRequiredError) {
          return { ownerId: "", boundOwnerId, allowed: false };
        }
        throw error;
      }
      const ownerId = normalizeOwnerId(credentials.userId);
      return {
        ownerId,
        boundOwnerId,
        allowed: !boundOwnerId || boundOwnerId === ownerId
      };
    });
  }

  pull() {
    return this.enqueue(async () => {
      const active = await this.activeOwner();
      const response = await this.request(
        "GET",
        this.stateUrl(active.ownerId),
        active.accessToken,
        null
      );
      if (response.status < 200 || response.status >= 300) {
        this.throwStatus(response.status);
      }
      const row = parseStateResponse(response.body);
      // Do not persist a binding on pull. The shared UI binds when it pushes
      // after its pull+merge succeeded, so a failed merge cannot lock the device.
      if (!row) {
        return { ownerId: active.ownerId, revision: 0, payload: null };
      }
      return {
        ownerId: active.ownerId,
        revision: row.revision,
        payload: row.payload
      };
    });
  }

  push(payload) {
    return this.enqueue(async () => {
      const data = isPlainObject(payload) ? payload : {};
      const expectedRevision = data.expectedRevision;
      if (typeof expectedRevision !== "number" ||
          !Number.isSafeInteger(expectedRevision) ||
          expectedRevision < 0) {
        throw new UserError(INVALID_BUNDLE_ERROR);
      }
      const bundle = validateBundle(data.payload);
      const active = await this.activeOwner();
      // The binding must be durable before the first upload can reach the
      // server, otherwise a later account switch could upload another user's
      // local data.
      await this.binding.ensure(active.ownerId);
      const body = JSON.stringify({
        expected_revision: expectedRevision,
        new_payload: bundle
      });
      if (Buffer.byteLength(body, "utf8") > MAX_BUNDLE_BYTES + 4096) {
        throw new UserError(TOO_LARGE_ERROR);
      }
      const response = await this.request(
        "POST",
        this.commitUrl(),
        active.accessToken,
        body
      );
      if (response.status === 409) {
        return { conflict: true };
      }
      if (response.status < 200 || response.status >= 300) {
        this.throwStatus(response.status);
      }
      const revision = parseCommitResponse(response.body);
      return {
        ownerId: active.ownerId,
        revision,
        payload: bundle,
        conflict: false
      };
    });
  }

  exportNative() {
    return this.enqueue(async () => {
      return { native: validateNative(this.store.cloudNativeSnapshot()) };
    });
  }

  apply(payload) {
    return this.enqueue(async () => {
      const data = isPlainObject(payload) ? payload : {};
      const ownerId = normalizeOwnerId(data.ownerId);
      const native = validateNative(data.native);
      const active = await this.activeOwner();
      if (ownerId !== active.ownerId) {
        throw new UserError(OWNER_MISMATCH_ERROR);
      }
      await this.binding.ensure(ownerId);
      const result = await this.store.mergeCloudNative(native);
      if (result.changed === true) {
        // The bootstrap snapshot is generated from the merged store. This also
        // verifies the sanitized bootstrap remains readable after the merge.
        this.store.bootstrapJson();
      }
      return { changed: result.changed === true };
    });
  }
}

module.exports = {
  CloudSync,
  OwnerBinding,
  validateBundle,
  validateNative,
  validateCloudState,
  MAX_BUNDLE_BYTES,
  MAX_RESPONSE_BYTES,
  STATE_PATH,
  COMMIT_PATH
};
