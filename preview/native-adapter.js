/*
 * 平江安澜 · 安卓桥接适配层
 *
 * 只在 WebView 注入 window.AndroidBridge 时启用。浏览器预览不创建假桥，
 * 也不把预览状态说成安装版已连接。
 *
 * 契约（native-contract.md v1）：
 *   getBootstrap(): 同步 JSON 字符串
 *   request(id, method, payloadJson): void
 *   window.__nativeResult(id, result): 原生异步回调
 */
(function (root, factory) {
  "use strict";
  var api = factory(root);
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.NativeApp = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  var DEFAULT_TIMEOUT_MS = 45000;
  var requestSequence = 0;
  var pending = Object.create(null);
  var bridge = root && root.AndroidBridge;
  var bridgeAvailable = Boolean(bridge && typeof bridge.request === "function");
  var bootstrapError = "";
  var bootstrapNotice = "";
  var mergeSummary = {
    sources: 0,
    questions: 0,
    types: 0,
    answers: 0
  };

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function safeString(value, max) {
    return String(value === null || value === undefined ? "" : value).slice(0, max || 200);
  }

  function makeError(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }

  function existingSourceIds() {
    var ids = new Set();
    var data = isPlainObject(root.STUDY_DATA) ? root.STUDY_DATA : null;
    var list = data && Array.isArray(data.sources) ? data.sources : [];
    list.forEach(function (source) {
      if (source && source.id !== undefined && source.id !== null) {
        ids.add(String(source.id));
      }
    });
    return ids;
  }

  function existingQuestionIds() {
    var ids = new Set();
    var data = isPlainObject(root.STUDY_DATA) ? root.STUDY_DATA : null;
    var list = data && Array.isArray(data.questions) ? data.questions : [];
    list.forEach(function (question) {
      if (question && question.id !== undefined && question.id !== null) {
        ids.add(String(question.id));
      }
    });
    return ids;
  }

  function existingGeneratedIds() {
    var ids = new Set();
    var list = Array.isArray(root.GENERATED_ANSWERS) ? root.GENERATED_ANSWERS : [];
    list.forEach(function (item) {
      if (!isPlainObject(item)) {
        return;
      }
      var id = item.question_id !== undefined ? item.question_id : item.id;
      if (id !== undefined && id !== null) {
        ids.add(String(id));
      }
    });
    return ids;
  }

  /**
   * 将 getBootstrap 返回的原生自定义内容合并到 app.js 启动前读取的三个全局。
   * 内置 208 题、已有来源与已有初稿一律不覆盖；非法/重复项跳过。
   */
  function mergeBootstrap(raw) {
    var parsed;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (error) {
      throw makeError("bootstrap_invalid", "安装版题库数据不是有效 JSON。");
    }
    if (!isPlainObject(parsed)) {
      throw makeError("bootstrap_invalid", "安装版题库数据格式不正确。");
    }

    var data = isPlainObject(root.STUDY_DATA)
      ? root.STUDY_DATA
      : { sources: [], questions: [], edition: "" };
    var sources = Array.isArray(data.sources) ? data.sources.slice() : [];
    var questions = Array.isArray(data.questions) ? data.questions.slice() : [];
    var generated = Array.isArray(root.GENERATED_ANSWERS) ? root.GENERATED_ANSWERS.slice() : [];
    var types = isPlainObject(root.QUESTION_TYPES) ? Object.assign({}, root.QUESTION_TYPES) : {};

    var sourceIds = existingSourceIds();
    var questionIds = existingQuestionIds();
    var generatedIds = existingGeneratedIds();
    var newSources = [];
    var newQuestions = [];
    var newAnswers = [];

    if (Array.isArray(parsed.customSources)) {
      parsed.customSources.forEach(function (source) {
        if (!isPlainObject(source) || source.id === undefined || source.id === null) {
          return;
        }
        var name = safeString(source.name, 300);
        if (!name || sourceIds.has(String(source.id))) {
          return;
        }
        sourceIds.add(String(source.id));
        var normalized = Object.assign({}, source, { name: name });
        sources.push(normalized);
        newSources.push(normalized);
      });
    }

    if (Array.isArray(parsed.customQuestions)) {
      parsed.customQuestions.forEach(function (question) {
        if (!isPlainObject(question) || question.id === undefined || question.id === null) {
          return;
        }
        var stem = safeString(question.question, 20000);
        if (!stem || questionIds.has(String(question.id))) {
          return;
        }
        questionIds.add(String(question.id));
        var normalized = Object.assign({}, question, { question: stem });
        questions.push(normalized);
        newQuestions.push(normalized);
      });
    }

    if (isPlainObject(parsed.customTypes)) {
      Object.keys(parsed.customTypes).forEach(function (key) {
        var typeName = safeString(parsed.customTypes[key], 40).trim();
        if (!typeName || Object.prototype.hasOwnProperty.call(types, key)) {
          return;
        }
        types[key] = typeName;
        mergeSummary.types += 1;
      });
    }

    if (Array.isArray(parsed.customAnswers)) {
      parsed.customAnswers.forEach(function (answer) {
        if (!isPlainObject(answer)) {
          return;
        }
        var id = answer.question_id !== undefined ? answer.question_id : answer.id;
        if (id === undefined || id === null || generatedIds.has(String(id)) ||
            !safeString(answer.answer, 20000).trim()) {
          return;
        }
        generatedIds.add(String(id));
        var normalized = Object.assign({}, answer);
        generated.push(normalized);
        newAnswers.push(normalized);
      });
    }

    if (!newSources.length && !newQuestions.length && !newAnswers.length &&
        mergeSummary.types === 0) {
      return mergeSummary;
    }

    data.sources = sources;
    data.questions = questions;
    root.STUDY_DATA = data;
    root.GENERATED_ANSWERS = generated;
    root.QUESTION_TYPES = types;
    mergeSummary.sources = newSources.length;
    mergeSummary.questions = newQuestions.length;
    mergeSummary.answers = newAnswers.length;
    return mergeSummary;
  }

  function readBootstrap() {
    if (!bridgeAvailable) {
      return;
    }
    try {
      if (typeof bridge.getBootstrap !== "function") {
        throw new Error("getBootstrap unavailable");
      }
      mergeBootstrap(bridge.getBootstrap());
    } catch (error) {
      // 引导数据读取失败时保持现有题库与本地存档不变，只记录可展示的提示。
      bootstrapError = "安装版新增题库读取失败；已保留原有题库与学习记录。";
    }
  }

  function markDocumentMode() {
    if (!root || !root.document || !root.document.documentElement) {
      return;
    }
    var element = root.document.documentElement;
    element.classList.toggle("native-app", bridgeAvailable);
    element.classList.toggle("web-preview", !bridgeAvailable);
  }

  function settle(id, outcome) {
    var entry = pending[id];
    if (!entry) {
      // 超时、取消或重复回调都到这里：只允许第一个结果生效。
      return false;
    }
    delete pending[id];
    if (entry.timer) {
      root.clearTimeout(entry.timer);
    }
    if (outcome.ok) {
      entry.resolve(outcome.data);
    } else {
      entry.reject(outcome.error);
    }
    return true;
  }

  function nativeResult(id, result) {
    var key = String(id);
    var entry = pending[key];
    if (!entry) {
      return false;
    }
    var value = result;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch (error) {
        settle(key, {
          ok: false,
          error: makeError("invalid_result", "安装版返回了无法解析的结果。")
        });
        return true;
      }
    }
    if (!isPlainObject(value)) {
      settle(key, {
        ok: false,
        error: makeError("invalid_result", "安装版返回结果格式不正确。")
      });
      return true;
    }
    if (value.ok === true) {
      settle(key, { ok: true, data: value.data });
    } else {
      var message = safeString(value.error, 200).trim() || "操作未完成，请稍后重试。";
      settle(key, { ok: false, error: makeError("native", message) });
    }
    return true;
  }

  function call(method, payload, options) {
    if (!bridgeAvailable) {
      return Promise.reject(makeError(
        "unavailable",
        "当前为网页预览，安装版功能不可用。"
      ));
    }
    var name = safeString(method, 80);
    if (!name) {
      return Promise.reject(makeError("invalid_method", "缺少要调用的安装版功能。"));
    }
    var timeoutMs = options && Number(options.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      timeoutMs = DEFAULT_TIMEOUT_MS;
    }
    var payloadJson;
    try {
      payloadJson = JSON.stringify(payload || {});
    } catch (error) {
      return Promise.reject(makeError("invalid_payload", "要发送的内容无法序列化。"));
    }
    requestSequence += 1;
    var id = "native-" + Date.now().toString(36) + "-" + requestSequence;
    return new Promise(function (resolve, reject) {
      var timer = root.setTimeout(function () {
        settle(id, {
          ok: false,
          error: makeError("timeout", "安装版响应超时，请稍后重试。")
        });
      }, timeoutMs);
      pending[id] = {
        resolve: resolve,
        reject: reject,
        timer: timer,
        method: name
      };
      try {
        bridge.request(id, name, payloadJson);
      } catch (error) {
        settle(id, {
          ok: false,
          error: makeError("request_failed", "无法连接安装版功能，请重新打开应用。")
        });
      }
    });
  }

  function cancel(id, reason) {
    var key = String(id);
    if (!pending[key]) {
      return false;
    }
    return settle(key, {
      ok: false,
      error: makeError("canceled", safeString(reason, 120) || "操作已取消。")
    });
  }

  function isPending(id) {
    return Boolean(pending[String(id)]);
  }

  function pendingCount() {
    return Object.keys(pending).length;
  }

  if (bridgeAvailable) {
    readBootstrap();
  }
  markDocumentMode();

  if (bridgeAvailable && root) {
    // 回调名固定为契约中的 window.__nativeResult；重复或超时后的回调会被忽略。
    root.__nativeResult = nativeResult;
  }

  var api = {
    hasBridge: bridgeAvailable,
    isNative: bridgeAvailable,
    isPreview: !bridgeAvailable,
    bootstrapError: bootstrapError,
    bootstrapNotice: bootstrapError,
    mergeSummary: Object.freeze(Object.assign({}, mergeSummary)),
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    call: call,
    cancel: cancel,
    isPending: isPending,
    pendingCount: pendingCount,
    __nativeResult: nativeResult
  };

  return Object.freeze(api);
});
