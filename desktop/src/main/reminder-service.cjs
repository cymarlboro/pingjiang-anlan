"use strict";

const { UserError } = require("./errors.cjs");
const {
  localDateKey,
  nextTriggerMillis,
  classifyOccurrence,
  shouldNotifyForDate,
  validNotificationTime
} = require("./reminder-policy.cjs");

function todayAt(time, nowMillis) {
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3, 5));
  const value = new Date(Number(nowMillis));
  value.setHours(hour, minute, 0, 0);
  return value.getTime();
}

/**
 * Local Windows notifications while the app is running. There is deliberately
 * no Windows scheduled-task fallback: closing the app stops reminders, and the
 * status says so instead of claiming delivery while stopped.
 */
class ReminderService {
  constructor({ store, Notification, getWindow, now = () => Date.now() }) {
    this.store = store;
    this.Notification = Notification;
    this.getWindow = getWindow;
    this.now = now;
    this.timer = null;
    this.interval = null;
    this.nextAt = 0;
    this.lastNotifiedDate = store.getLastNotifiedDate();
    this.lastMissedDate = "";
    this.notifying = false;
  }

  supported() {
    try {
      return Boolean(this.Notification && typeof this.Notification.isSupported === "function" &&
        this.Notification.isSupported());
    } catch {
      return false;
    }
  }

  status() {
    const reminder = this.store.getReminder();
    const supported = this.supported();
    return {
      enabled: reminder.enabled,
      time: reminder.time,
      permissionGranted: supported,
      channelEnabled: supported ? null : false,
      exactAlarmAllowed: true,
      exactAlarmPermissionRequired: false,
      alarmMode: "app-running",
      platform: "windows-desktop",
      appMustBeRunning: true,
      notificationSupported: supported,
      scheduleMode: "main-process-timer",
      lastNotifiedDate: this.lastNotifiedDate,
      lastMissedDate: this.lastMissedDate,
      ...(this.nextAt > 0 ? { nextTriggerAt: new Date(this.nextAt).toISOString() } : {}),
      note: supported
        ? "提醒仅在应用运行时由本机计时器发送；关闭应用后不会送达，也不会补发。"
        : "当前系统不支持本机通知，提醒不会送达。"
    };
  }

  start() {
    this.stop();
    const reminder = this.store.getReminder();
    if (reminder.enabled) {
      this.schedule({ wasRunning: false });
    }
    this.interval = setInterval(() => this.tick(), 60 * 1000);
    if (this.interval.unref) {
      this.interval.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.nextAt = 0;
  }

  async save(enabled, time) {
    if (!validNotificationTime(time)) {
      throw new UserError("提醒时间格式应为 HH:mm");
    }
    await this.store.saveReminder(enabled === true, time);
    this.schedule({ wasRunning: false });
    return this.status();
  }

  resume() {
    this.schedule({ wasRunning: false });
    return this.status();
  }

  requestExactAlarmPermission() {
    // Windows has no exact-alarm permission screen; report the real desktop mode.
    this.schedule({ wasRunning: false });
    return this.status();
  }

  schedule({ wasRunning }) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextAt = 0;
    const reminder = this.store.getReminder();
    if (!reminder.enabled) {
      return;
    }
    const now = this.now();
    const today = todayAt(reminder.time, now);
    if (now < today) {
      this.arm(today, reminder.time, { fireNow: false });
      return;
    }
    const occurrence = classifyOccurrence({
      nextAt: today,
      now,
      wasRunning
    });
    if (occurrence === "fire") {
      this.fire(reminder.time);
      return;
    }
    this.lastMissedDate = localDateKey(now);
    this.arm(nextTriggerMillis(reminder.time, now), reminder.time, { fireNow: false });
  }

  arm(when, time, { fireNow }) {
    const delay = Math.max(0, when - this.now());
    this.nextAt = when;
    if (fireNow) {
      this.fire(time);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onDue(time);
    }, Math.min(delay, 0x7fffffff));
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  onDue(time) {
    const reminder = this.store.getReminder();
    if (!reminder.enabled || reminder.time !== time) {
      this.schedule({ wasRunning: true });
      return;
    }
    const now = this.now();
    const occurrence = classifyOccurrence({
      nextAt: todayAt(time, now),
      now,
      wasRunning: true
    });
    if (occurrence === "fire") {
      this.fire(time);
    } else {
      this.lastMissedDate = localDateKey(now);
      this.arm(nextTriggerMillis(time, now), time, { fireNow: false });
    }
  }

  fire(time) {
    if (this.notifying) {
      this.arm(nextTriggerMillis(time, this.now()), time, { fireNow: false });
      return;
    }
    const now = this.now();
    if (!shouldNotifyForDate(this.lastNotifiedDate, now)) {
      this.arm(nextTriggerMillis(time, now), time, { fireNow: false });
      return;
    }
    const reminder = this.store.getReminder();
    if (!reminder.enabled || reminder.time !== time) {
      this.schedule({ wasRunning: true });
      return;
    }
    if (!this.supported()) {
      this.arm(nextTriggerMillis(time, now), time, { fireNow: false });
      return;
    }
    this.notifying = true;
    try {
      const notification = new this.Notification({
        title: "平江安澜 · 每日复习",
        body: "今天也来温故知新。打开平江安澜，继续本机复习。",
        silent: false,
        timeoutType: "default"
      });
      notification.on("click", () => {
        const window = this.getWindow();
        if (window && !window.isDestroyed()) {
          if (window.isMinimized()) {
            window.restore();
          }
          window.show();
          window.focus();
        }
      });
      notification.show();
      const dateKey = localDateKey(now);
      this.lastNotifiedDate = dateKey;
      this.store.setLastNotifiedDate(dateKey).catch(() => {
        // A notification already shown cannot be recalled; the in-memory ledger
        // still prevents a duplicate in this process.
      });
    } catch {
      // Notification failure must not crash the app or retry in a tight loop.
    } finally {
      this.notifying = false;
      this.arm(nextTriggerMillis(time, now), time, { fireNow: false });
    }
  }

  tick() {
    const reminder = this.store.getReminder();
    if (!reminder.enabled) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.nextAt = 0;
      return;
    }
    const now = this.now();
    const due = todayAt(reminder.time, now);
    if (this.timer && this.nextAt > 0 && this.nextAt !== due &&
        Math.abs(this.nextAt - due) > 60 * 1000 && due > now) {
      // Clock or timezone changed; recompute against the local wall clock.
      this.schedule({ wasRunning: false });
      return;
    }
    if (now >= due && now - due <= 60 * 1000 &&
        shouldNotifyForDate(this.lastNotifiedDate, now) && !this.notifying) {
      this.fire(reminder.time);
    }
  }
}

module.exports = { ReminderService, todayAt };
