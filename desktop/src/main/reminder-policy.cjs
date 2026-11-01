"use strict";

const { isValidReminderTime } = require("./text-rules.cjs");

const MISSED_GRACE_MS = 60 * 1000;

function localDateKey(millis) {
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Next local HH:mm occurrence: today if still ahead, otherwise tomorrow. */
function nextTriggerMillis(time, nowMillis = Date.now()) {
  if (!isValidReminderTime(time)) {
    throw new Error("提醒时间格式应为 HH:mm");
  }
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3, 5));
  const now = Number(nowMillis);
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  // setHours handles DST/local timezone transitions through the platform clock.
  if (next.getTime() <= now) {
    next.setDate(next.getDate() + 1);
    next.setHours(hour, minute, 0, 0);
  }
  return next.getTime();
}

/**
 * While the app/timer is running a delayed timer may fire within the grace
 * window. At startup or resume we know the process was not running at the due
 * time, so a past occurrence is honestly reported as missed instead of being
 * fired late or silently pretending it was delivered.
 */
function classifyOccurrence({ nextAt, now, wasRunning, graceMs = MISSED_GRACE_MS }) {
  const due = Number(nextAt);
  const current = Number(now);
  if (!Number.isFinite(due) || !Number.isFinite(current) || current < due) {
    return "wait";
  }
  if (wasRunning === true && current - due <= Math.max(0, Number(graceMs) || 0)) {
    return "fire";
  }
  return "missed";
}

function shouldNotifyForDate(lastNotifiedDate, millis) {
  const key = localDateKey(millis);
  return Boolean(key) && lastNotifiedDate !== key;
}

function validNotificationTime(time) {
  return isValidReminderTime(time);
}

module.exports = {
  MISSED_GRACE_MS,
  localDateKey,
  nextTriggerMillis,
  classifyOccurrence,
  shouldNotifyForDate,
  validNotificationTime
};
