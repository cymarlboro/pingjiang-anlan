"use strict";

const { UserError } = require("./errors.cjs");
const { requestOnce } = require("./http-request.cjs");
const { normalizeApiBase } = require("./url-rules.cjs");
const { normalize: normalizeType, isCanonical } = require("./question-types.cjs");
const compat = require("./api-compat.cjs");

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_CHARS = 12000;
const MAX_MODELS = 300;
const TIMEOUT_MS = 120000;

const CHOICE_MISSING_OPTIONS = "选择题缺少完整选项，请减少题量或重试";
const CHOICE_OPTION_LABELS = new Set("ABCDEFGH".split(""));
const EXTRA_CHOICE_TYPE_ALIASES = new Set([
  "单选",
  "多选",
  "多选题",
  "多项选择",
  "多项选择题",
  "不定项选择",
  "不定项选择题"
]);
const CHOICE_OPTIONS_PROMPT =
  "选择题的选项必须全部写在 question 字段内（当前没有 options 字段），" +
  "每个选项都要有 A、B 等独立标签且内容非空，至少包含 A、B 两条，可内联或换行；" +
  "原文没有选项时不得生成选择题，也不得只把答案标签当作选项。";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeGeneratedType(raw) {
  const compact = raw.replace(/[\s\u3000]+/g, "");
  if (EXTRA_CHOICE_TYPE_ALIASES.has(compact)) {
    return "选择题";
  }
  return normalizeType(raw);
}

/**
 * A generated choice question must carry its options inside `question`, because
 * the generation schema has no separate `options` field. Accept the common
 * Chinese inline/newline forms: A. / A、 / A． / A) / A） / (A) / （A）.
 */
function isOptionLabel(value) {
  return CHOICE_OPTION_LABELS.has(value);
}

function isOptionBoundary(text, index) {
  if (index === 0) {
    return true;
  }
  return /[\s\u3000;；,，。．？?！!、：:）)】\]]/.test(text[index - 1]);
}

function matchOptionMarker(text, index) {
  const first = text[index];
  if (first === "(" || first === "（") {
    if (index + 2 >= text.length) {
      return null;
    }
    const label = text[index + 1];
    const close = text[index + 2];
    if (isOptionLabel(label) && (close === ")" || close === "）")) {
      return { label, start: index, contentStart: index + 3 };
    }
    return null;
  }
  if (!isOptionLabel(first) || index + 1 >= text.length) {
    return null;
  }
  const separator = text[index + 1];
  if (".、．)）".includes(separator)) {
    return { label: first, start: index, contentStart: index + 2 };
  }
  return null;
}

function hasMeaningfulOptionText(value) {
  return /[\p{L}\p{N}]/u.test(value);
}

function hasCompleteChoiceOptions(question) {
  if (typeof question !== "string" || !question) {
    return false;
  }
  const markers = [];
  let sawStrongMarker = false;
  for (let index = 0; index < question.length;) {
    const marker = matchOptionMarker(question, index);
    const strong = isOptionBoundary(question, index);
    // The first option label must be at a real boundary. Later labels may be
    // tight against the previous option text (A.地壳B.地幔) once an option block
    // has clearly started.
    if (marker && (strong || sawStrongMarker)) {
      markers.push(marker);
      if (strong) {
        sawStrongMarker = true;
      }
      index = marker.contentStart;
      continue;
    }
    index += 1;
  }
  if (markers.length < 2) {
    return false;
  }
  const labels = new Set();
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const end = index + 1 < markers.length ? markers[index + 1].start : question.length;
    const content = question.slice(marker.contentStart, end).trim();
    if (!hasMeaningfulOptionText(content)) {
      return false;
    }
    if (labels.has(marker.label)) {
      return false;
    }
    labels.add(marker.label);
  }
  return labels.size >= 2;
}

// Keep the choice rule at the generation boundary so every production request
// carries it even though the shared grounding prompt lives in api-compat.cjs.
function buildGenerationSystemPrompt(maxQuestions) {
  return compat.buildSystemPrompt(maxQuestions) + CHOICE_OPTIONS_PROMPT;
}

function requiredText(item, key, maxLength) {
  const raw = item[key];
  if (typeof raw !== "string") {
    throw new UserError("模型返回的题目结构不完整");
  }
  const value = raw.trim();
  if (!value) {
    throw new UserError("模型返回的题目结构不完整");
  }
  if (value.length > maxLength) {
    throw new UserError("模型返回内容过长，已拒绝保存");
  }
  return value;
}

function stripCodeFence(content) {
  let value = String(content || "").trim();
  if (!value.startsWith("```")) {
    return value;
  }
  const firstNewline = value.indexOf("\n");
  if (firstNewline < 0) {
    return value;
  }
  value = value.slice(firstNewline + 1).trim();
  if (value.endsWith("```")) {
    value = value.slice(0, -3).trim();
  }
  return value;
}

function parseModels(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new UserError("模型列表不是有效 JSON");
  }
  const source = Array.isArray(parsed)
    ? parsed
    : (isPlainObject(parsed) && (Array.isArray(parsed.data)
      ? parsed.data
      : (Array.isArray(parsed.models) ? parsed.models : null)));
  if (!source) {
    throw new UserError("服务未返回模型列表");
  }
  const seen = new Set();
  for (const item of source) {
    let id = "";
    if (typeof item === "string") {
      id = item.trim();
    } else if (isPlainObject(item)) {
      id = String(item.id || item.name || "").trim();
    }
    if (id && id.length <= 200) {
      seen.add(id);
    }
    if (seen.size >= MAX_MODELS) {
      break;
    }
  }
  return [...seen];
}

function assertNotRedirect(status) {
  if (status >= 300 && status < 400) {
    throw new UserError(`服务返回重定向，已拒绝跟随（HTTP ${status}）`);
  }
}

function parseGenerated(body, importId, sourceName, selectedIndexes, pagesByIndex, maxQuestions) {
  let root;
  try {
    root = JSON.parse(body);
  } catch {
    throw new UserError("模型返回的内容不是有效 JSON");
  }
  if (!isPlainObject(root)) {
    throw new UserError("模型返回结构不完整");
  }
  if (isPlainObject(root.error)) {
    throw new UserError("模型服务返回错误");
  }
  const choices = root.choices;
  if (!Array.isArray(choices) || !choices.length || !isPlainObject(choices[0])) {
    throw new UserError("模型返回结构不完整");
  }
  const choice = choices[0];
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : "";
  if (finishReason === "length") {
    throw new UserError("模型回答因长度限制被截断，已拒绝保存，请减少题量后重试");
  }
  if (finishReason === "content_filter") {
    throw new UserError("模型返回被内容过滤，未产生可用草稿");
  }
  const message = choice.message;
  if (!isPlainObject(message) || typeof message.content !== "string") {
    throw new UserError("模型返回结构不完整");
  }
  let content = message.content.trim();
  if (!content) {
    throw new UserError("模型返回内容为空");
  }
  content = stripCodeFence(content);
  if (!content.startsWith("{") || !content.endsWith("}")) {
    throw new UserError("模型返回的 JSON 结构不完整或格式错误");
  }
  let generated;
  try {
    generated = JSON.parse(content);
  } catch {
    throw new UserError("模型返回的 JSON 结构不完整或格式错误");
  }
  const questions = generated && generated.questions;
  if (!Array.isArray(questions)) {
    throw new UserError("模型返回的 JSON 缺少 questions");
  }
  if (!questions.length) {
    throw new UserError("模型没有生成可用题目");
  }
  if (questions.length > maxQuestions) {
    throw new UserError("模型返回题量超过本次上限");
  }
  const seen = new Set();
  const result = [];
  for (const item of questions) {
    if (!isPlainObject(item)) {
      throw new UserError("模型返回的题目结构不完整");
    }
    const question = requiredText(item, "question", 4000);
    const answer = requiredText(item, "answer", 30000);
    const type = normalizeGeneratedType(requiredText(item, "type", 40));
    if (!type || !isCanonical(type)) {
      throw new UserError("模型返回了不允许的题型");
    }
    if (type === "选择题" && !hasCompleteChoiceOptions(question)) {
      // Reject the whole batch; never synthesize options or silently retype it.
      throw new UserError(CHOICE_MISSING_OPTIONS);
    }
    const sourceQuote = requiredText(item, "sourceQuote", 10000);
    const pageValue = item.pageIndex;
    if (typeof pageValue !== "number" || !Number.isInteger(pageValue)) {
      throw new UserError("模型返回的引用页码格式错误");
    }
    if (!selectedIndexes.has(pageValue)) {
      throw new UserError("模型返回的引用页码不在本次发送范围内");
    }
    const page = pagesByIndex.get(pageValue);
    if (!page || !String(page.text || "").includes(sourceQuote)) {
      throw new UserError("模型返回的引用未能在原文中精确匹配，已拒绝保存");
    }
    const dedupe = question.replace(/\s+/g, " ").trim();
    if (seen.has(dedupe)) {
      throw new UserError("模型返回了重复题目");
    }
    seen.add(dedupe);
    let chapter = typeof item.chapter === "string" ? item.chapter.trim().slice(0, 120) : "";
    if (!chapter) {
      chapter = "导入资料";
    }
    result.push({
      question,
      answer,
      type,
      chapter,
      sourceQuote,
      pageIndex: pageValue,
      locator: page.locator || ""
    });
  }
  return { questions: result, sourceName, importId };
}

class ApiClient {
  constructor({ store, keyStore, request = requestOnce }) {
    this.store = store;
    this.keyStore = keyStore;
    this.request = request;
  }

  async hasKey() {
    try {
      return (await this.keyStore.load()) !== null;
    } catch {
      return false;
    }
  }

  async getConfig() {
    return Object.assign({}, this.store.getApiConfig(), { hasKey: await this.hasKey() });
  }

  async saveConfig(payload) {
    if (!isPlainObject(payload)) {
      throw new UserError("API 设置格式错误");
    }
    function optionalString(value, max) {
      if (value === undefined || value === null) {
        return "";
      }
      if (typeof value !== "string") {
        throw new UserError("API 设置字段格式错误");
      }
      const text = value.trim();
      if (text.length > max) {
        throw new UserError("API 设置字段过长");
      }
      return text;
    }
    const serviceName = optionalString(payload.serviceName, 60);
    const baseUrlRaw = optionalString(payload.baseUrl, 2048);
    if (!baseUrlRaw) {
      throw new UserError("请填写兼容 chat/completions 的服务地址");
    }
    const baseUrl = normalizeApiBase(baseUrlRaw);
    const model = optionalString(payload.model, 200);
    const maxQuestions = Math.min(10, Math.max(1, Math.round(Number(payload.maxQuestions) || 5)));
    const apiKey = optionalString(payload.apiKey, 8192);
    const clearKey = payload.clearKey === true;
    if (apiKey) {
      if (/[\u0000-\u001f\u007f]/.test(apiKey)) {
        throw new UserError("API Key 包含无效控制字符");
      }
    }
    const previous = this.store.getApiConfig();
    const previousBase = previous.baseUrl || "";
    const keyPresent = await this.hasKey();
    const keyFilePresent = typeof this.keyStore.exists === "function"
      ? await this.keyStore.exists()
      : keyPresent;
    if (!clearKey && !apiKey && (keyPresent || keyFilePresent) &&
        previousBase !== baseUrl) {
      throw new UserError("更换服务地址时，请重新填写该服务的密钥，或先清除已保存密钥");
    }
    await this.store.saveApiConfig({
      serviceName,
      baseUrl,
      model,
      maxQuestions
    });
    try {
      if (clearKey) {
        await this.keyStore.clear();
      } else if (apiKey) {
        await this.keyStore.save(apiKey);
      }
    } catch (error) {
      try {
        await this.store.saveApiConfig(previous);
      } catch {
        // Best effort; keep the actionable key-storage failure.
      }
      throw error;
    }
    return this.getConfig();
  }

  async testApi() {
    const config = this.store.getApiConfig();
    if (!config.baseUrl) {
      throw new UserError("尚未配置 AI 服务地址");
    }
    const apiKey = await this.keyStore.load();
    if (!apiKey) {
      throw new UserError("尚未保存 API Key");
    }
    let baseUrl;
    try {
      baseUrl = normalizeApiBase(config.baseUrl);
    } catch (error) {
      throw error;
    }
    const response = await this.request({
      method: "GET",
      url: `${baseUrl}/models`,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      timeoutMs: 60000,
      maxBytes: MAX_RESPONSE_BYTES
    });
    assertNotRedirect(response.status);
    if (response.status === 401 || response.status === 403) {
      throw new UserError(`API Key 无效或无权访问（HTTP ${response.status}）`);
    }
    if (response.status === 404) {
      throw new UserError("该服务未提供 /models 模型列表接口（HTTP 404）");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new UserError(compat.classifyHttpError(response.status, response.body));
    }
    const models = parseModels(response.body);
    const configuredModel = String(config.model || "").trim();
    return {
      models,
      configuredModel,
      modelListed: Boolean(configuredModel) && models.includes(configuredModel),
      connectionScope: "model-list-only"
    };
  }

  async generate(payload) {
    if (!isPlainObject(payload)) {
      throw new UserError("请求参数格式错误");
    }
    const config = this.store.getApiConfig();
    if (!config.baseUrl) {
      throw new UserError("尚未配置 AI 服务地址");
    }
    if (!config.model) {
      throw new UserError("请先填写模型名称");
    }
    const apiKey = await this.keyStore.load();
    if (!apiKey) {
      throw new UserError("尚未保存 API Key");
    }
    const baseUrl = normalizeApiBase(config.baseUrl);
    const importId = Number(payload.importId);
    if (!Number.isSafeInteger(importId) || importId < 0) {
      throw new UserError("导入资料编号无效");
    }
    const document = this.store.getImport(importId);
    const requestedPages = payload.pageIndexes;
    if (!Array.isArray(requestedPages) || !requestedPages.length) {
      throw new UserError("请选择要发送的页码范围");
    }
    if (requestedPages.length > 50) {
      throw new UserError("一次选择的页面过多");
    }
    const pagesByIndex = new Map();
    for (const page of document.pages || []) {
      pagesByIndex.set(Number(page.pageIndex), page);
    }
    const selectedIndexes = new Set();
    const selected = [];
    let totalChars = 0;
    for (const rawIndex of requestedPages) {
      if (typeof rawIndex !== "number" || !Number.isInteger(rawIndex)) {
        throw new UserError("页码格式错误");
      }
      if (rawIndex < 0 || rawIndex > 100000) {
        throw new UserError("页码超出范围");
      }
      if (selectedIndexes.has(rawIndex)) {
        continue;
      }
      const page = pagesByIndex.get(rawIndex);
      if (!page) {
        throw new UserError("页码范围不在该导入资料中");
      }
      const text = typeof page.text === "string" ? page.text : "";
      if (!text.trim()) {
        throw new UserError("所选页面没有可发送的文字，请检查原文");
      }
      totalChars += text.length;
      if (totalChars > MAX_SOURCE_CHARS) {
        throw new UserError("所选原文超过 12000 字符，请减少范围");
      }
      selectedIndexes.add(rawIndex);
      selected.push({
        pageIndex: rawIndex,
        locator: typeof page.locator === "string" ? page.locator : "",
        text
      });
    }
    if (!selected.length) {
      throw new UserError("没有可发送的原文");
    }
    const maxQuestions = Math.min(10, Math.max(1, Math.round(Number(payload.maxQuestions) || config.maxQuestions || 5)));
    const systemPrompt = buildGenerationSystemPrompt(maxQuestions);
    const userPrompt = compat.buildUserPrompt(document.name || "导入资料", selected, maxQuestions);
    // response_format is the only optional field we send. temperature is omitted
    // because reasoning/thinking models may reject or ignore sampling parameters.
    let includeResponseFormat = true;
    let body = compat.buildChatRequestBody(
      config.model,
      systemPrompt,
      userPrompt,
      includeResponseFormat
    );
    const endpoint = `${baseUrl}/chat/completions`;
    const requestOptions = () => ({
      method: "POST",
      url: endpoint,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${apiKey}`
      },
      body,
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES
    });
    let response = await this.request(requestOptions());
    assertNotRedirect(response.status);
    if (response.status === 400) {
      // Exactly one bounded retry, and only when the provider explicitly rejects
      // response_format. Auth/quota/context/model/unknown 400s never resend.
      const rejected = compat.rejectedOptionalFields(response.body);
      if (includeResponseFormat && rejected.has("response_format")) {
        includeResponseFormat = false;
        body = compat.buildChatRequestBody(
          config.model,
          systemPrompt,
          userPrompt,
          includeResponseFormat
        );
        response = await this.request(requestOptions());
        assertNotRedirect(response.status);
      }
    }
    if (response.status === 401 || response.status === 403) {
      throw new UserError(`API Key 无效或无权访问（HTTP ${response.status}）`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new UserError(compat.classifyHttpError(response.status, response.body));
    }
    return parseGenerated(
      response.body,
      importId,
      document.name || "导入资料",
      selectedIndexes,
      pagesByIndex,
      maxQuestions
    );
  }
}

module.exports = {
  ApiClient,
  parseModels,
  parseGenerated,
  requiredText,
  hasCompleteChoiceOptions,
  normalizeGeneratedType,
  buildGenerationSystemPrompt,
  CHOICE_MISSING_OPTIONS,
  CHOICE_OPTIONS_PROMPT,
  MAX_SOURCE_CHARS,
  MAX_RESPONSE_BYTES
};
