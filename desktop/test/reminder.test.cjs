"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  localDateKey,
  nextTriggerMillis,
  classifyOccurrence,
  shouldNotifyForDate
} = require("../src/main/reminder-policy.cjs");
const { ReminderService } = require("../src/main/reminder-service.cjs");

function fakeStore(time = "09:00") {
  let reminder = { enabled: true, time };
  let lastNotifiedDate = "";
  return {
    getReminder: () => ({ ...reminder }),
    saveReminder: async (enabled, nextTime) => { reminder = { enabled, time: nextTime }; },
    getLastNotifiedDate: () => lastNotifiedDate,
    setLastNotifiedDate: async (value) => { lastNotifiedDate = value; },
    getCurrent: () => ({ ...reminder, lastNotifiedDate })
  };
}

function fakeNotificationClass(showCounter) {
  return class FakeNotification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; }
    on() { return this; }
    show() { showCounter.count += 1; }
  };
}

test("next trigger is the next local HH:mm, never the past", () => {
  const now = new Date(2026, 0, 15, 10, 0, 0, 0);
  assert.equal(nextTriggerMillis("12:00", now.getTime()), new Date(2026, 0, 15, 12, 0, 0, 0).getTime());
  assert.equal(nextTriggerMillis("09:00", now.getTime()), new Date(2026, 0, 16, 9, 0, 0, 0).getTime());
  assert.equal(nextTriggerMillis("10:00", now.getTime()), new Date(2026, 0, 16, 10, 0, 0, 0).getTime());
  assert.throws(() => nextTriggerMillis("24:00", now.getTime()), /HH:mm/);
});

test("missed versus running occurrence is explicit", () => {
  const due = 100000;
  assert.equal(classifyOccurrence({ nextAt: due, now: due - 1, wasRunning: true }), "wait");
  assert.equal(classifyOccurrence({ nextAt: due, now: due + 1000, wasRunning: true }), "fire");
  assert.equal(classifyOccurrence({ nextAt: due, now: due + 1000, wasRunning: false }), "missed");
  assert.equal(classifyOccurrence({ nextAt: due, now: due + 10 * 60 * 1000, wasRunning: true }), "missed");
});

test("one notification per local day", () => {
  const now = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();
  assert.equal(localDateKey(now), "2026-01-15");
  assert.equal(shouldNotifyForDate("", now), true);
  assert.equal(shouldNotifyForDate("2026-01-15", now), false);
  assert.equal(shouldNotifyForDate("2026-01-14", now), true);
});

test("app closed at due time reports missed and does not fire late", () => {
  const now = new Date(2026, 0, 15, 10, 0, 0, 0).getTime();
  const store = fakeStore("09:00");
  const shown = { count: 0 };
  const service = new ReminderService({
    store,
    Notification: fakeNotificationClass(shown),
    getWindow: () => null,
    now: () => now
  });
  service.start();
  try {
    const status = service.status();
    assert.equal(status.appMustBeRunning, true);
    assert.equal(status.alarmMode, "app-running");
    assert.equal(status.lastMissedDate, "2026-01-15");
    assert.equal(shown.count, 0);
    assert.ok(status.nextTriggerAt);
  } finally {
    service.stop();
  }
});

test("duplicate fire in the same day is suppressed", () => {
  const now = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();
  const store = fakeStore("12:00");
  const shown = { count: 0 };
  const service = new ReminderService({
    store,
    Notification: fakeNotificationClass(shown),
    getWindow: () => null,
    now: () => now
  });
  try {
    service.fire("12:00");
    service.fire("12:00");
    assert.equal(shown.count, 1);
    assert.equal(service.status().lastNotifiedDate, "2026-01-15");
  } finally {
    service.stop();
  }
});
