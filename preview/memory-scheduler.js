/*
 * 山月记 · 个性化复习调度（纯函数）
 *
 * 这是一个产品启发式模型：S 表示预测保持 90% 回忆率的天数，
 * R(t) = 0.9 ^ (t / S)。它不是墨墨背单词的算法，也不是任何原始
 * 记忆实验的精确复现。模块不读取 DOM、不读取应用 state，所有时间
 * 都由调用方传入，便于在 Node 中直接测试。
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MemoryScheduler = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MS_PER_DAY = 86400000;
  const MIN_STABILITY = 0.5;
  const MAX_STABILITY = 365;
  const DEFAULT_TARGET_RETENTION = 0.9;
  const MIN_INTERVAL_DAYS = 1;
  const MAX_INTERVAL_DAYS = 365;
  const MIN_GROWTH_GAP_MS = 12 * 60 * 60 * 1000;
  const LEGACY_STABILITY_BY_KNOWN_COUNT = [1, 3, 7, 14, 30];

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function toDate(value) {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
    }
    if (typeof value === "number") {
      const fromNumber = new Date(value);
      return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }

  // 本地日历日键。绝不使用 toISOString().slice(0, 10)，避免 UTC 日界。
  function localDateKey(now) {
    const date = toDate(now) || new Date();
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }

  function isDateKey(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }
    const parts = value.split("-").map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
    return date.getFullYear() === parts[0] &&
      date.getMonth() === parts[1] - 1 &&
      date.getDate() === parts[2];
  }

  function dateKeyOrNull(value) {
    return isDateKey(value) ? value : null;
  }

  function dateFromKey(key) {
    const parts = String(key).split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
  }

  // 用本地日历加天；即使跨夏令时也不按 24 小时硬算日界。
  function addLocalDays(key, amount) {
    if (!isDateKey(key)) {
      return null;
    }
    const date = dateFromKey(key);
    date.setDate(date.getDate() + Math.round(Number(amount) || 0));
    return localDateKey(date);
  }

  function isoOrNull(value) {
    if (typeof value !== "string" || !value.trim()) {
      return "";
    }
    return toDate(value) ? value : "";
  }

  function nonNegativeInteger(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
      return 0;
    }
    return Math.max(0, Math.round(number));
  }

  function clampStability(value) {
    const number = Number(value);
    const candidate = Number.isFinite(number) && number > 0 ? number : 1;
    return Math.min(MAX_STABILITY, Math.max(MIN_STABILITY, candidate));
  }

  function clampInterval(value) {
    const number = Number(value);
    const candidate = Number.isFinite(number) ? Math.round(number) : MIN_INTERVAL_DAYS;
    return Math.min(MAX_INTERVAL_DAYS, Math.max(MIN_INTERVAL_DAYS, candidate));
  }

  function legacyStabilityFromKnownCount(knownCount) {
    const count = Math.max(0, Math.round(Number(knownCount) || 0));
    const index = Math.min(Math.max(0, count - 1), LEGACY_STABILITY_BY_KNOWN_COUNT.length - 1);
    return LEGACY_STABILITY_BY_KNOWN_COUNT[index];
  }

  function earlierDateKey(left, right) {
    if (!isDateKey(left)) {
      return isDateKey(right) ? right : null;
    }
    if (!isDateKey(right)) {
      return left;
    }
    return left <= right ? left : right;
  }

  function laterDateKey(left, right) {
    if (!isDateKey(left)) {
      return isDateKey(right) ? right : null;
    }
    if (!isDateKey(right)) {
      return left;
    }
    return left >= right ? left : right;
  }

  function baseEntry() {
    return {
      stability: 1,
      knownCount: 0,
      lapses: 0,
      nextDue: null,
      forcedDueDate: null,
      lastReviewedAt: "",
      lastGrowthAt: "",
      lastForgotDate: null,
      lastSuccessDate: null,
      lastRating: null,
      updatedAt: "",
      legacy: false
    };
  }

  /**
   * 迁移旧版 schedule。旧版已知评价次数对应 1/3/7/14/30 天的稳定度，
   * 但已有 nextDue 原样保留，迁移本身不改变用户已有的日计划。
   */
  function migrateLegacyEntry(raw) {
    if (!isPlainObject(raw)) {
      return null;
    }
    const hasStability = Number.isFinite(Number(raw.stability)) && Number(raw.stability) > 0;
    const knownCount = nonNegativeInteger(raw.knownCount);
    const updatedAt = isoOrNull(raw.updatedAt);
    const lastReviewedAt = isoOrNull(raw.lastReviewedAt) || updatedAt;
    const lastSuccessDate = dateKeyOrNull(raw.lastSuccessDate) ||
      (raw.lastRating === "known" && lastReviewedAt
        ? localDateKey(new Date(lastReviewedAt))
        : null);
    const lastForgotDate = dateKeyOrNull(raw.lastForgotDate) ||
      (raw.lastRating === "forgot" && lastReviewedAt
        ? localDateKey(new Date(lastReviewedAt))
        : null);
    return {
      stability: hasStability ? clampStability(raw.stability) : legacyStabilityFromKnownCount(knownCount),
      knownCount: knownCount,
      lapses: nonNegativeInteger(raw.lapses),
      nextDue: dateKeyOrNull(raw.nextDue) || dateKeyOrNull(raw.dueDate),
      forcedDueDate: dateKeyOrNull(raw.forcedDueDate),
      lastReviewedAt: lastReviewedAt,
      lastGrowthAt: isoOrNull(raw.lastGrowthAt),
      lastForgotDate: lastForgotDate,
      lastSuccessDate: lastSuccessDate,
      lastRating: raw.lastRating === "known" || raw.lastRating === "forgot" ? raw.lastRating : null,
      updatedAt: updatedAt,
      legacy: raw.legacy === true || !hasStability
    };
  }

  /**
   * 预测回忆率 R(t) = 0.9 ^ (t / S)。
   * t 是距上次实际评价的真实毫秒数 / 86400000。
   */
  function calculateRecall(entry, now) {
    const current = isPlainObject(entry) ? entry : {};
    const currentDate = toDate(now) || new Date();
    const lastReviewed = toDate(current.lastReviewedAt);
    const stability = clampStability(current.stability);
    if (!lastReviewed) {
      return 1;
    }
    const elapsedDays = Math.max(0, (currentDate.getTime() - lastReviewed.getTime()) / MS_PER_DAY);
    return Math.max(0, Math.min(1, Math.pow(0.9, elapsedDays / stability)));
  }

  /**
   * 目标保持率 r 下的推荐间隔：I = round(S * ln(r) / ln(0.9))，
   * 并夹到 1—365 天。默认 r = 0.9，因此默认 I 约等于 S。
   */
  function recommendIntervalDays(stability, targetRetention) {
    const currentStability = clampStability(stability);
    const target = Number(targetRetention);
    const retention = Number.isFinite(target) && target > 0 && target < 1
      ? target
      : DEFAULT_TARGET_RETENTION;
    return clampInterval(currentStability * Math.log(retention) / Math.log(0.9));
  }

  function maxDateKey(left, right) {
    return laterDateKey(left, right);
  }

  /**
   * 处理一次实际评价。返回新的纯数据对象，不修改入参。
   * - 初次熟记：S=3，三天后复习。
   * - 初次遗忘：S=0.5，次日强制复习。
   * - 跨日且距上次增长 >= 12 小时：S' = clamp(S * (1.5 + 0.5 * (1-R)))。
   * - 同日重复熟知不增长；同日遗忘后的熟知不增长且保留次日强制。
   * - 同日多次遗忘只削减一次 S，但 lapses 逐次累计。
   */
  function applyReview(entry, rating, now) {
    if (rating !== "known" && rating !== "forgot") {
      throw new TypeError("rating must be 'known' or 'forgot'");
    }
    const currentDate = toDate(now);
    if (!currentDate) {
      throw new TypeError("now must be a valid date");
    }
    const migrated = entry ? migrateLegacyEntry(entry) : null;
    const current = migrated || baseEntry();
    const today = localDateKey(currentDate);
    const tomorrow = addLocalDays(today, 1);
    const previousReviewed = toDate(current.lastReviewedAt);
    const previousDate = previousReviewed ? localDateKey(previousReviewed) : null;
    const sameLocalDay = previousDate === today;
    const hadForgotToday = current.lastForgotDate === today;
    const next = Object.assign({}, current, {
      lastReviewedAt: currentDate.toISOString(),
      lastRating: rating,
      updatedAt: currentDate.toISOString()
    });

    if (rating === "forgot") {
      next.lapses = current.lapses + 1;
      // 同一天连续点击“遗忘”只削减一次稳定度，防止稳定度塌陷。
      if (current.lastForgotDate !== today) {
        next.stability = Math.max(MIN_STABILITY, 0.45 * current.stability);
      }
      next.lastForgotDate = today;
      next.forcedDueDate = tomorrow;
      next.nextDue = tomorrow;
      return next;
    }

    next.knownCount = current.knownCount + (current.lastSuccessDate === today ? 0 : 1);
    next.lastSuccessDate = today;

    if (hadForgotToday) {
      // 当天曾遗忘，后续熟知不能增长，也不能解除新的次日强制。
      next.forcedDueDate = tomorrow;
    } else if (current.knownCount === 0 && current.lapses === 0) {
      // 初次熟记后安排三天间隔；避免次日重复。
      next.stability = 3;
      next.lastGrowthAt = currentDate.toISOString();
      if (next.forcedDueDate && today >= next.forcedDueDate) {
        next.forcedDueDate = null;
      }
    } else {
      const growthBase = toDate(current.lastGrowthAt) || previousReviewed;
      const elapsedSinceGrowth = growthBase
        ? currentDate.getTime() - growthBase.getTime()
        : 0;
      const crossedDay = Boolean(previousDate && previousDate < today);
      const canGrow = !sameLocalDay && crossedDay && elapsedSinceGrowth >= MIN_GROWTH_GAP_MS;
      if (canGrow) {
        const recall = calculateRecall(current, currentDate);
        next.stability = Math.min(
          MAX_STABILITY,
          Math.max(MIN_STABILITY, Math.max(current.stability + 1, Math.ceil(current.stability * (1.5 + 0.5 * (1 - recall)))))
        );
        next.lastGrowthAt = currentDate.toISOString();
      }
      // 只有在后续日期真正到达旧 forcedDueDate 后才解除。
      if (next.forcedDueDate && today >= next.forcedDueDate) {
        next.forcedDueDate = null;
      }
    }

    const interval = recommendIntervalDays(next.stability, DEFAULT_TARGET_RETENTION);
    const recommendedDue = addLocalDays(today, interval);
    next.nextDue = next.forcedDueDate ? earlierDateKey(recommendedDue, next.forcedDueDate) : recommendedDue;
    return next;
  }

  function entryId(entry) {
    if (!isPlainObject(entry)) {
      return null;
    }
    const raw = entry.id !== undefined
      ? entry.id
      : entry.questionId !== undefined
        ? entry.questionId
        : entry.question_id;
    const number = Number(raw);
    return Number.isFinite(number) ? number : (raw === undefined ? null : String(raw));
  }

  function dueKeyOf(entry) {
    if (!isPlainObject(entry)) {
      return null;
    }
    return dateKeyOrNull(entry.nextDue) || dateKeyOrNull(entry.dueDate);
  }

  function isForcedDue(entry, now) {
    if (!isPlainObject(entry) || !isDateKey(entry.forcedDueDate)) {
      return false;
    }
    return entry.forcedDueDate <= localDateKey(now);
  }

  function isDue(entry, now) {
    const today = localDateKey(now);
    const dueKey = dueKeyOf(entry);
    if (dueKey && dueKey <= today) {
      return true;
    }
    return isForcedDue(entry, now);
  }

  function compareStableId(left, right) {
    const leftId = entryId(left);
    const rightId = entryId(right);
    const leftNumber = Number(leftId);
    const rightNumber = Number(rightId);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return leftNumber - rightNumber;
    }
    return String(leftId).localeCompare(String(rightId), "zh-CN", { numeric: true });
  }

  /**
   * 到期/逾期排序：强制优先 → 预测回忆率更低 → dueDate 更早 → 稳定 id。
   * 只排序，不丢弃任何传入的到期题；调用方应先用 isDue 过滤。
   */
  function rankDue(entries, now) {
    const list = Array.isArray(entries) ? entries.slice() : [];
    return list.sort(function (left, right) {
      const forcedDelta = Number(isForcedDue(right, now)) - Number(isForcedDue(left, now));
      if (forcedDelta !== 0) {
        return forcedDelta;
      }
      const recallDelta = calculateRecall(left, now) - calculateRecall(right, now);
      if (Math.abs(recallDelta) > 1e-12) {
        return recallDelta;
      }
      const leftDue = dueKeyOf(left) || "9999-12-31";
      const rightDue = dueKeyOf(right) || "9999-12-31";
      if (leftDue !== rightDue) {
        return leftDue < rightDue ? -1 : 1;
      }
      return compareStableId(left, right);
    });
  }

  function dueEntries(entries, now) {
    return rankDue((Array.isArray(entries) ? entries : []).filter(function (entry) {
      return isDue(entry, now);
    }), now);
  }

  const api = {
    MS_PER_DAY: MS_PER_DAY,
    MIN_STABILITY: MIN_STABILITY,
    MAX_STABILITY: MAX_STABILITY,
    DEFAULT_TARGET_RETENTION: DEFAULT_TARGET_RETENTION,
    MIN_GROWTH_GAP_MS: MIN_GROWTH_GAP_MS,
    LEGACY_STABILITY_BY_KNOWN_COUNT: LEGACY_STABILITY_BY_KNOWN_COUNT.slice(),
    localDateKey: localDateKey,
    isDateKey: isDateKey,
    addLocalDays: addLocalDays,
    clampStability: clampStability,
    legacyStabilityFromKnownCount: legacyStabilityFromKnownCount,
    migrateLegacyEntry: migrateLegacyEntry,
    calculateRecall: calculateRecall,
    recommendIntervalDays: recommendIntervalDays,
    applyReview: applyReview,
    isDue: isDue,
    isForcedDue: isForcedDue,
    rankDue: rankDue,
    dueEntries: dueEntries,
    dueKeyOf: dueKeyOf
  };

  return Object.freeze(api);
});
