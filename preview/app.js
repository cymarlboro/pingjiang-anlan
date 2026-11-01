(function () {
  "use strict";

  const SCHEMA_VERSION = 2;
  const STORAGE_KEY = "pingjianganlan.preview.v2";
  const LEGACY_STORAGE_KEYS = ["pingjianganlan.preview.v1"];
  const APP_VERSION = "1.0.0";
  const TABS = ["review", "select", "stats", "me"];
  const NATIVE_AVAILABLE = Boolean(
    typeof window !== "undefined" && window.NativeApp && window.NativeApp.hasBridge &&
    typeof window.NativeApp.call === "function"
  );
  const DESKTOP_AVAILABLE = Boolean(NATIVE_AVAILABLE && window.AndroidBridge && window.AndroidBridge.platform === "windows");
  const MAX_IMPORT_CHARS = 12000;
  const MAX_IMPORT_DRAFTS = 10;
  const DRAFT_STORE_KEY = "pingjianganlan.preview.import-drafts.v1";
  const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const ALLOWED_IMPORT_FORMATS = ["pdf", "docx", "md", "html", "txt"];
  const MAX_REFERENCE_BOOKS = 2;
  const GENERATED_STATUSES = ["draft", "needs_figure_review", "needs_source_review"];
  const CHAPTER_INFO = Object.freeze({
    1: {"name": "我国水资源和水利电力建设概况", "aliases": ["绪论", "水资源", "水利建设"]},
    2: {"name": "水库、水利枢纽和水工建筑物", "aliases": ["水库", "特征水位", "库容", "水利枢纽", "水工建筑物", "工程等级"]},
    3: {"name": "挡水建筑物", "aliases": ["重力坝", "拱坝", "土石坝", "面板堆石坝", "防渗", "管涌", "流土"]},
    4: {"name": "泄水建筑物", "aliases": ["泄洪", "溢洪道", "消能", "泄水"]},
    5: {"name": "水闸", "aliases": ["闸室", "铺盖", "护坦", "海漫", "闸基"]},
    6: {"name": "水利枢纽的施工导流", "aliases": ["施工导流", "围堰", "截流", "导流洞"]},
    7: {"name": "防洪", "aliases": ["防汛", "丁坝", "顺坝", "蓄洪", "滞洪", "抢险"]},
    8: {"name": "农田水利", "aliases": ["灌溉", "灌区", "渠道", "水泵", "泵房", "泵站"]},
    9: {"name": "内河航运", "aliases": ["航运", "船闸", "升船机", "鱼道", "过坝"]},
    10: {"name": "水力发电", "aliases": ["水电站", "水轮机", "调压室", "蜗壳", "抽水蓄能"]}
  });
  const CHINESE_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

  const studyData = (typeof window !== "undefined" && window.STUDY_DATA) || {
    sources: [],
    questions: [],
    edition: ""
  };
  const sources = Array.isArray(studyData.sources) ? studyData.sources : [];
  const questions = Array.isArray(studyData.questions) ? studyData.questions : [];
  const sourceById = new Map(sources.map(function (source) { return [source.id, source]; }));
  const questionById = new Map(questions.map(function (question) { return [question.id, question]; }));
  const generatedById = new Map();
  (Array.isArray(typeof window !== "undefined" && window.GENERATED_ANSWERS)
    ? window.GENERATED_ANSWERS
    : []
  ).forEach(function (item) {
    const normalized = normalizeGeneratedAnswer(item);
    if (normalized && !generatedById.has(normalized.question_id)) {
      generatedById.set(normalized.question_id, normalized);
    }
  });
  const questionImages = (typeof window !== "undefined" && window.QUESTION_IMAGES &&
    typeof window.QUESTION_IMAGES === "object") ? window.QUESTION_IMAGES : {};

  const RECALL_BUCKETS = [
    { id: "same-day", label: "同日", min: 0, max: 0, modelT: 0 },
    { id: "one-day", label: "1天", min: 1, max: 1, modelT: 1 },
    { id: "two-three", label: "2–3天", min: 2, max: 3, modelT: 2.5 },
    { id: "four-seven", label: "4–7天", min: 4, max: 7, modelT: 5.5 },
    { id: "eight-plus", label: "8天以上", min: 8, max: Infinity, modelT: 8 }
  ];

  let state = makeDefaultState();
  let currentTab = "review";
  let storageAvailable = true;
  let storageReadWarning = "";
  let toastTimer = null;
  let ratingBusy = false;
  let appScrollElement = null;
  let migrationNotice = "";
  let migratedFromKey = "";
  let needsSchemaRewrite = false;
  let subjectMigrationBlocked = false;
  let activeAnswerEditorId = null;
  let pendingEditorId = null;
  let cloudSyncApplyInProgress = false;
  let selectionFilter = {
    mode: "answerable",
    sourceId: "all",
    chapter: "all",
    query: "",
    shelfOpen: false,
    questionType: "all"
  };

  const nativeMe = {
    loaded: false,
    loading: false,
    reminder: null,
    reminderError: "",
    imports: null,
    importsError: "",
    updateConfig: null,
    updateError: "",
    updateCheck: null,
    updateBusy: false,
    updateBannerDismissed: false,
    appInfo: null,
    appInfoError: "",
    apiConfig: null,
    apiConfigError: ""
  };
  let nativeImportState = loadImportDraftState();
  let nativeRestoreConfirm = false;
  let nativeRestoreBusy = false;
  let nativeExportBusy = false;
  let nativeUpdateOpen = false;
  let draftPersistTimer = null;

  function questionTypeOf(question) {
    const types = window.QuestionTypeSupport;
    return types ? types.getType(question) : "综合题";
  }

  function mixedQuestionIds(count) {
    const types = window.QuestionTypeSupport;
    return types ? types.recommendedPlan(questions, count, function (question) {
      return Boolean(answeredQuestion(question.id));
    }) : getAnswerableQuestions().map(function (q) { return q.id; }).slice(0, count);
  }

  /* ----------------------------------------------------------------------- */
  /* Small utilities                                                         */
  /* ----------------------------------------------------------------------- */

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uniqueIds(values) {
    const seen = new Set();
    const result = [];
    (Array.isArray(values) ? values : []).forEach(function (value) {
      const id = Number(value);
      if (Number.isInteger(id) && !seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    });
    return result;
  }

  function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function hasAnswerText(value) {
    return value !== null && value !== undefined && String(value).trim().length > 0;
  }

  function normalizeGeneratedAnswer(raw) {
    if (!isPlainObject(raw)) {
      return null;
    }
    const id = Number(raw.question_id);
    if (!Number.isInteger(id) || !questionById.has(id) || !hasAnswerText(raw.answer)) {
      return null;
    }
    const status = GENERATED_STATUSES.includes(raw.status) ? raw.status : "needs_source_review";
    const keyPoints = Array.isArray(raw.key_points)
      ? raw.key_points.map(function (point) { return String(point).trim(); }).filter(Boolean)
      : [];
    const references = Array.isArray(raw.references)
      ? raw.references.map(function (reference) {
        if (!isPlainObject(reference)) {
          return null;
        }
        const unitId = Number(reference.unit_id);
        const pdfPage = Number(reference.pdf_page);
        const quote = typeof reference.quote === "string" ? reference.quote.trim() : "";
        if (!Number.isInteger(unitId) || !Number.isInteger(pdfPage) || !quote) {
          return null;
        }
        return { unit_id: unitId, pdf_page: pdfPage, quote: quote };
      }).filter(Boolean)
      : [];
    return {
      question_id: id,
      answer: String(raw.answer),
      key_points: keyPoints,
      status: status,
      references: references,
      caveat: typeof raw.caveat === "string" ? raw.caveat : ""
    };
  }

  function getBaseAnswerData(question) {
    if (!question) {
      return { text: "", source: "none", originalText: "", generated: null };
    }
    const originalText = hasAnswerText(question.answer) ? String(question.answer) : "";
    const generated = generatedById.get(Number(question.id)) || null;
    const generatedText = generated && hasAnswerText(generated.answer) ? String(generated.answer) : "";
    if (originalText) {
      return { text: originalText, source: "original", originalText: originalText, generated: generated };
    }
    if (generatedText) {
      return { text: generatedText, source: "generated", originalText: "", generated: generated };
    }
    return { text: "", source: "none", originalText: "", generated: generated };
  }

  function getAnswerData(question, editsOverride) {
    const base = getBaseAnswerData(question);
    const edits = editsOverride && isPlainObject(editsOverride)
      ? editsOverride
      : (state && isPlainObject(state.answerEdits) ? state.answerEdits : {});
    const rawEdit = question ? edits[String(question.id)] : null;
    const editText = isPlainObject(rawEdit) && hasAnswerText(rawEdit.text) ? String(rawEdit.text) : "";
    const currentText = editText || base.text;
    let source = base.source;
    if (editText) {
      source = "edit";
    } else if (!currentText) {
      source = "none";
    }
    return {
      text: currentText,
      source: source,
      originalText: base.originalText,
      baseText: base.text,
      baseSource: base.source,
      generated: base.generated,
      edit: editText ? rawEdit : null,
      hasEdit: Boolean(editText),
      status: base.generated ? base.generated.status : null,
      references: base.generated ? base.generated.references : [],
      keyPoints: base.generated ? base.generated.key_points : [],
      caveat: base.generated ? base.generated.caveat : "",
      isAnswerable: Boolean(currentText && currentText.trim())
    };
  }

  function isAnswerable(question, editsOverride) {
    return Boolean(question) && getAnswerData(question, editsOverride).isAnswerable;
  }

  function answeredQuestion(id, editsOverride) {
    const question = questionById.get(Number(id));
    return isAnswerable(question, editsOverride) ? question : null;
  }

  function getAnswerableQuestions(editsOverride) {
    return questions.filter(function (question) {
      return isAnswerable(question, editsOverride);
    });
  }

  function getPendingQuestions(editsOverride) {
    return questions.filter(function (question) {
      return !isAnswerable(question, editsOverride);
    });
  }

  function getGeneratedSummary() {
    const summary = { total: 0, draft: 0, needs_figure_review: 0, needs_source_review: 0 };
    generatedById.forEach(function (item) {
      summary.total += 1;
      summary[item.status] = (summary[item.status] || 0) + 1;
    });
    return summary;
  }

  function generatedStatusLabel(status) {
    if (status === "needs_figure_review") {
      return "需核图";
    }
    if (status === "needs_source_review") {
      return "需核来源";
    }
    return "待核对";
  }

  function answerStatusBadge(answerData) {
    if (answerData.hasEdit) {
      return { text: "我的修订", className: "is-edit" };
    }
    if (answerData.source === "original") {
      return { text: "题库原答案", className: "is-original" };
    }
    if (answerData.generated) {
      return {
        text: "DSH初稿 · " + generatedStatusLabel(answerData.generated.status),
        className: answerData.generated.status === "draft"
          ? "is-draft"
          : answerData.generated.status === "needs_figure_review"
            ? "is-figure"
            : "is-source"
      };
    }
    return { text: "待补答案", className: "is-pending" };
  }

  function cleanQuestionText(value) {
    return String(value || "")
      .replace(/\[配图：[^\]]*\]/gi, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function parseChineseNumber(value) {
    const text = String(value || "").trim();
    if (!text) {
      return null;
    }
    if (/^\d+$/.test(text)) {
      return Number(text);
    }
    if (text === "十") {
      return 10;
    }
    const tenIndex = text.indexOf("十");
    if (tenIndex >= 0) {
      const tensPart = text.slice(0, tenIndex);
      const onesPart = text.slice(tenIndex + 1);
      const tens = tensPart ? CHINESE_DIGITS[tensPart] : 1;
      const ones = onesPart ? CHINESE_DIGITS[onesPart] : 0;
      if (tens === undefined || ones === undefined) {
        return null;
      }
      return tens * 10 + ones;
    }
    if (CHINESE_DIGITS[text] !== undefined) {
      return CHINESE_DIGITS[text];
    }
    return null;
  }

  function parseChapterReference(token) {
    const text = String(token || "").replace(/\s+/g, "");
    let match = text.match(/^第?(\d+)章$/);
    if (match) {
      return Number(match[1]);
    }
    match = text.match(/^第?([一二三四五六七八九十]+)章$/);
    if (match) {
      return parseChineseNumber(match[1]);
    }
    return null;
  }

  function chapterNumbersFor(chapter) {
    return Array.from(new Set((String(chapter || "").match(/\d+/g) || []).map(Number)))
      .filter(function (number) { return Number.isFinite(number); });
  }

  function chapterNamesFor(chapter) {
    const names = [];
    chapterNumbersFor(chapter).forEach(function (number) {
      const info = CHAPTER_INFO[number];
      if (info) {
        [info.name].concat(info.aliases).forEach(function (name) {
          if (!names.includes(name)) {
            names.push(name);
          }
        });
      }
    });
    return names;
  }

  function chapterSearchText(chapter) {
    return [String(chapter || "")].concat(chapterNamesFor(chapter)).join(" ");
  }

  function splitSearchTokens(query) {
    return String(query || "").trim().toLowerCase().split(/[\s\u3000]+/).filter(Boolean);
  }

  // 题干与章节多关键词 AND 搜索；支持“第3章”“第三章”“3章”和章节名别名。
  function matchesQuestionSearch(question, query) {
    if (!question) {
      return false;
    }
    const tokens = splitSearchTokens(query);
    if (!tokens.length) {
      return true;
    }
    const chapter = String(question.chapter || "");
    const chapterNumbers = chapterNumbersFor(chapter);
    const haystack = (cleanQuestionText(question.question) + " " +
      String(question.chapter || "") + " " + chapterSearchText(chapter)).toLowerCase();
    return tokens.every(function (token) {
      const chapterNumber = parseChapterReference(token);
      if (chapterNumber !== null) { return chapterNumbers.includes(chapterNumber); }
      if (haystack.includes(token)) { return true; }
      if (chapterNumber !== null && chapterNumbers.includes(chapterNumber)) {
        return true;
      }
      const embedded = token.match(/^(第?\d+章|第?[一二三四五六七八九十]+章)(.+)$/);
      if (embedded) {
        const embeddedNumber = parseChapterReference(embedded[1]);
        if (embeddedNumber !== null && chapterNumbers.includes(embeddedNumber) &&
            haystack.includes(embedded[2])) {
          return true;
        }
      }
      return false;
    });
  }

  function getQuestionImageSourceList(questionId) {
    const images = questionImages[String(questionId)];
    if (!Array.isArray(images)) {
      return [];
    }
    return images.filter(function (source) {
      return typeof source === "string" && /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(source);
    });
  }

  function getSourceName(question) {
    if (question && question.source_name) {
      return String(question.source_name);
    }
    const source = question ? sourceById.get(question.source_id) : null;
    return source ? String(source.name) : "来源名称待核对";
  }

  function getLocatorLabel(question) {
    if (!question || !question.locator) {
      return "练习出处未标注";
    }
    if (question.locator === "LECTURE") {
      return "LECTURE · 课堂讲义（练习出处）";
    }
    return String(question.locator);
  }

  function extensionOf(name) {
    const match = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "";
  }

  function makeId(prefix) {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return prefix + "-" + crypto.randomUUID();
    }
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function formatFileSize(bytes) {
    const number = Number(bytes);
    if (!Number.isFinite(number) || number < 0) {
      return "大小未知";
    }
    if (number < 1024) {
      return number + " B";
    }
    if (number < 1024 * 1024) {
      return Math.round(number / 102.4) / 10 + " KB";
    }
    return Math.round(number / (1024 * 1024) * 10) / 10 + " MB";
  }

  /* ----------------------------------------------------------------------- */
  /* Local date helpers. Day keys never use UTC.                             */
  /* ----------------------------------------------------------------------- */

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function localDateKey(date) {
    const value = date instanceof Date ? date : new Date();
    return value.getFullYear() + "-" + pad2(value.getMonth() + 1) + "-" + pad2(value.getDate());
  }

  function todayKey() {
    return localDateKey(new Date());
  }

  function isDateKey(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }
    const parts = value.split("-").map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
    return date.getFullYear() === parts[0] && date.getMonth() === parts[1] - 1 &&
      date.getDate() === parts[2];
  }

  function dateFromKey(key) {
    const parts = String(key).split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
  }

  function addDays(key, amount) {
    const date = dateFromKey(key);
    date.setDate(date.getDate() + Number(amount || 0));
    return localDateKey(date);
  }

  function dayOrdinal(key) {
    // Compare local calendar days at noon so daylight-saving shifts do not
    // turn one day into 23 or 25 hours. This still uses local day boundaries.
    const date = dateFromKey(key);
    const epoch = new Date(1970, 0, 1, 12, 0, 0, 0);
    return Math.round((date.getTime() - epoch.getTime()) / 86400000);
  }

  function daysBetweenKeys(fromKey, toKey) {
    return dayOrdinal(toKey) - dayOrdinal(fromKey);
  }

  function formatDateKey(key, withYear) {
    const date = dateFromKey(key);
    if (withYear) {
      return date.getFullYear() + "." + pad2(date.getMonth() + 1) + "." + pad2(date.getDate());
    }
    return (date.getMonth() + 1) + "月" + date.getDate() + "日";
  }

  function formatShortDate(key) {
    const date = dateFromKey(key);
    return (date.getMonth() + 1) + "/" + date.getDate();
  }

  function dateHeading(key) {
    const date = dateFromKey(key);
    return (date.getMonth() + 1) + "月" + date.getDate() + "日 " + WEEKDAYS[date.getDay()];
  }

  function formatSavedAt(isoValue, fallbackDate) {
    const date = isoValue ? new Date(isoValue) : null;
    if (date && !Number.isNaN(date.getTime())) {
      return date.getFullYear() + "." + pad2(date.getMonth() + 1) + "." + pad2(date.getDate()) +
        " " + pad2(date.getHours()) + ":" + pad2(date.getMinutes());
    }
    if (isDateKey(fallbackDate)) {
      return formatDateKey(fallbackDate, true);
    }
    return "时间待核对";
  }

  function isoNow() {
    return new Date().toISOString();
  }

  function lastSevenKeys() {
    const today = todayKey();
    const result = [];
    for (let index = 6; index >= 0; index -= 1) {
      result.push(addDays(today, -index));
    }
    return result;
  }

  /* ----------------------------------------------------------------------- */
  /* State and persistence                                                   */
  /* ----------------------------------------------------------------------- */

  function makeDefaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      settings: {
        dailyTarget: 10,
        accountName: "水利同学",
        reminder: {
          enabled: false,
          time: "20:30"
        }
      },
      referenceIds: [],
      selectedIds: [],
      answerEdits: {},
      session: null,
      history: [],
      imports: [],
      schedule: {},
      lastUpdated: null
    };
  }

  function normalizeSettings(raw) {
    const defaults = makeDefaultState().settings;
    const value = isPlainObject(raw) ? raw : {};
    const reminder = isPlainObject(value.reminder) ? value.reminder : {};
    const account = typeof value.accountName === "string" ? value.accountName.trim().slice(0, 24) : "";
    const reminderTime = typeof reminder.time === "string" && /^\d{2}:\d{2}$/.test(reminder.time)
      ? reminder.time
      : defaults.reminder.time;
    return {
      dailyTarget: clampInteger(value.dailyTarget, 1, Math.max(1, questions.length), defaults.dailyTarget),
      accountName: (account === "山川同学" ? defaults.accountName : account) || defaults.accountName,
      reminder: {
        enabled: Boolean(reminder.enabled),
        time: reminderTime
      }
    };
  }

  function normalizeAnswerEdits(raw) {
    if (!isPlainObject(raw)) {
      return {};
    }
    const edits = {};
    Object.keys(raw).forEach(function (key) {
      const id = Number(key);
      const question = questionById.get(id);
      const item = raw[key];
      if (!question || !isPlainObject(item) || !hasAnswerText(item.text)) {
        return;
      }
      const at = typeof item.updatedAt === "string" && item.updatedAt ? item.updatedAt : "";
      const parsed = at ? new Date(at) : new Date();
      const fallbackDate = Number.isNaN(parsed.getTime()) ? todayKey() : localDateKey(parsed);
      edits[String(id)] = {
        text: String(item.text),
        updatedAt: at,
        updatedDate: isDateKey(item.updatedDate) ? item.updatedDate : fallbackDate
      };
    });
    return edits;
  }

  function normalizeHistoryEntry(raw) {
    if (!isPlainObject(raw)) {
      return null;
    }
    const question = questionById.get(Number(raw.id));
    if (!question) {
      return null;
    }
    if (raw.rating !== "known" && raw.rating !== "forgot") {
      return null;
    }
    const date = isDateKey(raw.date) ? raw.date : "";
    if (!date) {
      return null;
    }
    return {
      id: question.id,
      date: date,
      at: typeof raw.at === "string" ? raw.at : "",
      rating: raw.rating,
      chapter: question.chapter,
      source_id: question.source_id
    };
  }

  function normalizeImport(raw) {
    if (!isPlainObject(raw)) {
      return null;
    }
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 240) : "";
    if (!name) {
      return null;
    }
    const format = ALLOWED_IMPORT_FORMATS.includes(String(raw.format || "").toLowerCase())
      ? String(raw.format).toLowerCase()
      : extensionOf(name);
    if (!ALLOWED_IMPORT_FORMATS.includes(format)) {
      return null;
    }
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : makeId("import"),
      name: name,
      format: format,
      size: Number.isFinite(Number(raw.size)) && Number(raw.size) >= 0 ? Number(raw.size) : null,
      registeredAt: typeof raw.registeredAt === "string" ? raw.registeredAt : "",
      registeredDate: isDateKey(raw.registeredDate) ? raw.registeredDate : todayKey(),
      status: "registered",
      parseStatus: "pending_install"
    };
  }

  function normalizeScheduleEntry(raw) {
    if (!isPlainObject(raw)) {
      return null;
    }
    const scheduler = typeof window !== "undefined" ? window.MemoryScheduler : null;
    if (scheduler && typeof scheduler.migrateLegacyEntry === "function") {
      return scheduler.migrateLegacyEntry(raw);
    }
    return {
      stability: Math.min(365, Math.max(0.5, Number(raw.stability) || 1)),
      knownCount: Math.max(0, Math.round(Number(raw.knownCount) || 0)),
      lapses: Math.max(0, Math.round(Number(raw.lapses) || 0)),
      nextDue: isDateKey(raw.nextDue) ? raw.nextDue : (isDateKey(raw.dueDate) ? raw.dueDate : null),
      forcedDueDate: isDateKey(raw.forcedDueDate) ? raw.forcedDueDate : null,
      lastReviewedAt: typeof raw.lastReviewedAt === "string" ? raw.lastReviewedAt : "",
      lastGrowthAt: typeof raw.lastGrowthAt === "string" ? raw.lastGrowthAt : "",
      lastForgotDate: isDateKey(raw.lastForgotDate) ? raw.lastForgotDate : null,
      lastSuccessDate: isDateKey(raw.lastSuccessDate) ? raw.lastSuccessDate : null,
      lastRating: raw.lastRating === "known" || raw.lastRating === "forgot" ? raw.lastRating : null,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
      legacy: Boolean(raw.legacy)
    };
  }

  function normalizeSession(raw, editsOverride) {
    if (!isPlainObject(raw)) {
      return null;
    }
    const planIds = uniqueIds(raw.planIds).filter(function (id) {
      return Boolean(answeredQuestion(id, editsOverride));
    });
    if (!planIds.length) {
      return null;
    }
    const mandatoryIds = uniqueIds(raw.mandatoryIds).filter(function (id) {
      return planIds.includes(id);
    });
    const cards = {};
    if (isPlainObject(raw.cards)) {
      planIds.forEach(function (id) {
        const card = raw.cards[String(id)] || raw.cards[id];
        if (!isPlainObject(card)) {
          return;
        }
        cards[String(id)] = {
          attempts: Math.max(0, Math.round(Number(card.attempts) || 0)),
          lastRating: card.lastRating === "known" || card.lastRating === "forgot" ? card.lastRating : null,
          forgotten: Boolean(card.forgotten),
          lastAt: typeof card.lastAt === "string" ? card.lastAt : ""
        };
      });
    }
    const queue = uniqueIds(raw.queue).filter(function (id) { return planIds.includes(id); });
    const relearn = [];
    if (Array.isArray(raw.relearn)) {
      const seenRelearn = new Set();
      raw.relearn.forEach(function (item) {
        if (!isPlainObject(item)) {
          return;
        }
        const id = Number(item.id);
        if (!planIds.includes(id) || seenRelearn.has(id)) {
          return;
        }
        seenRelearn.add(id);
        relearn.push({
          id: id,
          remaining: clampInteger(item.remaining, 1, 3, 3)
        });
      });
    }
    let currentId = Number(raw.currentId);
    if (!planIds.includes(currentId)) {
      currentId = queue.length ? queue.shift() : null;
    }
    let completed = Boolean(raw.completed);
    if (!completed && !currentId && !queue.length && !relearn.length) {
      completed = true;
    }
    if (completed) {
      currentId = null;
      queue.length = 0;
      relearn.length = 0;
    } else if (!currentId && !queue.length && relearn.length) {
      currentId = relearn.shift().id;
    }
    if (currentId) {
      const currentIndex = relearn.findIndex(function (item) { return item.id === currentId; });
      if (currentIndex >= 0) {
        relearn.splice(currentIndex, 1);
      }
    }
    const date = isDateKey(raw.date) ? raw.date : todayKey();
    const target = Math.max(
      mandatoryIds.length,
      clampInteger(raw.target, 1, Math.max(1, questions.length), planIds.length)
    );
    return {
      date: date,
      target: target,
      planIds: planIds,
      mandatoryIds: mandatoryIds,
      queue: queue,
      currentId: currentId,
      revealed: completed ? false : Boolean(raw.revealed),
      completed: completed,
      completedAt: typeof raw.completedAt === "string" ? raw.completedAt : "",
      cards: cards,
      relearn: relearn,
      forgottenIds: uniqueIds(raw.forgottenIds).filter(function (id) { return planIds.includes(id); }),
      waitingRelearn: completed ? false : Boolean(raw.waitingRelearn),
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
      gapWarning: Boolean(raw.gapWarning)
    };
  }

  function normalizeState(raw) {
    const defaults = makeDefaultState();
    if (!isPlainObject(raw)) {
      return defaults;
    }
    const referenceIds = uniqueIds(raw.referenceIds).filter(function (id) {
      return sourceById.has(id);
    }).slice(0, MAX_REFERENCE_BOOKS);
    const answerEdits = normalizeAnswerEdits(raw.answerEdits);
    const selectedIds = uniqueIds(raw.selectedIds).filter(function (id) {
      return Boolean(answeredQuestion(id, answerEdits));
    });
    const history = (Array.isArray(raw.history) ? raw.history : [])
      .map(normalizeHistoryEntry)
      .filter(Boolean);
    const imports = (Array.isArray(raw.imports) ? raw.imports : [])
      .map(normalizeImport)
      .filter(Boolean);
    const schedule = {};
    if (isPlainObject(raw.schedule)) {
      Object.keys(raw.schedule).forEach(function (key) {
        const id = Number(key);
        if (!answeredQuestion(id, answerEdits)) {
          return;
        }
        const entry = normalizeScheduleEntry(raw.schedule[key]);
        if (entry) {
          schedule[String(id)] = entry;
        }
      });
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      settings: normalizeSettings(raw.settings),
      referenceIds: referenceIds,
      selectedIds: selectedIds,
      answerEdits: answerEdits,
      session: normalizeSession(raw.session, answerEdits),
      history: history,
      imports: imports,
      schedule: schedule,
      lastUpdated: typeof raw.lastUpdated === "string" ? raw.lastUpdated : null
    };
  }

  function archivePreviousSubject(storage, found) {
    if (studyData.bankId !== "hydraulic-engineering-2026") { return; }
    const marker = "pingjianganlan.subject-migration.v1";
    if (storage.getItem(marker)) { return; }
    const raw = storage.getItem(found.key);
    const archiveKey = "pingjianganlan.archive.natural-geography.v1";
    const previous = found.parsed;
    const oldBaseId = function (id) { return Number(id) >= 1 && Number(id) <= 310; };
    const legacySubject = (previous.selectedIds || []).some(oldBaseId) ||
      Object.keys(previous.schedule || {}).some(oldBaseId) ||
      Object.keys(previous.answerEdits || {}).some(oldBaseId) ||
      (previous.history || []).some(function (entry) { return entry && oldBaseId(entry.id); }) ||
      Boolean(previous.settings && previous.settings.accountName === "山川同学");
    if (raw && legacySubject && !storage.getItem(archiveKey)) {
      storage.setItem(archiveKey, raw);
      if (storage.getItem(archiveKey) !== raw) { throw new Error("subject archive failed"); }
    }
    storage.setItem(marker, "hydraulic-engineering-2026");
    migrationNotice = legacySubject ? "已切换水利工程概论题库。原地理学习记录已在本机归档，个人设置、API设置与私有导入保留；新题从独立进度开始。" : "已加载水利工程概论题库，个人设置与已有水利学习进度继续保留。";
    needsSchemaRewrite = true;
  }

  function loadState() {
    try {
      const storage = window.localStorage;
      const candidateKeys = [STORAGE_KEY].concat(LEGACY_STORAGE_KEYS);
      let parseFailed = false;
      let found = null;
      for (const key of candidateKeys) {
        const raw = storage.getItem(key);
        if (!raw) {
          continue;
        }
        try {
          const parsed = JSON.parse(raw);
          if (!isPlainObject(parsed)) {
            throw new Error("invalid state");
          }
          found = { key: key, parsed: parsed };
          break;
        } catch (error) {
          parseFailed = true;
        }
      }
      if (!found) {
        if (parseFailed) {
          storageReadWarning = "本机学习记录无法读取，已采用新的临时数据；原有内容没有被覆盖。";
        }
        return makeDefaultState();
      }
      if (found.key !== STORAGE_KEY) {
        migratedFromKey = found.key;
        needsSchemaRewrite = true;
        migrationNotice = "已从旧版本迁移本机学习记录，原有设置、日计划、历史与导入登记已保留。";
      } else if (found.parsed.schemaVersion !== SCHEMA_VERSION) {
        needsSchemaRewrite = true;
        storageReadWarning = "检测到旧版记录，已兼容读取并保留现有内容。";
      }
      try { archivePreviousSubject(storage, found); }
      catch (error) {
        subjectMigrationBlocked = true;
        storageAvailable = false;
        storageReadWarning = "旧学科学习记录归档失败，本次仅临时使用水利题库，原记录不覆盖。请释放存储空间后重新打开。";
        return normalizeState(found.parsed);
      }
      return normalizeState(found.parsed);
    } catch (error) {
      storageAvailable = false;
      storageReadWarning = "浏览器阻止了本机存储，本次更改只会保留在当前页面。";
      return makeDefaultState();
    }
  }

  function saveState(options) {
    if (subjectMigrationBlocked) { updateStorageWarning(); return false; }
    if (!options || options.preserveUpdatedAt !== true) {
      state.lastUpdated = isoNow();
    }
    let saved = true;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageAvailable = true;
    } catch (error) {
      storageAvailable = false;
      saved = false;
      storageReadWarning = "本机存储写入失败，本次更改只会保留在当前页面。";
    }
    updateStorageWarning();
    // 云端同步应用状态时不要再触发上传；其余有意义的保存会进入防抖同步。
    if (!cloudSyncApplyInProgress && typeof window !== "undefined" &&
        window.StudyCloudSync &&
        typeof window.StudyCloudSync.notifyStateChanged === "function") {
      window.StudyCloudSync.notifyStateChanged();
    }
    return saved;
  }

  function updateStorageWarning() {
    if (typeof document === "undefined") {
      return;
    }
    const warning = document.getElementById("storage-warning");
    if (!warning) {
      return;
    }
    const text = storageReadWarning || (!storageAvailable
      ? "本机存储不可用，本次更改只会保留在当前页面。"
      : "");
    warning.textContent = text;
    warning.hidden = !text;
  }

  /* ----------------------------------------------------------------------- */
  /* Study scheduling and plan construction                                  */
  /* ----------------------------------------------------------------------- */

  function hasForgottenToday(id, dayKey) {
    const key = dayKey || todayKey();
    return state.history.some(function (entry) {
      return entry.id === Number(id) && entry.date === key && entry.rating === "forgot";
    });
  }

  function getActiveForgottenIds(dayKey) {
    const key = dayKey || todayKey();
    const lastRating = {};
    state.history.forEach(function (entry) {
      if (entry.date === key && answeredQuestion(entry.id)) {
        lastRating[String(entry.id)] = entry.rating;
      }
    });
    return Object.keys(lastRating).filter(function (id) {
      return lastRating[id] === "forgot";
    }).map(Number);
  }

  function getScheduledDueIds(dayKey) {
    const key = dayKey || todayKey();
    const scheduler = typeof window !== "undefined" ? window.MemoryScheduler : null;
    const entries = Object.keys(state.schedule).map(function (id) {
      return Object.assign({ id: Number(id) }, state.schedule[id]);
    }).filter(function (entry) {
      return Boolean(answeredQuestion(entry.id));
    });
    if (scheduler && typeof scheduler.dueEntries === "function") {
      return scheduler.dueEntries(entries, dateFromKey(key)).map(function (entry) {
        return Number(entry.id);
      });
    }
    return entries.filter(function (entry) {
      return Boolean(entry.nextDue && entry.nextDue <= key);
    }).sort(function (a, b) {
      if (a.nextDue !== b.nextDue) {
        return a.nextDue < b.nextDue ? -1 : 1;
      }
      return Number(a.id) - Number(b.id);
    }).map(function (entry) {
      return Number(entry.id);
    });
  }

  function getMandatoryIdsForPlan(dayKey) {
    return uniqueIds(getScheduledDueIds(dayKey).concat(getActiveForgottenIds(dayKey)))
      .filter(function (id) { return Boolean(answeredQuestion(id)); });
  }

  function advanceRelearnCounters(relearn, answeredId) {
    const remaining = [];
    const dueIds = [];
    (Array.isArray(relearn) ? relearn : []).forEach(function (item) {
      if (!isPlainObject(item) || !answeredQuestion(item.id)) {
        return;
      }
      const id = Number(item.id);
      if (id === Number(answeredId)) {
        return;
      }
      const left = Math.max(0, Number(item.remaining) || 0) - 1;
      if (left <= 0) {
        if (!dueIds.includes(id)) {
          dueIds.push(id);
        }
      } else {
        remaining.push({ id: id, remaining: left });
      }
    });
    return { relearn: remaining, dueIds: dueIds };
  }

  function createSession(planIds, mandatoryIds, target) {
    const ids = uniqueIds(planIds).filter(function (id) { return Boolean(answeredQuestion(id)); });
    const mandatory = uniqueIds(mandatoryIds).filter(function (id) { return ids.includes(id); });
    const today = todayKey();
    return {
      date: today,
      target: Math.max(
        ids.length,
        clampInteger(target, 1, Math.max(1, questions.length), 10),
        mandatory.length
      ),
      planIds: ids,
      mandatoryIds: mandatory,
      queue: ids.slice(1),
      currentId: ids.length ? ids[0] : null,
      revealed: false,
      completed: ids.length === 0,
      completedAt: ids.length === 0 ? isoNow() : "",
      cards: {},
      relearn: [],
      forgottenIds: [],
      waitingRelearn: false,
      startedAt: isoNow(),
      gapWarning: false
    };
  }

  function getAnswerableLimit() {
    return Math.max(1, getAnswerableQuestions().length);
  }

  function trimOptionalSelection(preview) {
    const optional = uniqueIds(state.selectedIds).filter(function (id) {
      return Boolean(answeredQuestion(id)) && !preview.mandatory.includes(id);
    }).slice(0, Math.max(0, preview.effectiveTarget - preview.mandatory.length));
    state.selectedIds = optional;
    return optional;
  }

  function getPlanPreview() {
    const target = clampInteger(state.settings.dailyTarget, 1, getAnswerableLimit(), 10);
    const mandatory = getMandatoryIdsForPlan();
    const effectiveTarget = Math.max(target, mandatory.length);
    const optional = uniqueIds(state.selectedIds).filter(function (id) {
      return Boolean(answeredQuestion(id)) && !mandatory.includes(id);
    }).slice(0, Math.max(0, effectiveTarget - mandatory.length));
    return {
      target: target,
      effectiveTarget: effectiveTarget,
      mandatory: mandatory,
      optional: optional,
      total: mandatory.length + optional.length,
      answerableCount: getAnswerableQuestions().length
    };
  }

  function ensureTodaySession() {
    const today = todayKey();
    if (state.session && state.session.date === today) {
      createMissingQueueEntry();
      return;
    }
    const answerableIds = mixedQuestionIds(getAnswerableQuestions().length);
    const target = clampInteger(state.settings.dailyTarget, 1, Math.max(1, answerableIds.length), 10);
    const mandatory = getMandatoryIdsForPlan(today);
    const capacity = Math.max(0, target - mandatory.length);
    let optional = uniqueIds(state.selectedIds).filter(function (id) {
      const entry = state.schedule[String(id)];
      return Boolean(answeredQuestion(id)) && !mandatory.includes(id) &&
        (!entry || !entry.nextDue || entry.nextDue <= today);
    }).slice(0, capacity);
    if (optional.length < capacity) {
      answerableIds.forEach(function (id) {
        if (optional.length >= capacity) {
          return;
        }
        if (!mandatory.includes(id) && !optional.includes(id)) {
          const entry = state.schedule[String(id)];
          if (entry && entry.nextDue && entry.nextDue > today) {
            return;
          }
          optional.push(id);
        }
      });
    }
    if (!mandatory.length && !optional.length) {
      optional = answerableIds.filter(function (id) {
        const entry = state.schedule[String(id)];
        return !entry || !entry.nextDue || entry.nextDue <= today;
      }).slice(0, target);
    }
    state.selectedIds = optional;
    state.session = createSession(mandatory.concat(optional), mandatory, target);
    saveState();
  }

  function createMissingQueueEntry() {
    const session = state.session;
    if (!session || session.completed) {
      return;
    }
    if (!session.currentId && session.queue.length) {
      session.currentId = session.queue.shift();
    }
  }

  function updateScheduleAfterReview(id, rating, now) {
    const scheduler = typeof window !== "undefined" ? window.MemoryScheduler : null;
    if (!scheduler || typeof scheduler.applyReview !== "function") {
      throw new Error("MemoryScheduler 未加载");
    }
    const date = now instanceof Date ? now : new Date(now);
    const key = String(id);
    const today = localDateKey(date);
    let existing = state.schedule[key] ? clone(state.schedule[key]) : null;
    // 兼容旧记录：历史里今天已遗忘，但旧 schedule 没有 lastForgotDate。
    // 只补日期字段，不重复削减 stability 或 lapses。
    if (hasForgottenToday(id, today)) {
      if (!existing) {
        const forgottenTodayCount = state.history.filter(function (entry) {
          return entry.id === Number(id) && entry.date === today && entry.rating === "forgot";
        }).length;
        existing = {
          stability: 0.5,
          knownCount: 0,
          lapses: Math.max(0, forgottenTodayCount - (rating === "forgot" ? 1 : 0)),
          nextDue: null,
          forcedDueDate: null,
          lastReviewedAt: "",
          lastGrowthAt: "",
          lastForgotDate: today,
          lastSuccessDate: null,
          lastRating: "forgot",
          updatedAt: "",
          legacy: true
        };
      } else {
        existing.lastForgotDate = today;
      }
    }
    const next = scheduler.applyReview(existing, rating, date);
    state.schedule[key] = next;
    return next;
  }

  function scheduleSummaryFor(questionId) {
    const entry = state.schedule[String(questionId)];
    if (!entry) {
      return null;
    }
    return {
      nextDue: entry.nextDue,
      stability: entry.stability,
      forcedDueDate: entry.forcedDueDate,
      legacy: Boolean(entry.legacy)
    };
  }

  function advanceSession() {
    const session = state.session;
    if (!session) {
      return;
    }
    session.revealed = false;
    session.waitingRelearn = false;
    if (session.queue.length) {
      session.currentId = session.queue.shift();
      session.gapWarning = false;
      return;
    }
    const deferred = Array.isArray(session.relearn) ? session.relearn.shift() : null;
    if (deferred) {
      session.currentId = deferred.id;
      session.waitingRelearn = true;
      session.gapWarning = true;
      return;
    }
    const activeInPlan = getActiveForgottenIds().filter(function (id) {
      return session.planIds.includes(id);
    });
    if (activeInPlan.length) {
      session.currentId = activeInPlan[0];
      session.waitingRelearn = true;
      session.gapWarning = true;
      return;
    }
    session.currentId = null;
    session.completed = true;
    session.completedAt = isoNow();
  }

  /* ----------------------------------------------------------------------- */
  /* DOM helpers                                                             */
  /* ----------------------------------------------------------------------- */

  function appendChildren(node, children) {
    const list = Array.isArray(children) ? children.flat(Infinity) : [children];
    list.forEach(function (child) {
      if (child === null || child === undefined || child === false) {
        return;
      }
      if (typeof child === "string" || typeof child === "number") {
        node.appendChild(document.createTextNode(String(child)));
      } else if (child instanceof Node) {
        node.appendChild(child);
      }
    });
  }

  function el(tag, attributes, children) {
    const node = document.createElement(tag);
    if (attributes) {
      Object.keys(attributes).forEach(function (key) {
        const value = attributes[key];
        if (value === null || value === undefined || value === false) {
          return;
        }
        if (key === "class") {
          node.className = String(value);
        } else if (key === "text") {
          node.textContent = String(value);
        } else if (key === "value") {
          node.value = value;
        } else if (key === "checked" || key === "disabled" || key === "hidden" || key === "open") {
          node[key] = Boolean(value);
        } else if (key === "selected") {
          node.selected = Boolean(value);
        } else if (key === "dataset") {
          Object.keys(value).forEach(function (dataKey) {
            node.dataset[dataKey] = String(value[dataKey]);
          });
        } else if (key === "style") {
          node.setAttribute("style", String(value));
        } else {
          node.setAttribute(key, value === true ? "" : String(value));
        }
      });
    }
    appendChildren(node, children || []);
    return node;
  }

  function svgEl(tag, attributes, children) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (attributes) {
      Object.keys(attributes).forEach(function (key) {
        const value = attributes[key];
        if (value === null || value === undefined || value === false) {
          return;
        }
        if (key === "text") {
          node.textContent = String(value);
        } else {
          node.setAttribute(key, String(value));
        }
      });
    }
    appendChildren(node, children || []);
    return node;
  }

  function clearNode(node) {
    if (!node) {
      return;
    }
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function showToast(message) {
    if (typeof document === "undefined") {
      return;
    }
    const toast = document.getElementById("toast");
    if (!toast) {
      return;
    }
    toast.textContent = String(message);
    toast.hidden = false;
    if (toastTimer) {
      window.clearTimeout(toastTimer);
    }
    toastTimer = window.setTimeout(function () {
      toast.hidden = true;
    }, 3600);
  }

  function starSvg() {
    return svgEl("svg", {
      viewBox: "0 0 20 20",
      "aria-hidden": "true",
      focusable: "false"
    }, [
      svgEl("path", {
        d: "M10 2.4l2.25 4.56 5.03.73-3.64 3.55.86 5.01L10 13.88l-4.5 2.37.86-5.01L2.72 7.69l5.03-.73z",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "1.4",
        "stroke-linejoin": "round"
      })
    ]);
  }

  function searchSvg() {
    return svgEl("svg", {
      class: "search-mark",
      viewBox: "0 0 20 20",
      "aria-hidden": "true",
      focusable: "false"
    }, [
      svgEl("circle", {
        cx: "8.6",
        cy: "8.6",
        r: "5.2",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "1.5"
      }),
      svgEl("path", {
        d: "M12.6 12.6l4 4",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "1.5",
        "stroke-linecap": "round"
      })
    ]);
  }

  function contourSvg() {
    return svgEl("svg", {
      class: "contour",
      viewBox: "0 0 220 104",
      role: "img",
      "aria-labelledby": "contour-title contour-desc",
      focusable: "false"
    }, [
      svgEl("title", { id: "contour-title", text: "山脊与河谷等高线" }),
      svgEl("desc", { id: "contour-desc", text: "细线绘制的山脊、谷地与河流轮廓，用作页头纹理。" }),
      svgEl("g", {
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "0.9",
        "stroke-linecap": "round",
        "stroke-linejoin": "round"
      }, [
        svgEl("path", { d: "M5 83c17-4 25-16 35-31 9-14 21-22 35-18 11 3 15 15 27 19 17 6 31-13 44-13 18 0 29 17 45 19 10 1 17-3 24-8" }),
        svgEl("path", { d: "M3 91c19-3 31-15 42-32 10-16 22-27 37-24 12 2 17 16 29 21 17 7 29-8 42-8 20 0 31 19 48 22 8 1 14-1 19-5" }),
        svgEl("path", { d: "M18 72c10-3 16-12 23-24 8-13 17-20 27-18 9 1 14 12 24 17 14 7 26-7 38-9 14-2 25 10 34 18" }),
        svgEl("path", { d: "M35 63c7-3 12-10 17-19 6-10 13-15 20-13 8 2 11 10 19 14 10 5 20-4 29-5 10-1 17 7 24 13" }),
        svgEl("path", {
          d: "M150 7c-8 14-3 27 8 39 12 13 18 28 9 47",
          "stroke-dasharray": "2 5",
          opacity: "0.8"
        })
      ])
    ]);
  }

  function completionMarkSvg() {
    return svgEl("svg", {
      class: "completion-mark",
      viewBox: "0 0 80 80",
      role: "img",
      "aria-labelledby": "completion-mark-title",
      focusable: "false"
    }, [
      svgEl("title", { id: "completion-mark-title", text: "层层山峦与一轮朝阳" }),
      svgEl("g", {
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "1.2",
        "stroke-linecap": "round"
      }, [
        svgEl("circle", { cx: "55", cy: "24", r: "7" }),
        svgEl("path", { d: "M6 61c10-12 18-19 29-19 12 0 17 9 27 9 6 0 10-3 14-7" }),
        svgEl("path", { d: "M5 69c12-9 22-12 34-11 12 1 20 5 36 4" }),
        svgEl("path", { d: "M14 55c7-8 14-12 22-12 8 0 13 6 21 7" })
      ])
    ]);
  }

  /* ----------------------------------------------------------------------- */
  /* Routing and shared shell                                                */
  /* ----------------------------------------------------------------------- */

  function updateTabUI() {
    if (typeof document === "undefined") {
      return;
    }
    document.querySelectorAll(".tab-button").forEach(function (button) {
      if (button.dataset.tab === currentTab) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    });
    document.title = "平江安澜 · " + ({
      review: "复习",
      select: "选题",
      stats: "统计",
      me: "我的"
    }[currentTab] || "复习");
  }

  function maybeRollover() {
    if (state.session && state.session.date !== todayKey()) {
      state.session = null;
      ensureTodaySession();
    }
  }

  function navigate(tab) {
    if (!TABS.includes(tab)) {
      return false;
    }
    currentTab = tab;
    if (typeof document === "undefined") {
      return true;
    }
    activeAnswerEditorId = null;
    pendingEditorId = null;
    maybeRollover();
    updateTabUI();
    renderApp({ scroll: "top", focus: true });
    return true;
  }

  function renderApp(options) {
    const settings = options || {};
    if (typeof document === "undefined" || !appScrollElement) {
      return;
    }
    const main = document.getElementById("main-content");
    const ratingDock = document.getElementById("rating-dock");
    const previousScroll = appScrollElement.scrollTop;
    if (!main || !ratingDock) {
      return;
    }
    clearNode(main);
    clearNode(ratingDock);
    updateTabUI();

    if (currentTab === "review") {
      renderReview(main);
    } else if (currentTab === "select") {
      renderSelect(main);
    } else if (currentTab === "stats") {
      renderStats(main);
    } else {
      renderMe(main);
    }

    const updateBanner = buildNativeUpdateBanner();
    if (updateBanner) {
      main.insertBefore(updateBanner, main.firstChild);
    }

    updateStorageWarning();
    appScrollElement.classList.toggle("has-rating-dock", ratingDock.children.length > 0);
    if (settings.scroll === "top") {
      appScrollElement.scrollTop = 0;
    } else {
      appScrollElement.scrollTop = previousScroll;
    }
    if (settings.focus) {
      main.focus({ preventScroll: true });
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Review view                                                             */
  /* ----------------------------------------------------------------------- */

  function uniqueReviewedCount(session) {
    if (!session) {
      return 0;
    }
    return Object.keys(session.cards).filter(function (id) {
      return session.cards[id] && session.cards[id].attempts > 0;
    }).length;
  }

  function cardStatus(session, id) {
    const card = session.cards[String(id)];
    if (!card || !card.attempts) {
      return "unseen";
    }
    if (card.lastRating === "known") {
      return "known";
    }
    if (card.lastRating === "forgot") {
      return "forgotten";
    }
    return "unseen";
  }

  function buildReviewHead(options) {
    const total = Math.max(0, Number(options.total) || 0);
    const reviewed = Math.max(0, Number(options.reviewed) || 0);
    const progress = total ? Math.round(reviewed / total * 100) : 0;
    const children = [
      contourSvg(),
      el("h2", {
        class: "sr-only",
        id: "review-title",
        text: options.title || "今日复习"
      }),
      el("div", { class: "review-topline" }, [
        el("p", { class: "review-date", text: dateHeading(todayKey()) }),
        options.showProgress === false
          ? el("p", { class: "review-progress is-muted", text: "今日暂无计划" })
          : el("p", { class: "review-progress" }, [
            el("strong", { text: String(reviewed) }),
            " / " + total + " 道"
          ])
      ])
    ];
    if (options.showProgress !== false) {
      children.push(el("div", {
        class: "progress-track",
        role: "progressbar",
        "aria-label": "今日复习进度，按不同题目计数",
        "aria-valuemin": "0",
        "aria-valuemax": String(Math.max(1, total)),
        "aria-valuenow": String(reviewed)
      }, [
        el("span", { class: "progress-fill", style: "width:" + progress + "%" })
      ]));
    }
    if (options.session) {
      children.push(renderRecordStrip(options.session));
    }
    return el("header", { class: "review-head" }, children);
  }

  function openImageViewer(source, label) {
    if (typeof document === "undefined") {
      return;
    }
    const dialog = el("dialog", {
      class: "image-viewer",
      "aria-label": label
    });
    const closeButton = el("button", {
      class: "image-viewer-close",
      type: "button",
      "aria-label": "关闭原图",
      text: "关闭"
    });
    const bar = el("div", { class: "image-viewer-bar" }, [
      el("span", { text: label }),
      closeButton
    ]);
    const image = el("img", {
      class: "image-viewer-image",
      src: source,
      alt: label
    });
    dialog.appendChild(bar);
    dialog.appendChild(image);
    const close = function () {
      if (typeof dialog.close === "function" && dialog.open) {
        dialog.close();
      } else {
        dialog.remove();
      }
    };
    closeButton.addEventListener("click", close);
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) {
        close();
      }
    });
    dialog.addEventListener("close", function () {
      dialog.remove();
    });
    document.body.appendChild(dialog);
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
      } catch (error) {
        dialog.setAttribute("open", "");
      }
    } else {
      dialog.setAttribute("open", "");
    }
    closeButton.focus();
  }

  function renderQuestionImages(question) {
    const imageSources = getQuestionImageSourceList(question.id);
    if (!imageSources.length) {
      return null;
    }
    const container = el("div", { class: "question-figures", "aria-label": "题目原图" });
    imageSources.forEach(function (source, index) {
      const label = "第 " + question.id + " 题配图 " + (index + 1);
      const image = el("img", {
        class: "question-image",
        src: source,
        alt: label,
        loading: "lazy",
        decoding: "async"
      });
      const openButton = el("button", {
        class: "question-image-button",
        type: "button",
        "aria-label": "查看" + label + "大图"
      }, [image]);
      openButton.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        openImageViewer(source, label);
      });
      container.appendChild(el("figure", { class: "question-figure" }, [
        openButton,
        el("figcaption", {
          class: "question-image-caption",
          text: "配图 " + (index + 1) + " · 点击查看原图"
        })
      ]));
    });
    return container;
  }

  function buildAnswerForm(question, initialText, options) {
    const settings = options || {};
    const form = el("form", {
      class: "answer-edit-form",
      "aria-label": "编辑第 " + question.id + " 题答案"
    });
    const label = el("label", {
      class: "answer-edit-label",
      for: settings.idPrefix + "-" + question.id,
      text: "编辑答案"
    });
    const textarea = el("textarea", {
      class: "answer-edit-textarea",
      id: settings.idPrefix + "-" + question.id,
      rows: "8",
      "aria-label": "第 " + question.id + " 题答案编辑器"
    });
    textarea.value = initialText || "";
    const saveButton = el("button", {
      class: "primary-button answer-edit-save",
      type: "submit",
      text: settings.saveLabel || "保存修订"
    });
    const cancelButton = el("button", {
      class: "secondary-button",
      type: "button",
      text: "取消"
    });
    cancelButton.addEventListener("click", function () {
      if (typeof settings.onCancel === "function") {
        settings.onCancel();
      }
    });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      const text = textarea.value.trim();
      if (!text) {
        showToast("答案不能为空。");
        textarea.focus();
        return;
      }
      if (typeof settings.onSave === "function") {
        settings.onSave(text);
      }
    });
    form.appendChild(label);
    form.appendChild(el("p", {
      class: "answer-edit-hint",
      text: "保存的是我的修订，不会覆盖 DSH 初稿或题库原答案。"
    }));
    form.appendChild(textarea);
    form.appendChild(el("div", { class: "answer-edit-actions" }, [cancelButton, saveButton]));
    return form;
  }

  function renderDraftDetails(question, answerData) {
    const generated = answerData.generated;
    const blocks = [];
    if (answerData.hasEdit && answerData.originalText) {
      blocks.push(el("details", { class: "draft-details" }, [
        el("summary", { text: "查看原始答案（未修改）" }),
        el("p", { class: "draft-answer", text: answerData.originalText })
      ]));
    }
    if (generated) {
      const content = [
        el("div", { class: "draft-meta" }, [
          el("span", {
            class: "status-chip " + (
              generated.status === "draft" ? "is-draft" :
                generated.status === "needs_figure_review" ? "is-figure" : "is-source"
            ),
            text: "DSH初稿 · " + generatedStatusLabel(generated.status)
          }),
          el("span", { class: "draft-warning", text: "未审定，需核对" })
        ])
      ];
      if (answerData.hasEdit) {
        content.push(el("p", { class: "draft-label", text: "编辑前 DSH 初稿全文" }));
        content.push(el("p", { class: "draft-answer", text: answerData.baseText }));
      }
      if (answerData.keyPoints.length) {
        content.push(el("p", { class: "draft-label", text: "要点" }));
        const points = el("ul", { class: "draft-points" });
        answerData.keyPoints.forEach(function (point) {
          points.appendChild(el("li", { text: point }));
        });
        content.push(points);
      }
      if (generated.caveat) {
        content.push(el("p", { class: "draft-label", text: "说明与提醒" }));
        content.push(el("p", { class: "draft-caveat", text: generated.caveat }));
      }
      if (answerData.references.length) {
        content.push(el("p", { class: "draft-label", text: "教材依据（PDF 页序）" }));
        const refs = el("ol", { class: "draft-references" });
        answerData.references.forEach(function (reference) {
          refs.appendChild(el("li", { class: "draft-reference" }, [
            el("p", {
              class: "draft-reference-meta",
              text: "PDF 页序 " + reference.pdf_page + " · unit_id " + reference.unit_id
            }),
            el("blockquote", { class: "draft-quote", text: reference.quote })
          ]));
        });
        content.push(refs);
      } else {
        content.push(el("p", {
          class: "draft-caveat",
          text: "本初稿没有可列出的教材引用，请核对来源或任课教师口径。"
        }));
      }
      blocks.push(el("details", { class: "draft-details" }, [
        el("summary", {
          text: answerData.hasEdit ? "查看 DSH 初稿与依据（未修改）" : "查看初稿依据与说明"
        })
      ].concat(content)));
    }
    return blocks;
  }

  function beginAnswerEdit(questionId) {
    activeAnswerEditorId = Number(questionId);
    renderApp({ scroll: "preserve" });
    window.setTimeout(function () {
      const field = document.getElementById("answer-edit-" + questionId);
      if (field) {
        field.focus();
      }
    }, 0);
  }

  function cancelAnswerEdit() {
    activeAnswerEditorId = null;
    renderApp({ scroll: "preserve" });
    showToast("已取消编辑，未保存修改。");
  }

  function saveAnswerEdit(questionId, text) {
    const question = questionById.get(Number(questionId));
    if (!question) {
      showToast("题目不存在，无法保存。");
      return;
    }
    state.answerEdits[String(question.id)] = {
      text: text,
      updatedAt: isoNow(),
      updatedDate: todayKey()
    };
    const saved = saveState();
    activeAnswerEditorId = null;
    renderApp({ scroll: "preserve" });
    showToast(saved
      ? "答案修订已保存，初稿仍保留。"
      : "答案修订已更新，但本机存储写入失败；仅当前页面有效。");
  }

  function renderAnswer(question) {
    const answerData = getAnswerData(question);
    const region = el("section", {
      class: "answer-region",
      id: "answer-region",
      "aria-label": "答案与解析"
    });
    const editButton = el("button", {
      class: "text-edit-button",
      type: "button",
      "aria-label": (answerData.isAnswerable ? "编辑第 " + question.id + " 题答案" : "为第 " + question.id + " 题补写答案"),
      text: answerData.isAnswerable ? (answerData.hasEdit ? "再次编辑" : "编辑答案") : "补写答案"
    });
    editButton.addEventListener("click", function () {
      beginAnswerEdit(question.id);
    });
    const badges = [
      el("span", {
        class: "answer-source-label",
        text: answerData.hasEdit ? "我的修订" :
          answerData.source === "generated" ? "DSH 初稿" :
            answerData.source === "original" ? "题库原答案" : "待补答案"
      })
    ];
    if (question.metadata && question.metadata.source_reference) {
      region.appendChild(el("p", { class: "answer-source-note", text: "教材来源：" + question.metadata.source_reference +
        (question.metadata.knowledge_path ? " · 知识路径：" + question.metadata.knowledge_path : "") }));
    }
    if (answerData.generated) {
      const generatedClass = answerData.generated.status === "draft" ? "is-draft" :
        answerData.generated.status === "needs_figure_review" ? "is-figure" : "is-source";
      badges.push(el("span", {
        class: "status-chip " + generatedClass,
        text: generatedStatusLabel(answerData.generated.status)
      }));
    } else if (answerData.hasEdit) {
      badges.push(el("span", { class: "status-chip is-edit", text: "我的修订" }));
    }
    const header = el("div", { class: "answer-head" }, [
      el("div", { class: "answer-head-main" }, badges),
      activeAnswerEditorId === question.id ? null : editButton
    ]);
    region.appendChild(header);

    if (activeAnswerEditorId === question.id) {
      region.appendChild(buildAnswerForm(question, answerData.text, {
        idPrefix: "answer-edit",
        saveLabel: "保存修订",
        onSave: function (text) {
          saveAnswerEdit(question.id, text);
        },
        onCancel: cancelAnswerEdit
      }));
    } else if (answerData.isAnswerable) {
      region.appendChild(el("p", {
        class: "answer-text",
        text: answerData.text
      }));
      if (answerData.hasEdit && answerData.edit) {
        region.appendChild(el("p", {
          class: "edited-meta",
          text: "我的修订 · 保存于 " + formatSavedAt(answerData.edit.updatedAt, answerData.edit.updatedDate)
        }));
      }
      if (answerData.generated && !answerData.hasEdit) {
        region.appendChild(el("p", {
          class: "draft-inline-note",
          text: "此为 DSH 初稿，尚未审定；请结合初稿依据自行核对。"
        }));
      }
    } else {
      region.appendChild(el("p", {
        class: "answer-text is-empty-answer",
        text: "本题尚无可用答案，可先补写，再进入背诵。"
      }));
    }

    if (question.explanation && answerData.originalText) {
      region.appendChild(el("div", { class: "explanation-block" }, [
        el("p", { class: "answer-label", text: "解析" }),
        el("p", {
          class: "explanation-text",
          text: question.explanation
        })
      ]));
    }
    renderDraftDetails(question, answerData).forEach(function (block) {
      region.appendChild(block);
    });

    const schedule = state.schedule[String(question.id)];
    const scheduleDetails = el("details", { class: "schedule-details" });
    scheduleDetails.appendChild(el("summary", { text: "复习调度与下次日期" }));
    if (schedule && schedule.nextDue) {
      scheduleDetails.appendChild(el("p", {
        class: "schedule-line",
        text: "下次建议复习：" + formatDateKey(schedule.nextDue, true) +
          " · 稳定度 S≈" + Number(schedule.stability || 1).toFixed(2) +
          " 天 · 目标保持率 90%"
      }));
      if (schedule.forcedDueDate) {
        scheduleDetails.appendChild(el("p", {
          class: "schedule-line is-forced",
          text: "强制复习日：" + formatDateKey(schedule.forcedDueDate, true) +
            "（曾遗忘，到达该日期后再次熟记才解除）"
        }));
      }
      if (schedule.legacy) {
        scheduleDetails.appendChild(el("p", {
          class: "schedule-line",
          text: "这是从旧版排程迁移的数据：原有下次日期与计划已保留，稳定度按旧熟记次数初始化。"
        }));
      }
    } else {
      scheduleDetails.appendChild(el("p", {
        class: "schedule-line",
        text: "本题尚未形成个人调度。首次自评后会在本地安排下次复习；遗忘题次日照样强制复习。"
      }));
    }
    region.appendChild(scheduleDetails);

    region.appendChild(el("footer", { class: "source-note" }, [
      el("p", {}, [
        "来源：",
        el("span", { class: "source-name", text: getSourceName(question) })
      ]),
      el("p", { text: "出处：" + getLocatorLabel(question) }),
      el("p", {
        class: "page-pending",
        text: "教材印刷页码待核对"
      }),
      el("p", {
        text: answerData.generated
          ? "DSH 初稿引用 PDF 页序；未核实印刷页码，也未标为审定答案。"
          : "仅标明可核对的练习出处；教材印刷页码待核对。"
      })
    ]));
    return region;
  }

  function renderReview(main) {
    if (!state.session) {
      renderReviewNoPlan(main);
      return;
    }
    if (state.session.completed) {
      renderReviewCompletion(main);
      return;
    }
    const session = state.session;
    const id = Number(session.currentId);
    const question = answeredQuestion(id);
    if (!question) {
      renderReviewNoPlan(main);
      return;
    }

    const total = session.planIds.length;
    const reviewed = uniqueReviewedCount(session);
    const planIndex = Math.max(0, session.planIds.indexOf(question.id));
    const answerData = getAnswerData(question);
    const view = el("section", {
      class: "view review-view",
      "aria-labelledby": "review-title"
    });

    view.appendChild(buildReviewHead({
      reviewed: reviewed,
      total: total,
      session: session
    }));

    if (session.waitingRelearn) {
      const continueButton = el("button", {
        class: "secondary-button",
        type: "button",
        "aria-label": "继续复习当前这道题",
        text: "继续复习本题",
        style: "width:100%;margin-top:10px"
      });
      continueButton.addEventListener("click", revealCurrent);
      const waitingNote = el("div", { class: "waiting-note" }, [
        el("strong", { text: "没有足够其他题可以间隔" }),
        "本题已记为遗忘。当前没有其他未完成题目可用于“3 道其他题”的间隔，因此不会自动循环出题。",
        "你可以继续重看本题；需要时再重新自评。",
        continueButton
      ]);
      view.appendChild(waitingNote);
    }

    const stage = el("article", { class: "question-stage", "aria-labelledby": "question-text" });
    const revealZone = el("div", { class: "question-reveal-zone" });
    const meta = el("div", { class: "question-meta" }, [
      el("span", { class: "chapter-tag", text: question.chapter || "章节待核对" }),
      el("span", { class: "question-type-tag", text: questionTypeOf(question) }),
      el("span", {
        class: "question-ordinal",
        text: "第 " + (planIndex + 1) + " / " + total + " 题"
      })
    ]);
    revealZone.appendChild(meta);
    revealZone.appendChild(el("h3", {
      class: "question-text",
      id: "question-text",
      text: cleanQuestionText(question.question)
    }));

    const images = renderQuestionImages(question);
    if (images) {
      revealZone.appendChild(images);
    }

    const options = parseOptions(question.options);
    if (options.length) {
      const correctKeys = getCorrectKeys(answerData.text);
      const list = el("ol", { class: "option-list", "aria-label": "题目选项" });
      options.forEach(function (option) {
        const isCorrect = session.revealed && correctKeys.includes(option.key);
        list.appendChild(el("li", {
          class: "option-row" + (isCorrect ? " is-correct" : "")
        }, [
          el("span", { class: "option-key", text: option.key + "." }),
          el("span", { class: "option-text", text: option.text })
        ]));
      });
      revealZone.appendChild(list);
    } else {
      revealZone.appendChild(el("p", {
        class: "question-hint",
        text: window.QuestionTypeSupport ? window.QuestionTypeSupport.getHint(questionTypeOf(question)) : "先回忆，再揭晓参考要点。"
      }));
    }

    if (!session.revealed) {
      const reveal = el("button", {
        class: "reveal-button",
        type: "button",
        "aria-label": "查看本题答案",
        "aria-expanded": "false",
        "aria-controls": "answer-region",
        text: "查看答案"
      });
      reveal.addEventListener("click", revealCurrent);
      revealZone.appendChild(reveal);
    }

    revealZone.addEventListener("click", function (event) {
      if (event.target.closest("button, a, input, select, textarea, label")) {
        return;
      }
      if (state.session && !state.session.revealed && !state.session.waitingRelearn) {
        revealCurrent();
      }
    });

    stage.appendChild(revealZone);
    if (session.revealed) {
      stage.appendChild(renderAnswer(question));
    }
    view.appendChild(stage);
    main.appendChild(view);
    renderRatingDock(question);
  }

  function renderRecordStrip(session) {
    const wrapper = el("div", { class: "record-strip", "aria-label": "本轮题目记录，只读" });
    session.planIds.forEach(function (id, index) {
      const status = cardStatus(session, id);
      const current = id === session.currentId;
      const label = status === "known" ? "已熟记" : status === "forgotten" ? "今日曾遗忘，待重拾" : "未作答";
      const dot = el("span", {
        class: "record-dot" +
          (current ? " is-current" : "") +
          (status === "known" ? " is-known" : "") +
          (status === "forgotten" ? " is-forgotten" : ""),
        role: "img",
        "aria-label": "第 " + (index + 1) + " 题，" + label,
        title: "第 " + (index + 1) + " 题 · " + label,
        text: String(index + 1)
      });
      wrapper.appendChild(dot);
    });
    return wrapper;
  }

  function parseOptions(raw) {
    if (!raw) {
      return [];
    }
    const text = String(raw).replace(/\u3000/g, " ").trim();
    const matches = [];
    const regex = /([A-D])\s*[.．、]\s*/g;
    let match = regex.exec(text);
    while (match) {
      matches.push({ key: match[1], index: match.index, end: regex.lastIndex });
      match = regex.exec(text);
    }
    return matches.map(function (item, index) {
      const next = matches[index + 1];
      const content = text.slice(item.end, next ? next.index : text.length).trim();
      return { key: item.key, text: content };
    }).filter(function (item) { return item.text.length > 0; });
  }

  function getCorrectKeys(answer) {
    const match = String(answer || "").trim().match(/^([A-D]+)(?=\s|[；;，,.．、]|$)/);
    return match ? match[1].split("") : [];
  }

  function renderRatingDock(question) {
    const dock = document.getElementById("rating-dock");
    if (!dock) {
      return;
    }
    const session = state.session;
    if (!session || session.completed || !question) {
      return;
    }
    const editingAnswer = activeAnswerEditorId === question.id;
    const canRate = session.revealed && !session.waitingRelearn &&
      !editingAnswer && isAnswerable(question);
    const hint = session.waitingRelearn
      ? "先继续重看本题"
      : editingAnswer
        ? "先保存或取消编辑"
        : session.revealed
          ? "请诚实自评"
          : "揭晓答案后可自评";
    const forgot = el("button", {
      class: "rating-button forgotten",
      type: "button",
      disabled: !canRate,
      "aria-label": "标记为遗忘，之后会再次复习",
      text: "遗忘"
    });
    const known = el("button", {
      class: "rating-button known",
      type: "button",
      disabled: !canRate,
      "aria-label": "标记为熟记，本题不再列入今日重看",
      text: "熟记"
    });
    forgot.addEventListener("click", function () { rateCurrent("forgot"); });
    known.addEventListener("click", function () { rateCurrent("known"); });
    dock.appendChild(el("span", { class: "rating-hint", text: hint }));
    dock.appendChild(forgot);
    dock.appendChild(known);
  }

  function syncLocalDayBeforeReviewAction() {
    if (state.session && state.session.date !== todayKey()) {
      activeAnswerEditorId = null;
      maybeRollover();
      renderApp({ scroll: "top" });
      showToast("已进入新的一天，今日计划已按本地日期更新。");
      return true;
    }
    return false;
  }

  function revealCurrent(event) {
    if (event) {
      event.preventDefault();
    }
    if (syncLocalDayBeforeReviewAction()) {
      return;
    }
    const session = state.session;
    if (!session || session.completed || !session.currentId) {
      return;
    }
    const question = answeredQuestion(session.currentId);
    if (!question) {
      showToast("该题尚无答案，不能进入自评。");
      return;
    }
    if (session.revealed) {
      return;
    }
    const wasWaiting = session.waitingRelearn;
    session.revealed = true;
    session.waitingRelearn = false;
    saveState();
    renderApp({ scroll: "preserve" });
    if (wasWaiting) {
      showToast("已重新打开本题，请重看后自评。");
    }
  }

  function rateCurrent(rating) {
    if (ratingBusy || (rating !== "known" && rating !== "forgot")) {
      return;
    }
    if (syncLocalDayBeforeReviewAction()) {
      return;
    }
    const session = state.session;
    if (!session || session.completed || !session.currentId) {
      return;
    }
    const question = answeredQuestion(session.currentId);
    if (!question) {
      showToast("该题尚无答案，不能评价。");
      return;
    }
    if (!session.revealed) {
      showToast("请先揭晓答案，再进行自评。");
      return;
    }
    if (session.waitingRelearn) {
      showToast("请先继续重看本题。");
      return;
    }
    if (activeAnswerEditorId === question.id) {
      showToast("请先保存或取消答案编辑。");
      return;
    }
    ratingBusy = true;
    try {
      const id = question.id;
      const now = new Date();
      const card = session.cards[String(id)] || {
        attempts: 0,
        lastRating: null,
        forgotten: false,
        lastAt: ""
      };
      card.attempts += 1;
      card.lastRating = rating;
      card.forgotten = card.forgotten || rating === "forgot";
      card.lastAt = now.toISOString();
      session.cards[String(id)] = card;
      state.history.push({
        id: id,
        date: localDateKey(now),
        at: now.toISOString(),
        rating: rating,
        chapter: question.chapter,
        source_id: question.source_id
      });
      session.revealed = false;
      session.relearn = (session.relearn || []).filter(function (item) {
        return item.id !== id;
      });
      const aged = advanceRelearnCounters(session.relearn, id);
      session.relearn = aged.relearn;
      session.queue = session.queue.filter(function (queueId) { return queueId !== id; });
      if (aged.dueIds.length) {
        const dueSet = new Set(aged.dueIds);
        session.queue = aged.dueIds.concat(session.queue.filter(function (queueId) {
          return !dueSet.has(queueId);
        }));
      }
      let schedule;
      if (rating === "forgot") {
        if (!session.forgottenIds.includes(id)) {
          session.forgottenIds.push(id);
        }
        schedule = updateScheduleAfterReview(id, "forgot", now);
        session.relearn.push({ id: id, remaining: 3 });
      } else {
        schedule = updateScheduleAfterReview(id, "known", now);
      }
      advanceSession();
      activeAnswerEditorId = null;
      const needsMoreQuestions = session.waitingRelearn;
      saveState();
      renderApp({ scroll: "top" });
      const nextDueText = schedule && schedule.nextDue
        ? "下次复习：" + formatDateKey(schedule.nextDue, true)
        : "";
      if (needsMoreQuestions) {
        showToast("其他题不足 3 道，遗忘题已保留；请继续重看，不会自动循环。" +
          (nextDueText ? " " + nextDueText : ""));
      } else if (nextDueText) {
        showToast("已记录；" + nextDueText + "。");
      }
    } finally {
      ratingBusy = false;
    }
  }

  function renderReviewNoPlan(main) {
    const view = el("section", { class: "view", "aria-labelledby": "review-empty-title" }, [
      buildReviewHead({ showProgress: false }),
      el("div", { class: "empty-state" }, [
        el("h3", { class: "empty-state-title", id: "review-empty-title", text: "今日还没有计划" }),
        el("p", {
          class: "empty-state-copy",
          text: "从有答案的题目里选几道，生成今天的复习计划。"
        }),
        (function () {
          const button = el("button", {
            class: "primary-button",
            type: "button",
            "aria-label": "前往选题页生成今日计划",
            text: "去选题",
            style: "width:100%"
          });
          button.addEventListener("click", function () { navigate("select"); });
          return button;
        })()
      ])
    ]);
    main.appendChild(view);
  }

  function renderReviewCompletion(main) {
    const session = state.session;
    const total = session.planIds.length;
    const known = session.planIds.filter(function (id) {
      return cardStatus(session, id) === "known";
    }).length;
    const forgotten = session.forgottenIds.length;
    const tomorrow = addDays(todayKey(), 1);
    const tomorrowDue = Object.keys(state.schedule).filter(function (id) {
      return state.schedule[id].nextDue === tomorrow;
    }).length;
    const view = el("section", {
      class: "view",
      "aria-labelledby": "completion-title"
    }, [
      buildReviewHead({
        reviewed: total,
        total: total
      }),
      el("div", { class: "completion" }, [
        completionMarkSvg(),
        el("h3", { class: "completion-title", id: "completion-title", text: "今日复习完成" }),
        el("p", {
          class: "completion-copy",
          text: forgotten
            ? "今日曾遗忘的题目已留下重看记录；即使之后变为熟记，也保留次日必复习安排。"
            : "这一轮已全部完成。学过的水利知识，会在下一次回忆里更清楚。"
        }),
        el("div", { class: "completion-stats", "aria-label": "本轮统计" }, [
          el("div", { class: "completion-stat" }, [
            el("strong", { text: String(known) }),
            el("span", { text: "本轮熟记" })
          ]),
          el("div", { class: "completion-stat" }, [
            el("strong", { text: String(forgotten) }),
            el("span", { text: "曾遗忘" })
          ]),
          el("div", { class: "completion-stat" }, [
            el("strong", { text: String(tomorrowDue) }),
            el("span", { text: "明日待复习" })
          ])
        ]),
        el("div", { class: "completion-actions" }, [
          (function () {
            const primary = el("button", {
              class: "primary-button",
              type: "button",
              "aria-label": "去选题页安排下一轮复习",
              text: "去选题"
            });
            primary.addEventListener("click", function () { navigate("select"); });
            return primary;
          })(),
          (function () {
            const secondary = el("button", {
              class: "secondary-button",
              type: "button",
              "aria-label": "查看学习统计",
              text: "查看统计"
            });
            secondary.addEventListener("click", function () { navigate("stats"); });
            return secondary;
          })()
        ])
      ])
    ]);
    main.appendChild(view);
  }

  /* ----------------------------------------------------------------------- */
  /* Selection view                                                          */
  /* ----------------------------------------------------------------------- */

  function sourceFormatLabel(source) {
    const format = source && source.format ? String(source.format).replace(/^\./, "") : "";
    return format ? format.toUpperCase() : "资料";
  }

  function buildStarButton(source) {
    const starred = state.referenceIds.includes(source.id);
    const button = el("button", {
      class: "star-button" + (starred ? " is-starred" : ""),
      type: "button",
      "data-star-id": String(source.id),
      "aria-pressed": starred ? "true" : "false",
      "aria-label": (starred ? "取消星标：" : "星标：") + String(source.name)
    }, [
      starSvg(),
      el("span", { text: starred ? "已星标" : "星标" })
    ]);
    return button;
  }

  function renderSourceList(sourceList) {
    const list = el("ul", { class: "source-list" });
    sourceList.forEach(function (source) {
      const starred = state.referenceIds.includes(source.id);
      list.appendChild(el("li", { class: "source-row" }, [
        el("div", { class: "source-main" }, [
          el("span", { class: "source-title", text: source.name }),
          el("span", { class: "source-meta" }, [
            el("span", { class: "format-tag", text: sourceFormatLabel(source) }),
            el("span", { class: "source-state", text: starred ? "主要参考书" : "资料库" })
          ])
        ]),
        buildStarButton(source)
      ]));
    });
    return list;
  }

  function refreshStarButtons(container) {
    if (!container) {
      return;
    }
    container.querySelectorAll("button[data-star-id]").forEach(function (button) {
      const id = Number(button.dataset.starId);
      const source = sourceById.get(id);
      const starred = state.referenceIds.includes(id);
      button.classList.toggle("is-starred", starred);
      button.setAttribute("aria-pressed", starred ? "true" : "false");
      button.setAttribute("aria-label", (starred ? "取消星标：" : "星标：") + (source ? source.name : ""));
      const label = button.querySelector("span");
      if (label) {
        label.textContent = starred ? "已星标" : "星标";
      }
      const row = button.closest(".source-row");
      const stateLabel = row ? row.querySelector(".source-state") : null;
      if (stateLabel) {
        stateLabel.textContent = starred ? "主要参考书" : "资料库";
      }
    });
  }

  function toggleReference(sourceId) {
    const id = Number(sourceId);
    if (!sourceById.has(id)) {
      return { changed: false, reason: "missing" };
    }
    const index = state.referenceIds.indexOf(id);
    if (index >= 0) {
      state.referenceIds.splice(index, 1);
      saveState();
      return { changed: true, starred: false };
    }
    if (state.referenceIds.length >= MAX_REFERENCE_BOOKS) {
      showToast("最多星标 2 份主要参考书。");
      return { changed: false, reason: "limit" };
    }
    state.referenceIds.push(id);
    saveState();
    return { changed: true, starred: true };
  }

  function optionElement(value, label, selected) {
    return el("option", {
      value: value,
      text: label,
      selected: Boolean(selected)
    });
  }

  function renderSelect(main) {
    const preview = getPlanPreview();
    const answerableNow = getAnswerableQuestions();
    const pendingNow = getPendingQuestions();
    const generatedSummary = getGeneratedSummary();
    const editCount = Object.keys(state.answerEdits).length;
    const view = el("section", { class: "view", "aria-labelledby": "select-title" });
    const head = el("header", { class: "page-head" }, [
      el("p", { class: "eyebrow", text: "按自己的节奏" }),
      el("h2", { class: "view-title", id: "select-title", text: "选题" }),
      el("p", {
        class: "page-head-copy",
        text: "按题干、章节和来源筛选；列表默认不显示答案。"
      }),
      el("details", { class: "selection-info" }, [
        el("summary", { text: "题库与初稿来源说明" }),
        el("p", {
          text: "题库共 " + questions.length + " 道；当前有可用答案 " + answerableNow.length +
            " 道，待补答案 " + pendingNow.length + " 道。"
        }),
        el("p", {
          text: "DSH 初稿 " + generatedSummary.total + " 道：待核对 " + generatedSummary.draft +
            "、需核图 " + generatedSummary.needs_figure_review +
            "、需核来源 " + generatedSummary.needs_source_review +
            "。这些均为未审定初稿，不冒充权威答案；依据与提醒可在复习答案中展开查看。"
        }),
        editCount ? el("p", {
          text: "我的修订 " + editCount + " 条，仅覆盖该题当前显示的答案，不覆盖 DSH 初稿或题库原答案。"
        }) : null
      ])
    ]);
    view.appendChild(head);

    const targetSection = el("section", { class: "section" });
    const targetInput = el("input", {
      class: "number-input",
      id: "daily-target",
      type: "number",
      inputmode: "numeric",
      min: "1",
      max: String(Math.max(1, answerableNow.length)),
      step: "1",
      value: String(Math.min(state.settings.dailyTarget, Math.max(1, answerableNow.length))),
      "aria-label": "每日题量，默认 10 道，最多随有答案题量变化"
    });
    targetSection.appendChild(el("div", { class: "setting-row" }, [
      el("div", {}, [
        el("label", { class: "setting-label", for: "daily-target", text: "每日题量" }),
        el("span", {
          class: "setting-sub",
          text: "默认 10 道；当前可调至 " + Math.max(1, answerableNow.length) +
            " 道。必选到期题不会因题量上限被丢弃。"
        })
      ]),
      el("div", { class: "number-field" }, [
        targetInput,
        el("span", { class: "number-suffix", text: "道" })
      ])
    ]));

    const mandatoryCount = el("strong", { text: String(preview.mandatory.length) });
    const optionalCount = el("strong", { text: String(preview.optional.length) });
    const totalCount = el("strong", { text: String(preview.total) });
    targetSection.appendChild(el("div", { class: "plan-equation", "aria-label": "今日计划构成" }, [
      el("div", { class: "equation-cell" }, [mandatoryCount, el("span", { text: "必选" })]),
      el("div", { class: "equation-cell" }, [optionalCount, el("span", { text: "自选" })]),
      el("div", { class: "equation-cell" }, [totalCount, el("span", { text: "已选合计" })])
    ]));
    const planNote = el("p", { class: "plan-note" });
    const noticeHost = el("div");
    targetSection.appendChild(planNote);
    targetSection.appendChild(noticeHost);

    const generateButton = el("button", {
      class: "primary-button generate-button",
      type: "button",
      "aria-label": "生成今日计划"
    });
    generateButton.addEventListener("click", generatePlanFromSelection);
    targetSection.appendChild(generateButton);
    const mixedButton = el("button", {
      class: "secondary-button mixed-plan-button", type: "button",
      text: "混合题型推荐", "aria-label": "按不同题型推荐题目，保留必选题"
    });
    mixedButton.addEventListener("click", function () {
      const preview = getPlanPreview();
      const capacity = Math.max(0, preview.effectiveTarget - preview.mandatory.length);
      state.selectedIds = mixedQuestionIds(questions.length).filter(function (id) {
        return !preview.mandatory.includes(id);
      }).slice(0, capacity);
      saveState();
      renderApp({ scroll: "preserve" });
      showToast("已推荐不同题型；点击生成今日计划后开始复习。");
    });
    targetSection.appendChild(mixedButton);
    view.appendChild(targetSection);

    const filterSection = el("section", { class: "section" });
    filterSection.appendChild(el("h3", { class: "section-heading", text: "筛选题目" }));
    filterSection.appendChild(el("p", {
      class: "section-copy",
      text: "来源、章节筛选与多关键词搜索可组合使用；搜索按空格分词，每个关键词都要同时命中题干或章节。"
    }));

    const segmented = el("div", { class: "segmented", role: "group", "aria-label": "题库筛选" });
    const modes = [
      { id: "all", label: "全部" },
      { id: "answerable", label: "有答案" },
      { id: "pending", label: "待补答案" }
    ];
    const modeButtons = {};
    modes.forEach(function (mode) {
      const button = el("button", {
        class: "segment-button",
        type: "button",
        "data-mode": mode.id,
        "aria-label": mode.label,
        "aria-pressed": selectionFilter.mode === mode.id ? "true" : "false"
      }, [
        el("span", { text: mode.label })
      ]);
      button.addEventListener("click", function () {
        selectionFilter.mode = mode.id;
        Object.keys(modeButtons).forEach(function (key) {
          modeButtons[key].setAttribute("aria-pressed", key === mode.id ? "true" : "false");
        });
        renderSelectionList();
      });
      modeButtons[mode.id] = button;
      segmented.appendChild(button);
    });
    filterSection.appendChild(segmented);

    const searchInput = el("input", {
      class: "text-input",
      id: "question-search",
      type: "search",
      placeholder: "搜索题干、章节；空格分词",
      value: selectionFilter.query,
      autocomplete: "off",
      "aria-label": "搜索题干或章节，多关键词需同时命中"
    });
    searchInput.addEventListener("input", function () {
      selectionFilter.query = searchInput.value;
      renderSelectionList();
    });

    const sourceSelect = el("select", {
      class: "select-input",
      id: "source-filter",
      "aria-label": "按题目来源筛选"
    }, [
      optionElement("all", "全部来源（" + sources.length + "）", selectionFilter.sourceId === "all")
    ]);
    sources.forEach(function (source) {
      sourceSelect.appendChild(optionElement(
        String(source.id),
        source.name,
        selectionFilter.sourceId === String(source.id)
      ));
    });
    sourceSelect.addEventListener("change", function () {
      selectionFilter.sourceId = sourceSelect.value;
      renderSelectionList();
    });

    const chapterSelect = el("select", {
      class: "select-input",
      id: "chapter-filter",
      "aria-label": "按章节筛选"
    }, [
      optionElement("all", "全部章节", selectionFilter.chapter === "all")
    ]);
    const chapters = [];
    questions.forEach(function (question) {
      if (!chapters.includes(question.chapter)) {
        chapters.push(question.chapter);
      }
    });
    chapters.forEach(function (chapter) {
      chapterSelect.appendChild(optionElement(chapter, chapter, selectionFilter.chapter === chapter));
    });
    chapterSelect.addEventListener("change", function () {
      selectionFilter.chapter = chapterSelect.value;
      renderSelectionList();
    });

    const typeSelect = el("select", {
      class: "select-input", id: "question-type-filter", "aria-label": "按题型筛选"
    }, [optionElement("all", "全部题型", selectionFilter.questionType === "all")]);
    const typeCounts = window.QuestionTypeSupport ? window.QuestionTypeSupport.getCounts(questions) : {};
    (window.QuestionTypeSupport ? window.QuestionTypeSupport.getTypes(questions) : []).forEach(function (type) {
      typeSelect.appendChild(optionElement(type, type + "（" + (typeCounts[type] || 0) + "）", selectionFilter.questionType === type));
    });
    typeSelect.addEventListener("change", function () {
      selectionFilter.questionType = typeSelect.value;
      renderSelectionList();
    });
    filterSection.appendChild(el("div", { class: "filters" }, [
      el("div", { class: "filter-field is-wide" }, [
        el("label", { class: "field-label", for: "question-search", text: "搜索" }),
        el("div", { class: "search-wrap" }, [searchSvg(), searchInput])
      ]),
      el("div", { class: "filter-field" }, [
        el("label", { class: "field-label", for: "source-filter", text: "题目来源" }),
        sourceSelect
      ]),
      el("div", { class: "filter-field" }, [
        el("label", { class: "field-label", for: "chapter-filter", text: "章节" }),
        chapterSelect
      ]),
      el("div", { class: "filter-field" }, [
        el("label", { class: "field-label", for: "question-type-filter", text: "题型" }), typeSelect
      ])
    ]));

    const shelf = el("details", {
      class: "source-shelf",
      open: selectionFilter.shelfOpen
    });
    shelf.addEventListener("toggle", function () {
      selectionFilter.shelfOpen = shelf.open;
    });
    const shelfSummary = el("summary");
    const shelfList = renderSourceList(sources);
    shelf.appendChild(shelfSummary);
    shelf.appendChild(el("p", {
      class: "source-shelf-copy",
      text: "可星标最多 2 份主要参考书。星标与上方“题目来源”筛选相互独立。"
    }));
    shelf.appendChild(shelfList);
    shelfList.addEventListener("click", function (event) {
      const button = event.target.closest("button[data-star-id]");
      if (!button) {
        return;
      }
      const result = toggleReference(button.dataset.starId);
      if (!result.changed) {
        return;
      }
      refreshStarButtons(shelfList);
      updateShelfLabel();
    });
    function updateShelfLabel() {
      shelfSummary.textContent = "资料库 · " + sources.length + " 份 · 主参考书 " +
        state.referenceIds.length + "/" + MAX_REFERENCE_BOOKS;
    }
    updateShelfLabel();
    filterSection.appendChild(shelf);
    view.appendChild(filterSection);

    const listSection = el("section", { class: "section" });
    const listMeta = el("div", { class: "list-meta" });
    const listHost = el("div");
    listSection.appendChild(listMeta);
    listSection.appendChild(listHost);
    listSection.appendChild(el("p", {
      class: "list-footnote",
      text: "列表只显示题干、章节与选择状态；不展示答案或选项。待补题补写后加入，但不会自动进入今日计划。"
    }));
    view.appendChild(listSection);

    function filterQuestions(list) {
      return list.filter(function (question) {
        if (selectionFilter.sourceId !== "all" &&
            String(question.source_id) !== selectionFilter.sourceId) {
          return false;
        }
        if (selectionFilter.chapter !== "all" && question.chapter !== selectionFilter.chapter) {
          return false;
        }
        if (selectionFilter.questionType !== "all" && questionTypeOf(question) !== selectionFilter.questionType) { return false; }
        return matchesQuestionSearch(question, selectionFilter.query);
      });
    }

    function makeAnsweredRow(question, previewValue, selectedSet, mandatorySet, capacity, optionalCount) {
      const isMandatory = mandatorySet.has(question.id);
      const isSelected = selectedSet.has(question.id);
      const checkbox = el("input", {
        class: "row-check",
        type: "checkbox",
        "data-select-id": String(question.id),
        checked: isSelected,
        disabled: isMandatory || (!isSelected && optionalCount >= capacity),
        "aria-label": "选择第 " + question.id + " 题：" + question.chapter
      });
      return el("label", { class: "question-row" + (isMandatory ? " is-mandatory" : "") }, [
        checkbox,
        el("span", { class: "row-main" }, [
          el("span", { class: "row-title", text: cleanQuestionText(question.question) }),
          el("span", { class: "row-meta" }, [
            el("span", { text: question.chapter || "章节待核对" }),
            el("span", { text: questionTypeOf(question) }),
            isMandatory
              ? el("span", { class: "row-status", text: "必选" })
              : isSelected
                ? el("span", { class: "row-status", text: "已选" })
                : null
          ]),
          isMandatory
            ? el("span", {
              class: "row-caption",
              text: "到期复习或今日待重拾，必选不可移除。"
            })
            : null
        ])
      ]);
    }

    function makePendingRow(question) {
      const item = el("li", { class: "pending-item" });
      const supplementButton = el("button", {
        class: "text-edit-button",
        type: "button",
        "aria-label": "为第 " + question.id + " 题补写答案",
        text: "补写答案"
      });
      supplementButton.addEventListener("click", function () {
        pendingEditorId = question.id;
        renderSelectionList();
        window.setTimeout(function () {
          const field = document.getElementById("pending-edit-" + question.id);
          if (field) {
            field.focus();
          }
        }, 0);
      });
      item.appendChild(el("div", {
        class: "question-row pending-question-row",
        "aria-label": "待补答案题目，可补写后加入计划"
      }, [
        el("span", { class: "row-main" }, [
          el("span", { class: "row-title", text: cleanQuestionText(question.question) }),
          el("span", { class: "row-meta" }, [
            el("span", { text: question.chapter || "章节待核对" }),
            el("span", { class: "row-status pending", text: "待补答案" })
          ])
        ]),
        supplementButton
      ]));
      if (pendingEditorId === question.id) {
        item.appendChild(buildAnswerForm(question, "", {
          idPrefix: "pending-edit",
          saveLabel: "保存并加入计划",
          onSave: function (text) {
            state.answerEdits[String(question.id)] = {
              text: text,
              updatedAt: isoNow(),
              updatedDate: todayKey()
            };
            const saved = saveState();
            pendingEditorId = null;
            renderApp({ scroll: "preserve" });
            showToast(saved
              ? "答案已补写，已加入可选题；可继续编辑修订。"
              : "答案已补写，但本机存储写入失败；仅当前页面有效。");
          },
          onCancel: function () {
            pendingEditorId = null;
            renderSelectionList();
          }
        }));
      }
      return item;
    }

    function appendSubheading(host, title, count) {
      host.appendChild(el("p", {
        class: "list-subhead",
        text: title + " · " + count + " 道"
      }));
    }

    function renderSelectionList() {
      const previewValue = getPlanPreview();
      const mandatorySet = new Set(previewValue.mandatory);
      const selectedSet = new Set(previewValue.mandatory.concat(previewValue.optional));
      const capacity = Math.max(0, previewValue.effectiveTarget - previewValue.mandatory.length);
      const optionalCount = previewValue.optional.length;
      const answerableNow = getAnswerableQuestions();
      const pendingNow = getPendingQuestions();
      const answerableFiltered = filterQuestions(answerableNow);
      const pendingFiltered = filterQuestions(pendingNow);
      clearNode(listHost);

      if (selectionFilter.mode === "answerable") {
        listMeta.replaceChildren(
          el("span", {}, ["筛选后 ", el("strong", { text: String(answerableFiltered.length) }), " 道"])
        );
        if (!answerableFiltered.length) {
          listHost.appendChild(el("p", {
            class: "list-empty",
            text: "该筛选下暂无有答案的题。可切换来源或章节，或查看待补答案题。"
          }));
          return;
        }
        const list = el("ul", { class: "question-list" });
        answerableFiltered.forEach(function (question) {
          list.appendChild(makeAnsweredRow(
            question,
            previewValue,
            selectedSet,
            mandatorySet,
            capacity,
            optionalCount
          ));
        });
        listHost.appendChild(list);
        if (optionalCount >= capacity && capacity > 0) {
          listHost.appendChild(el("p", {
            class: "list-footnote",
            text: "已选满今日目标；未选题目暂不可加入。可调大每日题量后继续选择。"
          }));
        }
        return;
      }

      if (selectionFilter.mode === "pending") {
        listMeta.replaceChildren(
          el("span", {}, ["筛选后 ", el("strong", { text: String(pendingFiltered.length) }), " 道"])
        );
        if (!pendingFiltered.length) {
          listHost.appendChild(el("p", {
            class: "list-empty",
            text: "该筛选下暂无待补答案题。"
          }));
          return;
        }
        const list = el("ul", { class: "question-list" });
        pendingFiltered.forEach(function (question) {
          list.appendChild(makePendingRow(question));
        });
        listHost.appendChild(list);
        listHost.appendChild(el("p", {
          class: "list-footnote",
          text: "待补题可以补写后加入计划；补写会记入“我的修订”，不会伪造 DSH 初稿。"
        }));
        return;
      }

      listMeta.replaceChildren(
        el("span", {}, [
          "筛选后 ",
          el("strong", { text: String(answerableFiltered.length + pendingFiltered.length) }),
          " 道"
        ])
      );
      if (!answerableFiltered.length && !pendingFiltered.length) {
        listHost.appendChild(el("p", {
          class: "list-empty",
          text: "该筛选下没有题目。"
        }));
        return;
      }
      if (answerableFiltered.length) {
        appendSubheading(listHost, "有答案", answerableFiltered.length);
        const answeredList = el("ul", { class: "question-list" });
        answerableFiltered.forEach(function (question) {
          answeredList.appendChild(makeAnsweredRow(
            question,
            previewValue,
            selectedSet,
            mandatorySet,
            capacity,
            optionalCount
          ));
        });
        listHost.appendChild(answeredList);
      }
      if (pendingFiltered.length) {
        appendSubheading(listHost, "待补答案", pendingFiltered.length);
        const pendingList = el("ul", { class: "question-list" });
        pendingFiltered.forEach(function (question) {
          pendingList.appendChild(makePendingRow(question));
        });
        listHost.appendChild(pendingList);
      }
      if (optionalCount >= capacity && capacity > 0) {
        listHost.appendChild(el("p", {
          class: "list-footnote",
          text: "已选满今日目标；未选题目暂不可加入。可调大每日题量后继续选择。"
        }));
      }
    }

    listHost.addEventListener("change", function (event) {
      const checkbox = event.target.closest("input[data-select-id]");
      if (!checkbox) {
        return;
      }
      const id = Number(checkbox.dataset.selectId);
      if (!answeredQuestion(id)) {
        checkbox.checked = false;
        return;
      }
      const previewValue = getPlanPreview();
      if (previewValue.mandatory.includes(id)) {
        checkbox.checked = true;
        showToast("必选题不能移除。");
        return;
      }
      const capacity = Math.max(0, previewValue.effectiveTarget - previewValue.mandatory.length);
      if (checkbox.checked) {
        if (previewValue.optional.length >= capacity) {
          checkbox.checked = false;
          showToast("已达到今日目标，先调大每日题量再添加。");
          return;
        }
        if (!state.selectedIds.includes(id)) {
          state.selectedIds.push(id);
        }
      } else {
        state.selectedIds = state.selectedIds.filter(function (value) { return value !== id; });
      }
      state.selectedIds = uniqueIds(state.selectedIds).filter(function (value) {
        return Boolean(answeredQuestion(value)) && !previewValue.mandatory.includes(value);
      });
      saveState();
      refreshSelectionSummary();
      renderSelectionList();
    });

    function refreshSelectionSummary() {
      const current = getPlanPreview();
      mandatoryCount.textContent = String(current.mandatory.length);
      optionalCount.textContent = String(current.optional.length);
      totalCount.textContent = String(current.total);
      clearNode(noticeHost);
      planNote.textContent = "今日目标 " + current.effectiveTarget + " 道。必选 " +
        current.mandatory.length + " + 自选 " + current.optional.length + " = " +
        current.total + " 道。";
      if (current.mandatory.length > current.target) {
        noticeHost.appendChild(el("p", {
          class: "notice",
          text: "今日必选 " + current.mandatory.length + " 道已超过设置题量 " +
            current.target + " 道。计划会自动扩容，必选题不会被丢弃。"
        }));
      } else if (current.mandatory.length === current.effectiveTarget) {
        noticeHost.appendChild(el("p", {
          class: "notice is-info",
          text: "必选已占满今日目标；如需增加自选，请先调大每日题量。"
        }));
      } else if (current.total < current.effectiveTarget) {
        noticeHost.appendChild(el("p", {
          class: "notice is-info",
          text: "还差 " + (current.effectiveTarget - current.total) +
            " 道可选；未选满也可以按当前已选数量生成计划。"
        }));
      }
      generateButton.textContent = "生成今日计划 · 已选 " + current.total + " 道";
      generateButton.setAttribute("aria-label", "按已选 " + current.total + " 道生成今日计划");
      generateButton.disabled = current.total === 0;
    }

    targetInput.addEventListener("input", function () {
      const limit = getAnswerableLimit();
      const value = Number(targetInput.value);
      if (Number.isFinite(value) && value >= 1 && value <= limit) {
        state.settings.dailyTarget = Math.round(value);
        saveState();
        refreshSelectionSummary();
      }
    });
    targetInput.addEventListener("change", function () {
      const limit = getAnswerableLimit();
      const value = clampInteger(targetInput.value, 1, limit, state.settings.dailyTarget);
      targetInput.value = String(value);
      state.settings.dailyTarget = value;
      trimOptionalSelection(getPlanPreview());
      saveState();
      refreshSelectionSummary();
      renderSelectionList();
    });

    function generatePlanFromSelection() {
      const current = getPlanPreview();
      if (!current.total) {
        showToast("请至少选择一道有答案的题。");
        return;
      }
      state.settings.dailyTarget = current.target;
      state.selectedIds = current.optional.slice();
      state.session = createSession(
        current.mandatory.concat(current.optional),
        current.mandatory,
        current.effectiveTarget
      );
      saveState();
      showToast("今日计划已生成：" + current.total + " 道");
      currentTab = "review";
      updateTabUI();
      renderApp({ scroll: "top", focus: true });
    }

    refreshSelectionSummary();
    renderSelectionList();
    main.appendChild(view);
  }

  /* ----------------------------------------------------------------------- */
  /* Statistics view                                                         */
  /* ----------------------------------------------------------------------- */

  function modelRecall(days, scale) {
    const s = Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1;
    return Math.pow(0.9, Math.max(0, Number(days) || 0) / s);
  }

  function bucketForInterval(days) {
    const value = Math.max(0, Number(days) || 0);
    return RECALL_BUCKETS.find(function (bucket) {
      return value >= bucket.min && value <= bucket.max;
    }) || RECALL_BUCKETS[RECALL_BUCKETS.length - 1];
  }

  function computeRecallData() {
    const ordered = state.history.map(function (entry, index) {
      const time = Date.parse(entry.at);
      return {
        entry: entry,
        index: index,
        time: Number.isFinite(time) ? time : (isDateKey(entry.date) ? dateFromKey(entry.date).getTime() : 0)
      };
    }).sort(function (left, right) {
      if (left.time !== right.time) {
        return left.time - right.time;
      }
      return left.index - right.index;
    });
    const byQuestion = new Map();
    ordered.forEach(function (item) {
      if (!byQuestion.has(item.entry.id)) {
        byQuestion.set(item.entry.id, []);
      }
      byQuestion.get(item.entry.id).push(item.entry);
    });
    const buckets = RECALL_BUCKETS.map(function (bucket) {
      return { bucket: bucket, known: 0, total: 0, rate: null };
    });
    function addSample(intervalDays, rating) {
      const bucket = bucketForInterval(intervalDays);
      const bucketIndex = RECALL_BUCKETS.findIndex(function (item) { return item.id === bucket.id; });
      if (bucketIndex < 0) {
        return;
      }
      buckets[bucketIndex].total += 1;
      if (rating === "known") {
        buckets[bucketIndex].known += 1;
      }
    }
    byQuestion.forEach(function (entries) {
      // 每题每个本地日只取第一次评价；只有该日之前（严格更早的日期）
      // 已有测试记录时才计入真实回忆率，避免同日反复揭晓/重做刷高。
      let previousTestDate = null;
      let currentDate = null;
      let firstRatingOfDay = null;
      function flushDay() {
        if (currentDate && previousTestDate && firstRatingOfDay &&
            currentDate > previousTestDate) {
          addSample(daysBetweenKeys(previousTestDate, currentDate), firstRatingOfDay.rating);
        }
      }
      entries.forEach(function (entry) {
        if (entry.date !== currentDate) {
          flushDay();
          if (currentDate) {
            previousTestDate = currentDate;
          }
          currentDate = entry.date;
          firstRatingOfDay = entry;
        }
      });
      flushDay();
    });
    buckets.forEach(function (entry) {
      entry.rate = entry.total ? entry.known / entry.total : null;
    });
    return buckets;
  }

  function computeStats() {
    const history = state.history.slice();
    const knownCount = history.filter(function (entry) { return entry.rating === "known"; }).length;
    const forgottenCount = history.filter(function (entry) { return entry.rating === "forgot"; }).length;
    const dates = history.map(function (entry) { return entry.date; }).filter(isDateKey).sort();
    const week = lastSevenKeys().map(function (key) {
      const ids = new Set();
      history.forEach(function (entry) {
        if (entry.date === key) {
          ids.add(entry.id);
        }
      });
      return { date: key, count: ids.size };
    });
    return {
      reviewedCount: history.length,
      knownCount: knownCount,
      forgottenCount: forgottenCount,
      startDate: dates.length ? dates[0] : null,
      endDate: todayKey(),
      week: week,
      recallBuckets: computeRecallData()
    };
  }

  function createRecallChart(recallBuckets) {
    const width = 360;
    const height = 214;
    const left = 38;
    const right = 24;
    const top = 14;
    const bottom = 34;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const actual = recallBuckets.filter(function (entry) {
      return entry.rate !== null;
    });
    const xForIndex = function (index) {
      return left + plotWidth * (index / (RECALL_BUCKETS.length - 1));
    };
    const yForRate = function (rate) {
      return top + plotHeight * (1 - Math.max(0, Math.min(1, rate)));
    };
    const svg = svgEl("svg", {
      class: "recall-chart",
      viewBox: "0 0 " + width + " " + height,
      role: "img",
      "aria-labelledby": "recall-chart-title recall-chart-desc"
    });
    svg.appendChild(svgEl("title", { id: "recall-chart-title", text: "记忆保持示意与实际回忆率" }));
    svg.appendChild(svgEl("desc", {
      id: "recall-chart-desc",
      text: actual.length
        ? "绿色曲线为 R(t)=0.9^(t/S)、S=1 天的参考模型；红色折线仅取每题每日第一次跨日评价，按真实间隔分桶。"
        : "绿色曲线为 R(t)=0.9^(t/S)、S=1 天的参考模型；本机尚无可计算间隔的真实跨日复习记录，因此不绘制红色实际曲线。"
    }));

    [0, 0.25, 0.5, 0.75, 1].forEach(function (rate) {
      const y = yForRate(rate);
      svg.appendChild(svgEl("line", {
        x1: String(left),
        y1: String(y),
        x2: String(width - right),
        y2: String(y),
        stroke: "rgba(23,61,99,0.12)",
        "stroke-width": "1"
      }));
      svg.appendChild(svgEl("text", {
        x: String(left - 7),
        y: String(y + 3),
        "text-anchor": "end",
        fill: "#63788D",
        "font-size": "9",
        "font-family": "Roboto, Noto Sans SC, Microsoft YaHei, sans-serif",
        text: Math.round(rate * 100) + "%"
      }));
    });

    RECALL_BUCKETS.forEach(function (bucket, index) {
      svg.appendChild(svgEl("text", {
        x: String(xForIndex(index)),
        y: String(top + plotHeight + 19),
        "text-anchor": "middle",
        fill: "#63788D",
        "font-size": "9",
        "font-family": "Roboto, Noto Sans SC, Microsoft YaHei, sans-serif",
        text: bucket.label
      }));
    });
    svg.appendChild(svgEl("text", {
      x: String(left + plotWidth / 2),
      y: String(height - 2),
      "text-anchor": "middle",
      fill: "#63788D",
      "font-size": "9",
      "font-family": "Roboto, Noto Sans SC, Microsoft YaHei, sans-serif",
      text: "复习间隔"
    }));

    const modelPoints = RECALL_BUCKETS.map(function (bucket, index) {
      return xForIndex(index) + "," + yForRate(modelRecall(bucket.modelT, 1));
    }).join(" ");
    svg.appendChild(svgEl("polyline", {
      points: modelPoints,
      fill: "none",
      stroke: "#3E8E65",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round"
    }));
    RECALL_BUCKETS.forEach(function (bucket, index) {
      svg.appendChild(svgEl("circle", {
        cx: String(xForIndex(index)),
        cy: String(yForRate(modelRecall(bucket.modelT, 1))),
        r: "2.5",
        fill: "#FFFFFF",
        stroke: "#3E8E65",
        "stroke-width": "1.4"
      }));
    });

    if (actual.length) {
      if (actual.length >= 2) {
        const actualPoints = actual.map(function (entry) {
          const index = RECALL_BUCKETS.findIndex(function (bucket) { return bucket.id === entry.bucket.id; });
          return xForIndex(index) + "," + yForRate(entry.rate);
        }).join(" ");
        svg.appendChild(svgEl("polyline", {
          points: actualPoints,
          fill: "none",
          stroke: "#B75D52",
          "stroke-width": "1.8",
          "stroke-linejoin": "round",
          "stroke-linecap": "round"
        }));
      }
      actual.forEach(function (entry) {
        const index = RECALL_BUCKETS.findIndex(function (bucket) { return bucket.id === entry.bucket.id; });
        const circle = svgEl("circle", {
          cx: String(xForIndex(index)),
          cy: String(yForRate(entry.rate)),
          r: "3.7",
          fill: "#B75D52",
          stroke: "#FFFFFF",
          "stroke-width": "1.4"
        });
        circle.appendChild(svgEl("title", {
          text: entry.bucket.label + "：" + Math.round(entry.rate * 100) + "%，n=" + entry.total
        }));
        svg.appendChild(circle);
      });
    }
    return svg;
  }

  function renderStats(main) {
    const stats = computeStats();
    const actual = stats.recallBuckets.filter(function (entry) { return entry.rate !== null; });
    const view = el("section", { class: "view", "aria-labelledby": "stats-title" });
    view.appendChild(el("header", { class: "page-head" }, [
      el("p", { class: "eyebrow", text: "真实日志 · 本地日界" }),
      el("h2", { class: "view-title", id: "stats-title", text: "统计" }),
      el("p", {
        class: "stats-range",
        text: stats.startDate
          ? "统计范围：" + formatDateKey(stats.startDate, true) + " 至 " + formatDateKey(stats.endDate, true) + "（本地日界）"
          : "统计范围：今天（本地日界）；尚无学习记录。"
      }),
      el("div", { class: "stat-grid", "aria-label": "学习次数统计" }, [
        el("div", { class: "stat-cell" }, [
          el("strong", { text: String(stats.reviewedCount) }),
          el("span", { text: "已复习 · 次" })
        ]),
        el("div", { class: "stat-cell" }, [
          el("strong", { text: String(stats.knownCount) }),
          el("span", { text: "熟记 · 次" })
        ]),
        el("div", { class: "stat-cell" }, [
          el("strong", { text: String(stats.forgottenCount) }),
          el("span", { text: "遗忘 · 次" })
        ])
      ])
    ]));

    const chartSection = el("section", { class: "section" });
    chartSection.appendChild(el("div", { class: "chart-heading-row" }, [
      el("h3", { class: "section-heading", text: "记忆曲线与真实回忆" }),
      el("span", { class: "chart-scale", text: "纵轴 · 回忆率" })
    ]));
    const emptyLegend = !actual.length;
    chartSection.appendChild(el("div", { class: "chart-legend", "aria-label": "图例" }, [
      el("span", { class: "legend-item" }, [
        el("span", { class: "legend-swatch", "aria-hidden": "true" }),
        "绿色参考模型 R(t)=0.9^(t/S)，S=1 天"
      ]),
      el("span", { class: "legend-item" + (emptyLegend ? " is-empty" : "") }, [
        el("span", { class: "legend-swatch actual", "aria-hidden": "true" }),
        emptyLegend ? "红色实际回忆率 · 待积累" : "红色实际回忆率 · 每日首次跨日"
      ])
    ]));
    chartSection.appendChild(createRecallChart(stats.recallBuckets));
    if (!actual.length) {
      chartSection.appendChild(el("p", {
        class: "chart-empty",
        text: "尚无“每题每日第一次跨日测试”的真实记录，红色实际曲线不会伪造显示。同一天反复揭晓或重做不计入回忆率。"
      }));
    } else {
      const table = el("table", { class: "bucket-table", "aria-label": "实际回忆率分桶明细" });
      table.appendChild(el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "间隔分桶" }),
          el("th", { text: "熟记" }),
          el("th", { text: "记录数" }),
          el("th", { text: "回忆率" })
        ])
      ]));
      const body = el("tbody");
      actual.forEach(function (entry) {
        body.appendChild(el("tr", {}, [
          el("td", { text: entry.bucket.label }),
          el("td", { text: String(entry.known) }),
          el("td", { text: String(entry.total) }),
          el("td", { text: Math.round(entry.rate * 100) + "%" })
        ]));
      });
      table.appendChild(body);
      chartSection.appendChild(table);
    }
    const algorithmDetails = el("details", { class: "algorithm-details" });
    algorithmDetails.appendChild(el("summary", { text: "推荐算法与统计口径" }));
    algorithmDetails.appendChild(el("p", {
      text: "这是产品启发式模型，不是墨墨背单词的算法，也不是任何原始记忆实验的精确复现。"
    }));
    algorithmDetails.appendChild(el("p", {
      text: "稳定度 S 表示预测保持 90% 回忆率的间隔天数，默认 S=1，范围 0.5—365 天。预测回忆率 R(t)=0.9^(t/S)，t 取距上次实际评价的真实毫秒数除以 86400000。"
    }));
    algorithmDetails.appendChild(el("p", {
      text: "目标保持率默认 r=0.9，推荐间隔 I=round(S×ln(r)/ln(0.9))，限制 1—365 天。初次熟记 S=3、三天后复习；初次遗忘 S=0.5、次日强制复习；跨日且距上次增长满 12 小时的熟记才增长，同日重复熟记不增长。"
    }));
    algorithmDetails.appendChild(el("p", {
      text: "每日计划先纳入全部到期和逾期题，不受每日题量上限丢弃；必选过多时自动扩容，自选题再填满剩余名额。排序为强制复习优先，然后预测回忆率更低、下次日期更早、稳定题号更小。"
    }));
    algorithmDetails.appendChild(el("p", {
      text: "当天遗忘仍使用原有队列：答完 3 道其他题后再现；这个当天队列与跨日 schedule 独立保存，互不覆盖。"
    }));
    algorithmDetails.appendChild(el("p", {
      text: "红色实际曲线只取每题每个本地日的第一次跨日评价（该日之前已有测试），排除同一天反复揭晓、重做造成的虚高，再按真实间隔天分桶；没有样本就保持空态，不绘制假红线。"
    }));
    chartSection.appendChild(algorithmDetails);
    view.appendChild(chartSection);

    const weekSection = el("section", { class: "section" });
    weekSection.appendChild(el("h3", { class: "section-heading", text: "过去 7 天学习量" }));
    const weekTotal = stats.week.reduce(function (sum, entry) { return sum + entry.count; }, 0);
    weekSection.appendChild(el("p", {
      class: "section-copy",
      text: "按每天实际作答过的不同题目计数；同一天重复作答不重复累加题数。"
    }));
    const maxCount = Math.max.apply(null, stats.week.map(function (entry) { return entry.count; }).concat([1]));
    const weekChart = el("div", { class: "week-chart", "aria-label": "过去七天每日不同题目数量" });
    stats.week.forEach(function (entry) {
      const isToday = entry.date === todayKey();
      const height = entry.count ? Math.max(7, Math.round(entry.count / maxCount * 68)) : 2;
      const column = el("div", {
        class: "week-column" + (isToday ? " is-today" : ""),
        role: "img",
        "aria-label": formatDateKey(entry.date) + "，学习 " + entry.count + " 道题目"
      }, [
        el("span", { class: "week-count", text: String(entry.count) }),
        el("span", { class: "week-bar", style: "height:" + height + "px" }),
        el("span", { class: "week-date", text: formatShortDate(entry.date) })
      ]);
      weekChart.appendChild(column);
    });
    weekSection.appendChild(weekChart);
    weekSection.appendChild(el("p", {
      class: "week-note",
      text: weekTotal
        ? "这 7 天共有 " + weekTotal + " 道不同题目被学习过。柱高只比较这 7 天内的相对学习量。"
        : "这 7 天尚无学习记录。完成第一道自评后，这里会出现真实的本地数据。"
    }));
    view.appendChild(weekSection);

    const noteSection = el("section", { class: "section" });
    noteSection.appendChild(el("h3", { class: "section-heading", text: "关于数字" }));
    noteSection.appendChild(el("p", {
      class: "section-copy",
      text: "所有统计都使用浏览器本地日期划分日界线，不把 UTC 零点当作“今天”。当前没有演示数据，也没有向统计写入虚构记录；实际回忆曲线需要真实数据积累后才会显示。"
    }));
    view.appendChild(noteSection);
    main.appendChild(view);
  }

  /* ----------------------------------------------------------------------- */
  /* Native installation sections (only active when AndroidBridge exists)     */
  /* ----------------------------------------------------------------------- */

  function nativeErrorText(error) {
    if (!error) {
      return "操作未完成，请稍后重试。";
    }
    const message = String(error.message || error || "").trim();
    return message || "操作未完成，请稍后重试。";
  }

  function nativeRead(method, timeoutMs) {
    if (!NATIVE_AVAILABLE) {
      return Promise.resolve({ ok: false, error: "当前为网页预览。" });
    }
    return window.NativeApp.call(method, {}, { timeoutMs: timeoutMs || 6000 }).then(function (data) {
      return { ok: true, data: data };
    }).catch(function (error) {
      return { ok: false, error: nativeErrorText(error) };
    });
  }

  function rerenderMe() {
    if (currentTab === "me") {
      renderApp({ scroll: "preserve" });
    }
  }

  function normalizeNativeReminder(value, fallbackTime) {
    const data = isPlainObject(value) ? value : {};
    const time = typeof data.time === "string" && /^\d{2}:\d{2}$/.test(data.time)
      ? data.time
      : fallbackTime;
    return {
      enabled: Boolean(data.enabled),
      time: time,
      platform: typeof data.platform === "string" ? data.platform : "android",
      permissionGranted: Boolean(data.permissionGranted),
      channelEnabled: data.channelEnabled === undefined ? null : Boolean(data.channelEnabled),
      exactAlarmAllowed: data.exactAlarmAllowed === undefined ? true : Boolean(data.exactAlarmAllowed)
    };
  }

  function ensureNativeMeData() {
    if (!NATIVE_AVAILABLE || nativeMe.loading || nativeMe.loaded) {
      return;
    }
    nativeMe.loading = true;
    Promise.all([
      nativeRead("getReminder", 6000).then(function (result) {
        if (result.ok) {
          nativeMe.reminder = normalizeNativeReminder(result.data, "20:30");
          nativeMe.reminderError = "";
          state.settings.reminder = {
            enabled: nativeMe.reminder.enabled,
            time: nativeMe.reminder.time
          };
        } else {
          nativeMe.reminderError = result.error;
        }
      }),
      nativeRead("listImports", 8000).then(function (result) {
        if (result.ok) {
          const list = Array.isArray(result.data)
            ? result.data
            : (isPlainObject(result.data) && Array.isArray(result.data.imports) ? result.data.imports : []);
          nativeMe.imports = list;
          nativeMe.importsError = "";
        } else {
          nativeMe.importsError = result.error;
        }
      }),
      nativeRead("getUpdateConfig", 6000).then(function (result) {
        if (result.ok) {
          nativeMe.updateConfig = {
            manifestUrl: isPlainObject(result.data) && typeof result.data.manifestUrl === "string"
              ? result.data.manifestUrl
              : "",
            usingDefault: isPlainObject(result.data) && result.data.usingDefault === true
          };
          nativeMe.updateError = "";
        } else {
          nativeMe.updateError = result.error;
        }
      }),
      nativeRead("appInfo", 6000).then(function (result) {
        if (result.ok) {
          const value = isPlainObject(result.data) ? result.data : {};
          nativeMe.appInfo = {
            versionName: typeof value.versionName === "string" ? value.versionName : APP_VERSION,
            versionCode: Number.isFinite(Number(value.versionCode)) ? Number(value.versionCode) : null,
            packageName: typeof value.packageName === "string" ? value.packageName : ""
          };
          nativeMe.appInfoError = "";
        } else {
          nativeMe.appInfoError = result.error;
        }
      }),
      nativeRead("getApiConfig", 6000).then(function (result) {
        if (result.ok) {
          nativeMe.apiConfig = isPlainObject(result.data) ? result.data : null;
          nativeMe.apiConfigError = "";
        } else {
          nativeMe.apiConfigError = result.error;
        }
      })
    ]).then(function () {
      nativeMe.loading = false;
      nativeMe.loaded = true;
      rerenderMe();
    }).catch(function () {
      nativeMe.loading = false;
      nativeMe.loaded = true;
      rerenderMe();
    });
  }

  function currentServiceConfig() {
    try {
      const live = window.StudyAISettings && typeof window.StudyAISettings.getNativeConfig === "function"
        ? window.StudyAISettings.getNativeConfig()
        : null;
      if (live && live.baseUrl) {
        return live;
      }
    } catch (error) {
      // 继续使用启动时缓存的非敏感配置。
    }
    return nativeMe.apiConfig;
  }

  function baseUrlHost(baseUrl) {
    try {
      return new URL(baseUrl).host;
    } catch (error) {
      return "";
    }
  }

  function reminderStatusText(reminder) {
    if (!reminder) {
      return "正在读取系统提醒状态…";
    }
    if (!reminder.enabled) {
      return "提醒已关闭。提醒时间仍可保存。";
    }
    if (!reminder.permissionGranted) {
      return "系统尚未允许通知，提醒不会生效。可在系统设置中允许通知后重试；提醒时间仍可保存。";
    }
    if (reminder.channelEnabled === false) {
      return "通知渠道已关闭，提醒暂时不会送达。请在系统设置中开启通知渠道；提醒时间仍可保存。";
    }
    if (reminder.exactAlarmAllowed === false) {
      return "系统未允许精确提醒，已改用普通提醒，实际送达可能延迟（省电或打盹模式下可能超过一小时）。可打开下方系统设置允许精确提醒；提醒时间仍可保存。";
    }
    return "系统已允许精确提醒。实际送达仍受系统通知权限、渠道与省电限制影响，不保证置顶或绝对准点。";
  }

  function saveNativeReminder(nextEnabled, nextTime, successMessage) {
    if (!NATIVE_AVAILABLE || nativeMe.reminderBusy) {
      return;
    }
    nativeMe.reminderBusy = true;
    rerenderMe();
    window.NativeApp.call("saveReminder", {
      enabled: Boolean(nextEnabled),
      time: nextTime
    }, { timeoutMs: 15000 }).then(function (result) {
      const reminder = normalizeNativeReminder(result, nextTime);
      nativeMe.reminder = reminder;
      nativeMe.reminderError = "";
      state.settings.reminder = { enabled: reminder.enabled, time: reminder.time };
      saveState();
      nativeMe.reminderBusy = false;
      if (nextEnabled && (!reminder.enabled || !reminder.permissionGranted)) {
        showToast("提醒未启用：系统未允许通知或通知渠道关闭。提醒时间已经保存。");
      } else if (nextEnabled && reminder.channelEnabled === false) {
        showToast("提醒未生效：系统通知渠道已关闭。提醒时间已经保存。");
      } else {
        const base = successMessage ||
          (reminder.enabled ? "提醒已启用。" : "提醒已关闭，时间已保存。");
        showToast(base + (nextEnabled && reminder.exactAlarmAllowed === false
          ? " 系统未允许精确提醒，送达可能延迟。"
          : ""));
      }
      rerenderMe();
    }).catch(function (error) {
      nativeMe.reminderBusy = false;
      showToast("提醒保存未完成：" + nativeErrorText(error));
      rerenderMe();
    });
  }

  function requestNativeExactAlarmPermission() {
    if (!NATIVE_AVAILABLE || nativeMe.reminderBusy || !nativeMe.reminder) {
      return;
    }
    const fallbackTime = nativeMe.reminder.time;
    nativeMe.reminderBusy = true;
    rerenderMe();
    window.NativeApp.call("requestExactAlarmPermission", {}, { timeoutMs: 120000 })
      .then(function (result) {
        const reminder = normalizeNativeReminder(result, fallbackTime);
        nativeMe.reminder = reminder;
        nativeMe.reminderError = "";
        state.settings.reminder = { enabled: reminder.enabled, time: reminder.time };
        saveState();
        nativeMe.reminderBusy = false;
        showToast(reminder.exactAlarmAllowed === false
          ? "尚未允许精确提醒；提醒仍会送达，但可能延迟。"
          : "已允许精确提醒，提醒已按本地时间重新安排。");
        rerenderMe();
      }).catch(function (error) {
        nativeMe.reminderBusy = false;
        showToast("打开精确提醒设置未完成：" + nativeErrorText(error));
        rerenderMe();
      });
  }

  function buildNativeReminderSection() {
    const reminder = nativeMe.reminder;
    const busy = Boolean(nativeMe.reminderBusy);
    const section = el("section", { class: "settings-block", id: "native-reminder-section" });
    section.appendChild(el("h3", { class: "section-heading", text: "每日提醒" }));
    section.appendChild(el("p", {
      class: "section-copy",
      text: DESKTOP_AVAILABLE ? "提醒在电脑本地发送，不需要账户。请保持应用运行；关闭应用或电脑休眠时不会按时提醒。可将窗口最小化，Windows 通知权限与专注模式也会影响送达。" : "提醒由安装版在本地发送，不需要账户。允许精确提醒时会按本地时间安排；未允许或受系统省电策略影响时可能延迟，不保证置顶或绝对准点。"
    }));
    if (nativeMe.reminderError) {
      section.appendChild(el("p", {
        class: "notice is-error",
        text: "暂时无法读取系统提醒状态：" + nativeMe.reminderError + " 仍可保存提醒时间，或稍后重新进入本页重试。"
      }));
    }
    const switchButton = el("button", {
      class: "switch",
      type: "button",
      role: "switch",
      "aria-checked": reminder && reminder.enabled ? "true" : "false",
      "aria-label": "每日提醒开关",
      disabled: busy || !reminder
    });
    switchButton.addEventListener("click", function () {
      if (busy || !reminder) {
        return;
      }
      saveNativeReminder(!reminder.enabled, reminder.time,
        reminder.enabled ? "提醒已关闭，时间已保存。" : "提醒已启用。");
    });
    section.appendChild(el("div", { class: "reminder-row" }, [
      el("div", {}, [
        el("span", { class: "setting-label", text: "提醒开关" }),
        el("span", {
          class: "setting-sub",
          text: reminder && reminder.enabled ? "当前在系统提醒中启用" : "当前关闭；可先保存时间"
        })
      ]),
      switchButton
    ]));
    const timeInput = el("input", {
      class: "time-input",
      id: "reminder-time",
      type: "time",
      value: reminder ? reminder.time : (state.settings.reminder.time || "20:30"),
      "aria-label": "每日提醒时间"
    });
    timeInput.disabled = busy;
    timeInput.addEventListener("change", function () {
      if (!/^\d{2}:\d{2}$/.test(timeInput.value)) {
        return;
      }
      const enabled = reminder ? reminder.enabled : false;
      if (!reminder) {
        nativeMe.reminder = normalizeNativeReminder({
          enabled: false,
          time: timeInput.value,
          permissionGranted: false
        }, timeInput.value);
        state.settings.reminder = { enabled: false, time: timeInput.value };
        saveState();
      }
      nativeMe.reminderBusy = true;
      rerenderMe();
      window.NativeApp.call("saveReminder", {
        enabled: enabled,
        time: timeInput.value
      }, { timeoutMs: 15000 }).then(function (result) {
        nativeMe.reminder = normalizeNativeReminder(result, timeInput.value);
        nativeMe.reminderError = "";
        state.settings.reminder = {
          enabled: nativeMe.reminder.enabled,
          time: nativeMe.reminder.time
        };
        saveState();
        nativeMe.reminderBusy = false;
        if (nativeMe.reminder.enabled) {
          showToast("提醒时间已保存。" +
            (nativeMe.reminder.permissionGranted ? "" : " 系统通知权限未授予，提醒暂不会生效。") +
            (nativeMe.reminder.exactAlarmAllowed === false ? " 系统未允许精确提醒，送达可能延迟。" : ""));
        } else {
          showToast("提醒时间已保存；提醒开关当前关闭。");
        }
        rerenderMe();
      }).catch(function (error) {
        nativeMe.reminderBusy = false;
        showToast("提醒时间保存未完成：" + nativeErrorText(error));
        rerenderMe();
      });
    });
    section.appendChild(el("div", { class: "reminder-time-row" }, [
      el("label", { class: "setting-label", for: "reminder-time", text: "提醒时间" }),
      timeInput
    ]));
    if (reminder && reminder.exactAlarmAllowed === false) {
      const exactButton = el("button", {
        class: "secondary-button",
        type: "button",
        id: "native-exact-alarm-settings",
        text: busy ? "正在打开系统设置…" : "打开精确提醒设置",
        disabled: busy
      });
      exactButton.addEventListener("click", requestNativeExactAlarmPermission);
      section.appendChild(el("div", { class: "reminder-time-row" }, [
        el("label", { class: "setting-label", text: "精确提醒" }),
        exactButton
      ]));
    }
    section.appendChild(el("p", {
      class: "reminder-note",
      id: "native-reminder-status",
      text: busy ? "正在应用提醒设置…" : reminderStatusText(reminder)
    }));
    return section;
  }

  /* ----------------------------------------------------------------------- */
  /* Native import and draft flow                                            */
  /* ----------------------------------------------------------------------- */

  function normalizeStoredDraft(raw) {
    if (!isPlainObject(raw)) {
      return null;
    }
    const question = typeof raw.question === "string" ? raw.question.slice(0, 20000) : "";
    const answer = typeof raw.answer === "string" ? raw.answer.slice(0, 40000) : "";
    if (!question.trim() || !answer.trim()) {
      return null;
    }
    return {
      question: question,
      answer: answer,
      type: typeof raw.type === "string" && raw.type.trim() ? raw.type.trim().slice(0, 40) : "简答题",
      chapter: typeof raw.chapter === "string" ? raw.chapter.slice(0, 120) : "",
      sourceQuote: typeof raw.sourceQuote === "string" ? raw.sourceQuote.slice(0, 20000) : "",
      pageIndex: Number.isFinite(Number(raw.pageIndex)) ? Math.round(Number(raw.pageIndex)) : null,
      locator: typeof raw.locator === "string" ? raw.locator.slice(0, 300) : "",
      selected: raw.selected !== false
    };
  }

  function loadImportDraftState() {
    const empty = {
      document: null,
      pageIndexes: [],
      drafts: [],
      draftsImportId: null,
      draftsImportName: "",
      busy: "",
      message: "",
      messageTone: "info",
      restored: false
    };
    if (typeof window === "undefined" || !window.localStorage) {
      return empty;
    }
    try {
      const raw = window.localStorage.getItem(DRAFT_STORE_KEY);
      if (!raw) {
        return empty;
      }
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed) || !Array.isArray(parsed.drafts)) {
        return empty;
      }
      const drafts = parsed.drafts.map(normalizeStoredDraft).filter(Boolean).slice(0, MAX_IMPORT_DRAFTS);
      if (!drafts.length || parsed.importId === undefined || parsed.importId === null) {
        return empty;
      }
      const name = typeof parsed.importName === "string" && parsed.importName
        ? parsed.importName.slice(0, 240)
        : "上次导入的资料";
      return {
        document: {
          id: parsed.importId,
          name: name,
          format: typeof parsed.format === "string" ? parsed.format : "",
          pages: [],
          needsOcr: false
        },
        pageIndexes: [],
        drafts: drafts,
        draftsImportId: parsed.importId,
        draftsImportName: name,
        busy: "",
        message: "已从本机恢复上次未确认的草稿；请核对后再决定是否加入题库。",
        messageTone: "info",
        restored: true
      };
    } catch (error) {
      return empty;
    }
  }

  function persistImportDraftState() {
    if (typeof window === "undefined" || !window.localStorage) {
      return false;
    }
    const drafts = Array.isArray(nativeImportState.drafts) ? nativeImportState.drafts : [];
    if (!drafts.length || nativeImportState.draftsImportId === null ||
        nativeImportState.draftsImportId === undefined) {
      try {
        window.localStorage.removeItem(DRAFT_STORE_KEY);
      } catch (error) {
        // 草稿存储失败不影响当前页面操作。
      }
      return false;
    }
    try {
      window.localStorage.setItem(DRAFT_STORE_KEY, JSON.stringify({
        version: 1,
        savedAt: isoNow(),
        importId: nativeImportState.draftsImportId,
        importName: nativeImportState.draftsImportName,
        format: nativeImportState.document ? nativeImportState.document.format : "",
        drafts: drafts.map(function (draft) {
          return {
            question: draft.question,
            answer: draft.answer,
            type: draft.type,
            chapter: draft.chapter,
            sourceQuote: draft.sourceQuote,
            pageIndex: draft.pageIndex,
            locator: draft.locator,
            selected: draft.selected !== false
          };
        })
      }));
      return true;
    } catch (error) {
      return false;
    }
  }

  function scheduleDraftPersist() {
    if (typeof window === "undefined") {
      return;
    }
    if (draftPersistTimer) {
      window.clearTimeout(draftPersistTimer);
    }
    draftPersistTimer = window.setTimeout(function () {
      draftPersistTimer = null;
      persistImportDraftState();
    }, 250);
  }

  function clearImportDraftState() {
    if (draftPersistTimer) {
      window.clearTimeout(draftPersistTimer);
      draftPersistTimer = null;
    }
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.removeItem(DRAFT_STORE_KEY);
      }
    } catch (error) {
      // 清理失败时保留草稿，不删除用户内容。
    }
  }

  function normalizeImportDocument(raw) {
    if (!isPlainObject(raw) || raw.id === undefined || raw.id === null) {
      return null;
    }
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 240) : "";
    if (!name) {
      return null;
    }
    const pages = (Array.isArray(raw.pages) ? raw.pages : []).map(function (page, index) {
      if (!isPlainObject(page)) {
        return null;
      }
      const pageIndex = Number(page.pageIndex);
      return {
        pageIndex: Number.isInteger(pageIndex) ? pageIndex : index,
        locator: typeof page.locator === "string" && page.locator.trim()
          ? page.locator.trim().slice(0, 300)
          : "位置待核对",
        text: typeof page.text === "string" ? page.text : "",
        needsOcr: Boolean(page.needsOcr),
        ocr: Boolean(page.ocr)
      };
    }).filter(Boolean);
    return {
      id: raw.id,
      name: name,
      format: typeof raw.format === "string" ? raw.format.slice(0, 20) : "",
      pages: pages,
      needsOcr: Boolean(raw.needsOcr),
      truncated: Boolean(raw.truncated),
      note: typeof raw.note === "string" ? raw.note.slice(0, 4000) : ""
    };
  }

  function importPageTextLength(page) {
    return page && typeof page.text === "string" ? page.text.length : 0;
  }

  function selectedImportPages() {
    const documentValue = nativeImportState.document;
    if (!documentValue) {
      return [];
    }
    const wanted = new Set((nativeImportState.pageIndexes || []).map(String));
    return documentValue.pages.filter(function (page) {
      return wanted.has(String(page.pageIndex));
    });
  }

  function selectedImportChars() {
    return selectedImportPages().reduce(function (total, page) {
      return total + importPageTextLength(page);
    }, 0);
  }

  function selectedImportText() {
    return selectedImportPages().map(function (page) {
      return "【" + page.locator + "】\n" + page.text;
    }).join("\n\n");
  }

  function selectedImportLocators() {
    return selectedImportPages().map(function (page) { return page.locator; });
  }

  function defaultImportPageIndexes(documentValue) {
    const selected = [];
    let total = 0;
    (documentValue.pages || []).forEach(function (page) {
      const length = importPageTextLength(page);
      if (length <= 0) {
        return;
      }
      if (total + length <= MAX_IMPORT_CHARS) {
        selected.push(page.pageIndex);
        total += length;
      }
    });
    return selected;
  }

  function importDraftTypeOptions(currentType) {
    const types = [];
    const support = window.QuestionTypeSupport;
    const base = support && Array.isArray(support.TYPE_ORDER)
      ? support.TYPE_ORDER
      : ["名词解释", "填空题", "判断题", "选择题", "简答题", "论述题", "读图分析题", "分类与配对题"];
    base.forEach(function (type) {
      if (type && !types.includes(type)) {
        types.push(type);
      }
    });
    questions.forEach(function (question) {
      const type = questionTypeOf(question);
      if (type && !types.includes(type)) {
        types.push(type);
      }
    });
    (nativeImportState.drafts || []).forEach(function (draft) {
      if (draft.type && !types.includes(draft.type)) {
        types.push(draft.type);
      }
    });
    if (currentType && !types.includes(currentType)) {
      types.push(currentType);
    }
    return types;
  }

  function setImportMessage(message, tone) {
    nativeImportState.message = message || "";
    nativeImportState.messageTone = tone === "error" ? "error" : "info";
  }

  function selectedDrafts() {
    return (nativeImportState.drafts || []).filter(function (draft) {
      return draft.selected !== false;
    });
  }

  function updateDraftSelectionLimit() {
    const drafts = nativeImportState.drafts || [];
    const selectedCount = drafts.filter(function (draft) { return draft.selected !== false; }).length;
    return selectedCount >= MAX_IMPORT_DRAFTS;
  }

  function pickNativeImport() {
    if (!NATIVE_AVAILABLE || nativeImportState.busy) {
      return;
    }
    nativeImportState.busy = "pick";
    setImportMessage("正在打开系统文件选择器…", "info");
    rerenderMe();
    window.NativeApp.call("pickImport", {}, { timeoutMs: 600000 }).then(function (result) {
      const documentValue = normalizeImportDocument(result);
      if (!documentValue) {
        throw new Error("没有读到可用的文件内容。");
      }
      nativeImportState.busy = "";
      nativeImportState.document = documentValue;
      nativeImportState.pageIndexes = defaultImportPageIndexes(documentValue);
      if (Array.isArray(nativeMe.imports)) {
        const existing = nativeMe.imports.some(function (item) {
          return isPlainObject(item) && String(item.id) === String(documentValue.id);
        });
        if (!existing) {
          nativeMe.imports.unshift({
            id: documentValue.id,
            name: documentValue.name,
            format: documentValue.format,
            pageCount: documentValue.pages.length,
            needsOcr: documentValue.needsOcr
          });
        }
      }
      if (!nativeImportState.document.pages.length) {
        setImportMessage("文件已导入，但没有读到可预览的页段；可重试或换一个文件。", "error");
      } else if (!nativeImportState.pageIndexes.length) {
        setImportMessage("文件已解析，但单个页段超过 12000 字，无法一次发送。请换用较小的页段或文件。", "error");
      } else {
        setImportMessage("已解析原文。请检查页段与发送范围；在你点击发送按钮前不会调用 AI。", "info");
      }
      rerenderMe();
    }).catch(function (error) {
      nativeImportState.busy = "";
      const message = nativeErrorText(error);
      setImportMessage(/取消|cancel/i.test(message)
        ? "已取消选择，没有导入文件，当前内容未改变。"
        : "未能导入文件：" + message,
      /取消|cancel/i.test(message) ? "info" : "error");
      rerenderMe();
    });
  }

  function openNativeImport(id) {
    if (!NATIVE_AVAILABLE || nativeImportState.busy) {
      return;
    }
    nativeImportState.busy = "history";
    setImportMessage("正在读取历史资料…", "info");
    rerenderMe();
    window.NativeApp.call("getImport", { id: id }, { timeoutMs: 30000 }).then(function (result) {
      const documentValue = normalizeImportDocument(result);
      if (!documentValue) {
        throw new Error("历史资料内容为空或格式不正确。");
      }
      nativeImportState.busy = "";
      nativeImportState.document = documentValue;
      nativeImportState.pageIndexes = defaultImportPageIndexes(documentValue);
      if (nativeImportState.drafts.length) {
        setImportMessage("已打开历史资料；未确认草稿仍保留，可继续确认，也可用这份资料重新生成。", "info");
      } else {
        setImportMessage("已打开历史资料。选择页段后才会发送；默认不自动外发。", "info");
      }
      rerenderMe();
    }).catch(function (error) {
      nativeImportState.busy = "";
      setImportMessage("未能打开历史资料：" + nativeErrorText(error), "error");
      rerenderMe();
    });
  }

  function generateNativeImport() {
    if (!NATIVE_AVAILABLE || nativeImportState.busy || !nativeImportState.document) {
      return;
    }
    const config = currentServiceConfig();
    const pages = selectedImportPages();
    const chars = selectedImportChars();
    if (!config || !config.baseUrl) {
      setImportMessage("尚未完成 AI 接口设置，无法生成。请先在“AI 解析设置”中保存服务地址和模型。", "error");
      rerenderMe();
      return;
    }
    if (!config.model) {
      setImportMessage("尚未填写模型名称。请先在“AI 解析设置”中手动填写服务提供的模型；不会猜测模型。", "error");
      rerenderMe();
      return;
    }
    if (!config.hasKey) {
      setImportMessage("尚未保存 API Key。请先在“AI 解析设置”中保存密钥，再发送所选原文。", "error");
      rerenderMe();
      return;
    }
    if (!pages.length) {
      setImportMessage("请至少选择一个有原文的页段。", "error");
      rerenderMe();
      return;
    }
    if (chars > MAX_IMPORT_CHARS) {
      setImportMessage("所选原文共 " + chars + " 字，超过单次 12000 字上限，请减少页段。", "error");
      rerenderMe();
      return;
    }
    if (nativeImportState.drafts.length) {
      const replace = window.confirm("重新生成会替换当前未确认草稿，但不会影响已加入题库的题目。继续？");
      if (!replace) {
        setImportMessage("已取消重新生成，现有草稿保留。", "info");
        rerenderMe();
        return;
      }
    }
    nativeImportState.busy = "generate";
    setImportMessage("正在发送所选原文并生成草稿…", "info");
    rerenderMe();
    window.NativeApp.call("generate", {
      importId: nativeImportState.document.id,
      pageIndexes: pages.map(function (page) { return page.pageIndex; }),
      maxQuestions: clampInteger(config.maxQuestions, 1, MAX_IMPORT_DRAFTS, 5)
    }, { timeoutMs: 180000 }).then(function (result) {
      const rawQuestions = Array.isArray(result && result.questions) ? result.questions : [];
      const drafts = rawQuestions.map(function (raw) {
        if (!isPlainObject(raw)) {
          return null;
        }
        const question = typeof raw.question === "string" ? raw.question.trim() : "";
        const answer = typeof raw.answer === "string" ? raw.answer.trim() : "";
        if (!question || !answer) {
          return null;
        }
        return {
          question: question.slice(0, 20000),
          answer: answer.slice(0, 40000),
          type: typeof raw.type === "string" && raw.type.trim() ? raw.type.trim() : "简答题",
          chapter: typeof raw.chapter === "string" ? raw.chapter.slice(0, 120) : "",
          sourceQuote: typeof raw.sourceQuote === "string" ? raw.sourceQuote.slice(0, 20000) : "",
          pageIndex: Number.isFinite(Number(raw.pageIndex)) ? Math.round(Number(raw.pageIndex)) : null,
          locator: typeof raw.locator === "string" ? raw.locator.slice(0, 300) : "",
          selected: true
        };
      }).filter(Boolean).slice(0, MAX_IMPORT_DRAFTS);
      if (!drafts.length) {
        throw new Error("服务没有返回可用的问答草稿，请检查模型输出或稍后重试。");
      }
      nativeImportState.busy = "";
      nativeImportState.drafts = drafts;
      nativeImportState.draftsImportId = result && result.importId !== undefined
        ? result.importId
        : nativeImportState.document.id;
      nativeImportState.draftsImportName = result && typeof result.sourceName === "string" && result.sourceName
        ? result.sourceName.slice(0, 240)
        : nativeImportState.document.name;
      nativeImportState.restored = false;
      persistImportDraftState();
      setImportMessage("已生成 " + drafts.length + " 道草稿，默认全选。可逐条修改题干、答案、题型和章节；只有点击确认后才加入题库。", "info");
      rerenderMe();
    }).catch(function (error) {
      nativeImportState.busy = "";
      setImportMessage("生成未完成：" + nativeErrorText(error) + " 原文没有被加入题库，可调整范围后重试。", "error");
      rerenderMe();
    });
  }

  function buildAcceptQuestionsPayload(drafts) {
    return (Array.isArray(drafts) ? drafts : []).map(function (draft) {
      const pageIndex = Number(draft.pageIndex);
      return {
        question: String(draft.question || "").trim(),
        answer: String(draft.answer || "").trim(),
        type: String(draft.type || "").trim(),
        chapter: String(draft.chapter || "").trim(),
        sourceQuote: String(draft.sourceQuote || ""),
        pageIndex: Number.isFinite(pageIndex) ? Math.round(pageIndex) : 0,
        locator: String(draft.locator || "")
      };
    });
  }

  function acceptNativeDrafts() {
    if (!NATIVE_AVAILABLE || nativeImportState.busy) {
      return;
    }
    const drafts = selectedDrafts();
    if (!drafts.length) {
      setImportMessage("请至少勾选一道草稿再确认。", "error");
      rerenderMe();
      return;
    }
    if (drafts.length > MAX_IMPORT_DRAFTS) {
      setImportMessage("一次最多确认 10 道草稿。", "error");
      rerenderMe();
      return;
    }
    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index];
      if (!String(draft.question || "").trim() || !String(draft.answer || "").trim()) {
        setImportMessage("第 " + (index + 1) + " 道草稿的题干或答案为空，请补全后再确认。", "error");
        rerenderMe();
        return;
      }
      if (!String(draft.type || "").trim()) {
        setImportMessage("第 " + (index + 1) + " 道草稿缺少题型，请选择后再确认。", "error");
        rerenderMe();
        return;
      }
    }
    persistImportDraftState();
    nativeImportState.busy = "accept";
    setImportMessage("正在加入题库…", "info");
    rerenderMe();
    window.NativeApp.call("acceptQuestions", {
      importId: nativeImportState.draftsImportId,
      questions: buildAcceptQuestionsPayload(drafts)
    }, { timeoutMs: 60000 }).then(function (result) {
      const count = result && Number.isFinite(Number(result.count)) ? Number(result.count) : drafts.length;
      if (!(count > 0)) {
        throw new Error("没有题目被保存，草稿仍保留。");
      }
      nativeImportState.busy = "";
      nativeImportState.drafts = [];
      nativeImportState.restored = false;
      clearImportDraftState();
      showToast("已加入题库 " + count + " 道，正在重新载入题库。");
      setImportMessage("已加入题库；页面即将重新载入以合并新题、题型和来源。", "info");
      rerenderMe();
      window.setTimeout(function () {
        window.location.reload();
      }, 450);
    }).catch(function (error) {
      nativeImportState.busy = "";
      setImportMessage("确认加入题库未完成：" + nativeErrorText(error) + " 草稿仍保留在本机，可重试。", "error");
      rerenderMe();
    });
  }

  function buildNativeImportSection() {
    const section = el("section", {
      class: "settings-block native-import",
      id: "native-import-section"
    });
    section.appendChild(el("h3", { class: "section-heading", text: "导入学习资料" }));
    section.appendChild(el("p", {
      class: "section-copy",
      text: "从安装版文件选择器导入 PDF、DOCX、MD、HTML 或 TXT。文件先在本地解析；页段原文只有在你确认后才发送，用于生成问答草稿。"
    }));
    const pickButton = el("button", {
      class: "secondary-button",
      type: "button",
      id: "native-pick-import",
      text: nativeImportState.busy === "pick" ? "正在打开选择器…" : "选择文件并解析",
      disabled: Boolean(nativeImportState.busy)
    });
    pickButton.addEventListener("click", pickNativeImport);
    section.appendChild(el("div", { class: "import-actions" }, [pickButton]));
    if (nativeImportState.message) {
      section.appendChild(el("p", {
        class: "notice" + (nativeImportState.messageTone === "error" ? " is-error" : " is-info"),
        role: "status",
        text: nativeImportState.message
      }));
    }

    const documentValue = nativeImportState.document;
    if (documentValue) {
      const header = el("div", { class: "native-import-head" }, [
        el("div", {}, [
          el("p", { class: "native-import-name", text: documentValue.name }),
          el("p", {
            class: "native-import-meta",
            text: (documentValue.format ? String(documentValue.format).toUpperCase() + " · " : "") +
              documentValue.pages.length + " 个页段" +
              (documentValue.needsOcr ? " · 含扫描页，中文识别由安装版处理" : "")
          })
        ])
      ]);
      section.appendChild(header);
      if (documentValue.note || documentValue.truncated || documentValue.needsOcr) {
        section.appendChild(el("p", {
          class: "notice is-info",
          text: [documentValue.note,
            documentValue.truncated ? "资料已截断，未提取的部分不会发送。" : "",
            documentValue.needsOcr ? (DESKTOP_AVAILABLE
              ? "部分页面需 OCR，电脑版未识别这些页，请核对原文。"
              : "存在识别不完整的页面，请先核对原文再发送。") : ""
          ].filter(Boolean).join(" ")
        }));
      }

      if (!documentValue.pages.length) {
        section.appendChild(el("p", {
          class: nativeImportState.drafts.length ? "notice is-info" : "notice is-error",
          text: nativeImportState.drafts.length
            ? "这份资料是重载后恢复的，原文页段未重复保存在网页；未确认草稿仍可编辑和加入题库。要重新生成时，请在下方历史导入中重新打开文件。"
            : "没有可显示的页段。请重新选择文件；若为扫描 PDF，安装版会先做中文识别。"
        }));
      } else {
        section.appendChild(el("p", {
          class: "section-copy",
          text: "勾选要发送的原文页段。单次最多 12000 字；不会把整个资料库或其他文件一起发送。"
        }));
        const pageList = el("div", { class: "native-pages", "aria-label": "原文页段预览与选择" });
        const selectedSet = new Set(nativeImportState.pageIndexes.map(String));
        documentValue.pages.forEach(function (page) {
          const length = importPageTextLength(page);
          const selected = selectedSet.has(String(page.pageIndex));
          const willExceed = !selected && selectedImportChars() + length > MAX_IMPORT_CHARS;
          const checkbox = el("input", {
            class: "row-check",
            type: "checkbox",
            "data-page-index": String(page.pageIndex),
            checked: selected,
            disabled: Boolean(nativeImportState.busy) || length <= 0 || willExceed,
            "aria-label": "选择页段：" + page.locator
          });
          checkbox.addEventListener("change", function () {
            const key = String(page.pageIndex);
            const current = new Set(nativeImportState.pageIndexes.map(String));
            if (checkbox.checked) {
              if (selectedImportChars() + length > MAX_IMPORT_CHARS) {
                checkbox.checked = false;
                setImportMessage("所选原文会超过 12000 字上限，已取消这个页段。", "error");
                rerenderMe();
                return;
              }
              current.add(key);
            } else {
              current.delete(key);
            }
            nativeImportState.pageIndexes = documentValue.pages
              .filter(function (item) { return current.has(String(item.pageIndex)); })
              .map(function (item) { return item.pageIndex; });
            rerenderMe();
          });
          const pageCard = el("div", { class: "native-page" + (selected ? " is-selected" : "") }, [
            el("div", { class: "native-page-head" }, [
              checkbox,
              el("span", { class: "native-page-locator", text: page.locator }),
              el("span", { class: "native-page-count", text: length + " 字" })
            ])
          ]);
          if (length > 0) {
            const details = el("details", { class: "native-page-details" });
            details.appendChild(el("summary", {
              text: "展开原文页段（" + length + " 字）"
            }));
            details.appendChild(el("pre", {
              class: "native-page-text",
              text: page.text
            }));
            pageCard.appendChild(details);
          } else {
            pageCard.appendChild(el("p", {
              class: "tiny-note",
              text: "这一页没有可用文字；扫描页由安装版中文 OCR 处理。"
            }));
          }
          pageList.appendChild(pageCard);
        });
        section.appendChild(pageList);

        const chars = selectedImportChars();
        const locators = selectedImportLocators();
        const config = currentServiceConfig();
        section.appendChild(el("p", {
          class: "native-import-count",
          text: "已选 " + nativeImportState.pageIndexes.length + " 段 · " + chars +
            " / " + MAX_IMPORT_CHARS + " 字"
        }));
        if (!config || !config.baseUrl || !config.model || !config.hasKey) {
          section.appendChild(el("p", {
            class: "notice is-error",
            text: "发送前还需要完成 AI 接口设置（服务地址、模型和密钥）。不会在缺少设置时假装生成成功。"
          }));
          const aiLink = el("button", {
            class: "text-edit-button",
            type: "button",
            text: "打开 AI 解析设置"
          });
          aiLink.addEventListener("click", function () {
            const details = document.getElementById("ai-settings");
            if (details) {
              details.open = true;
              details.scrollIntoView({ block: "start" });
            }
          });
          section.appendChild(aiLink);
        }
        const sendPanel = el("div", { class: "native-send-panel" }, [
          el("p", { class: "native-send-title", text: "发送前确认" }),
          el("dl", { class: "native-send-meta" }, [
            el("dt", { text: "服务" }),
            el("dd", { text: config && config.serviceName ? config.serviceName : "尚未设置" }),
            el("dt", { text: "地址" }),
            el("dd", { text: config && config.baseUrl ? baseUrlHost(config.baseUrl) : "尚未设置" }),
            el("dt", { text: "模型" }),
            el("dd", { text: config && config.model ? config.model : "尚未填写（不会猜测）" }),
            el("dt", { text: "密钥" }),
            el("dd", { text: config && config.hasKey ? "已保存（不显示）" : "尚未保存" }),
            el("dt", { text: "文件" }),
            el("dd", { text: documentValue.name }),
            el("dt", { text: "所选位置" }),
            el("dd", { text: locators.length ? locators.join("；") : "尚未选择" }),
            el("dt", { text: "字数" }),
            el("dd", { text: chars + " 字（单次最多 " + MAX_IMPORT_CHARS + " 字）" })
          ])
        ]);
        if (locators.length) {
          const textDetails = el("details", { class: "native-send-text" });
          textDetails.appendChild(el("summary", {
            text: "展开将发送的原文全文（" + chars + " 字）"
          }));
          textDetails.appendChild(el("pre", {
            class: "native-page-text",
            text: selectedImportText()
          }));
          sendPanel.appendChild(textDetails);
        }
        sendPanel.appendChild(el("p", {
          class: "tiny-note",
          text: "原文只作为内容，不会被当作指令。只发送勾选页段，不会上传整库。"
        }));
        const generateButton = el("button", {
          class: "primary-button",
          type: "button",
          id: "native-generate-import",
          text: nativeImportState.busy === "generate"
            ? "正在生成…"
            : "发送所选原文并生成问答",
          disabled: Boolean(nativeImportState.busy) || !locators.length || chars > MAX_IMPORT_CHARS ||
            !config || !config.baseUrl || !config.model || !config.hasKey
        });
        generateButton.addEventListener("click", generateNativeImport);
        sendPanel.appendChild(generateButton);
        section.appendChild(sendPanel);
      }
    }

    const drafts = nativeImportState.drafts || [];
    if (drafts.length) {
      const draftSection = el("div", { class: "native-drafts", id: "native-drafts" });
      draftSection.appendChild(el("h4", {
        class: "native-drafts-title",
        text: "待确认草稿 · " + drafts.length + " 道"
      }));
      draftSection.appendChild(el("p", {
        class: "section-copy",
        text: "默认全选；只有点击下方确认按钮才会加入题库。可修改题干、答案、题型和章节，引用与出处保持可见。"
      }));
      if (nativeImportState.restored) {
        draftSection.appendChild(el("p", {
          class: "notice is-info",
          text: "已从本机恢复上次未确认的草稿。原文全文如需重看，可在历史导入中重新打开；这不影响确认草稿。"
        }));
      }
      if (nativeImportState.draftsImportName &&
          (!nativeImportState.document || String(nativeImportState.document.id) !== String(nativeImportState.draftsImportId))) {
        draftSection.appendChild(el("p", {
          class: "tiny-note",
          text: "这些草稿来自：" + nativeImportState.draftsImportName + "。当前打开的预览资料不改变草稿的加入目标。"
        }));
      }
      const acceptButton = el("button", {
        class: "primary-button",
        type: "button",
        id: "native-accept-drafts",
        text: nativeImportState.busy === "accept"
          ? "正在加入题库…"
          : "确认加入题库 · " + selectedDrafts().length + " 道",
        disabled: Boolean(nativeImportState.busy) || selectedDrafts().length === 0
      });
      acceptButton.addEventListener("click", acceptNativeDrafts);
      drafts.forEach(function (draft, index) {
        const card = el("div", { class: "native-draft" });
        const checkbox = el("input", {
          class: "row-check",
          type: "checkbox",
          "data-draft-select": String(index),
          checked: draft.selected !== false,
          disabled: Boolean(nativeImportState.busy) ||
            (draft.selected === false && updateDraftSelectionLimit()),
          "aria-label": "选择第 " + (index + 1) + " 道草稿"
        });
        checkbox.addEventListener("change", function () {
          draft.selected = checkbox.checked;
          persistImportDraftState();
          rerenderMe();
        });
        card.appendChild(el("div", { class: "native-draft-head" }, [
          checkbox,
          el("span", { class: "native-draft-number", text: "草稿 " + (index + 1) }),
          el("span", {
            class: "native-draft-locator",
            text: (draft.locator || "出处待核对") +
              (Number.isFinite(Number(draft.pageIndex)) ? " · 页段 " + draft.pageIndex : "")
          })
        ]));
        function fieldBlock(label, field, tag, rows) {
          const wrapper = el("label", { class: "native-draft-field" }, [
            el("span", { class: "field-label", text: label })
          ]);
          let input;
          if (tag === "textarea") {
            input = el("textarea", {
              class: "answer-edit-textarea",
              rows: rows || "3",
              "data-draft-field": field,
              "data-draft-index": String(index)
            });
            input.value = draft[field] || "";
          } else {
            input = el("input", {
              class: "text-input",
              type: "text",
              "data-draft-field": field,
              "data-draft-index": String(index),
              value: draft[field] || ""
            });
          }
          input.disabled = Boolean(nativeImportState.busy);
          input.addEventListener("input", function () {
            draft[field] = input.value;
            scheduleDraftPersist();
          });
          input.addEventListener("change", function () {
            draft[field] = input.value;
            persistImportDraftState();
          });
          wrapper.appendChild(input);
          return wrapper;
        }
        card.appendChild(fieldBlock("题干（可修改）", "question", "textarea", "3"));
        card.appendChild(fieldBlock("答案（可修改）", "answer", "textarea", "5"));
        const typeWrapper = el("label", { class: "native-draft-field" }, [
          el("span", { class: "field-label", text: "题型" })
        ]);
        const typeSelect = el("select", {
          class: "select-input",
          "data-draft-field": "type",
          "data-draft-index": String(index),
          disabled: Boolean(nativeImportState.busy)
        }, importDraftTypeOptions(draft.type).map(function (type) {
          return el("option", {
            value: type,
            text: type,
            selected: type === draft.type
          });
        }));
        typeSelect.addEventListener("change", function () {
          draft.type = typeSelect.value;
          persistImportDraftState();
        });
        typeWrapper.appendChild(typeSelect);
        card.appendChild(typeWrapper);
        card.appendChild(fieldBlock("章节（可修改）", "chapter", "input"));
        if (draft.sourceQuote) {
          card.appendChild(el("div", { class: "native-draft-quote" }, [
            el("p", { class: "field-label", text: "原文引用" }),
            el("blockquote", { text: draft.sourceQuote })
          ]));
        }
        draftSection.appendChild(card);
      });
      draftSection.appendChild(acceptButton);
      section.appendChild(draftSection);
    }

    const importHistory = el("details", { class: "library-details native-import-history" });
    importHistory.appendChild(el("summary", {
      text: "历史导入" + (Array.isArray(nativeMe.imports) ? " · " + nativeMe.imports.length + " 份" : "")
    }));
    if (nativeMe.importsError) {
      importHistory.appendChild(el("p", {
        class: "notice is-error",
        text: "历史导入读取失败：" + nativeMe.importsError
      }));
    } else if (!Array.isArray(nativeMe.imports)) {
      importHistory.appendChild(el("p", { class: "tiny-note", text: "正在读取历史导入…" }));
    } else if (!nativeMe.imports.length) {
      importHistory.appendChild(el("p", { class: "tiny-note", text: "还没有导入记录。" }));
    } else {
      const list = el("ul", { class: "import-list" });
      nativeMe.imports.forEach(function (item) {
        if (!isPlainObject(item)) {
          return;
        }
        const id = item.id;
        if (id === undefined || id === null) {
          return;
        }
        const openButton = el("button", {
          class: "text-edit-button",
          type: "button",
          text: nativeImportState.busy === "history" ? "读取中…" : "查看并生成",
          disabled: Boolean(nativeImportState.busy)
        });
        openButton.addEventListener("click", function () {
          openNativeImport(id);
        });
        const meta = [
          typeof item.format === "string" ? String(item.format).toUpperCase() : "",
          Number.isFinite(Number(item.pageCount)) ? Number(item.pageCount) + " 页段" : "",
          item.needsOcr ? "含扫描页" : ""
        ].filter(Boolean).join(" · ");
        list.appendChild(el("li", { class: "import-row native-history-row" }, [
          el("div", { class: "native-history-main" }, [
            el("span", { class: "import-name", text: typeof item.name === "string" ? item.name : "未命名资料" }),
            el("span", { class: "import-meta", text: meta })
          ]),
          openButton
        ]));
      });
      importHistory.appendChild(list);
    }
    section.appendChild(importHistory);
    return section;
  }

  /* ----------------------------------------------------------------------- */
  /* Native backup, restore, update and about                                */
  /* ----------------------------------------------------------------------- */

  function validateRestoredState(raw) {
    if (!isPlainObject(raw)) {
      return null;
    }
    const keys = ["settings", "referenceIds", "selectedIds", "answerEdits", "session",
      "history", "imports", "schedule", "lastUpdated", "schemaVersion"];
    const hasContent = ["settings", "referenceIds", "selectedIds", "answerEdits", "session",
      "history", "imports", "schedule"].some(function (key) {
      return Object.prototype.hasOwnProperty.call(raw, key);
    });
    if (!hasContent) {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(raw, "settings") && !isPlainObject(raw.settings)) {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(raw, "answerEdits") && !isPlainObject(raw.answerEdits)) {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(raw, "schedule") && !isPlainObject(raw.schedule)) {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(raw, "session") &&
        raw.session !== null && !isPlainObject(raw.session)) {
      return null;
    }
    const arrayKeys = ["referenceIds", "selectedIds", "history", "imports"];
    for (let index = 0; index < arrayKeys.length; index += 1) {
      const key = arrayKeys[index];
      if (Object.prototype.hasOwnProperty.call(raw, key) && !Array.isArray(raw[key])) {
        return null;
      }
    }
    const clean = {};
    keys.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) {
        clean[key] = raw[key];
      }
    });
    clean.schemaVersion = SCHEMA_VERSION;
    if (typeof clean.lastUpdated !== "string" && clean.lastUpdated !== null) {
      clean.lastUpdated = null;
    }
    return clean;
  }

  function exportNativeBackup() {
    if (!NATIVE_AVAILABLE || nativeExportBusy) {
      return;
    }
    const payload = sanitizeForExport(clone(state));
    nativeExportBusy = true;
    rerenderMe();
    window.NativeApp.call("exportBackup", {
      json: JSON.stringify(payload)
    }, { timeoutMs: 120000 }).then(function () {
      nativeExportBusy = false;
      showToast("学习资料备份已生成；备份包含学习记录、计划与自定义题，不含 API Key。");
      rerenderMe();
    }).catch(function (error) {
      nativeExportBusy = false;
      showToast("导出未完成：" + nativeErrorText(error));
      rerenderMe();
    });
  }

  function restoreNativeBackup() {
    if (!NATIVE_AVAILABLE || nativeRestoreBusy) {
      return;
    }
    nativeRestoreBusy = true;
    rerenderMe();
    window.NativeApp.call("importBackup", {}, { timeoutMs: 120000 }).then(function (result) {
      const candidate = isPlainObject(result) && isPlainObject(result.state)
        ? result.state
        : (isPlainObject(result) && Object.prototype.hasOwnProperty.call(result, "settings") ? result : null);
      const clean = validateRestoredState(candidate);
      if (!clean) {
        throw new Error("备份内容缺少必要的学习记录结构，当前记录没有改动。");
      }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
      } catch (error) {
        throw new Error("本机存储不可用，无法写入恢复记录；当前记录没有改动。");
      }
      nativeRestoreBusy = false;
      nativeRestoreConfirm = false;
      showToast("已恢复备份，正在重新载入本机学习记录。");
      window.setTimeout(function () {
        window.location.reload();
      }, 450);
    }).catch(function (error) {
      nativeRestoreBusy = false;
      nativeRestoreConfirm = false;
      showToast("恢复未完成：" + nativeErrorText(error));
      rerenderMe();
    });
  }

  function buildNativeExportSection() {
    const section = el("section", { class: "export-block", id: "native-export-section" });
    section.appendChild(el("h3", { class: "section-heading", text: "学习记录" }));
    section.appendChild(el("p", {
      class: "section-copy",
      text: "导出完整学习记录：设置、计划、真实作答日志、我的答案修订（" +
        Object.keys(state.answerEdits).length + " 条）、资料登记与星标。安装版会合并自定义题库。备份不含 API Key。"
    }));
    const exportButton = el("button", {
      class: "secondary-button",
      type: "button",
      id: "native-export-backup",
      text: nativeExportBusy ? "正在生成备份…" : "导出学习数据",
      disabled: nativeExportBusy || nativeRestoreBusy
    });
    exportButton.addEventListener("click", exportNativeBackup);
    section.appendChild(exportButton);

    const restoreButton = el("button", {
      class: "secondary-button",
      type: "button",
      id: "native-restore-backup",
      text: "恢复备份",
      disabled: nativeRestoreBusy || nativeExportBusy
    });
    restoreButton.addEventListener("click", function () {
      if (nativeRestoreBusy || nativeExportBusy) {
        return;
      }
      nativeRestoreConfirm = true;
      rerenderMe();
    });
    section.appendChild(restoreButton);
    if (nativeRestoreConfirm) {
      section.appendChild(el("div", { class: "notice native-restore-confirm" }, [
        el("p", {
          text: "恢复备份会替换当前学习记录、计划、日志、修订和本机题库内容。建议先导出一份备份。是否继续？"
        }),
        el("div", { class: "native-restore-actions" }, [
          (function () {
            const cancel = el("button", {
              class: "secondary-button",
              type: "button",
              text: "取消",
              disabled: nativeRestoreBusy
            });
            cancel.addEventListener("click", function () {
              nativeRestoreConfirm = false;
              rerenderMe();
            });
            return cancel;
          })(),
          (function () {
            const confirm = el("button", {
              class: "primary-button",
              type: "button",
              id: "native-confirm-restore",
              text: nativeRestoreBusy ? "正在恢复…" : "确认替换并选择备份",
              disabled: nativeRestoreBusy
            });
            confirm.addEventListener("click", restoreNativeBackup);
            return confirm;
          })()
        ])
      ]));
    }
    section.appendChild(el("p", {
      class: "tiny-note",
      text: "恢复不会清理其他本机设置；只替换当前学习记录键，并在写入前校验备份结构。"
    }));
    return section;
  }

  function validateManifestUrl(raw) {
    const input = String(raw || "").trim();
    if (!input) {
      return { ok: true, value: "" };
    }
    let parsed;
    try {
      parsed = new URL(input);
    } catch (error) {
      return { ok: false, error: "发布清单地址格式不正确。" };
    }
    if (parsed.protocol !== "https:") {
      return { ok: false, error: "发布清单地址必须使用 HTTPS。" };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, error: "发布清单地址不能包含用户名或密码。" };
    }
    return { ok: true, value: parsed.href };
  }

  function saveNativeUpdateConfig(manifestUrl) {
    if (!NATIVE_AVAILABLE || nativeMe.updateBusy) {
      return;
    }
    const check = validateManifestUrl(manifestUrl);
    if (!check.ok) {
      showToast(check.error);
      return;
    }
    nativeMe.updateBusy = true;
    rerenderMe();
    window.NativeApp.call("saveUpdateConfig", {
      manifestUrl: check.value
    }, { timeoutMs: 15000 }).then(function (result) {
      nativeMe.updateBusy = false;
      nativeMe.updateConfig = {
        manifestUrl: isPlainObject(result) && typeof result.manifestUrl === "string"
          ? result.manifestUrl
          : check.value,
        usingDefault: isPlainObject(result) && result.usingDefault === true
      };
      nativeMe.updateCheck = null;
      nativeMe.updateBannerDismissed = false;
      nativeMe.updateError = "";
      showToast(nativeMe.updateConfig.manifestUrl
        ? "发布清单地址已保存。"
        : "发布清单地址已清除；检查更新将不可用。");
      rerenderMe();
    }).catch(function (error) {
      nativeMe.updateBusy = false;
      showToast("发布清单地址保存未完成：" + nativeErrorText(error));
      rerenderMe();
    });
  }

  function normalizeNativeUpdate(value) {
    const data = isPlainObject(value) ? value : {};
    return {
      available: data.available === true,
      versionCode: Number.isFinite(Number(data.versionCode)) ? Number(data.versionCode) : null,
      versionName: typeof data.versionName === "string" ? data.versionName : "",
      notes: typeof data.notes === "string" ? data.notes.slice(0, 4000) : "",
      apkUrl: typeof data.apkUrl === "string" ? data.apkUrl : "",
      sha256: typeof data.sha256 === "string" ? data.sha256 : ""
    };
  }

  // Native pushes a throttled startup/resume result here. The banner reuses the
  // existing verified download/installer path; it never installs silently.
  function showNativeUpdateAvailable(value) {
    const update = normalizeNativeUpdate(value);
    if (!update.available) {
      return false;
    }
    const previousCode = nativeMe.updateCheck ? nativeMe.updateCheck.versionCode : null;
    if (previousCode !== update.versionCode) {
      nativeMe.updateBannerDismissed = false;
    }
    nativeMe.updateCheck = update;
    nativeMe.updateError = "";
    if (typeof document !== "undefined" && appScrollElement) {
      renderApp({ scroll: "preserve" });
    }
    return true;
  }

  function checkNativeUpdate() {
    if (!NATIVE_AVAILABLE || nativeMe.updateBusy) {
      return;
    }
    nativeMe.updateBusy = true;
    nativeMe.updateCheck = null;
    rerenderMe();
    window.NativeApp.call("checkUpdate", {}, { timeoutMs: 60000 }).then(function (result) {
      nativeMe.updateBusy = false;
      nativeMe.updateCheck = normalizeNativeUpdate(result);
      nativeMe.updateBannerDismissed = false;
      nativeMe.updateError = "";
      renderApp({ scroll: "preserve" });
    }).catch(function (error) {
      nativeMe.updateBusy = false;
      nativeMe.updateCheck = null;
      nativeMe.updateError = nativeErrorText(error);
      rerenderMe();
    });
  }

  function installNativeUpdate() {
    const update = nativeMe.updateCheck;
    if (!NATIVE_AVAILABLE || nativeMe.updateBusy || !update || !update.available) {
      return;
    }
    nativeMe.updateBusy = true;
    rerenderMe();
    window.NativeApp.call("installUpdate", {
      versionCode: update.versionCode,
      apkUrl: update.apkUrl,
      sha256: update.sha256
    }, { timeoutMs: 180000 }).then(function () {
      nativeMe.updateBusy = false;
      showToast("已交给系统下载安装；请按系统提示确认。签名与版本校验由安装版完成。");
      rerenderMe();
    }).catch(function (error) {
      nativeMe.updateBusy = false;
      showToast("下载安装未完成：" + nativeErrorText(error));
      rerenderMe();
    });
  }

  function buildNativeUpdateBanner() {
    if (!NATIVE_AVAILABLE || !nativeMe.updateCheck || !nativeMe.updateCheck.available ||
        nativeMe.updateBannerDismissed) {
      return null;
    }
    const update = nativeMe.updateCheck;
    const install = el("button", {
      class: "primary-button",
      type: "button",
      id: "native-update-banner-install",
      text: nativeMe.updateBusy ? "正在处理…" : "下载并安装",
      disabled: nativeMe.updateBusy
    });
    install.addEventListener("click", installNativeUpdate);
    const later = el("button", {
      class: "secondary-button",
      type: "button",
      id: "native-update-banner-dismiss",
      text: "稍后",
      disabled: nativeMe.updateBusy
    });
    later.addEventListener("click", function () {
      nativeMe.updateBannerDismissed = true;
      renderApp({ scroll: "preserve" });
    });
    return el("section", {
      class: "update-banner",
      id: "native-update-banner",
      role: "status"
    }, [
      el("div", { class: "update-banner-copy" }, [
        el("p", {
          class: "update-banner-title",
          text: "发现新版本 " + (update.versionName || "版本号待核对")
        }),
        el("p", {
          class: "update-banner-text",
          text: "下载后会校验 SHA256、包名、签名和版本，再交由系统安装确认；" +
            "同签名覆盖安装会保留本机学习记录。"
        }),
        update.notes ? el("p", { class: "update-banner-notes", text: update.notes }) : null
      ]),
      el("div", { class: "update-banner-actions" }, [install, later])
    ]);
  }

  function buildNativeUpdateSection() {
    const section = el("section", { class: "settings-block native-update", id: "native-update-section" });
    const details = el("details", { class: "library-details native-update-details", open: nativeUpdateOpen });
    details.addEventListener("toggle", function () {
      nativeUpdateOpen = Boolean(details.open);
    });
    details.appendChild(el("summary", { text: "版本与更新" }));
    details.appendChild(el("p", {
      class: "section-copy",
      text: "默认使用官方更新清单，也可换成自己的 HTTPS 地址；不会覆盖已保存的自定义地址。检查更新无需账号，学习功能保持离线。"
    }));
    const manifestValue = nativeMe.updateConfig && typeof nativeMe.updateConfig.manifestUrl === "string"
      ? nativeMe.updateConfig.manifestUrl
      : "";
    const usingDefault = Boolean(nativeMe.updateConfig && nativeMe.updateConfig.usingDefault);
    const input = el("input", {
      class: "text-input",
      id: "native-update-manifest",
      type: "url",
      inputmode: "url",
      autocomplete: "off",
      value: manifestValue,
      placeholder: "https://example.com/update.json（可留空以关闭自动检查）",
      "aria-label": "更新发布清单 HTTPS 地址，可留空",
      disabled: nativeMe.updateBusy
    });
    details.appendChild(el("label", {
      class: "field-label",
      for: "native-update-manifest",
      text: "发布清单地址"
    }));
    details.appendChild(input);
    const saveButton = el("button", {
      class: "secondary-button",
      type: "button",
      id: "native-save-update-config",
      text: nativeMe.updateBusy ? "正在保存…" : "保存发布地址",
      disabled: nativeMe.updateBusy
    });
    saveButton.addEventListener("click", function () {
      saveNativeUpdateConfig(input.value);
    });
    details.appendChild(el("div", { class: "native-update-actions" }, [saveButton]));
    if (nativeMe.updateError) {
      details.appendChild(el("p", {
        class: "notice is-error",
        text: nativeMe.updateError
      }));
    }
    if (usingDefault) {
      details.appendChild(el("p", {
        class: "notice is-info",
        text: "当前使用官方默认清单。清空输入并保存可关闭自动检查；保存自定义 HTTPS 地址会覆盖默认地址。"
      }));
    }
    if (!manifestValue) {
      details.appendChild(el("p", {
        class: "notice is-info",
        text: DESKTOP_AVAILABLE ? "尚未设置发布地址，无法检查更新。使用官方安装包覆盖安装可保留本机学习记录。" : "尚未设置发布地址，无法检查更新，也不能说“已是最新版”。可用同签名 APK 覆盖安装，本机学习记录会保留。"
      }));
    }
    const checkButton = el("button", {
      class: "secondary-button",
      type: "button",
      id: "native-check-update",
      text: nativeMe.updateBusy ? "正在检查…" : "检查更新",
      disabled: nativeMe.updateBusy
    });
    checkButton.addEventListener("click", checkNativeUpdate);
    details.appendChild(el("div", { class: "native-update-actions" }, [checkButton]));
    if (nativeMe.updateCheck) {
      const update = nativeMe.updateCheck;
      if (update.available) {
        const box = el("div", { class: "native-update-result" }, [
          el("p", { class: "native-update-title", text: "发现新版本 " + (update.versionName || "版本号待核对") }),
          el("p", {
            class: "tiny-note",
            text: (update.versionCode ? "版本代码 " + update.versionCode + " · " : "") +
              (DESKTOP_AVAILABLE ? "更新清单通过签名验证后，再校验安装包 SHA256、应用标识与版本。" : "下载前会由安装版校验 SHA256、包名、签名与版本。")
          }),
          update.notes ? el("p", { class: "native-update-notes", text: update.notes }) : null
        ]);
        const installButton = el("button", {
          class: "primary-button",
          type: "button",
          id: "native-install-update",
          text: nativeMe.updateBusy ? "正在处理…" : "下载并安装",
          disabled: nativeMe.updateBusy
        });
        installButton.addEventListener("click", installNativeUpdate);
        box.appendChild(installButton);
        details.appendChild(box);
      } else {
        details.appendChild(el("p", {
          class: "notice is-info",
          text: "当前发布清单没有更高的正式版本" +
            (update.versionName ? "（清单版本 " + update.versionName + "）" : "") +
            "。这不表示永久无需更新；发布地址或清单更新后可再次检查。"
        }));
      }
    }
    details.appendChild(el("p", {
      class: "tiny-note",
      text: DESKTOP_AVAILABLE ? "下载完成后打开 Windows 安装向导，覆盖安装保留学习记录和设置。请先关闭正在运行的平江安澜；安装器可能显示 Windows 安全提示。" : "安装更新会走系统安装确认，不绕过系统未知来源授权。同签名 APK 覆盖安装会保留本机学习记录。"
    }));
    section.appendChild(details);
    return section;
  }

  function buildNativeAboutSection() {
    const info = nativeMe.appInfo;
    const versionName = info && info.versionName ? info.versionName : APP_VERSION;
    const section = el("section", { class: "about-block", id: "native-about-section" });
    section.appendChild(el("p", {
      class: "about-version",
      text: "平江安澜 v" + versionName
    }));
    section.appendChild(el("p", {
      text: "离线复习 · AI 解析联网"
    }));
    section.appendChild(el("p", {
      text: "题库、修订、计划与学习日志保存在本机；可随时导出备份，备份不含 API Key。"
    }));
    if (info && info.versionCode !== null) {
      section.appendChild(el("p", {
        class: "tiny-note",
        text: "版本代码 " + info.versionCode + (info.packageName ? " · " + info.packageName : "")
      }));
    }
    if (nativeMe.appInfoError) {
      section.appendChild(el("p", {
        class: "tiny-note",
        text: "暂时无法读取完整版本信息；不影响离线复习。"
      }));
    }
    const generatedSummary = getGeneratedSummary();
    section.appendChild(el("p", {
      text: "题库 " + questions.length + " 道 · 有答案 " + getAnswerableQuestions().length +
        " 道 · 待补答案 " + getPendingQuestions().length + " 道 · 我的修订 " +
        Object.keys(state.answerEdits).length + " 条"
    }));
    section.appendChild(el("p", {
      class: "tiny-note",
      text: "DSH 初稿 " + generatedSummary.total + " 道，均为未审定初稿；可核对引用与出处。"
    }));
    return section;
  }

  /* ----------------------------------------------------------------------- */
  /* Me view                                                                 */
  /* ----------------------------------------------------------------------- */

  function buildBrowserReminderSection() {
    const section = el("section", { class: "settings-block" });
    section.appendChild(el("h3", { class: "section-heading", text: "每日提醒" }));
    section.appendChild(el("p", {
      class: "section-copy",
      text: "预览版只保存提醒偏好；安卓系统通知将在安装版接入，当前不会真的发送通知。"
    }));
    const switchButton = el("button", {
      class: "switch",
      type: "button",
      role: "switch",
      "aria-checked": state.settings.reminder.enabled ? "true" : "false",
      "aria-label": "每日提醒开关，仅保存本地偏好"
    });
    const reminderNote = el("p", { class: "reminder-note" });
    function updateReminderNote() {
      reminderNote.replaceChildren(
        el("strong", { text: "安卓通知待安装版实现。" }),
        " 当前切换仅保存本地偏好，不会启用系统通知，也不会在后台唤醒；不保证置顶或准点。"
      );
    }
    switchButton.addEventListener("click", function () {
      state.settings.reminder.enabled = !state.settings.reminder.enabled;
      switchButton.setAttribute("aria-checked", state.settings.reminder.enabled ? "true" : "false");
      const saved = saveState();
      updateReminderNote();
      if (!saved) {
        showToast("提醒偏好已更新，但本机存储写入失败；仅当前页面有效。");
      } else {
        showToast(state.settings.reminder.enabled
          ? "提醒偏好已保存；系统通知待安装版实现。"
          : "提醒偏好已关闭，仅保存在本机。");
      }
    });
    section.appendChild(el("div", { class: "reminder-row" }, [
      el("div", {}, [
        el("span", { class: "setting-label", text: "提醒开关" }),
        el("span", { class: "setting-sub", text: "仅本地保存，不伪装成已启用通知。" })
      ]),
      switchButton
    ]));
    const timeInput = el("input", {
      class: "time-input",
      id: "reminder-time",
      type: "time",
      value: state.settings.reminder.time,
      "aria-label": "每日提醒时间，仅保存本地偏好"
    });
    timeInput.addEventListener("change", function () {
      if (/^\d{2}:\d{2}$/.test(timeInput.value)) {
        state.settings.reminder.time = timeInput.value;
        saveState();
      }
    });
    section.appendChild(el("div", { class: "reminder-time-row" }, [
      el("label", { class: "setting-label", for: "reminder-time", text: "提醒时间" }),
      timeInput
    ]));
    section.appendChild(reminderNote);
    updateReminderNote();
    return section;
  }

  function buildBrowserImportSection() {
    const section = el("section", { class: "settings-block" });
    section.appendChild(el("h3", { class: "section-heading", text: "导入学习资料" }));
    section.appendChild(el("p", {
      class: "section-copy",
      text: "点选或拖放 PDF、DOCX、MD、HTML、TXT。预览版只登记文件元数据，不读取、不解析文件内容。"
    }));
    const fileInput = el("input", {
      class: "file-input",
      id: "file-input",
      type: "file",
      accept: ".pdf,.docx,.md,.html,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/html,text/plain",
      multiple: true,
      "aria-label": "选择要登记的学习资料"
    });
    const fileButton = el("button", {
      class: "secondary-button",
      type: "button",
      "aria-label": "选择要登记的学习资料文件",
      text: "选择文件"
    });
    const dropzone = el("div", { class: "dropzone" }, [
      el("p", {
        class: "dropzone-copy",
        text: "将文件拖到这里，或使用文件选择器。文件内容不会被上传或解析。"
      }),
      fileButton,
      fileInput
    ]);
    fileButton.addEventListener("click", function () {
      fileInput.click();
    });
    fileInput.addEventListener("change", function () {
      handleFiles(fileInput.files);
      fileInput.value = "";
    });
    ["dragenter", "dragover"].forEach(function (eventName) {
      dropzone.addEventListener(eventName, function (event) {
        event.preventDefault();
        dropzone.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (eventName) {
      dropzone.addEventListener(eventName, function (event) {
        event.preventDefault();
        dropzone.classList.remove("is-dragover");
      });
    });
    dropzone.addEventListener("drop", function (event) {
      handleFiles(event.dataTransfer ? event.dataTransfer.files : null);
    });
    section.appendChild(dropzone);
    section.appendChild(el("p", {
      class: "import-note",
      text: "已登记，内容解析待安装版接入。预览版绝不使用导入文件名或内容拼接到页面结构中。"
    }));

    const importList = el("ul", { class: "import-list", "aria-label": "已登记的导入资料" });
    if (!state.imports.length) {
      section.appendChild(el("p", {
        class: "import-empty",
        text: "还没有导入登记。所选文件只会保存名称、格式、大小和登记时间。"
      }));
    } else {
      state.imports.forEach(function (file) {
        importList.appendChild(el("li", { class: "import-row" }, [
          el("span", { class: "import-name", text: file.name }),
          el("span", { class: "import-meta" }, [
            el("span", { text: String(file.format).toUpperCase() }),
            el("span", { text: formatFileSize(file.size) }),
            el("span", { text: formatDateKey(file.registeredDate, true) + " 登记" }),
            el("span", { class: "import-status", text: "已登记 · 内容解析待安装版接入" })
          ])
        ]));
      });
      section.appendChild(importList);
    }
    return section;
  }

  function buildBrowserExportSection() {
    const section = el("section", { class: "export-block" });
    section.appendChild(el("h3", { class: "section-heading", text: "学习记录" }));
    section.appendChild(el("p", {
      class: "section-copy",
      text: "导出包含设置、计划、真实作答日志、我的答案修订（" +
        Object.keys(state.answerEdits).length + " 条）、资料登记和星标的 JSON。导出只在本机生成下载，不发起网络请求。"
    }));
    const exportButton = el("button", {
      class: "secondary-button",
      type: "button",
      "aria-label": "导出学习记录 JSON 文件",
      text: "导出学习记录 JSON"
    });
    exportButton.addEventListener("click", exportLearningRecord);
    section.appendChild(exportButton);
    const restoreButton = el("button", {
      class: "secondary-button",
      type: "button",
      id: "browser-restore-disabled",
      text: "恢复备份（仅安装版）",
      disabled: true,
      "aria-label": "恢复备份仅在安卓安装版可用"
    });
    section.appendChild(restoreButton);
    section.appendChild(el("p", {
      class: "tiny-note",
      text: "网页预览不能选择本机 JSON 恢复学习记录；恢复备份功能仅在安卓安装版启用。"
    }));
    return section;
  }

  function buildBrowserUpdateSection() {
    const section = el("section", { class: "settings-block" });
    const details = el("details", { class: "library-details native-update-details" });
    details.appendChild(el("summary", { text: "版本与更新" }));
    details.appendChild(el("p", {
      class: "section-copy",
      text: "更新检查仅在安卓安装版可用。网页预览不创建应用商店链接，也不会显示“已是最新版”。"
    }));
    details.appendChild(el("p", {
      class: "tiny-note",
      text: "安装版可由用户配置 HTTPS 发布清单；同签名 APK 覆盖安装可保留本机学习记录。"
    }));
    section.appendChild(details);
    return section;
  }

  function buildBrowserAboutSection() {
    const section = el("section", { class: "about-block" });
    section.appendChild(el("p", {
      class: "about-version",
      text: "平江安澜 · 网页预览 v" + APP_VERSION
    }));
    section.appendChild(el("p", {
      text: "完全离线网页预览 · 无 CDN、无外部字体、无网络请求"
    }));
    section.appendChild(el("p", {
      text: "本地存储：" + (storageAvailable ? "可用（数据仅在本机浏览器）" : "不可用（仅当前页面内存）")
    }));
    section.appendChild(el("p", {
      text: "当前是网页预览，不是 APK，也不会伪装成已安装应用。安卓安装包与系统通知需在安装版验证。"
    }));
    const generatedSummary = getGeneratedSummary();
    section.appendChild(el("p", {
      text: "题库 " + questions.length + " 道 · 有答案 " + getAnswerableQuestions().length +
        " 道 · 待补答案 " + getPendingQuestions().length + " 道 · 我的修订 " +
        Object.keys(state.answerEdits).length + " 条"
    }));
    section.appendChild(el("p", {
      text: "DSH 初稿 " + generatedSummary.total + " 道：待核对 " + generatedSummary.draft +
        " · 需核图 " + generatedSummary.needs_figure_review +
        " · 需核来源 " + generatedSummary.needs_source_review + "。均为初稿，未自动标为审定。"
    }));
    section.appendChild(el("p", {
      text: "数据版本：" + (studyData.edition || "待核对") + " · 本地 schema v" + SCHEMA_VERSION
    }));
    return section;
  }

  function buildReferenceSection() {
    const referenceSection = el("section", { class: "reference-block" });
    referenceSection.appendChild(el("h3", { class: "section-heading", text: "参考书与资料" }));
    referenceSection.appendChild(el("p", {
      class: "section-copy",
      text: "星标最多 2 份主要参考书；星标与题目来源筛选相互独立。"
    }));
    const starredSources = state.referenceIds.map(function (id) {
      return sourceById.get(id);
    }).filter(Boolean);
    if (!starredSources.length) {
      referenceSection.appendChild(el("p", {
        class: "reference-empty",
        text: "尚未星标主要参考书。可在下方资料库或选题页星标。"
      }));
    } else {
      const referenceList = el("ul", { class: "reference-list" });
      starredSources.forEach(function (source) {
        referenceList.appendChild(el("li", { class: "reference-row" }, [
          el("span", { class: "reference-name", text: source.name }),
          buildStarButton(source)
        ]));
      });
      referenceSection.appendChild(referenceList);
      referenceList.addEventListener("click", function (event) {
        const button = event.target.closest("button[data-star-id]");
        if (!button) {
          return;
        }
        const result = toggleReference(button.dataset.starId);
        if (result.changed) {
          renderApp({ scroll: "preserve" });
        }
      });
    }

    const libraryDetails = el("details", { class: "library-details" });
    const librarySummary = el("summary", {
      text: "全部资料 · " + sources.length + " 份"
    });
    const libraryList = renderSourceList(sources);
    libraryList.addEventListener("click", function (event) {
      const button = event.target.closest("button[data-star-id]");
      if (!button) {
        return;
      }
      const result = toggleReference(button.dataset.starId);
      if (result.changed) {
        renderApp({ scroll: "preserve" });
      }
    });
    libraryDetails.appendChild(librarySummary);
    libraryDetails.appendChild(libraryList);
    referenceSection.appendChild(libraryDetails);
    referenceSection.appendChild(el("p", {
      class: "tiny-note",
      text: "题库来源记录共 " + sources.length + " 份；其中来源名称原样显示，来源筛选与主参考书星标分别保存。"
    }));
    return referenceSection;
  }

  function buildPreviousSubjectArchiveSection() {
    let raw = "";
    try { raw = window.localStorage.getItem("pingjianganlan.archive.natural-geography.v1") || ""; }
    catch (error) { return null; }
    if (!raw) { return null; }
    const section = el("section", { class: "section" });
    section.appendChild(el("h3", { class: "section-heading", text: "改版前学习记录" }));
    section.appendChild(el("p", { class: "section-copy", text: "改版前的地理学习记录保留在本机归档中。导出供留存，不会把旧题进度套用到水利题。" }));
    const button = el("button", { class: "secondary-button", type: "button", id: "export-previous-subject", text: "导出改版前记录" });
    button.addEventListener("click", function () {
      let payload;
      try { payload = JSON.stringify(sanitizeForExport(JSON.parse(raw))); }
      catch (error) { showToast("旧记录无法解析，归档原文仍保留在本机。"); return; }
      if (NATIVE_AVAILABLE) {
        window.NativeApp.call("exportBackup", { json: payload }, { timeoutMs: 120000 })
          .then(function () { showToast("改版前学习记录已导出，不含 API Key。"); })
          .catch(function (error) { showToast("导出未完成：" + nativeErrorText(error)); });
      } else {
        const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
        const a = document.createElement("a"); a.href = url;
        a.download = "平江安澜-改版前地理学习记录.json";
        document.body.appendChild(a); a.click(); a.remove();
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      }
    });
    section.appendChild(button);
    return section;
  }

  function renderMe(main) {
    if (NATIVE_AVAILABLE) {
      ensureNativeMeData();
    }
    const view = el("section", { class: "view", "aria-labelledby": "me-title" });
    view.appendChild(el("header", { class: "profile-head" }, [
      el("p", { class: "eyebrow", text: "本机账户 · 无需登录" }),
      el("h2", { class: "profile-name", id: "me-title", text: state.settings.accountName }),
      el("p", {
        class: "profile-copy",
        text: NATIVE_AVAILABLE
          ? "把治水的原理，记成自己的知识。学习记录保存在本机。"
          : "把治水的原理，记成自己的知识。数据不离开这台设备。"
      })
    ]));

    if (NATIVE_AVAILABLE && window.NativeApp && window.NativeApp.bootstrapError) {
      view.appendChild(el("p", {
        class: "notice is-error",
        role: "alert",
        text: window.NativeApp.bootstrapError
      }));
    }

    const accountSection = el("section", { class: "section" });
    accountSection.appendChild(el("h3", { class: "section-heading", text: "账户名" }));
    accountSection.appendChild(el("p", {
      class: "section-copy",
      text: NATIVE_AVAILABLE
        ? "可以随时改成自己的名字；只保存在本机，不需要登录。"
        : "可以随时改成自己的名字；只保存在浏览器本地。"
    }));
    const accountInput = el("input", {
      class: "account-input",
      id: "account-name",
      type: "text",
      maxlength: "24",
      value: state.settings.accountName,
      autocomplete: "nickname",
      "aria-label": "账户名，最多 24 个字符"
    });
    const saveAccount = el("button", {
      class: "secondary-button",
      type: "button",
      "aria-label": "保存账户名",
      text: "保存"
    });
    saveAccount.addEventListener("click", function () {
      const name = accountInput.value.trim().slice(0, 24) || "水利同学";
      state.settings.accountName = name;
      accountInput.value = name;
      const heading = view.querySelector(".profile-name");
      if (heading) {
        heading.textContent = name;
      }
      const saved = saveState();
      showToast(saved
        ? "账户名已保存到本机。"
        : "账户名已更新，但本机存储写入失败；仅当前页面有效。");
    });
    accountSection.appendChild(el("div", { class: "account-row" }, [
      el("div", {}, [
        el("label", { class: "field-label", for: "account-name", text: "显示名称" }),
        accountInput
      ]),
      saveAccount
    ]));
    view.appendChild(accountSection);

    if (window.StudyCloudAccount && typeof window.StudyCloudAccount.render === "function") {
      view.appendChild(window.StudyCloudAccount.render());
    }
    view.appendChild(NATIVE_AVAILABLE ? buildNativeReminderSection() : buildBrowserReminderSection());

    if (typeof window !== "undefined" && window.StudyAISettings &&
        typeof window.StudyAISettings.render === "function") {
      const aiSettings = window.StudyAISettings.render();
      if (aiSettings) {
        view.appendChild(aiSettings);
      }
    }

    view.appendChild(NATIVE_AVAILABLE ? buildNativeImportSection() : buildBrowserImportSection());
    view.appendChild(buildReferenceSection());
    view.appendChild(NATIVE_AVAILABLE ? buildNativeExportSection() : buildBrowserExportSection());
    const previousSubjectArchive = buildPreviousSubjectArchiveSection();
    if (previousSubjectArchive) { view.appendChild(previousSubjectArchive); }
    view.appendChild(NATIVE_AVAILABLE ? buildNativeUpdateSection() : buildBrowserUpdateSection());
    view.appendChild(NATIVE_AVAILABLE ? buildNativeAboutSection() : buildBrowserAboutSection());

    main.appendChild(view);
  }

  function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) {
      return;
    }
    let added = 0;
    let rejected = 0;
    files.forEach(function (file) {
      const format = extensionOf(file.name);
      if (!ALLOWED_IMPORT_FORMATS.includes(format)) {
        rejected += 1;
        return;
      }
      const now = new Date();
      state.imports.unshift({
        id: makeId("import"),
        name: String(file.name).slice(0, 240),
        format: format,
        size: Number.isFinite(Number(file.size)) ? Number(file.size) : null,
        registeredAt: now.toISOString(),
        registeredDate: localDateKey(now),
        status: "registered",
        parseStatus: "pending_install"
      });
      added += 1;
    });
    const saved = added ? saveState() : true;
    if (added) {
      renderApp({ scroll: "preserve" });
    }
    if (rejected) {
      showToast("已登记 " + added + " 份；不支持 " + rejected + " 份（仅 PDF / DOCX / MD / HTML / TXT）。" +
        (!saved ? " 本机存储写入失败，仅当前页面有效。" : ""));
    } else if (added) {
      showToast(saved
        ? "已登记 " + added + " 份文件；内容解析待安装版接入。"
        : "已登记到当前页面，但本机存储写入失败；关闭页面后不会保留。");
    }
  }

  function isSensitiveExportKey(key) {
    const normalized = String(key || "").toLowerCase().replace(/[\s_-]/g, "");
    if (["key", "token", "secret", "password", "authorization", "auth",
      "credential", "credentials"].includes(normalized)) {
      return true;
    }
    return normalized.endsWith("key") || normalized.endsWith("token") ||
      normalized.endsWith("secret") || normalized.endsWith("password");
  }

  // 导出前递归过滤任何 key/token/secret 一类字段。正常 state 里本来
  // 就没有 API Key；这里是第二道防线，避免未来字段扩展时误导出。
  function sanitizeForExport(value) {
    if (Array.isArray(value)) {
      return value.map(sanitizeForExport);
    }
    if (!isPlainObject(value)) {
      return value;
    }
    const result = {};
    Object.keys(value).forEach(function (key) {
      if (!isSensitiveExportKey(key)) {
        result[key] = sanitizeForExport(value[key]);
      }
    });
    return result;
  }

  function exportLearningRecord() {
    const payload = sanitizeForExport(clone(state));
    payload.exportedAt = isoNow();
    payload.app = {
      name: "平江安澜",
      version: APP_VERSION,
      channel: "ui-review-web-preview"
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "平江安澜-学习记录-" + todayKey() + ".json";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
    showToast("学习记录已生成本机下载。");
  }

  /* ----------------------------------------------------------------------- */
  /* Read-only public API and pure debug helpers                             */
  /* ----------------------------------------------------------------------- */

  const schedulerApi = typeof window !== "undefined" ? window.MemoryScheduler : null;

  const debugHelpers = {
    questionTypeOf: questionTypeOf,
    mixedQuestionIds: mixedQuestionIds,
    isAnswerable: isAnswerable,
    getAnswerData: function (questionOrId) {
      const question = typeof questionOrId === "number" ? questionById.get(questionOrId) : questionOrId;
      return clone(getAnswerData(question));
    },
    cleanQuestionText: cleanQuestionText,
    countSources: sources.length,
    countAllQuestions: questions.length,
    countAnswerableQuestions: function () { return getAnswerableQuestions().length; },
    generatedSummary: function () { return clone(getGeneratedSummary()); },
    localDateKey: localDateKey,
    addLocalDays: addDays,
    daysBetweenLocalKeys: daysBetweenKeys,
    bucketForIntervalDays: function (days) { return bucketForInterval(days).id; },
    modelRecall: modelRecall,
    advanceRelearnCounters: advanceRelearnCounters,
    matchesQuestionSearch: matchesQuestionSearch,
    chapterNumbersFor: function (chapter) { return chapterNumbersFor(chapter); },
    chapterNamesFor: function (chapter) { return chapterNamesFor(chapter); },
    searchQuestionIds: function (query) {
      return questions.filter(function (question) {
        return matchesQuestionSearch(question, query);
      }).map(function (question) { return question.id; });
    },
    planPreview: function () { return clone(getPlanPreview()); },
    scheduledDueIds: function (dayKey) { return getScheduledDueIds(dayKey); },
    mandatoryIdsForPlan: function (dayKey) { return getMandatoryIdsForPlan(dayKey); },
    scheduleForQuestion: function (questionId) { return clone(scheduleSummaryFor(questionId)); },
    computeRecallData: function () { return clone(computeRecallData()); },
    sanitizeForExport: sanitizeForExport,
    native: {
      isNative: function () { return NATIVE_AVAILABLE; },
      importCharLimit: MAX_IMPORT_CHARS,
      maxDrafts: MAX_IMPORT_DRAFTS,
      draftStoreKey: DRAFT_STORE_KEY,
      normalizeImportDocument: function (raw) { return clone(normalizeImportDocument(raw)); },
      defaultImportPageIndexes: function (raw) {
        const documentValue = normalizeImportDocument(raw);
        return documentValue ? defaultImportPageIndexes(documentValue) : [];
      },
      buildAcceptQuestionsPayload: function (drafts) {
        return clone(buildAcceptQuestionsPayload(drafts));
      },
      validateRestoredState: function (raw) {
        return clone(validateRestoredState(raw));
      },
      validateManifestUrl: validateManifestUrl
    },
    // 纯函数直通给审核使用；debug 不提供任意 state 写入。
    calculateRecall: schedulerApi ? schedulerApi.calculateRecall : function () { return 1; },
    recommendIntervalDays: schedulerApi ? schedulerApi.recommendIntervalDays : function () { return 1; },
    applyReview: schedulerApi ? schedulerApi.applyReview : function () { return null; },
    rankDue: schedulerApi ? schedulerApi.rankDue : function (entries) { return entries || []; },
    dueEntries: schedulerApi ? schedulerApi.dueEntries : function (entries) { return entries || []; },
    normalizeScheduleEntry: normalizeScheduleEntry,
    migrateLegacyScheduleEntry: schedulerApi ? schedulerApi.migrateLegacyEntry : normalizeScheduleEntry,
    nextReviewDelayAfterKnown: function (knownCount, forgotToday, stability) {
      if (forgotToday) {
        return 1;
      }
      return schedulerApi
        ? schedulerApi.recommendIntervalDays(stability, 0.9)
        : 1;
    },
    nextDueFromNow: function (now, delayDays, forgotToday) {
      const key = localDateKey(now instanceof Date ? now : new Date(now));
      return addDays(key, forgotToday ? 1 : Math.max(1, Math.round(Number(delayDays) || 1)));
    }
  };
  Object.defineProperty(debugHelpers, "countAnsweredQuestions", {
    enumerable: true,
    get: function () { return getAnswerableQuestions().length; }
  });
  Object.defineProperty(debugHelpers, "countPendingQuestions", {
    enumerable: true,
    get: function () { return getPendingQuestions().length; }
  });
  Object.freeze(debugHelpers);

  function cloudSyncBusy() {
    // 保守：编辑答案、正在自评、原生导入/恢复或复习会话进行中时，
    // 不把云端状态写回界面，避免打断用户当前操作。
    return Boolean(
      activeAnswerEditorId !== null ||
      ratingBusy ||
      nativeRestoreBusy ||
      nativeMe.updateBusy ||
      (state.session && !state.session.completed)
    );
  }

  function mergeCloudNativeContent(native) {
    const custom = native && isPlainObject(native.customContent) ? native.customContent : null;
    if (!custom) {
      return 0;
    }
    const nativeApp = typeof window !== "undefined" ? window.NativeApp : null;
    if (!nativeApp || typeof nativeApp.mergeBootstrap !== "function") {
      throw new Error("安装版题库合并功能不可用。");
    }
    nativeApp.mergeBootstrap(custom);
    let added = 0;
    const data = typeof window !== "undefined" && isPlainObject(window.STUDY_DATA)
      ? window.STUDY_DATA
      : null;
    const globalSources = data && Array.isArray(data.sources) ? data.sources : [];
    const globalQuestions = data && Array.isArray(data.questions) ? data.questions : [];
    globalSources.forEach(function (source) {
      if (!isPlainObject(source) || source.id === undefined || source.id === null) {
        return;
      }
      if (!sourceById.has(source.id)) {
        sourceById.set(source.id, source);
        if (!sources.some(function (item) { return item.id === source.id; })) {
          sources.push(source);
          added += 1;
        }
      }
    });
    globalQuestions.forEach(function (question) {
      if (!isPlainObject(question) || question.id === undefined || question.id === null) {
        return;
      }
      if (!questionById.has(question.id)) {
        questionById.set(question.id, question);
        if (!questions.some(function (item) { return item.id === question.id; })) {
          questions.push(question);
          added += 1;
        }
      }
    });
    const generated = typeof window !== "undefined" && Array.isArray(window.GENERATED_ANSWERS)
      ? window.GENERATED_ANSWERS
      : [];
    generated.forEach(function (item) {
      const normalized = normalizeGeneratedAnswer(item);
      if (normalized && !generatedById.has(normalized.question_id)) {
        generatedById.set(normalized.question_id, normalized);
        added += 1;
      }
    });
    return added;
  }

  function applyCloudSyncState(payload) {
    if (!isPlainObject(payload) || !isPlainObject(payload.state)) {
      return false;
    }
    if (cloudSyncBusy()) {
      return false;
    }
    const previousState = state;
    cloudSyncApplyInProgress = true;
    try {
      if (payload.native) {
        mergeCloudNativeContent(payload.native);
      }
      state = normalizeState(payload.state);
      const syncedUpdatedAt = state.lastUpdated;
      // 远端会话可能来自昨天；按本机日界滚动，避免把旧计划直接显示成今天。
      maybeRollover();
      ensureTodaySession();
      state.lastUpdated = syncedUpdatedAt;
      if (!saveState({ preserveUpdatedAt: true })) {
        throw new Error("无法保存同步后的学习记录，保留原记录");
      }
      if (typeof document !== "undefined" && appScrollElement) {
        renderApp({ scroll: "preserve" });
      }
      return true;
    } catch (error) {
      state = previousState;
      return false;
    } finally {
      cloudSyncApplyInProgress = false;
    }
  }

  if (typeof window !== "undefined") {
    window.StudyApp = Object.freeze({
      getState: function () {
        return clone(state);
      },
      navigate: function (tab) {
        return navigate(tab);
      },
      applyCloudSync: applyCloudSyncState,
      isCloudSyncBusy: cloudSyncBusy,
      debug: debugHelpers
    });
  }

  /* ----------------------------------------------------------------------- */
  /* Initialization                                                          */
  /* ----------------------------------------------------------------------- */

  if (typeof window !== "undefined") {
    window.__nativeUpdateAvailable = function (value) {
      return showNativeUpdateAvailable(value);
    };
  }

  function init() {
    appScrollElement = document.getElementById("app-scroll");
    const tabbar = document.querySelector(".tabbar");
    if (tabbar) {
      tabbar.addEventListener("click", function (event) {
        const button = event.target.closest("button[data-tab]");
        if (!button) {
          return;
        }
        navigate(button.dataset.tab);
      });
    }
    if (NATIVE_AVAILABLE && typeof window.addEventListener === "function") {
      window.addEventListener("study-ai-config-changed", function (event) {
        if (event && isPlainObject(event.detail)) {
          nativeMe.apiConfig = event.detail;
          if (currentTab === "me") {
            const previous = document.getElementById("native-import-section");
            if (previous) {
              const replacement = buildNativeImportSection();
              previous.replaceWith(replacement);
            }
          }
        }
      });
    }
    state = loadState();
    currentTab = TABS.includes(currentTab) ? currentTab : "review";
    ensureTodaySession();
    if (migratedFromKey || needsSchemaRewrite) {
      saveState();
    }
    updateStorageWarning();
    updateTabUI();
    renderApp({ scroll: "top" });
    if (NATIVE_AVAILABLE && window.StudyCloudSync &&
        typeof window.StudyCloudSync.configure === "function") {
      try {
        window.StudyCloudSync.configure({
          getState: function () { return clone(state); },
          applyState: applyCloudSyncState,
          isBusy: cloudSyncBusy,
          notify: showToast
        });
      } catch (error) {
        // 同步初始化失败不能影响本机复习；面板会显示未连接状态。
      }
    }
    if (NATIVE_AVAILABLE && window.NativeApp && window.NativeApp.bootstrapError) {
      showToast(window.NativeApp.bootstrapError);
    } else if (migrationNotice) {
      showToast(migrationNotice);
    }

    let knownDay = todayKey();
    window.setInterval(function () {
      if (todayKey() !== knownDay) {
        knownDay = todayKey();
        maybeRollover();
        renderApp({ scroll: "preserve" });
      }
    }, 60000);
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
      init();
    }
  }
})();
