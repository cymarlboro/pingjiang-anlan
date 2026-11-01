"use strict";

const { UserError } = require("./errors.cjs");
const { APP_ID } = require("./security.cjs");
const { normalizeApiBase } = require("./url-rules.cjs");
const { isValidReminderTime } = require("./text-rules.cjs");

const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const MAX_STATE_BYTES = 4_500_000;
const MAX_JS_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const STATE_FIELDS = new Set([
  "schemaVersion",
  "settings",
  "referenceIds",
  "selectedIds",
  "answerEdits",
  "session",
  "history",
  "imports",
  "schedule",
  "lastUpdated"
]);
const BACKUP_FIELDS = new Set(["schemaVersion", "createdAt", "app", "state", "native"]);
const APP_FIELDS = new Set(["packageName", "versionCode", "versionName"]);
const NATIVE_FIELDS = new Set([
  "customContent",
  "imports",
  "apiConfig",
  "reminder",
  "updateConfig"
]);
const CUSTOM_FIELDS = new Set([
  "schemaVersion",
  "customQuestions",
  "customSources",
  "customTypes",
  "customAnswers"
]);
const API_CONFIG_FIELDS = new Set(["serviceName", "baseUrl", "model", "maxQuestions"]);
const REMINDER_FIELDS = new Set(["enabled", "time"]);
const UPDATE_FIELDS = new Set(["manifestUrl", "customized"]);

const SENSITIVE_KEYS = new Set([
  "key",
  "apikey",
  "token",
  "password",
  "secret",
  "authorization",
  "auth",
  "bearer",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "credential",
  "credentials",
  "keystore",
  "storepass",
  "keypass",
  "privatekey"
]);

function isSensitiveKey(key) {
  const normalized = String(key || "").toLowerCase().replace(/[\s_-]/g, "");
  if (SENSITIVE_KEYS.has(normalized)) {
    return true;
  }
  return (
    normalized.endsWith("key") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    normalized.endsWith("credential")
  );
}

function assertNoSensitiveKeys(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoSensitiveKeys(item);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const key of Object.keys(value)) {
    if (isSensitiveKey(key)) {
      throw new UserError("备份包含不支持的密钥或令牌字段，已拒绝");
    }
    assertNoSensitiveKeys(value[key]);
  }
}

function sanitizeForExport(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeForExport);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const result = {};
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    if (!isSensitiveKey(key)) {
      result[key] = sanitizeForExport(value[key]);
    }
  }
  return result;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new UserError("备份内容包含无法序列化的数据");
  }
}

function rejectUnknown(object, allowed, message) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new UserError(message);
    }
  }
}

function validateState(raw) {
  if (!isPlainObject(raw)) {
    throw new UserError("备份缺少学习记录");
  }
  rejectUnknown(raw, STATE_FIELDS, "学习记录包含未知字段");
  const result = {};
  if (Object.prototype.hasOwnProperty.call(raw, "schemaVersion")) {
    const schema = Number(raw.schemaVersion);
    if (!Number.isInteger(schema) || schema < 1 || schema > 1000) {
      throw new UserError("学习记录版本无效");
    }
    result.schemaVersion = schema;
  } else {
    result.schemaVersion = 1;
  }
  for (const key of ["settings", "answerEdits", "schedule"]) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      if (!isPlainObject(raw[key])) {
        throw new UserError("学习记录字段格式错误");
      }
      result[key] = cloneJson(raw[key]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, "session")) {
    if (raw.session !== null && !isPlainObject(raw.session)) {
      throw new UserError("学习记录会话格式错误");
    }
    result.session = raw.session === null ? null : cloneJson(raw.session);
  }
  for (const key of ["referenceIds", "selectedIds"]) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      if (!Array.isArray(raw[key]) || raw[key].length > 20000) {
        throw new UserError("学习记录题目编号格式错误");
      }
      result[key] = cloneJson(raw[key]);
    }
  }
  for (const key of ["history", "imports"]) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      if (!Array.isArray(raw[key]) || raw[key].length > 100000) {
        throw new UserError("学习记录条目过多或格式错误");
      }
      result[key] = cloneJson(raw[key]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, "lastUpdated")) {
    if (raw.lastUpdated !== null && typeof raw.lastUpdated !== "string") {
      throw new UserError("学习记录时间字段无效");
    }
    if (typeof raw.lastUpdated === "string" && raw.lastUpdated.length > 80) {
      throw new UserError("学习记录时间字段无效");
    }
    result.lastUpdated = raw.lastUpdated;
  }
  const contentKeys = [
    "settings", "referenceIds", "selectedIds", "answerEdits", "session",
    "history", "imports", "schedule"
  ];
  if (!contentKeys.some((key) => Object.prototype.hasOwnProperty.call(raw, key))) {
    throw new UserError("备份缺少学习记录内容");
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_STATE_BYTES) {
    throw new UserError("学习记录超过网页本机存储可写入的大小");
  }
  return result;
}

function validateApiConfig(raw) {
  if (!isPlainObject(raw)) {
    throw new UserError("备份 API 配置格式错误");
  }
  rejectUnknown(raw, API_CONFIG_FIELDS, "备份 API 配置包含未知字段");
  const config = {
    serviceName: typeof raw.serviceName === "string" ? raw.serviceName.trim().slice(0, 60) : "",
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "",
    model: typeof raw.model === "string" ? raw.model.trim().slice(0, 200) : "",
    maxQuestions: Math.min(10, Math.max(1, Number(raw.maxQuestions) || 5))
  };
  if (config.baseUrl) {
    config.baseUrl = normalizeApiBase(config.baseUrl);
  }
  return config;
}

function validateReminder(raw) {
  if (!isPlainObject(raw)) {
    throw new UserError("备份提醒配置格式错误");
  }
  rejectUnknown(raw, REMINDER_FIELDS, "备份提醒配置包含未知字段");
  const time = typeof raw.time === "string" ? raw.time : "20:30";
  if (!isValidReminderTime(time)) {
    throw new UserError("备份提醒时间格式错误");
  }
  return { enabled: raw.enabled === true, time };
}

function validateUpdateConfig(raw) {
  if (!isPlainObject(raw)) {
    throw new UserError("备份更新配置格式错误");
  }
  rejectUnknown(raw, UPDATE_FIELDS, "备份更新配置包含未知字段");
  return {
    manifestUrl: typeof raw.manifestUrl === "string" ? raw.manifestUrl : "",
    customized: raw.customized === true
  };
}

function validateNative(raw) {
  if (!isPlainObject(raw)) {
    throw new UserError("备份缺少原生内容");
  }
  rejectUnknown(raw, NATIVE_FIELDS, "备份原生内容包含未知字段");
  const apiConfig = raw.apiConfig === undefined || raw.apiConfig === null
    ? null
    : validateApiConfig(raw.apiConfig);
  if (!isPlainObject(raw.customContent)) {
    throw new UserError("备份缺少自定义题库");
  }
  // Use the same native whitelist as cloud export/apply. A restored backup must
  // never contain content that the cloud sync path would reject later.
  const customContent = Object.assign({}, raw.customContent);
  if (customContent.schemaVersion === undefined || customContent.schemaVersion === null) {
    customContent.schemaVersion = 1;
  }
  const { validateNative: validateSyncNative } = require("./cloud-sync.cjs");
  const syncNative = validateSyncNative({
    customContent,
    imports: raw.imports === undefined || raw.imports === null ? [] : raw.imports
  });
  return {
    customContent: syncNative.customContent,
    imports: syncNative.imports,
    apiConfig,
    reminder: raw.reminder === undefined || raw.reminder === null
      ? null
      : validateReminder(raw.reminder),
    updateConfig: raw.updateConfig === undefined || raw.updateConfig === null
      ? null
      : validateUpdateConfig(raw.updateConfig)
  };
}

function validateBackup(root) {
  if (!isPlainObject(root)) {
    throw new UserError("备份 JSON 格式错误");
  }
  assertNoSensitiveKeys(root);
  rejectUnknown(root, BACKUP_FIELDS, "备份包含未知字段");
  if (Number(root.schemaVersion) !== 1) {
    throw new UserError("备份版本不受支持");
  }
  const createdAt = typeof root.createdAt === "string" ? root.createdAt : "";
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
    throw new UserError("备份创建时间无效");
  }
  if (!isPlainObject(root.app)) {
    throw new UserError("备份缺少应用信息");
  }
  rejectUnknown(root.app, APP_FIELDS, "备份应用信息包含未知字段");
  const { validateCloudState } = require("./cloud-sync.cjs");
  const state = validateCloudState(root.state);
  const native = validateNative(root.native);
  return { state, native };
}

function buildBackup({ state, native, now = new Date(), versionCode = 1, versionName = "1.0.0" }) {
  if (!isPlainObject(state) || !isPlainObject(native)) {
    throw new UserError("学习记录或本机数据为空，无法备份");
  }
  const backup = {
    schemaVersion: 1,
    createdAt: new Date(now).toISOString(),
    app: {
      packageName: APP_ID,
      versionCode: Number(versionCode),
      versionName: String(versionName)
    },
    state: validateState(sanitizeForExport(state)),
    native: {
      customContent: {
        schemaVersion: 1,
        customQuestions: cloneJson(native.customContent?.customQuestions || []),
        customSources: cloneJson(native.customContent?.customSources || []),
        customTypes: cloneJson(native.customContent?.customTypes || {}),
        customAnswers: cloneJson(native.customContent?.customAnswers || [])
      },
      imports: cloneJson(native.imports || []),
      apiConfig: native.apiConfig ? cloneJson(native.apiConfig) : null,
      reminder: native.reminder ? cloneJson(native.reminder) : null,
      updateConfig: native.updateConfig ? cloneJson(native.updateConfig) : null
    }
  };
  // Second line of defence: a future state field named key/token can never leak.
  const safe = sanitizeForExport(backup);
  assertNoSensitiveKeys(safe);
  const text = JSON.stringify(safe, null, 2);
  if (Buffer.byteLength(text, "utf8") > MAX_BACKUP_BYTES) {
    throw new UserError("备份超过 20MB，请减少导入资料后再导出");
  }
  return { backup: safe, text };
}

function parseBackupText(text) {
  if (typeof text !== "string" || !text.length) {
    throw new UserError("备份文件为空");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BACKUP_BYTES) {
    throw new UserError("备份文件超过 20MB");
  }
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    throw new UserError("备份 JSON 格式错误");
  }
  return validateBackup(root);
}

module.exports = {
  MAX_BACKUP_BYTES,
  MAX_STATE_BYTES,
  isSensitiveKey,
  sanitizeForExport,
  assertNoSensitiveKeys,
  validateState,
  validateBackup,
  buildBackup,
  parseBackupText
};
