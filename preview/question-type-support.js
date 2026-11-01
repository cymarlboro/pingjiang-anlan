(function (root, factory) {
  "use strict";
  var api = factory(root);
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.QuestionTypeSupport = api;
  }
  if (typeof window !== "undefined" && window && window !== root) {
    window.QuestionTypeSupport = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this), function (root) {
  "use strict";

  /*
   * 展示与推荐使用的规范题型顺序。前三项对应期中复习的优先题型；
   * 读图题保留独立类型，避免把“读图简答/分析”误判成选择题。
   */
  var TYPE_ORDER = Object.freeze([
    "简答题",
    "名词解释",
    "论述题",
    "读图分析题",
    "填空题",
    "判断题",
    "选择题",
    "分类与配对题"
  ]);

  var TYPE_ALIASES = Object.freeze({
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
  });

  var SELF_ASSESS_OPTIONS = Object.freeze(["熟记", "遗忘"]);
  var SELF_ASSESS_NOTE = "所有题型均自评，不做自动判分。";
  var PENDING_ANSWER_RE = /^(?:待答|待补充|待确认|待定|暂无(?:答案)?|todo|tbd)(?:[\s。．.!！?？…]|[（(][^）)]{0,20}[）)])*$/i;

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function globalValue(name) {
    if (root && root[name] !== undefined && root[name] !== null) {
      return root[name];
    }
    if (typeof window !== "undefined" && window && window !== root &&
      window[name] !== undefined && window[name] !== null) {
      return window[name];
    }
    return undefined;
  }

  function normalizeType(type) {
    if (type === null || type === undefined) {
      return "";
    }
    var raw = String(type).replace(/[\s\u3000]+/g, "");
    if (!raw) {
      return "";
    }
    return hasOwn(TYPE_ALIASES, raw) ? TYPE_ALIASES[raw] : raw;
  }

  function asQuestion(question) {
    if (question && typeof question === "object") {
      return question;
    }
    if (question === null || question === undefined) {
      return null;
    }
    return { id: question };
  }

  function questionKey(question) {
    if (!question || typeof question !== "object") {
      return question === null || question === undefined ? "" : String(question);
    }
    var id = question.id;
    if (id === undefined || id === null) {
      id = question.question_id;
    }
    return id === undefined || id === null ? "" : String(id);
  }

  function questionId(question) {
    if (!question || typeof question !== "object") {
      return null;
    }
    if (question.id !== undefined && question.id !== null) {
      return question.id;
    }
    if (question.question_id !== undefined && question.question_id !== null) {
      return question.question_id;
    }
    return null;
  }

  function lookupType(map, id) {
    if (!map || typeof map !== "object" || !id) {
      return "";
    }
    var value = map[id];
    if (value === undefined && /^-?\d+$/.test(id)) {
      value = map[Number(id)];
    }
    return typeof value === "string" && value.trim() ? value : "";
  }

  function hasOptions(question) {
    if (!question || typeof question !== "object") {
      return false;
    }
    var options = question.options;
    if (Array.isArray(options)) {
      return options.length > 0;
    }
    if (typeof options === "string") {
      return options.trim().length > 0;
    }
    return false;
  }

  function hasImage(question, imagesMap, id) {
    if (id && imagesMap && typeof imagesMap === "object") {
      var images = imagesMap[id];
      if (Array.isArray(images) ? images.length > 0 : Boolean(images)) {
        return true;
      }
    }
    if (!question || typeof question !== "object") {
      return false;
    }
    if (Array.isArray(question.images) && question.images.length > 0) {
      return true;
    }
    if (typeof question.image === "string" && question.image.trim()) {
      return true;
    }
    if (typeof question.image_url === "string" && question.image_url.trim()) {
      return true;
    }
    return false;
  }

  function getStem(question) {
    if (!question || typeof question !== "object") {
      return "";
    }
    var stem = question.question || question.title || question.text || "";
    return typeof stem === "string" ? stem : String(stem || "");
  }

  /**
   * 返回规范题型。真实题型映射优先，其次题型字段；
   * 映射缺失时再根据图片、选项与题干线索判断。
   * 注意：有选项但缺映射的题统一视为“选择题”，不擅自推断为多选。
   */
  function getType(question, typesMap, imagesMap) {
    var q = asQuestion(question);
    if (!q) {
      return "未分类";
    }
    var id = questionKey(q);
    var maps = [];
    if (typesMap && typeof typesMap === "object") {
      maps.push(typesMap);
    }
    var globalTypes = globalValue("QUESTION_TYPES");
    if (globalTypes && typeof globalTypes === "object" && globalTypes !== typesMap) {
      maps.push(globalTypes);
    }
    for (var i = 0; i < maps.length; i += 1) {
      var mapped = lookupType(maps[i], id);
      if (mapped) {
        return normalizeType(mapped);
      }
    }

    var declared = q.type || q.question_type || q.questionType;
    if (typeof declared === "string" && declared.trim()) {
      return normalizeType(declared);
    }

    var imageSource = imagesMap && typeof imagesMap === "object"
      ? imagesMap
      : globalValue("QUESTION_IMAGES");
    if (hasImage(q, imageSource, id)) {
      return "读图分析题";
    }

    if (hasOptions(q)) {
      return "选择题";
    }

    var stem = getStem(q);
    if (/读图|看图|据图|图中|图示|如图|图表/.test(stem)) {
      return "读图分析题";
    }
    if (/论述|试述|阐述|论证/.test(stem)) {
      return "论述题";
    }
    if (/名词解释|名词|概念解释|术语解释/.test(stem)) {
      return "名词解释";
    }
    if (/填空|_{2,}|（\s*）|\(\s*\)/.test(stem)) {
      return "填空题";
    }
    if (/配对|配伍|分类/.test(stem)) {
      return "分类与配对题";
    }
    if (/判断(?:题|对错|正误)|是否正确|对错/.test(stem)) {
      return "判断题";
    }
    if (/简答|简述|简要|说明|分析|比较|为什么|如何/.test(stem)) {
      return "简答题";
    }
    return "未分类";
  }

  function hasAnswerText(value) {
    if (value === null || value === undefined) {
      return false;
    }
    var text = String(value).replace(/\u00a0/g, " ").trim();
    if (!text) {
      return false;
    }
    return !PENDING_ANSWER_RE.test(text);
  }

  function getGeneratedAnswerIds() {
    var ids = new Set();
    var data = globalValue("GENERATED_ANSWERS");
    if (Array.isArray(data)) {
      data.forEach(function (item) {
        if (!item || typeof item !== "object") {
          return;
        }
        var id = item.question_id;
        if (id === undefined || id === null) {
          id = item.id;
        }
        if (id !== undefined && id !== null && hasAnswerText(item.answer)) {
          ids.add(String(id));
        }
      });
    } else if (data && typeof data === "object") {
      Object.keys(data).forEach(function (key) {
        var item = data[key];
        var text = typeof item === "string" ? item : item && item.answer;
        if (hasAnswerText(text)) {
          ids.add(String(key));
        }
      });
    }
    return ids;
  }

  /**
   * 有题库原答案、生成答案（可选全局回退）或回调认可，才视为可答。
   * 回调是补充认可，不会否定已有答案。
   */
  function isAnswerable(question, isAnswerableFn, generatedIds) {
    if (!question || typeof question !== "object") {
      return false;
    }
    if (hasAnswerText(question.answer)) {
      return true;
    }
    if (typeof isAnswerableFn === "function") {
      var approved = false;
      try {
        approved = Boolean(isAnswerableFn(question));
      } catch (error) {
        approved = false;
      }
      if (approved) {
        return true;
      }
    }
    var ids = generatedIds || getGeneratedAnswerIds();
    return ids.has(questionKey(question));
  }

  function orderedCounts(countMap) {
    var result = {};
    TYPE_ORDER.forEach(function (type) {
      if (countMap.has(type)) {
        result[type] = countMap.get(type);
      }
    });
    countMap.forEach(function (count, type) {
      if (TYPE_ORDER.indexOf(type) === -1) {
        result[type] = count;
      }
    });
    return result;
  }

  function getCounts(questions) {
    var list = Array.isArray(questions) ? questions : [];
    var countMap = new Map();
    list.forEach(function (question) {
      var type = normalizeType(getType(question)) || "未分类";
      countMap.set(type, (countMap.get(type) || 0) + 1);
    });
    return orderedCounts(countMap);
  }

  /**
   * 不传 questions 时返回全部规范题型；传入数组时返回其中实际出现的题型。
   */
  function getTypes(questions) {
    if (!Array.isArray(questions)) {
      return TYPE_ORDER.slice();
    }
    var counts = getCounts(questions);
    var present = Object.keys(counts);
    var known = TYPE_ORDER.filter(function (type) {
      return hasOwn(counts, type);
    });
    var extras = present.filter(function (type) {
      return TYPE_ORDER.indexOf(type) === -1;
    });
    return known.concat(extras);
  }

  function matchesType(question, selected) {
    if (selected === null || selected === undefined) {
      return true;
    }
    var wanted;
    if (Array.isArray(selected)) {
      if (selected.length === 0) {
        return true;
      }
      wanted = selected.map(normalizeType);
    } else {
      var raw = String(selected).trim();
      if (!raw) {
        return true;
      }
      var lower = raw.toLowerCase();
      if (raw === "*" || raw === "全部" || raw === "所有" || lower === "all") {
        return true;
      }
      wanted = [normalizeType(raw)];
    }
    if (wanted.some(function (type) {
      return type === "*" || type === "全部" || type === "所有" || type.toLowerCase() === "all";
    })) {
      return true;
    }
    return wanted.indexOf(normalizeType(getType(question))) !== -1;
  }

  function getHint(type) {
    var normalized = type && typeof type === "object"
      ? getType(type)
      : normalizeType(type);
    switch (normalized) {
      case "名词解释":
        return "先回忆定义与关键特征";
      case "简答题":
        return "按要点回忆，再对照答案";
      case "论述题":
        return "先组织论点与依据，再展开作答";
      case "读图分析题":
        return "结合原图回忆判读依据";
      case "选择题":
        return "先独立判断，再查看答案";
      case "填空题":
        return "先回忆关键术语，再对照答案";
      case "判断题":
        return "先独立判断对错，再对照答案";
      case "分类与配对题":
        return "先明确分类标准，再逐项配对";
      default:
        return "先回忆要点，再对照答案";
    }
  }

  /**
   * 确定性混合推荐：按题型优先级轮流取，同题型内按题号升序。
   * 仅用于“初始无计划”或用户明确选择“混合题型推荐”的场景；
   * 调用方不得用本函数覆盖已有 session / selectedIds。
   */
  function recommendedPlan(questions, count, isAnswerableFn, typesMap) {
    if (!Array.isArray(questions)) {
      return [];
    }
    if (typeof isAnswerableFn !== "function") {
      if (isAnswerableFn && typeof isAnswerableFn === "object" && !typesMap) {
        typesMap = isAnswerableFn;
      }
      isAnswerableFn = null;
    }
    var limit = Math.floor(Number(count));
    if (!Number.isFinite(limit) || limit <= 0) {
      return [];
    }

    var generatedIds = getGeneratedAnswerIds();
    var sourceTypes = typesMap || globalValue("QUESTION_TYPES");
    var queues = TYPE_ORDER.map(function () {
      return [];
    });
    var seen = new Set();

    questions.forEach(function (question, index) {
      if (!question || typeof question !== "object") {
        return;
      }
      var id = questionId(question);
      if (id === null) {
        return;
      }
      var key = String(id);
      if (seen.has(key)) {
        return;
      }
      if (!isAnswerable(question, isAnswerableFn, generatedIds)) {
        return;
      }
      var type = normalizeType(getType(question, sourceTypes));
      var bucketIndex = TYPE_ORDER.indexOf(type);
      if (bucketIndex === -1) {
        return;
      }
      seen.add(key);
      queues[bucketIndex].push({
        id: id,
        index: index,
        numeric: typeof id === "number" ? id : Number(id)
      });
    });

    queues.forEach(function (queue) {
      queue.sort(function (left, right) {
        var leftNumeric = Number.isFinite(left.numeric) ? left.numeric : null;
        var rightNumeric = Number.isFinite(right.numeric) ? right.numeric : null;
        if (leftNumeric !== null && rightNumeric !== null && leftNumeric !== rightNumeric) {
          return leftNumeric - rightNumeric;
        }
        return left.index - right.index;
      });
    });

    var result = [];
    while (result.length < limit) {
      var added = false;
      for (var i = 0; i < TYPE_ORDER.length && result.length < limit; i += 1) {
        var next = queues[i].shift();
        if (next) {
          result.push(next.id);
          added = true;
        }
      }
      if (!added) {
        break;
      }
    }
    return result;
  }

  return {
    TYPE_ORDER: TYPE_ORDER,
    SELF_ASSESS_OPTIONS: SELF_ASSESS_OPTIONS,
    SELF_ASSESS_NOTE: SELF_ASSESS_NOTE,
    normalizeType: normalizeType,
    getType: getType,
    getCounts: getCounts,
    getTypes: getTypes,
    matchesType: matchesType,
    getHint: getHint,
    isAnswerable: isAnswerable,
    recommendedPlan: recommendedPlan
  };
});
