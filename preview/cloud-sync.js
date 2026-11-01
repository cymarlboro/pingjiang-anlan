/*
 * 平江安澜 · 跨设备同步（安装版）
 *
 * 网页只负责“合并什么、什么时候应用”，真正的网络、令牌、账户校验和
 * 原生资料库写入全部在安装版完成。这里绝不读取或保存访问令牌、API Key、
 * 密码或角色；浏览器预览不会同步，也不会调用任何云端方法。
 *
 * 纯合并函数通过 UMD 导出，Node 测试不需要真实网络或账户。
 */
(function (root, factory) {
  "use strict";
  var api = factory(root);
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.StudyCloudSync = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  var SCHEMA_VERSION = 1;
  var MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
  var MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
  var FIRST_NATIVE_ID = 1000000000000;
  var NATIVE_ID_LIMIT = Math.pow(2, 52);
  var MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
  var META_KEY = "pingjianganlan.cloud-sync.meta.v1";
  var LAST_GOOD_KEY = "pingjianganlan.cloud-sync.last-good.v1";
  var CONFLICT_KEY = "pingjianganlan.cloud-sync.conflicts.v1";
  var DEBOUNCE_MS = 2500;
  var MAX_ATTEMPTS = 3;

  var STATE_KEYS = [
    "schemaVersion", "settings", "referenceIds", "selectedIds", "answerEdits",
    "session", "history", "imports", "schedule", "lastUpdated"
  ];
  var SETTINGS_KEYS = ["dailyTarget", "accountName", "reminder"];
  var REMINDER_KEYS = ["enabled", "time"];
  var NATIVE_KEYS = ["customContent", "imports"];
  var CUSTOM_KEYS = ["schemaVersion", "customQuestions", "customSources", "customTypes", "customAnswers"];
  var QUESTION_FIELDS = [
    "id", "chapter", "question", "options", "answer", "explanation",
    "source_id", "locator", "type", "metadata"
  ];
  var SOURCE_FIELDS = ["id", "name", "format", "importId"];
  var ANSWER_FIELDS = [
    "question_id", "answer", "key_points", "status", "references", "caveat",
    "sourceQuote", "pageIndex", "locator", "sourceName", "type", "chapter",
    "userEdited", "origin"
  ];
  var IMPORT_FIELDS = [
    "id", "name", "format", "size", "createdAt", "pages", "needsOcr",
    "truncated", "note"
  ];
  var PAGE_FIELDS = [
    "pageIndex", "locator", "text", "paragraphIndex", "ocr", "needsOcr"
  ];
  var HISTORY_FIELDS = ["id", "date", "at", "rating", "chapter", "source_id"];
  var EDIT_FIELDS = ["text", "updatedAt", "updatedDate"];
  var IMPORT_STATE_FIELDS = [
    "id", "name", "format", "size", "registeredAt", "registeredDate", "status", "parseStatus"
  ];
  var SESSION_FIELDS = [
    "date", "target", "planIds", "mandatoryIds", "queue", "currentId", "revealed",
    "completed", "completedAt", "cards", "relearn", "forgottenIds", "waitingRelearn",
    "startedAt", "gapWarning"
  ];
  var CARD_FIELDS = ["attempts", "lastRating", "forgotten", "lastAt"];
  var RELEARN_FIELDS = ["id", "remaining"];
  var SCHEDULE_FIELDS = [
    "stability", "knownCount", "lapses", "nextDue", "dueDate", "forcedDueDate",
    "lastReviewedAt", "lastGrowthAt", "lastForgotDate", "lastSuccessDate",
    "lastRating", "updatedAt", "legacy"
  ];
  var FORMATS = ["pdf", "docx", "md", "html", "txt"];
  var ANSWER_STATUSES = ["draft", "needs_figure_review", "needs_source_review"];
  var SENSITIVE_KEYS = {
    key: true, apikey: true, token: true, accesstoken: true, refreshtoken: true,
    password: true, pwd: true, secret: true, clientsecret: true,
    authorization: true, auth: true, bearer: true, credential: true,
    credentials: true, role: true, roles: true, servicerole: true,
    privatekey: true, keystore: true, storepass: true, keypass: true
  };
  var DEFAULT_SETTINGS = {
    dailyTarget: 10,
    accountName: "水利同学",
    reminder: { enabled: false, time: "20:30" }
  };
  // One native-content contract shared by preview, desktop and Android. These
  // values are the broadest bounds already accepted by an existing native
  // validator/backup, so legacy content can still sync after one cleanup.
  var MAX_QUESTION_TEXT = 20000;
  var MAX_PAGE_LOCATOR = 300;
  var MAX_PAGE_TEXT = 2000000;
  var MAX_IMPORT_TEXT = 5000000;
  var MAX_IMPORT_NOTE = 1000;
  var MAX_IMPORT_SIZE = 30 * 1024 * 1024;
  var MIN_QUESTION_ID = 1000000;
  var MIN_SOURCE_ID = 900000;
  var MIN_IMPORT_ID = 100000;
  var QUESTION_TYPE_ALIASES = {
    "简答": "简答题",
    "简答题": "简答题",
    "简述题": "简答题",
    "名词": "名词解释",
    "名词解释": "名词解释",
    "论述": "论述题",
    "论述题": "论述题",
    "读图与分析题": "读图分析题",
    "读图分析": "读图分析题",
    "读图分析题": "读图分析题",
    "读图题": "读图分析题",
    "图题": "读图分析题",
    "图表分析题": "读图分析题",
    "填空": "填空题",
    "填空题": "填空题",
    "判断": "判断题",
    "判断题": "判断题",
    "选择": "选择题",
    "选择题": "选择题",
    "单项选择": "选择题",
    "单项选择题": "选择题",
    "单选题": "选择题",
    "分类与配对题": "分类与配对题",
    "分类题": "分类与配对题",
    "配对题": "分类与配对题"
  };

  var MemoryScheduler = root && root.MemoryScheduler;
  if (!MemoryScheduler && typeof require === "function") {
    try {
      MemoryScheduler = require("./memory-scheduler.js");
    } catch (error) {
      MemoryScheduler = null;
    }
  }

  function SyncError(code, message) {
    this.name = "SyncError";
    this.code = code;
    this.message = message;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SyncError);
    }
  }
  SyncError.prototype = Object.create(Error.prototype);
  SyncError.prototype.constructor = SyncError;

  function fail(code, message) {
    throw new SyncError(code, message);
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function normalizeQuestionType(value) {
    if (typeof value !== "string") {
      return null;
    }
    var key = value.replace(/[\s\u3000]+/g, "");
    return hasOwn(QUESTION_TYPE_ALIASES, key) ? QUESTION_TYPE_ALIASES[key] : null;
  }

  function isValidReminderTime(value) {
    if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) {
      return false;
    }
    var hours = Number(value.slice(0, 2));
    var minutes = Number(value.slice(3, 5));
    return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
  }

  function safeString(value, max, label) {
    if (value === undefined || value === null) {
      return "";
    }
    if (typeof value !== "string") {
      fail("invalid_bundle", (label || "字段") + "格式不正确，已停止同步。");
    }
    if (value.length > max) {
      fail("too_large", (label || "字段") + "过长，已停止同步。");
    }
    return value;
  }

  function isSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function isSafeNativeId(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= MAX_SAFE_INTEGER;
  }

  function isDateKey(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }
    var parts = value.split("-").map(Number);
    var date = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
    return date.getFullYear() === parts[0] &&
      date.getMonth() === parts[1] - 1 &&
      date.getDate() === parts[2];
  }

  function isValidAt(value) {
    return typeof value === "string" && value.length > 0 &&
      value.length <= 80 && Number.isFinite(Date.parse(value));
  }

  function isoOrNull(value) {
    return isValidAt(value) ? value : null;
  }

  function timeMs(value) {
    return isValidAt(value) ? Date.parse(value) : 0;
  }

  function isUuid(value) {
    return typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  function isSensitiveKey(key) {
    var normalized = String(key === null || key === undefined ? "" : key)
      .toLowerCase().replace(/[\s_-]/g, "");
    if (normalized === "keypoints") {
      return false;
    }
    if (SENSITIVE_KEYS[normalized]) {
      return true;
    }
    return normalized.length > 3 &&
      /(?:token|secret|password|credential|key|role|roles)$/.test(normalized);
  }

  function assertNotDangerousKey(key) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      fail("invalid_bundle", "同步内容包含不安全的字段名，已停止同步。");
    }
  }

  function assertNotSensitive(key, context) {
    assertNotDangerousKey(key);
    if (isSensitiveKey(key)) {
      fail("sensitive_field", (context || "同步内容") +
        "包含不应上传的敏感字段，已停止同步。");
    }
  }

  function assertAllowedKeys(object, allowed, context) {
    Object.keys(object).forEach(function (key) {
      assertNotSensitive(key, context);
      if (allowed.indexOf(key) === -1) {
        fail("unknown_field", (context || "同步内容") +
          "包含不支持的字段，已停止同步。");
      }
    });
  }

  function assertJsonValue(value, depth) {
    var level = depth || 0;
    if (level > 20) {
      fail("invalid_bundle", "同步内容嵌套过深，已停止同步。");
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        fail("invalid_bundle", "同步内容包含无效数字，已停止同步。");
      }
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > 100000) {
        fail("too_large", "同步内容条目过多，已停止同步。");
      }
      value.forEach(function (item) {
        assertJsonValue(item, level + 1);
      });
      return;
    }
    if (isPlainObject(value)) {
      Object.keys(value).forEach(function (key) {
        assertNotSensitive(key, "同步内容");
        assertJsonValue(value[key], level + 1);
      });
      return;
    }
    fail("invalid_bundle", "同步内容格式不正确，已停止同步。");
  }

  function cloneJsonValue(value, depth) {
    var level = depth || 0;
    if (level > 20) {
      fail("invalid_bundle", "同步内容嵌套过深，已停止同步。");
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        fail("invalid_bundle", "同步内容包含无效数字，已停止同步。");
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(function (item) {
        return cloneJsonValue(item, level + 1);
      });
    }
    if (isPlainObject(value)) {
      var result = {};
      Object.keys(value).forEach(function (key) {
        assertNotSensitive(key, "同步内容");
        result[key] = cloneJsonValue(value[key], level + 1);
      });
      return result;
    }
    fail("invalid_bundle", "同步内容格式不正确，已停止同步。");
  }

  function canonicalJson(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return JSON.stringify(value);
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    }
    if (Array.isArray(value)) {
      return "[" + value.map(canonicalJson).join(",") + "]";
    }
    if (isPlainObject(value)) {
      return "{" + Object.keys(value).sort().map(function (key) {
        return JSON.stringify(key) + ":" + canonicalJson(value[key]);
      }).join(",") + "}";
    }
    return "null";
  }

  function jsonByteLength(value) {
    var text = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof text !== "string") {
      fail("invalid_bundle", "同步内容无法序列化，已停止同步。");
    }
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(text).length;
    }
    if (typeof Buffer !== "undefined") {
      return Buffer.byteLength(text, "utf8");
    }
    return unescape(encodeURIComponent(text)).length;
  }

  function compareIds(left, right) {
    var a = Number(left);
    var b = Number(right);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return a - b;
    }
    var sa = String(left);
    var sb = String(right);
    return sa === sb ? 0 : (sa < sb ? -1 : 1);
  }

  function uniqueSafeIds(value, label) {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value) || value.length > 20000) {
      fail("invalid_bundle", (label || "编号列表") + "格式不正确，已停止同步。");
    }
    var seen = new Set();
    var result = [];
    value.forEach(function (item) {
      var id = Number(item);
      if (!isSafeInteger(id)) {
        fail("invalid_bundle", (label || "编号列表") + "包含无效编号，已停止同步。");
      }
      if (!seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    });
    return result;
  }

  function sanitizeSettings(raw) {
    if (raw === undefined || raw === null) {
      return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    }
    if (!isPlainObject(raw)) {
      fail("invalid_bundle", "同步设置格式不正确，已停止同步。");
    }
    assertAllowedKeys(raw, SETTINGS_KEYS, "同步设置");
    var reminder = raw.reminder === undefined || raw.reminder === null ? {} : raw.reminder;
    if (!isPlainObject(reminder)) {
      fail("invalid_bundle", "同步提醒设置格式不正确，已停止同步。");
    }
    assertAllowedKeys(reminder, REMINDER_KEYS, "同步提醒设置");
    var dailyTarget = Number(raw.dailyTarget);
    if (!Number.isInteger(dailyTarget) || dailyTarget < 1 || dailyTarget > 100000) {
      dailyTarget = DEFAULT_SETTINGS.dailyTarget;
    }
    var accountName = raw.accountName === undefined || raw.accountName === null
      ? DEFAULT_SETTINGS.accountName
      : safeString(raw.accountName, 200, "账户名");
    if (!accountName.trim()) {
      accountName = DEFAULT_SETTINGS.accountName;
    }
    var time = reminder.time === undefined || reminder.time === null
      ? DEFAULT_SETTINGS.reminder.time
      : safeString(reminder.time, 5, "提醒时间");
    if (!isValidReminderTime(time)) {
      time = DEFAULT_SETTINGS.reminder.time;
    }
    return {
      dailyTarget: dailyTarget,
      accountName: accountName,
      reminder: {
        enabled: reminder.enabled === true,
        time: time
      }
    };
  }

  function sanitizeAnswerEdits(raw) {
    if (raw === undefined || raw === null) {
      return {};
    }
    if (!isPlainObject(raw)) {
      fail("invalid_bundle", "答案修订格式不正确，已停止同步。");
    }
    if (Object.keys(raw).length > 20000) {
      fail("too_large", "答案修订数量过多，已停止同步。");
    }
    var result = {};
    Object.keys(raw).forEach(function (key) {
      var id = Number(key);
      if (!isSafeInteger(id) || String(id) !== key) {
        fail("invalid_bundle", "答案修订包含无效题号，已停止同步。");
      }
      var item = raw[key];
      if (!isPlainObject(item)) {
        fail("invalid_bundle", "答案修订格式不正确，已停止同步。");
      }
      assertAllowedKeys(item, EDIT_FIELDS, "答案修订");
      var text = safeString(item.text, 50000, "答案修订");
      if (!text.trim()) {
        return;
      }
      var updatedAt = safeString(item.updatedAt, 80, "答案修订时间");
      var updatedDate = item.updatedDate === undefined || item.updatedDate === null
        ? ""
        : safeString(item.updatedDate, 10, "答案修订日期");
      if (updatedDate && !isDateKey(updatedDate)) {
        fail("invalid_bundle", "答案修订日期格式不正确，已停止同步。");
      }
      result[String(id)] = {
        text: text,
        updatedAt: updatedAt,
        updatedDate: updatedDate
      };
    });
    return result;
  }

  function sanitizeHistory(raw) {
    if (raw === undefined || raw === null) {
      return [];
    }
    if (!Array.isArray(raw) || raw.length > 100000) {
      fail("invalid_bundle", "学习历史格式不正确，已停止同步。");
    }
    return raw.map(function (item) {
      if (!isPlainObject(item)) {
        fail("invalid_bundle", "学习历史格式不正确，已停止同步。");
      }
      assertAllowedKeys(item, HISTORY_FIELDS, "学习历史");
      var id = Number(item.id);
      if (!isSafeInteger(id)) {
        fail("invalid_bundle", "学习历史包含无效题号，已停止同步。");
      }
      if (item.rating !== "known" && item.rating !== "forgot") {
        fail("invalid_bundle", "学习历史评价无效，已停止同步。");
      }
      if (!isDateKey(item.date)) {
        fail("invalid_bundle", "学习历史日期无效，已停止同步。");
      }
      var entry = {
        id: id,
        date: item.date,
        at: safeString(item.at, 80, "学习历史时间"),
        rating: item.rating
      };
      if (item.chapter !== undefined && item.chapter !== null) {
        entry.chapter = safeString(item.chapter, 120, "学习历史章节");
      }
      if (item.source_id !== undefined && item.source_id !== null) {
        var sourceId = Number(item.source_id);
        if (!isSafeInteger(sourceId)) {
          fail("invalid_bundle", "学习历史来源编号无效，已停止同步。");
        }
        entry.source_id = sourceId;
      }
      return entry;
    });
  }

  function sanitizeStateImports(raw) {
    if (raw === undefined || raw === null) {
      return [];
    }
    if (!Array.isArray(raw) || raw.length > 100000) {
      fail("invalid_bundle", "导入登记格式不正确，已停止同步。");
    }
    return raw.map(function (item) {
      if (!isPlainObject(item)) {
        fail("invalid_bundle", "导入登记格式不正确，已停止同步。");
      }
      assertAllowedKeys(item, IMPORT_STATE_FIELDS, "导入登记");
      var id = item.id;
      if (typeof id === "string") {
        id = safeString(id, 120, "导入登记编号");
        if (!id) {
          fail("invalid_bundle", "导入登记编号无效，已停止同步。");
        }
      } else {
        id = Number(id);
        if (!isSafeInteger(id)) {
          fail("invalid_bundle", "导入登记编号无效，已停止同步。");
        }
      }
      var name = safeString(item.name, 240, "导入登记名称");
      if (!name.trim()) {
        fail("invalid_bundle", "导入登记名称无效，已停止同步。");
      }
      var format = safeString(item.format, 20, "导入登记格式").toLowerCase();
      if (FORMATS.indexOf(format) === -1) {
        fail("invalid_bundle", "导入登记格式无效，已停止同步。");
      }
      var size = item.size === undefined || item.size === null ? null : Number(item.size);
      if (size !== null && (!Number.isFinite(size) || size < 0)) {
        fail("invalid_bundle", "导入登记大小无效，已停止同步。");
      }
      var registeredDate = item.registeredDate === undefined || item.registeredDate === null
        ? ""
        : safeString(item.registeredDate, 10, "导入登记日期");
      if (registeredDate && !isDateKey(registeredDate)) {
        fail("invalid_bundle", "导入登记日期无效，已停止同步。");
      }
      return {
        id: id,
        name: name,
        format: format,
        size: size,
        registeredAt: safeString(item.registeredAt, 80, "导入登记时间"),
        registeredDate: registeredDate,
        status: safeString(item.status, 40, "导入登记状态") || "registered",
        parseStatus: safeString(item.parseStatus, 40, "导入解析状态") || "pending_install"
      };
    });
  }

  function sanitizeScheduleEntry(raw) {
    if (!isPlainObject(raw)) {
      fail("invalid_bundle", "复习排程格式不正确，已停止同步。");
    }
    assertAllowedKeys(raw, SCHEDULE_FIELDS, "复习排程");
    function numberOr(value, fallback) {
      var number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    }
    function nonNegative(value) {
      return Math.max(0, Math.round(numberOr(value, 0)));
    }
    var nextDue = isDateKey(raw.nextDue) ? raw.nextDue : (isDateKey(raw.dueDate) ? raw.dueDate : null);
    var entry = {
      stability: Math.min(365, Math.max(0.5, numberOr(raw.stability, 1))),
      knownCount: nonNegative(raw.knownCount),
      lapses: nonNegative(raw.lapses),
      nextDue: nextDue,
      forcedDueDate: isDateKey(raw.forcedDueDate) ? raw.forcedDueDate : null,
      lastReviewedAt: safeString(raw.lastReviewedAt, 80, "排程复习时间"),
      lastGrowthAt: safeString(raw.lastGrowthAt, 80, "排程增长时间"),
      lastForgotDate: isDateKey(raw.lastForgotDate) ? raw.lastForgotDate : null,
      lastSuccessDate: isDateKey(raw.lastSuccessDate) ? raw.lastSuccessDate : null,
      lastRating: raw.lastRating === "known" || raw.lastRating === "forgot" ? raw.lastRating : null,
      updatedAt: safeString(raw.updatedAt, 80, "排程更新时间"),
      legacy: raw.legacy === true
    };
    return entry;
  }

  function sanitizeSchedule(raw) {
    if (raw === undefined || raw === null) {
      return {};
    }
    if (!isPlainObject(raw) || Object.keys(raw).length > 20000) {
      fail("invalid_bundle", "复习排程格式不正确，已停止同步。");
    }
    var result = {};
    Object.keys(raw).forEach(function (key) {
      var id = Number(key);
      if (!isSafeInteger(id) || String(id) !== key) {
        fail("invalid_bundle", "复习排程包含无效题号，已停止同步。");
      }
      result[key] = sanitizeScheduleEntry(raw[key]);
    });
    return result;
  }

  function sanitizeSession(raw) {
    if (raw === undefined || raw === null) {
      return null;
    }
    if (!isPlainObject(raw)) {
      fail("invalid_bundle", "当日复习会话格式不正确，已停止同步。");
    }
    assertAllowedKeys(raw, SESSION_FIELDS, "当日复习会话");
    var planIds = uniqueSafeIds(raw.planIds, "当日计划题号");
    if (!planIds.length) {
      return null;
    }
    var cards = {};
    if (raw.cards !== undefined && raw.cards !== null) {
      if (!isPlainObject(raw.cards)) {
        fail("invalid_bundle", "复习卡片格式不正确，已停止同步。");
      }
      Object.keys(raw.cards).forEach(function (key) {
        var id = Number(key);
        if (!isSafeInteger(id)) {
          fail("invalid_bundle", "复习卡片题号无效，已停止同步。");
        }
        var card = raw.cards[key];
        if (!isPlainObject(card)) {
          fail("invalid_bundle", "复习卡片格式不正确，已停止同步。");
        }
        assertAllowedKeys(card, CARD_FIELDS, "复习卡片");
        cards[key] = {
          attempts: Math.max(0, Math.round(Number(card.attempts) || 0)),
          lastRating: card.lastRating === "known" || card.lastRating === "forgot" ? card.lastRating : null,
          forgotten: card.forgotten === true,
          lastAt: safeString(card.lastAt, 80, "复习卡片时间")
        };
      });
    }
    var relearn = [];
    if (raw.relearn !== undefined && raw.relearn !== null) {
      if (!Array.isArray(raw.relearn)) {
        fail("invalid_bundle", "重学列表格式不正确，已停止同步。");
      }
      raw.relearn.forEach(function (item) {
        if (!isPlainObject(item)) {
          fail("invalid_bundle", "重学列表格式不正确，已停止同步。");
        }
        assertAllowedKeys(item, RELEARN_FIELDS, "重学列表");
        var id = Number(item.id);
        if (!isSafeInteger(id)) {
          fail("invalid_bundle", "重学题号无效，已停止同步。");
        }
        relearn.push({
          id: id,
          remaining: Math.min(3, Math.max(1, Math.round(Number(item.remaining) || 3)))
        });
      });
    }
    var currentId = Number(raw.currentId);
    if (!isSafeInteger(currentId)) {
      currentId = null;
    }
    var completed = raw.completed === true;
    if (!completed && !currentId && !uniqueSafeIds(raw.queue).length && !relearn.length) {
      completed = true;
    }
    return {
      date: isDateKey(raw.date) ? raw.date : null,
      target: Math.min(100000, Math.max(1, Math.round(Number(raw.target) || planIds.length))),
      planIds: planIds,
      mandatoryIds: uniqueSafeIds(raw.mandatoryIds, "当日必做编号"),
      queue: uniqueSafeIds(raw.queue, "当日队列编号"),
      currentId: completed ? null : currentId,
      revealed: completed ? false : raw.revealed === true,
      completed: completed,
      completedAt: safeString(raw.completedAt, 80, "会话完成时间"),
      cards: cards,
      relearn: completed ? [] : relearn,
      forgottenIds: uniqueSafeIds(raw.forgottenIds, "当日遗忘编号"),
      waitingRelearn: completed ? false : raw.waitingRelearn === true,
      startedAt: safeString(raw.startedAt, 80, "会话开始时间"),
      gapWarning: raw.gapWarning === true
    };
  }

  function sanitizeState(raw) {
    if (!isPlainObject(raw)) {
      fail("invalid_bundle", "学习记录格式不正确，已停止同步。");
    }
    assertAllowedKeys(raw, STATE_KEYS, "学习记录");
    var schemaVersion = Number(raw.schemaVersion);
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 1000) {
      schemaVersion = 1;
    }
    var lastUpdated = raw.lastUpdated === undefined || raw.lastUpdated === null
      ? null
      : safeString(raw.lastUpdated, 80, "学习记录更新时间");
    if (lastUpdated && !isValidAt(lastUpdated)) {
      lastUpdated = null;
    }
    return {
      schemaVersion: schemaVersion,
      settings: sanitizeSettings(raw.settings),
      referenceIds: uniqueSafeIds(raw.referenceIds, "参考书编号"),
      selectedIds: uniqueSafeIds(raw.selectedIds, "选题编号"),
      answerEdits: sanitizeAnswerEdits(raw.answerEdits),
      session: sanitizeSession(raw.session),
      history: sanitizeHistory(raw.history),
      imports: sanitizeStateImports(raw.imports),
      schedule: sanitizeSchedule(raw.schedule),
      lastUpdated: lastUpdated
    };
  }

  function sanitizeQuestion(raw) {
    if (!isPlainObject(raw)) {
      fail("invalid_bundle", "自定义题格式不正确，已停止同步。");
    }
    assertAllowedKeys(raw, QUESTION_FIELDS, "自定义题");
    var id = Number(raw.id);
    if (!isSafeNativeId(id) || id < MIN_QUESTION_ID) {
      fail("invalid_bundle", "自定义题编号无效，已停止同步。");
    }
    var sourceId = Number(raw.source_id);
    if (!isSafeNativeId(sourceId) || sourceId < MIN_SOURCE_ID) {
      fail("invalid_bundle", "自定义题来源编号无效，已停止同步。");
    }
    var question = safeString(raw.question, MAX_QUESTION_TEXT, "自定义题题干");
    if (!question.trim()) {
      fail("invalid_bundle", "自定义题题干不能为空，已停止同步。");
    }
    var result = {
      id: id,
      question: question,
      source_id: sourceId
    };
    if (raw.chapter !== undefined && raw.chapter !== null) {
      result.chapter = safeString(raw.chapter, 120, "自定义题章节");
    }
    if (raw.options !== undefined && raw.options !== null) {
      if (typeof raw.options !== "string") {
        fail("invalid_bundle", "自定义题选项格式不正确，已停止同步。");
      }
      result.options = safeString(raw.options, 20000, "自定义题选项");
    }
    if (raw.answer !== undefined && raw.answer !== null) {
      result.answer = safeString(raw.answer, 50000, "自定义题答案");
    }
    if (raw.explanation !== undefined && raw.explanation !== null) {
      result.explanation = safeString(raw.explanation, 100000, "自定义题解析");
    }
    if (raw.locator !== undefined && raw.locator !== null) {
      result.locator = safeString(raw.locator, 200, "自定义题定位");
    }
    if (raw.type !== undefined && raw.type !== null) {
      var type = normalizeQuestionType(raw.type);
      if (!type) {
        fail("invalid_bundle", "自定义题题型无效，已停止同步。");
      }
      result.type = type;
    }
    if (raw.metadata !== undefined && raw.metadata !== null) {
      assertJsonValue(raw.metadata, 0);
      result.metadata = cloneJsonValue(raw.metadata, 0);
    }
    return result;
  }

  function sanitizeSource(raw) {
    if (!isPlainObject(raw)) {
      fail("invalid_bundle", "自定义来源格式不正确，已停止同步。");
    }
    assertAllowedKeys(raw, SOURCE_FIELDS, "自定义来源");
    var id = Number(raw.id);
    if (!isSafeNativeId(id) || id < MIN_SOURCE_ID) {
      fail("invalid_bundle", "自定义来源编号无效，已停止同步。");
    }
    var name = safeString(raw.name, 240, "自定义来源名称");
    if (!name.trim()) {
      fail("invalid_bundle", "自定义来源名称无效，已停止同步。");
    }
    var format = safeString(raw.format, 20, "自定义来源格式");
    if (FORMATS.indexOf(format.toLowerCase()) === -1) {
      fail("invalid_bundle", "自定义来源格式无效，已停止同步。");
    }
    var result = { id: id, name: name, format: format };
    if (raw.importId !== undefined && raw.importId !== null) {
      var importId = Number(raw.importId);
      if (!isSafeNativeId(importId) || importId < MIN_IMPORT_ID) {
        fail("invalid_bundle", "自定义来源导入编号无效，已停止同步。");
      }
      result.importId = importId;
    }
    return result;
  }

  function sanitizeAnswer(raw) {
    if (!isPlainObject(raw)) {
      fail("invalid_bundle", "自定义答案格式不正确，已停止同步。");
    }
    assertAllowedKeys(raw, ANSWER_FIELDS, "自定义答案");
    var questionId = Number(raw.question_id);
    if (!isSafeNativeId(questionId) || questionId < MIN_QUESTION_ID) {
      fail("invalid_bundle", "自定义答案题号无效，已停止同步。");
    }
    var answer = safeString(raw.answer, 50000, "自定义答案");
    if (!answer.trim()) {
      fail("invalid_bundle", "自定义答案不能为空，已停止同步。");
    }
    var result = { question_id: questionId, answer: answer };
    if (raw.key_points !== undefined && raw.key_points !== null) {
      if (!Array.isArray(raw.key_points) || raw.key_points.length > 100) {
        fail("invalid_bundle", "自定义答案要点格式不正确，已停止同步。");
      }
      result.key_points = raw.key_points.map(function (point) {
        if (typeof point !== "string") {
          fail("invalid_bundle", "自定义答案要点格式不正确，已停止同步。");
        }
        return safeString(point, 2000, "自定义答案要点");
      });
    }
    if (raw.status !== undefined && raw.status !== null) {
      var status = safeString(raw.status, 40, "自定义答案状态");
      if (ANSWER_STATUSES.indexOf(status) === -1) {
        fail("invalid_bundle", "自定义答案状态无效，已停止同步。");
      }
      result.status = status;
    }
    if (raw.references !== undefined && raw.references !== null) {
      if (!Array.isArray(raw.references) || raw.references.length > 1000) {
        fail("invalid_bundle", "自定义答案引用格式不正确，已停止同步。");
      }
      result.references = raw.references.map(function (reference) {
        if (!isPlainObject(reference)) {
          fail("invalid_bundle", "自定义答案引用格式不正确，已停止同步。");
        }
        assertAllowedKeys(reference, ["unit_id", "pdf_page", "quote"], "自定义答案引用");
        var unitId = Number(reference.unit_id);
        var pdfPage = Number(reference.pdf_page);
        if (!isSafeNativeId(unitId) || !isSafeNativeId(pdfPage)) {
          fail("invalid_bundle", "自定义答案引用编号无效，已停止同步。");
        }
        var quote = safeString(reference.quote, 10000, "自定义答案引用原文");
        if (!quote.trim()) {
          fail("invalid_bundle", "自定义答案引用原文不能为空，已停止同步。");
        }
        return { unit_id: unitId, pdf_page: pdfPage, quote: quote };
      });
    }
    if (raw.caveat !== undefined && raw.caveat !== null) {
      result.caveat = safeString(raw.caveat, 4000, "自定义答案说明");
    }
    if (raw.sourceQuote !== undefined && raw.sourceQuote !== null) {
      result.sourceQuote = safeString(raw.sourceQuote, 10000, "自定义答案原文");
    }
    if (raw.pageIndex !== undefined && raw.pageIndex !== null) {
      var pageIndex = Number(raw.pageIndex);
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex > 100000) {
        fail("invalid_bundle", "自定义答案页码无效，已停止同步。");
      }
      result.pageIndex = pageIndex;
    }
    if (raw.locator !== undefined && raw.locator !== null) {
      result.locator = safeString(raw.locator, 200, "自定义答案定位");
    }
    if (raw.sourceName !== undefined && raw.sourceName !== null) {
      result.sourceName = safeString(raw.sourceName, 240, "自定义答案来源名称");
    }
    if (raw.type !== undefined && raw.type !== null) {
      var answerType = normalizeQuestionType(raw.type);
      if (!answerType) {
        fail("invalid_bundle", "自定义答案题型无效，已停止同步。");
      }
      result.type = answerType;
    }
    if (raw.chapter !== undefined && raw.chapter !== null) {
      result.chapter = safeString(raw.chapter, 120, "自定义答案章节");
    }
    if (raw.userEdited !== undefined && raw.userEdited !== null) {
      result.userEdited = raw.userEdited === true;
    }
    if (raw.origin !== undefined && raw.origin !== null) {
      result.origin = safeString(raw.origin, 40, "自定义答案来源");
    }
    return result;
  }

  function sanitizeNativeImport(raw) {
    if (!isPlainObject(raw)) {
      fail("invalid_bundle", "原生导入资料格式不正确，已停止同步。");
    }
    assertAllowedKeys(raw, IMPORT_FIELDS, "原生导入资料");
    var id = Number(raw.id);
    if (!isSafeNativeId(id) || id < MIN_IMPORT_ID) {
      fail("invalid_bundle", "原生导入资料编号无效，已停止同步。");
    }
    var name = safeString(raw.name, 240, "原生导入资料名称");
    if (!name.trim()) {
      fail("invalid_bundle", "原生导入资料名称无效，已停止同步。");
    }
    var format = safeString(raw.format, 20, "原生导入资料格式");
    if (FORMATS.indexOf(format.toLowerCase()) === -1) {
      fail("invalid_bundle", "原生导入资料格式无效，已停止同步。");
    }
    if (!Array.isArray(raw.pages) || raw.pages.length > 5000) {
      fail("invalid_bundle", "原生导入资料页面格式不正确，已停止同步。");
    }
    var totalChars = 0;
    var pageIndexes = new Set();
    var pages = raw.pages.map(function (page) {
      if (!isPlainObject(page)) {
        fail("invalid_bundle", "原生导入页面格式不正确，已停止同步。");
      }
      assertAllowedKeys(page, PAGE_FIELDS, "原生导入页面");
      var pageIndex = Number(page.pageIndex);
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex > 100000 ||
          pageIndexes.has(pageIndex)) {
        fail("invalid_bundle", "原生导入页面编号无效，已停止同步。");
      }
      pageIndexes.add(pageIndex);
      var locator = safeString(page.locator, MAX_PAGE_LOCATOR, "原生导入页面定位");
      var text = safeString(page.text, MAX_PAGE_TEXT, "原生导入页面正文");
      totalChars += text.length;
      if (totalChars > MAX_IMPORT_TEXT) {
        fail("too_large", "原生导入资料正文超限，已停止同步。");
      }
      var result = { pageIndex: pageIndex, locator: locator, text: text };
      if (page.paragraphIndex !== undefined && page.paragraphIndex !== null) {
        var paragraphIndex = Number(page.paragraphIndex);
        if (!Number.isSafeInteger(paragraphIndex) || paragraphIndex < 0) {
          fail("invalid_bundle", "原生导入段落编号无效，已停止同步。");
        }
        result.paragraphIndex = paragraphIndex;
      }
      if (page.ocr !== undefined && page.ocr !== null) {
        if (typeof page.ocr !== "boolean") {
          fail("invalid_bundle", "原生导入 OCR 标记格式不正确，已停止同步。");
        }
        result.ocr = page.ocr;
      }
      if (page.needsOcr !== undefined && page.needsOcr !== null) {
        result.needsOcr = page.needsOcr === true;
      }
      return result;
    });
    var resultImport = {
      id: id,
      name: name,
      format: format,
      pages: pages
    };
    if (raw.size !== undefined && raw.size !== null) {
      var size = Number(raw.size);
      if (!Number.isFinite(size) || size < 0 || size > MAX_IMPORT_SIZE) {
        fail("invalid_bundle", "原生导入资料大小无效，已停止同步。");
      }
      resultImport.size = size;
    }
    if (raw.createdAt !== undefined && raw.createdAt !== null) {
      resultImport.createdAt = safeString(raw.createdAt, 80, "原生导入创建时间");
    }
    if (raw.needsOcr !== undefined && raw.needsOcr !== null) {
      resultImport.needsOcr = raw.needsOcr === true;
    }
    if (raw.truncated !== undefined && raw.truncated !== null) {
      resultImport.truncated = raw.truncated === true;
    }
    if (raw.note !== undefined && raw.note !== null) {
      resultImport.note = safeString(raw.note, MAX_IMPORT_NOTE, "原生导入备注");
    }
    return resultImport;
  }

  function sanitizeNative(raw) {
    if (raw === undefined || raw === null) {
      return {
        customContent: {
          schemaVersion: 1,
          customQuestions: [],
          customSources: [],
          customTypes: {},
          customAnswers: []
        },
        imports: []
      };
    }
    if (!isPlainObject(raw)) {
      fail("invalid_bundle", "原生内容格式不正确，已停止同步。");
    }
    assertAllowedKeys(raw, NATIVE_KEYS, "原生内容");
    var custom = raw.customContent;
    if (custom === undefined || custom === null) {
      custom = {};
    }
    if (!isPlainObject(custom)) {
      fail("invalid_bundle", "原生自定义内容格式不正确，已停止同步。");
    }
    assertAllowedKeys(custom, CUSTOM_KEYS, "原生自定义内容");
    var customVersion = Number(custom.schemaVersion);
    if (customVersion !== 1) {
      fail("invalid_bundle", "原生自定义内容版本不受支持，已停止同步。");
    }
    var questions = custom.customQuestions === undefined || custom.customQuestions === null
      ? [] : custom.customQuestions;
    var sources = custom.customSources === undefined || custom.customSources === null
      ? [] : custom.customSources;
    var answers = custom.customAnswers === undefined || custom.customAnswers === null
      ? [] : custom.customAnswers;
    var types = custom.customTypes === undefined || custom.customTypes === null
      ? {} : custom.customTypes;
    if (!Array.isArray(questions) || questions.length > 10000 ||
        !Array.isArray(sources) || sources.length > 10000 ||
        !Array.isArray(answers) || answers.length > 10000) {
      fail("invalid_bundle", "原生自定义内容数量格式不正确，已停止同步。");
    }
    if (!isPlainObject(types)) {
      fail("invalid_bundle", "原生自定义题型格式不正确，已停止同步。");
    }
    var imports = raw.imports === undefined || raw.imports === null ? [] : raw.imports;
    if (!Array.isArray(imports) || imports.length > 500) {
      fail("invalid_bundle", "原生导入资料数量格式不正确，已停止同步。");
    }
    var sanitizedTypes = {};
    Object.keys(types).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (key) {
      assertNotSensitive(key, "原生自定义题型");
      var id = Number(key);
      if (!isSafeNativeId(id) || id < MIN_QUESTION_ID || String(id) !== key) {
        fail("invalid_bundle", "原生自定义题型编号无效，已停止同步。");
      }
      var normalizedType = normalizeQuestionType(types[key]);
      if (!normalizedType) {
        fail("invalid_bundle", "原生自定义题型无效，已停止同步。");
      }
      sanitizedTypes[key] = normalizedType;
    });
    var cleanQuestions = questions.map(sanitizeQuestion).sort(function (a, b) {
      return a.id - b.id;
    });
    var cleanSources = sources.map(sanitizeSource).sort(function (a, b) {
      return a.id - b.id;
    });
    var cleanAnswers = answers.map(sanitizeAnswer).sort(function (a, b) {
      return a.question_id - b.question_id;
    });
    var cleanImports = imports.map(sanitizeNativeImport).sort(function (a, b) {
      return a.id - b.id;
    });
    // The native layers reject duplicate ids and broken cross references. Do the
    // same before any upload so the shared UI can never push a bundle that the
    // Android/desktop apply step would refuse.
    var sourceIds = new Set();
    cleanSources.forEach(function (source) {
      if (sourceIds.has(source.id)) {
        fail("invalid_bundle", "自定义来源编号重复，已停止同步。");
      }
      sourceIds.add(source.id);
    });
    var questionIds = new Set();
    cleanQuestions.forEach(function (question) {
      if (questionIds.has(question.id)) {
        fail("invalid_bundle", "自定义题编号重复，已停止同步。");
      }
      questionIds.add(question.id);
      if (!sourceIds.has(question.source_id)) {
        fail("invalid_bundle", "自定义题指向不存在的来源，已停止同步。");
      }
    });
    var answerQuestionIds = new Set();
    cleanAnswers.forEach(function (answer) {
      if (answerQuestionIds.has(answer.question_id)) {
        fail("invalid_bundle", "自定义答案题号重复，已停止同步。");
      }
      answerQuestionIds.add(answer.question_id);
      if (!questionIds.has(answer.question_id)) {
        fail("invalid_bundle", "自定义答案指向不存在的题目，已停止同步。");
      }
    });
    Object.keys(sanitizedTypes).forEach(function (key) {
      if (!questionIds.has(Number(key))) {
        fail("invalid_bundle", "自定义题型指向不存在的题目，已停止同步。");
      }
    });
    var importIds = new Set();
    cleanImports.forEach(function (item) {
      if (importIds.has(item.id)) {
        fail("invalid_bundle", "原生导入资料编号重复，已停止同步。");
      }
      importIds.add(item.id);
    });
    return {
      customContent: {
        schemaVersion: 1,
        customQuestions: cleanQuestions,
        customSources: cleanSources,
        customTypes: sanitizedTypes,
        customAnswers: cleanAnswers
      },
      imports: cleanImports
    };
  }

  function sanitizeBundle(raw) {
    if (!isPlainObject(raw)) {
      fail("invalid_bundle", "云端同步数据格式不正确，已停止同步。");
    }
    assertAllowedKeys(raw, ["schemaVersion", "state", "native"], "云端同步数据");
    if (Number(raw.schemaVersion) !== SCHEMA_VERSION) {
      fail("unsupported_schema", "云端同步数据版本不受支持，已停止同步。");
    }
    var bundle = {
      schemaVersion: SCHEMA_VERSION,
      state: sanitizeState(raw.state),
      native: sanitizeNative(raw.native)
    };
    assertBundleSize(bundle);
    return bundle;
  }

  function assertBundleSize(bundle) {
    if (jsonByteLength(bundle) > MAX_BUNDLE_BYTES) {
      fail("too_large", "同步内容超过 16 MiB，已停止同步。");
    }
    return bundle;
  }

  function assertResponseSize(value) {
    if (jsonByteLength(value) > MAX_RESPONSE_BYTES) {
      fail("too_large", "云端返回内容超过 20 MiB，已停止同步。");
    }
    return value;
  }

  function stateIsEmpty(state) {
    return !state.session &&
      state.history.length === 0 &&
      state.imports.length === 0 &&
      state.referenceIds.length === 0 &&
      state.selectedIds.length === 0 &&
      Object.keys(state.answerEdits).length === 0 &&
      Object.keys(state.schedule).length === 0 &&
      canonicalJson(state.settings) === canonicalJson(DEFAULT_SETTINGS);
  }

  function laterSnapshot(local, remote) {
    var localEmpty = stateIsEmpty(local);
    var remoteEmpty = stateIsEmpty(remote);
    if (localEmpty && !remoteEmpty) {
      return remote;
    }
    if (remoteEmpty && !localEmpty) {
      return local;
    }
    var localTime = timeMs(local.lastUpdated);
    var remoteTime = timeMs(remote.lastUpdated);
    if (localTime !== remoteTime) {
      return localTime > remoteTime ? local : remote;
    }
    return canonicalJson(local) >= canonicalJson(remote) ? local : remote;
  }

  function historyKey(entry) {
    return [entry.id, entry.date, entry.at || "", entry.rating].join("|");
  }

  function compareHistory(left, right) {
    var leftAt = left.at || "";
    var rightAt = right.at || "";
    if (leftAt !== rightAt) {
      if (!leftAt) { return 1; }
      if (!rightAt) { return -1; }
      return leftAt < rightAt ? -1 : 1;
    }
    if (left.date !== right.date) {
      return left.date < right.date ? -1 : 1;
    }
    if (left.id !== right.id) {
      return left.id - right.id;
    }
    if (left.rating !== right.rating) {
      return left.rating === "known" ? -1 : 1;
    }
    var leftJson = canonicalJson(left);
    var rightJson = canonicalJson(right);
    return leftJson === rightJson ? 0 : (leftJson < rightJson ? -1 : 1);
  }

  function mergeHistory(localHistory, remoteHistory) {
    var map = {};
    localHistory.concat(remoteHistory).forEach(function (entry) {
      var key = historyKey(entry);
      var existing = map[key];
      if (!existing || canonicalJson(entry) > canonicalJson(existing)) {
        map[key] = entry;
      }
    });
    return Object.keys(map).map(function (key) { return map[key]; }).sort(compareHistory);
  }

  function mergeAnswerEdits(localEdits, remoteEdits, conflicts) {
    var result = {};
    var keys = {};
    Object.keys(localEdits).concat(Object.keys(remoteEdits)).forEach(function (key) {
      keys[key] = true;
    });
    Object.keys(keys).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (key) {
      var local = localEdits[key];
      var remote = remoteEdits[key];
      if (!local) {
        result[key] = remote;
        return;
      }
      if (!remote) {
        result[key] = local;
        return;
      }
      if (local.text === remote.text) {
        result[key] = canonicalJson(local) >= canonicalJson(remote) ? local : remote;
        return;
      }
      var localTime = timeMs(local.updatedAt);
      var remoteTime = timeMs(remote.updatedAt);
      var chosen;
      var tie = localTime === remoteTime;
      if (localTime !== remoteTime) {
        chosen = localTime > remoteTime ? local : remote;
      } else {
        chosen = canonicalJson(local) >= canonicalJson(remote) ? local : remote;
      }
      result[key] = chosen;
      conflicts.push({
        kind: "answer_edit",
        questionId: Number(key),
        local: local,
        remote: remote,
        chosen: chosen === local ? "local" : "remote",
        tie: tie
      });
    });
    return result;
  }

  function mergeStateImports(localImports, remoteImports, conflicts) {
    var map = Object.create(null);
    localImports.concat(remoteImports).forEach(function (item) {
      var key = String(item.id);
      var existing = map[key];
      if (!existing) {
        map[key] = item;
        return;
      }
      if (canonicalJson(existing) === canonicalJson(item)) {
        return;
      }
      var chosen = canonicalJson(existing) >= canonicalJson(item) ? existing : item;
      map[key] = chosen;
      conflicts.push({
        kind: "state_import",
        id: item.id,
        local: existing,
        remote: item,
        chosen: chosen === existing ? "local" : "remote"
      });
    });
    return Object.keys(map).map(function (key) { return map[key]; }).sort(function (a, b) {
      return compareIds(a.id, b.id);
    });
  }

  function compareScheduleEntry(left, right) {
    if (!left) { return right || null; }
    if (!right) { return left; }
    var leftTime = timeMs(left.updatedAt);
    var rightTime = timeMs(right.updatedAt);
    if (leftTime !== rightTime) {
      return leftTime > rightTime ? left : right;
    }
    return canonicalJson(left) >= canonicalJson(right) ? left : right;
  }

  function mergeSchedules(localSchedule, remoteSchedule, history) {
    var result = {};
    var ids = {};
    Object.keys(localSchedule).concat(Object.keys(remoteSchedule)).forEach(function (id) {
      ids[id] = true;
    });
    history.forEach(function (entry) {
      ids[String(entry.id)] = true;
    });
    Object.keys(ids).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (id) {
      var events = history.filter(function (entry) {
        return String(entry.id) === id;
      }).slice().sort(compareHistory);
      var allValidAt = events.length > 0 && events.every(function (entry) {
        return isValidAt(entry.at);
      });
      var localEntry = localSchedule[id];
      var remoteEntry = remoteSchedule[id];
      // 旧排程可能保留了比历史更长的评价次数；这时不能只按现有历史从零重放。
      var historyComplete = true;
      [localEntry, remoteEntry].forEach(function (entry) {
        if (entry && (entry.knownCount + entry.lapses) > events.length) {
          historyComplete = false;
        }
      });
      var replay = null;
      if (allValidAt && historyComplete &&
          MemoryScheduler && typeof MemoryScheduler.applyReview === "function") {
        try {
          events.forEach(function (entry) {
            replay = MemoryScheduler.applyReview(replay, entry.rating, new Date(entry.at));
          });
        } catch (error) {
          replay = null;
        }
      }
      if (replay) {
        result[id] = sanitizeScheduleEntry(replay);
        return;
      }
      var baseline = compareScheduleEntry(localEntry, remoteEntry);
      if (!baseline) {
        return;
      }
      if (MemoryScheduler && typeof MemoryScheduler.applyReview === "function") {
        var baseAt = timeMs(baseline.lastReviewedAt);
        events.forEach(function (entry) {
          if (!isValidAt(entry.at)) {
            return;
          }
          if (!baseAt || Date.parse(entry.at) <= baseAt) {
            return;
          }
          try {
            baseline = MemoryScheduler.applyReview(baseline, entry.rating, new Date(entry.at));
          } catch (error) {
            // 保留已选基线，不因为单条历史异常而丢弃旧排程。
          }
        });
      }
      result[id] = sanitizeScheduleEntry(baseline);
    });
    return result;
  }

  function latestTimestamp(values) {
    var latest = null;
    var latestMs = -1;
    values.forEach(function (value) {
      var ms = timeMs(value);
      if (ms > latestMs || (ms === latestMs && value && (!latest || value > latest))) {
        latestMs = ms;
        latest = value;
      }
    });
    return latest;
  }

  function mergeLearningState(localRaw, remoteRaw, options) {
    var local = sanitizeState(localRaw);
    var remote = sanitizeState(remoteRaw);
    var base = laterSnapshot(local, remote);
    var conflicts = [];
    var history = mergeHistory(local.history, remote.history);
    var answerEdits = mergeAnswerEdits(local.answerEdits, remote.answerEdits, conflicts);
    var imports = mergeStateImports(local.imports, remote.imports, conflicts);
    var schedule = mergeSchedules(local.schedule, remote.schedule, history);
    var latestValues = [local.lastUpdated, remote.lastUpdated, base.lastUpdated];
    Object.keys(answerEdits).forEach(function (key) {
      latestValues.push(answerEdits[key].updatedAt);
    });
    history.forEach(function (entry) {
      latestValues.push(entry.at);
    });
    Object.keys(schedule).forEach(function (key) {
      latestValues.push(schedule[key].updatedAt);
    });
    var merged = {
      schemaVersion: Math.max(local.schemaVersion, remote.schemaVersion, 1),
      settings: base.settings,
      referenceIds: base.referenceIds.slice(),
      selectedIds: base.selectedIds.slice(),
      answerEdits: answerEdits,
      session: base.session,
      history: history,
      imports: imports,
      schedule: schedule,
      lastUpdated: latestTimestamp(latestValues)
    };
    return { state: sanitizeState(merged), conflicts: conflicts };
  }

  function mergeImmutableList(localList, remoteList, label) {
    var map = {};
    localList.forEach(function (item) {
      map[String(item.id)] = item;
    });
    remoteList.forEach(function (item) {
      var key = String(item.id);
      var existing = map[key];
      if (!existing) {
        map[key] = item;
        return;
      }
      if (canonicalJson(existing) !== canonicalJson(item)) {
        fail("native_conflict", "云端与本机存在同编号但内容不同的" + label +
          "，已保留本机内容并停止同步。请先备份，再核对两台设备。");
      }
    });
    return Object.keys(map).map(function (key) { return map[key]; }).sort(function (a, b) {
      return Number(a.id) - Number(b.id);
    });
  }

  function answerIsEdited(answer) {
    return Boolean(answer && answer.userEdited === true);
  }

  /**
   * One deterministic policy for every client: a user-edited answer wins over a
   * non-edited one; otherwise the stable canonical JSON comparison decides. It
   * is commutative and idempotent, so repeated syncs converge on the same text.
   */
  function compareAnswers(left, right) {
    var leftEdited = answerIsEdited(left);
    var rightEdited = answerIsEdited(right);
    if (leftEdited !== rightEdited) {
      return leftEdited ? 1 : -1;
    }
    var leftText = canonicalJson(left);
    var rightText = canonicalJson(right);
    if (leftText === rightText) {
      return 0;
    }
    return leftText > rightText ? 1 : -1;
  }

  function mergeAnswers(localAnswers, remoteAnswers, conflicts) {
    var map = {};
    localAnswers.concat(remoteAnswers).forEach(function (answer) {
      var key = String(answer.question_id);
      var existing = map[key];
      if (!existing) {
        map[key] = answer;
        return;
      }
      if (canonicalJson(existing) === canonicalJson(answer)) {
        return;
      }
      var chosen = compareAnswers(existing, answer) >= 0 ? existing : answer;
      map[key] = chosen;
      conflicts.push({
        kind: "custom_answer",
        questionId: answer.question_id,
        local: existing,
        remote: answer,
        chosen: chosen === existing ? "local" : "remote",
        tie: answerIsEdited(existing) === answerIsEdited(answer)
      });
    });
    return Object.keys(map).map(function (key) { return map[key]; }).sort(function (a, b) {
      return a.question_id - b.question_id;
    });
  }

  function mergeTypes(localTypes, remoteTypes, conflicts) {
    var result = {};
    var keys = {};
    Object.keys(localTypes).concat(Object.keys(remoteTypes)).forEach(function (key) {
      keys[key] = true;
    });
    Object.keys(keys).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (key) {
      var local = localTypes[key];
      var remote = remoteTypes[key];
      if (local === undefined) {
        result[key] = remote;
        return;
      }
      if (remote === undefined) {
        result[key] = local;
        return;
      }
      if (local === remote) {
        result[key] = local;
        return;
      }
      // Values are normalized canonical type names before this point. All three
      // clients pick the lexicographically larger name, which Android accepts.
      var chosen = local >= remote ? local : remote;
      result[key] = chosen;
      conflicts.push({
        kind: "custom_type",
        questionId: Number(key),
        local: local,
        remote: remote,
        chosen: chosen === local ? "local" : "remote"
      });
    });
    return result;
  }

  function mergeNative(localRaw, remoteRaw) {
    var local = sanitizeNative(localRaw);
    var remote = sanitizeNative(remoteRaw);
    var conflicts = [];
    var native = {
      customContent: {
        schemaVersion: 1,
        customQuestions: mergeImmutableList(
          local.customContent.customQuestions, remote.customContent.customQuestions, "自定义题"),
        customSources: mergeImmutableList(
          local.customContent.customSources, remote.customContent.customSources, "自定义来源"),
        customTypes: mergeTypes(
          local.customContent.customTypes, remote.customContent.customTypes, conflicts),
        customAnswers: mergeAnswers(
          local.customContent.customAnswers, remote.customContent.customAnswers, conflicts)
      },
      imports: mergeImmutableList(local.imports, remote.imports, "导入资料")
    };
    return { native: native, conflicts: conflicts };
  }

  function mergeBundles(localRaw, remoteRaw) {
    var local = sanitizeBundle(localRaw);
    var remote = remoteRaw === null || remoteRaw === undefined
      ? null
      : sanitizeBundle(remoteRaw);
    if (!remote) {
      return { bundle: local, conflicts: [], warnings: [] };
    }
    var stateMerge = mergeLearningState(local.state, remote.state);
    var nativeMerge = mergeNative(local.native, remote.native);
    var bundle = sanitizeBundle({
      schemaVersion: SCHEMA_VERSION,
      state: stateMerge.state,
      native: nativeMerge.native
    });
    return {
      bundle: bundle,
      conflicts: stateMerge.conflicts.concat(nativeMerge.conflicts),
      warnings: []
    };
  }

  function secureRandom53() {
    var cryptoApi = (root && root.crypto) ||
      (typeof globalThis !== "undefined" ? globalThis.crypto : null);
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function" ||
        typeof Uint32Array === "undefined") {
      fail("random_unavailable", "当前设备无法生成安全随机编号，已停止新建导入。");
    }
    var words = new Uint32Array(2);
    cryptoApi.getRandomValues(words);
    return (words[0] & 0x1fffff) * 4294967296 + words[1];
  }

  function randomSafeId(usedIds, randomSource) {
    var used = usedIds instanceof Set ? usedIds : new Set(
      Array.from(usedIds || []).map(function (value) { return String(value); })
    );
    var range = NATIVE_ID_LIMIT - FIRST_NATIVE_ID;
    for (var attempt = 0; attempt < 200; attempt += 1) {
      var raw = typeof randomSource === "function" ? randomSource() : secureRandom53();
      var number = Math.floor(Number(raw));
      if (!Number.isFinite(number)) {
        fail("random_unavailable", "随机编号生成失败，已停止新建导入。");
      }
      var candidate = number >= FIRST_NATIVE_ID && number < NATIVE_ID_LIMIT
        ? number
        : FIRST_NATIVE_ID + (Math.abs(number) % range);
      if (!used.has(String(candidate))) {
        return candidate;
      }
    }
    fail("id_collision", "无法分配不冲突的新编号，请稍后重试。");
  }

  function stateFingerprint(rawState) {
    return canonicalJson(sanitizeState(rawState));
  }

  function nativeFingerprint(rawNative) {
    return canonicalJson(sanitizeNative(rawNative));
  }

  /* --------------------------------------------------------------------- */
  /* UI / transport controller                                             */
  /* --------------------------------------------------------------------- */

  var controller = {
    configured: false,
    hooks: null,
    panel: null,
    panelHost: null,
    native: false,
    auth: null,
    ownerId: "",
    running: false,
    dirty: false,
    epoch: 0,
    debounceTimer: null,
    pendingApply: null,
    pendingCheckTimer: null,
    pendingNoticeAt: 0,
    status: "idle",
    error: "",
    message: "",
    lastSyncedAt: 0,
    conflicts: [],
    started: false
  };

  function getNativeApp() {
    var app = root && root.NativeApp;
    if (!app || app.hasBridge !== true || typeof app.call !== "function") {
      return null;
    }
    return app;
  }

  function isNative() {
    return Boolean(getNativeApp());
  }

  function callNative(method, payload, timeoutMs) {
    var app = getNativeApp();
    if (!app) {
      return Promise.reject(new SyncError("unavailable", "当前为网页预览，跨设备同步不可用。"));
    }
    try {
      return Promise.resolve(app.call(method, payload || {}, { timeoutMs: timeoutMs || 120000 }));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function storage() {
    try {
      return root && root.localStorage ? root.localStorage : null;
    } catch (error) {
      return null;
    }
  }

  function readJsonStorage(key) {
    var store = storage();
    if (!store) {
      return null;
    }
    try {
      var text = store.getItem(key);
      return text ? JSON.parse(text) : null;
    } catch (error) {
      return null;
    }
  }

  function writeJsonStorage(key, value) {
    var store = storage();
    if (!store) {
      return false;
    }
    try {
      store.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  }

  var meta = null;
  function loadMeta() {
    if (meta) {
      return meta;
    }
    var raw = readJsonStorage(META_KEY);
    meta = {
      version: 1,
      boundOwnerId: raw && typeof raw.boundOwnerId === "string" ? raw.boundOwnerId : "",
      optIn: raw && isPlainObject(raw.optIn) ? raw.optIn : {},
      lastSyncedAt: raw && Number.isFinite(Number(raw.lastSyncedAt)) ? Number(raw.lastSyncedAt) : 0
    };
    controller.lastSyncedAt = meta.lastSyncedAt;
    return meta;
  }

  function saveMeta() {
    var value = loadMeta();
    if (!writeJsonStorage(META_KEY, {
      version: 1,
      boundOwnerId: value.boundOwnerId || "",
      optIn: value.optIn || {},
      lastSyncedAt: controller.lastSyncedAt || 0
    })) {
      return false;
    }
    return true;
  }

  function sanitizeAuth(raw) {
    if (!isPlainObject(raw)) {
      return null;
    }
    var userId = typeof raw.userId === "string" ? raw.userId : "";
    if (!isUuid(userId)) {
      userId = "";
    }
    return {
      configured: raw.configured === true,
      loggedIn: raw.loggedIn === true && Boolean(userId),
      userId: userId,
      needsEmailConfirmation: raw.needsEmailConfirmation === true,
      error: typeof raw.error === "string" ? raw.error.slice(0, 160) : ""
    };
  }

  /**
   * cloudAuthStatus may return the cached identity together with a fixed error
   * after a network/verification failure. Such a status is only useful for the
   * account card; it is never proof of a verified owner for sync.
   */
  function authIsVerified(status) {
    return Boolean(status && status.loggedIn && status.userId && !status.error);
  }

  function abortInFlight() {
    controller.epoch += 1;
    controller.pendingApply = null;
    if (controller.debounceTimer) {
      root.clearTimeout(controller.debounceTimer);
      controller.debounceTimer = null;
    }
    if (controller.pendingCheckTimer) {
      root.clearTimeout(controller.pendingCheckTimer);
      controller.pendingCheckTimer = null;
    }
  }

  function setStatus(status, message, error) {
    controller.status = status;
    controller.message = message || "";
    controller.error = error || "";
    redraw();
  }

  function safeErrorMessage(error) {
    var fixed = {
      native_conflict: "检测到同编号但内容不同的自定义内容或导入资料；已保留本机内容，未上传覆盖。请先备份，再核对两台设备。",
      sensitive_field: "同步内容含敏感字段，已停止同步；本机学习记录未被上传。",
      unknown_field: "同步内容包含不支持的字段，已停止同步；本机学习记录未被上传。",
      too_large: "同步内容超过大小限制，已停止同步；本机学习记录保持不变。",
      account_mismatch: "本机学习数据已绑定另一个云端账户。请退出登录后重新登录原绑定账户继续同步；如需改用新账户，请先在“我的 → 导出学习数据”保存备份，再清除本机应用数据后重新登录。退出登录不会删除本机学习记录。",
      backup_failed: "无法在本机保存同步前备份，已停止应用云端内容；本机学习记录保持不变。",
      archive_failed: "无法在本机保存冲突版本，已停止同步；本机学习记录保持不变。",
      binding_failed: "无法保存本机同步绑定信息，已停止同步；本机学习记录保持不变。",
      meta_failed: "无法保存本机同步设置，请检查本机存储。",
      auth_unavailable: "无法确认登录状态，已停止同步；本机学习记录不受影响。",
      auth_invalid: "账户状态格式不正确，已停止同步。",
      auth_required: "请先登录后再同步。",
      auth_changed: "登录账户已变化，已停止应用云端内容。",
      owner_mismatch: "云端账户与当前登录账户不一致，已停止同步。",
      export_invalid: "安装版返回的本机内容格式不正确，已停止同步。",
      apply_invalid: "安装版返回的同步应用结果格式不正确。",
      apply_failed: "云端内容已保存，但本机应用失败；已保留同步前备份。",
      conflict: "云端已有其他设备更新，多次合并仍未完成；请稍后重试。",
      state_changed: "本机学习记录在同步过程中发生变化，已改为稍后重新合并。",
      id_collision: "无法分配不冲突的新编号，请稍后重试。",
      random_unavailable: "当前设备无法生成安全随机编号，已停止新建导入。"
    };
    if (error && error.code && fixed[error.code]) {
      return fixed[error.code];
    }
    // 不透传原生上游正文或可能含有令牌的错误字符串。
    return "同步未完成，请稍后重试；本机学习记录不受影响。";
  }

  function ensureOwner() {
    if (!controller.auth || !controller.auth.loggedIn || !controller.auth.userId) {
      throw new SyncError("auth_required", "请先登录后再同步。");
    }
    return controller.auth.userId;
  }

  function checkBinding(ownerId) {
    var value = loadMeta();
    if (value.boundOwnerId && value.boundOwnerId !== ownerId) {
      throw new SyncError("account_mismatch", "本机学习数据已绑定另一个云端账户。");
    }
  }

  function bindOwner(ownerId) {
    var value = loadMeta();
    if (value.boundOwnerId && value.boundOwnerId !== ownerId) {
      throw new SyncError("account_mismatch", "本机学习数据已绑定另一个云端账户。");
    }
    if (value.boundOwnerId === ownerId) {
      return;
    }
    value.boundOwnerId = ownerId;
    if (!saveMeta()) {
      value.boundOwnerId = "";
      throw new SyncError("binding_failed", "无法保存本机同步绑定信息，已停止同步。");
    }
  }

  function isOptedIn(ownerId) {
    var value = loadMeta();
    return Boolean(ownerId && value.optIn && value.optIn[ownerId] === true);
  }

  function setOptIn(ownerId, enabled) {
    var value = loadMeta();
    if (enabled) {
      value.optIn[ownerId] = true;
    } else {
      delete value.optIn[ownerId];
    }
    if (!saveMeta()) {
      throw new SyncError("meta_failed", "无法保存本机同步设置，请检查本机存储。");
    }
  }

  async function refreshAuth() {
    var startEpoch = controller.epoch;
    var previousOwner = controller.ownerId;
    var raw;
    try {
      raw = await callNative("cloudAuthStatus", {}, 120000);
    } catch (error) {
      if (startEpoch !== controller.epoch) {
        throw new SyncError("aborted", "账户状态已变化，已取消本次同步。");
      }
      // 网络失败不能沿用旧身份；停止所有同步，保留本机数据。
      abortInFlight();
      controller.auth = null;
      controller.ownerId = "";
      setStatus("error", "", "无法确认登录状态，已停止同步；本机学习记录不受影响。");
      throw new SyncError("auth_unavailable", "无法确认登录状态，已停止同步。");
    }
    if (startEpoch !== controller.epoch) {
      throw new SyncError("aborted", "账户状态已变化，已取消本次同步。");
    }
    var status = sanitizeAuth(raw);
    if (!status) {
      abortInFlight();
      controller.auth = null;
      controller.ownerId = "";
      setStatus("error", "", "安装版返回的账户状态格式不正确，已停止同步。");
      throw new SyncError("auth_invalid", "账户状态格式不正确，已停止同步。");
    }
    if (status.error) {
      // A cached identity with an error is not a verified sync owner.
      abortInFlight();
      controller.auth = null;
      controller.ownerId = "";
      setStatus("error", "", "无法确认登录状态，已停止同步；本机学习记录不受影响。");
      throw new SyncError("auth_unavailable", "无法确认登录状态，已停止同步。");
    }
    controller.auth = status;
    var nextOwner = status.loggedIn ? status.userId : "";
    if (previousOwner !== nextOwner) {
      abortInFlight();
    }
    controller.ownerId = nextOwner;
    if (!nextOwner) {
      setStatus("off", "登录后可选择开启跨设备同步；退出登录不会删除本机学习记录。");
      return status;
    }
    renderForOwner();
    return status;
  }

  function notifyAuthStatus(raw) {
    if (!isNative()) {
      return;
    }
    var status = sanitizeAuth(raw);
    if (!status) {
      return;
    }
    if (status.error) {
      // Never turn a cached/error status into a sync owner, even when the
      // account card still wants to show the last known identity.
      notifyAuthFailure();
      return;
    }
    var previousOwner = controller.ownerId;
    controller.auth = status;
    var nextOwner = status.loggedIn ? status.userId : "";
    if (previousOwner !== nextOwner) {
      abortInFlight();
    }
    controller.ownerId = nextOwner;
    if (!nextOwner) {
      setStatus("off", "已退出登录。学习数据仍保存在本机；重新登录同一账户后可继续同步。");
      redraw();
      return;
    }
    renderForOwner();
    if (isOptedIn(nextOwner)) {
      scheduleSync(350);
    } else {
      setStatus("consent", "请先阅读说明并选择是否开启跨设备同步。");
    }
  }

  function notifyAuthFailure() {
    if (!isNative()) {
      return;
    }
    abortInFlight();
    controller.auth = null;
    controller.ownerId = "";
    setStatus("error", "", "无法确认登录状态，已停止同步；本机学习记录不受影响。");
  }

  function renderForOwner() {
    var ownerId = controller.ownerId;
    if (!ownerId) {
      return;
    }
    try {
      checkBinding(ownerId);
    } catch (error) {
      setStatus("blocked", "", safeErrorMessage(error));
      return;
    }
    if (!isOptedIn(ownerId)) {
      setStatus("consent", "尚未开启跨设备同步；登录本身不会自动上传学习记录。");
      return;
    }
    if (!controller.running && controller.status !== "error") {
      setStatus("idle", controller.lastSyncedAt
        ? "已开启跨设备同步。上次同步：" + formatTime(controller.lastSyncedAt)
        : "已开启跨设备同步。");
    } else {
      redraw();
    }
  }

  function formatTime(value) {
    try {
      var date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return "";
      }
      return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" +
        String(date.getDate()).padStart(2, "0") + " " +
        String(date.getHours()).padStart(2, "0") + ":" +
        String(date.getMinutes()).padStart(2, "0");
    } catch (error) {
      return "";
    }
  }

  function persistConflicts(conflicts) {
    if (!conflicts || !conflicts.length) {
      return;
    }
    var existing = readJsonStorage(CONFLICT_KEY);
    var list = existing && Array.isArray(existing.items) ? existing.items : [];
    var seen = new Set();
    list.forEach(function (item) {
      seen.add(canonicalJson(item));
    });
    var added = false;
    conflicts.forEach(function (item) {
      var safe = {
        kind: String(item.kind || "").slice(0, 40),
        questionId: Number.isSafeInteger(Number(item.questionId)) ? Number(item.questionId) : null,
        id: typeof item.id === "string" || Number.isSafeInteger(Number(item.id)) ? item.id : null,
        local: item.local,
        remote: item.remote,
        chosen: item.chosen === "local" || item.chosen === "remote" ? item.chosen : "",
        tie: item.tie === true,
        savedAt: new Date().toISOString()
      };
      var key = canonicalJson({
        kind: safe.kind, questionId: safe.questionId, id: safe.id,
        local: safe.local, remote: safe.remote
      });
      if (!seen.has(key)) {
        seen.add(key);
        list.push(safe);
        added = true;
      }
    });
    if (!added) {
      controller.conflicts = list;
      return;
    }
    if (list.length > 50) {
      list = list.slice(list.length - 50);
    }
    if (!writeJsonStorage(CONFLICT_KEY, { version: 1, items: list })) {
      throw new SyncError("archive_failed", "无法保存答案冲突备份，已停止同步；本机学习记录保持不变。");
    }
    controller.conflicts = list;
  }

  function saveLastGood(ownerId, state, native) {
    var backup = {
      version: 1,
      ownerId: ownerId,
      savedAt: new Date().toISOString(),
      bundle: sanitizeBundle({
        schemaVersion: SCHEMA_VERSION,
        state: state,
        native: native
      })
    };
    if (!writeJsonStorage(LAST_GOOD_KEY, backup)) {
      throw new SyncError("backup_failed", "无法保存同步前本机备份。");
    }
  }

  function captureLocalBundle() {
    var state = controller.hooks.getState();
    return callNative("cloudSyncExport", {}, 60000).then(function (result) {
      assertResponseSize(result);
      if (!isPlainObject(result) || !isPlainObject(result.native)) {
        throw new SyncError("export_invalid", "安装版返回的本机内容格式不正确，已停止同步。");
      }
      var bundle = sanitizeBundle({
        schemaVersion: SCHEMA_VERSION,
        state: state,
        native: result.native
      });
      return bundle;
    });
  }

  async function revalidateOwner(ownerId, epoch) {
    var raw;
    try {
      raw = await callNative("cloudAuthStatus", {}, 120000);
    } catch (error) {
      if (epoch === controller.epoch) {
        abortInFlight();
        controller.auth = null;
        controller.ownerId = "";
        setStatus("error", "", "无法确认登录状态，已停止同步；本机学习记录不受影响。");
      }
      throw new SyncError("auth_unavailable", "无法确认登录状态，已停止同步。");
    }
    if (epoch !== controller.epoch) {
      throw new SyncError("aborted", "账户状态已变化，已取消本次同步。");
    }
    var status = sanitizeAuth(raw);
    if (!status || status.error) {
      if (epoch === controller.epoch) {
        abortInFlight();
        controller.auth = null;
        controller.ownerId = "";
        setStatus("error", "", "无法确认登录状态，已停止同步；本机学习记录不受影响。");
      }
      throw new SyncError("auth_unavailable", "无法确认登录状态，已停止同步。");
    }
    if (!status.loggedIn || status.userId !== ownerId) {
      if (epoch === controller.epoch) {
        abortInFlight();
        controller.auth = status;
        controller.ownerId = status.loggedIn ? status.userId : "";
      }
      throw new SyncError("auth_changed", "登录账户已变化，已停止应用云端内容。");
    }
    controller.auth = status;
    return true;
  }

  async function applyMerged(ownerId, merged, epoch, localBundle) {
    if (epoch !== controller.epoch || controller.ownerId !== ownerId) {
      throw new SyncError("aborted", "账户状态已变化，已取消本次同步。");
    }
    var currentState = controller.hooks.getState();
    if (stateFingerprint(currentState) !== stateFingerprint(localBundle.state)) {
      controller.dirty = true;
      throw new SyncError("state_changed", "本机学习记录在同步过程中发生变化，已改为稍后重新合并。");
    }
    if (controller.hooks.isBusy && controller.hooks.isBusy()) {
      controller.pendingApply = {
        ownerId: ownerId,
        merged: merged,
        epoch: epoch,
        localBundle: localBundle
      };
      setStatus("pending", "云端有更新，将在结束当前编辑或复习后应用。");
      if (typeof controller.hooks.notify === "function" &&
          (!controller.pendingNoticeAt || Date.now() - controller.pendingNoticeAt > 60000)) {
        controller.pendingNoticeAt = Date.now();
        try {
          controller.hooks.notify("云端有新内容，将在结束当前编辑或复习后应用。");
        } catch (error) {
          // 提示失败不影响延后应用。
        }
      }
      schedulePendingApplyCheck();
      return;
    }
    await revalidateOwner(ownerId, epoch);
    var currentNative = await callNative("cloudSyncExport", {}, 60000);
    assertResponseSize(currentNative);
    if (!isPlainObject(currentNative) || !isPlainObject(currentNative.native)) {
      throw new SyncError("export_invalid", "安装版返回的本机内容格式不正确，已停止同步。");
    }
    if (stateFingerprint(controller.hooks.getState()) !== stateFingerprint(localBundle.state)) {
      controller.dirty = true;
      throw new SyncError("state_changed", "本机学习记录在同步过程中发生变化，已改为稍后重新合并。");
    }
    saveLastGood(ownerId, currentState, currentNative.native);
    if (epoch !== controller.epoch || controller.ownerId !== ownerId) {
      throw new SyncError("aborted", "账户状态已变化，已取消本次同步。");
    }
    var applyResult = await callNative("cloudSyncApply", {
      ownerId: ownerId,
      native: merged.native
    }, 120000);
    if (!isPlainObject(applyResult) || applyResult.changed !== true && applyResult.changed !== false) {
      throw new SyncError("apply_invalid", "安装版返回的同步应用结果格式不正确。");
    }
    if (epoch !== controller.epoch) {
      throw new SyncError("aborted", "账户状态已变化，已取消本次同步。");
    }
    // 契约要求应用后刷新 bootstrap；导出的是原生合并后的完整内容。
    var refreshed = await callNative("cloudSyncExport", {}, 60000);
    assertResponseSize(refreshed);
    if (!isPlainObject(refreshed) || !isPlainObject(refreshed.native)) {
      throw new SyncError("export_invalid", "应用后读取本机内容失败，已保留同步前备份。");
    }
    if (stateFingerprint(controller.hooks.getState()) !== stateFingerprint(localBundle.state)) {
      controller.dirty = true;
      throw new SyncError("state_changed", "本机学习记录在同步过程中发生变化，已改为稍后重新合并。");
    }
    var applied = controller.hooks.applyState({
      state: merged.state,
      native: refreshed.native
    });
    if (applied !== true) {
      throw new SyncError("apply_failed", "云端内容已保存，但本机应用失败；已保留同步前备份。");
    }
    controller.pendingApply = null;
    controller.lastSyncedAt = Date.now();
    saveMeta();
    setStatus("success", "已同步 · " + formatTime(controller.lastSyncedAt));
  }

  function schedulePendingApplyCheck() {
    if (controller.pendingCheckTimer) {
      return;
    }
    controller.pendingCheckTimer = root.setTimeout(function () {
      controller.pendingCheckTimer = null;
      if (!controller.pendingApply) {
        return;
      }
      if (controller.hooks.isBusy && controller.hooks.isBusy()) {
        schedulePendingApplyCheck();
        return;
      }
      syncNow("pending").catch(function () {
        // 状态已由 syncNow 设置。
      });
    }, 4000);
  }

  async function performSync(ownerId, epoch) {
    controller.pendingApply = null;
    var lastConflict = null;
    for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (epoch !== controller.epoch || controller.ownerId !== ownerId) {
        throw new SyncError("aborted", "账户状态已变化，已取消本次同步。");
      }
      setStatus("syncing", attempt === 1 ? "正在同步…" : "正在重新合并（" + attempt + "/" + MAX_ATTEMPTS + "）…");
      var localBundle = await captureLocalBundle();
      var localFingerprint = stateFingerprint(localBundle.state);
      if (epoch !== controller.epoch) {
        throw new SyncError("aborted", "账户状态已变化，已取消本次同步。");
      }
      var pull = await callNative("cloudSyncPull", {}, 120000);
      if (epoch !== controller.epoch) {
        throw new SyncError("aborted", "账户状态已变化，已取消本次同步。");
      }
      assertResponseSize(pull);
      if (!isPlainObject(pull)) {
        throw new SyncError("pull_invalid", "安装版返回的云端状态格式不正确，已停止同步。");
      }
      var pullOwner = typeof pull.ownerId === "string" ? pull.ownerId : "";
      if (!isUuid(pullOwner) || pullOwner !== ownerId) {
        throw new SyncError("owner_mismatch", "云端账户与当前登录账户不一致，已停止同步。");
      }
      var revision = Number(pull.revision);
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new SyncError("pull_invalid", "云端版本号无效，已停止同步。");
      }
      var remoteBundle = pull.payload === null || pull.payload === undefined
        ? null
        : sanitizeBundle(pull.payload);
      var merged = mergeBundles(localBundle, remoteBundle);
      assertBundleSize(merged.bundle);
      persistConflicts(merged.conflicts);
      if (epoch !== controller.epoch) {
        throw new SyncError("aborted", "账户状态已变化，已取消本次同步。");
      }
      // 推送前再次用 /user 验证当前账户，避免把旧账户数据写到新账户。
      await revalidateOwner(ownerId, epoch);
      // The owner binding becomes durable only after the first pull and merge
      // succeeded. A failed first pull must not lock the device to that account.
      bindOwner(ownerId);
      var push = await callNative("cloudSyncPush", {
        expectedRevision: revision,
        payload: merged.bundle
      }, 120000);
      if (epoch !== controller.epoch) {
        throw new SyncError("aborted", "账户状态已变化，已取消本次同步。");
      }
      assertResponseSize(push);
      if (!isPlainObject(push)) {
        throw new SyncError("push_invalid", "安装版返回的同步结果格式不正确，已停止同步。");
      }
      if (push.conflict === true) {
        lastConflict = new SyncError("conflict", "云端已有其他设备更新，正在重新合并。");
        if (attempt < MAX_ATTEMPTS) {
          continue;
        }
        throw lastConflict;
      }
      var pushOwner = typeof push.ownerId === "string" ? push.ownerId : "";
      if (!isUuid(pushOwner) || pushOwner !== ownerId) {
        throw new SyncError("owner_mismatch", "云端账户与当前登录账户不一致，已停止同步。");
      }
      var pushedRevision = Number(push.revision);
      if (!Number.isSafeInteger(pushedRevision) || pushedRevision < 0) {
        throw new SyncError("push_invalid", "云端版本号无效，已停止同步。");
      }
      if (stateFingerprint(controller.hooks.getState()) !== localFingerprint) {
        // 网络期间本地又产生了新改动：不要用旧响应覆盖，改为下一轮合并。
        controller.dirty = true;
        setStatus("idle", "检测到本机新改动，正在安排再次同步。");
        scheduleSync(400);
        return;
      }
      await revalidateOwner(ownerId, epoch);
      var stateChanged = canonicalJson(merged.bundle.state) !== canonicalJson(localBundle.state);
      var nativeChanged = nativeFingerprint(merged.bundle.native) !== nativeFingerprint(localBundle.native);
      controller.lastSyncedAt = Date.now();
      saveMeta();
      if (!stateChanged && !nativeChanged) {
        setStatus("success", "已同步 · " + formatTime(controller.lastSyncedAt));
        return;
      }
      await applyMerged(ownerId, {
        state: merged.bundle.state,
        native: merged.bundle.native
      }, epoch, localBundle);
      return;
    }
    if (lastConflict) {
      throw lastConflict;
    }
  }

  async function syncNow(reason) {
    if (!isNative()) {
      setStatus("off", "仅安装版支持跨设备同步；网页预览不会上传任何内容。");
      return { status: "preview" };
    }
    if (controller.running) {
      controller.dirty = true;
      return { status: "already_running" };
    }
    controller.running = true;
    controller.dirty = false;
    try {
      await refreshAuth();
      var ownerId = ensureOwner();
      if (controller.ownerId !== ownerId) {
        throw new SyncError("aborted", "账户状态已变化，已取消本次同步。");
      }
      checkBinding(ownerId);
      if (!isOptedIn(ownerId)) {
        controller.pendingApply = null;
        setStatus("consent", "请先阅读说明并选择是否开启跨设备同步。");
        return { status: "consent_required" };
      }
      // Do not bind here. performSync binds only after a successful pull+merge.
      var epoch = controller.epoch;
      await performSync(ownerId, epoch);
      return { status: controller.status };
    } catch (error) {
      if (error && error.code === "aborted") {
        setStatus("idle", "账户已变化，已取消上一次同步；本机学习记录未受影响。");
      } else if (error && error.code === "auth_required") {
        setStatus("off", "登录后可开启跨设备同步。");
      } else {
        setStatus("error", "", safeErrorMessage(error));
      }
      return { status: "error", error: safeErrorMessage(error) };
    } finally {
      controller.running = false;
      redraw();
      if (controller.dirty && !controller.pendingApply) {
        controller.dirty = false;
        scheduleSync(600);
      }
    }
  }

  function scheduleSync(delay) {
    if (!isNative() || !controller.ownerId || !isOptedIn(controller.ownerId)) {
      return;
    }
    try {
      checkBinding(controller.ownerId);
    } catch (error) {
      setStatus("blocked", "", safeErrorMessage(error));
      return;
    }
    if (controller.debounceTimer) {
      root.clearTimeout(controller.debounceTimer);
    }
    controller.debounceTimer = root.setTimeout(function () {
      controller.debounceTimer = null;
      syncNow("scheduled").catch(function () {
        // syncNow 已在界面中给出固定错误。
      });
    }, Number.isFinite(delay) ? delay : DEBOUNCE_MS);
  }

  function notifyStateChanged() {
    if (!isNative() || !controller.configured) {
      return;
    }
    if (controller.running) {
      controller.dirty = true;
      return;
    }
    if (controller.ownerId && isOptedIn(controller.ownerId)) {
      scheduleSync(DEBOUNCE_MS);
    }
  }

  function configure(hooks) {
    if (!isPlainObject(hooks) || typeof hooks.getState !== "function" ||
        typeof hooks.applyState !== "function") {
      throw new Error("StudyCloudSync.configure 需要 getState 与 applyState。");
    }
    controller.hooks = hooks;
    controller.configured = true;
    start();
    return true;
  }

  function resumeSync(delay) {
    if (!isNative()) {
      return;
    }
    if (controller.ownerId && isOptedIn(controller.ownerId)) {
      scheduleSync(delay);
      return;
    }
    root.setTimeout(function () {
      refreshAuth().then(function (status) {
        if (status.loggedIn && isOptedIn(status.userId)) {
          scheduleSync(200);
        }
      }).catch(function () {
        // 状态已由 refreshAuth 设置为固定错误。
      });
    }, Number.isFinite(delay) ? delay : 0);
  }

  function start() {
    if (controller.started || !isNative() || !root || typeof root.addEventListener !== "function") {
      return;
    }
    controller.started = true;
    root.addEventListener("online", function () {
      resumeSync(300);
    });
    root.addEventListener("focus", function () {
      if (!controller.running) {
        resumeSync(600);
      }
    });
    if (root.document && typeof root.document.addEventListener === "function") {
      root.document.addEventListener("visibilitychange", function () {
        if (root.document.visibilityState === "visible" && !controller.running) {
          resumeSync(600);
        }
      });
    }
    root.setTimeout(function () {
      refreshAuth().then(function (status) {
        if (status.loggedIn && isOptedIn(status.userId)) {
          scheduleSync(300);
        }
      }).catch(function () {
        // 状态已给出固定错误。
      });
    }, 0);
  }

  function el(tag, attributes, children) {
    var node = root.document.createElement(tag);
    if (attributes) {
      Object.keys(attributes).forEach(function (key) {
        var value = attributes[key];
        if (value === null || value === undefined || value === false) {
          return;
        }
        if (key === "class") {
          node.className = String(value);
        } else if (key === "text") {
          node.textContent = String(value);
        } else if (key === "disabled" || key === "hidden") {
          node[key] = Boolean(value);
        } else {
          node.setAttribute(key, value === true ? "" : String(value));
        }
      });
    }
    (Array.isArray(children) ? children : (children === undefined ? [] : [children]))
      .forEach(function (child) {
        if (child === null || child === undefined || child === false) {
          return;
        }
        if (typeof child === "string" || typeof child === "number") {
          node.appendChild(root.document.createTextNode(String(child)));
        } else {
          node.appendChild(child);
        }
      });
    return node;
  }

  function redraw() {
    if (!controller.panelHost || !root || !root.document) {
      return;
    }
    var host = controller.panelHost;
    host.textContent = "";
    host.appendChild(el("h4", { class: "section-subheading", text: "跨设备同步" }));
    if (!isNative()) {
      host.appendChild(el("p", {
        class: "notice is-info",
        text: "仅安装版支持跨设备同步。网页预览不上传、不下载任何学习记录。"
      }));
      return;
    }
    if (controller.conflicts.length) {
      host.appendChild(el("p", {
        class: "notice is-info",
        text: "本机保留了 " + controller.conflicts.length + " 条答案或内容冲突版本（不会同步），最新版本已按规则选用。"
      }));
    }
    if (controller.error) {
      host.appendChild(el("p", {
        class: "notice is-error",
        role: "alert",
        text: controller.error
      }));
    } else if (controller.message) {
      host.appendChild(el("p", {
        class: "notice is-info",
        role: "status",
        "aria-live": "polite",
        text: controller.message
      }));
    }
    var ownerId = controller.ownerId;
    if (!controller.auth || !controller.auth.loggedIn || !ownerId) {
      host.appendChild(el("p", {
        class: "tiny-note",
        text: "登录后可选择是否开启跨设备同步；不登录也能离线复习和修改本机记录。"
      }));
      return;
    }
    try {
      checkBinding(ownerId);
    } catch (error) {
      host.appendChild(el("p", {
        class: "notice is-error",
        role: "alert",
        text: safeErrorMessage(error)
      }));
      return;
    }
    if (!isOptedIn(ownerId)) {
      host.appendChild(el("p", {
        class: "section-copy",
        text: "开启后，云端会保存学习历史、答案修订、复习进度和已解析的导入资料；" +
          "其他用户不可见，管理员可能审核导入内容。API Key 和密码不会同步。" +
          "开启前不会自动上传；本机离线复习不受影响。"
      }));
      host.appendChild(el("div", { class: "account-row" }, [
        el("button", {
          class: "primary-button",
          type: "button",
          id: "cloud-sync-enable",
          text: "开启跨设备同步"
        })
      ]));
      var enable = host.querySelector ? host.querySelector("#cloud-sync-enable") : null;
      if (enable) {
        enable.addEventListener("click", function () {
          try {
            checkBinding(ownerId);
            setOptIn(ownerId, true);
            setStatus("syncing", "正在同步…");
            syncNow("opt-in").catch(function () {});
          } catch (error) {
            setStatus("error", "", safeErrorMessage(error));
          }
        });
      }
      return;
    }
    host.appendChild(el("p", {
      class: "tiny-note",
      text: "已开启。云端保存学习历史、答案修订、复习进度和已解析的导入资料；" +
        "API Key 和密码不会同步。"
    }));
    var row = el("div", { class: "account-row" }, [
      el("button", {
        class: "secondary-button",
        type: "button",
        id: "cloud-sync-now",
        text: controller.running ? "正在同步…" : "立即同步",
        disabled: controller.running
      }),
      el("button", {
        class: "secondary-button",
        type: "button",
        id: "cloud-sync-disable",
        text: "关闭本机同步",
        disabled: controller.running
      })
    ]);
    host.appendChild(row);
    var nowButton = host.querySelector ? host.querySelector("#cloud-sync-now") : null;
    if (nowButton) {
      nowButton.addEventListener("click", function () {
        syncNow("manual").catch(function () {});
      });
    }
    var disableButton = host.querySelector ? host.querySelector("#cloud-sync-disable") : null;
    if (disableButton) {
      disableButton.addEventListener("click", function () {
        try {
          setOptIn(ownerId, false);
          controller.pendingApply = null;
          if (controller.debounceTimer) {
            root.clearTimeout(controller.debounceTimer);
            controller.debounceTimer = null;
          }
          setStatus("off", "已关闭本机自动同步；本机学习记录和绑定保持不变。");
        } catch (error) {
          setStatus("error", "", safeErrorMessage(error));
        }
      });
    }
  }

  function render() {
    if (!root || !root.document) {
      return null;
    }
    var host = el("div", { class: "cloud-sync-panel", id: "cloud-sync-panel" });
    controller.panelHost = host;
    controller.panel = host;
    var stored = readJsonStorage(CONFLICT_KEY);
    controller.conflicts = stored && Array.isArray(stored.items) ? stored.items : [];
    redraw();
    return host;
  }

  return Object.freeze({
    // 纯函数（Node 测试直接用）
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_BUNDLE_BYTES: MAX_BUNDLE_BYTES,
    MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
    FIRST_NATIVE_ID: FIRST_NATIVE_ID,
    NATIVE_ID_LIMIT: NATIVE_ID_LIMIT,
    sanitizeBundle: sanitizeBundle,
    sanitizeState: sanitizeState,
    sanitizeNative: sanitizeNative,
    mergeBundles: mergeBundles,
    mergeLearningState: mergeLearningState,
    mergeNative: mergeNative,
    stateFingerprint: stateFingerprint,
    canonicalJson: canonicalJson,
    isSensitiveKey: isSensitiveKey,
    isSafeNativeId: isSafeNativeId,
    randomSafeId: randomSafeId,
    allocateNativeId: randomSafeId,
    jsonByteLength: jsonByteLength,
    SyncError: SyncError,
    // 共享 UI / 控制器（两个平台复用同一份）
    render: render,
    configure: configure,
    syncNow: syncNow,
    notifyAuthStatus: notifyAuthStatus,
    notifyAuthFailure: notifyAuthFailure,
    notifyStateChanged: notifyStateChanged,
    isNative: isNative,
    getStatus: function () { return controller.status; },
    getLastError: function () { return controller.error; },
    __controller: controller
  });
});
