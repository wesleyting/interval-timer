(function attachTimer(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.IntervalTimer = Object.assign(root.IntervalTimer || {}, api);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createTimerApi() {
  "use strict";

  const DEFAULT_MAIN_INTERVAL_MS = 62000;
  const DEFAULT_TOTAL_ALERTS = 29;
  const DEFAULT_REMINDER_INTERVAL_MS = 90000;

  function defaultNow() {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }

    return Date.now();
  }

  function positiveMilliseconds(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 100 ? number : fallback;
  }

  function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
  }

  function uniqueReminderId(value, index, usedIds) {
    const supplied = typeof value === "string" ? value.trim().slice(0, 64) : "";
    const base = supplied || `reminder-${index + 1}`;
    let id = base;
    let suffix = 2;

    while (usedIds.has(id)) {
      const suffixText = `-${suffix}`;
      id = `${base.slice(0, Math.max(1, 64 - suffixText.length))}${suffixText}`;
      suffix += 1;
    }

    usedIds.add(id);
    return id;
  }

  function normalizeReminderDefinitions(value) {
    if (!Array.isArray(value)) return Object.freeze([]);

    const usedIds = new Set();
    const reminders = value.map((entry, index) => {
      const source = entry && typeof entry === "object" ? entry : {};

      return Object.freeze({
        id: uniqueReminderId(source.id, index, usedIds),
        enabled: typeof source.enabled === "boolean" ? source.enabled : false,
        intervalMs: positiveMilliseconds(
          source.intervalMs,
          DEFAULT_REMINDER_INTERVAL_MS
        )
      });
    });

    return Object.freeze(reminders);
  }

  function remindersFromConfig(source) {
    if (Array.isArray(source.reminders)) {
      return normalizeReminderDefinitions(source.reminders);
    }

    // Keep accepting the original single-reminder configuration while callers move
    // to the reminders array. A config with no legacy fields has no reminders.
    if (
      Object.prototype.hasOwnProperty.call(source, "secondaryEnabled") ||
      Object.prototype.hasOwnProperty.call(source, "secondaryIntervalMs")
    ) {
      return normalizeReminderDefinitions([
        {
          id: "item-reminder",
          enabled: Boolean(source.secondaryEnabled),
          intervalMs: source.secondaryIntervalMs
        }
      ]);
    }

    return Object.freeze([]);
  }

  function freezeConfig(mainIntervalMs, totalAlerts, reminders) {
    const firstReminder = reminders[0] || null;

    return Object.freeze({
      mainIntervalMs,
      totalAlerts,
      reminders,
      // Read-only aliases keep the former config shape usable during migration.
      secondaryEnabled: Boolean(firstReminder && firstReminder.enabled),
      secondaryIntervalMs: firstReminder
        ? firstReminder.intervalMs
        : DEFAULT_REMINDER_INTERVAL_MS
    });
  }

  function normalizeConfig(config) {
    const source = config && typeof config === "object" ? config : {};

    return freezeConfig(
      positiveMilliseconds(source.mainIntervalMs, DEFAULT_MAIN_INTERVAL_MS),
      positiveInteger(source.totalAlerts, DEFAULT_TOTAL_ALERTS),
      remindersFromConfig(source)
    );
  }

  class TimerEngine {
    constructor(options = {}) {
      this.now = typeof options.now === "function" ? options.now : defaultNow;
      this.sessionId = 0;
      this.reset();
    }

    reset() {
      this.phase = "idle";
      this.startedAt = null;
      this.config = null;
      this.completedMain = 0;
      this.mainNextAt = null;
      this.reminders = new Map();
      this.reminderEventSequence = 0;
      this.lastObservedAt = null;
      return this.getSnapshot();
    }

    start(config, at = this.now()) {
      const now = this._observe(at, true);
      this.sessionId += 1;
      this.phase = "running";
      this.startedAt = now;
      this.config = normalizeConfig(config);
      this.completedMain = 0;
      this.reminderEventSequence = 0;
      this.mainNextAt = now + this.config.mainIntervalMs;
      this.reminders = new Map(
        this.config.reminders.map((reminder) => [
          reminder.id,
          {
            id: reminder.id,
            enabled: reminder.enabled,
            intervalMs: reminder.intervalMs,
            nextAt: reminder.enabled ? now + reminder.intervalMs : null,
            sequence: 0
          }
        ])
      );
      return this.getSnapshot(now);
    }

    syncReminders(definitions, at = this.now()) {
      const now = this._observe(at);

      if (this.phase !== "running") {
        return this.getSnapshot(now);
      }

      const normalized = normalizeReminderDefinitions(definitions);
      const nextStates = new Map();

      normalized.forEach((definition) => {
        const previous = this.reminders.get(definition.id);
        let nextAt = null;

        if (definition.enabled) {
          const scheduleIsUnchanged =
            previous &&
            previous.enabled &&
            previous.intervalMs === definition.intervalMs &&
            previous.nextAt !== null;
          nextAt = scheduleIsUnchanged ? previous.nextAt : now + definition.intervalMs;
        }

        nextStates.set(definition.id, {
          id: definition.id,
          enabled: definition.enabled,
          intervalMs: definition.intervalMs,
          nextAt,
          sequence: previous ? previous.sequence : 0
        });
      });

      this.reminders = nextStates;
      this.config = freezeConfig(
        this.config.mainIntervalMs,
        this.config.totalAlerts,
        normalized
      );
      return this.getSnapshot(now);
    }

    reconcile(at = this.now()) {
      const now = this._observe(at);
      const events = [];

      if (this.phase !== "running") {
        return events;
      }

      if (now >= this.mainNextAt) {
        const scheduledAt = this.mainNextAt;
        const mainEvent = this._consumeMain("scheduled", now, scheduledAt);
        events.push(mainEvent);

        // Completion owns the notification moment and stops every independent
        // reminder, including reminders due at the same timestamp.
        if (mainEvent.type === "completion") {
          return events;
        }
      }

      this.reminders.forEach((reminder) => {
        if (!reminder.enabled || reminder.nextAt === null || now < reminder.nextAt) {
          return;
        }

        const scheduledAt = reminder.nextAt;
        reminder.sequence += 1;
        this.reminderEventSequence += 1;

        events.push({
          type: "reminder-alert",
          id: `${this.sessionId}:reminder:${this.reminderEventSequence}`,
          sessionId: this.sessionId,
          reminderId: reminder.id,
          sequence: reminder.sequence,
          scheduledAt,
          firedAt: now,
          lateByMs: Math.max(0, now - scheduledAt)
        });

        // A delayed callback produces one notification per independent reminder,
        // never a replay of every missed slot.
        reminder.nextAt = now + reminder.intervalMs;
      });

      return events;
    }

    alertNow(at = this.now()) {
      const now = this._observe(at);

      if (this.phase !== "running") {
        return [];
      }

      return [this._consumeMain("manual", now, now)];
    }

    getSnapshot(at = this.now()) {
      const now = this._observe(at);
      const totalAlerts = this.config ? this.config.totalAlerts : 0;
      const reminders = Array.from(this.reminders.values(), (reminder) => ({
        id: reminder.id,
        enabled: reminder.enabled,
        intervalMs: reminder.intervalMs,
        nextAt: reminder.nextAt,
        remainingMs:
          this.phase === "running" && reminder.nextAt !== null
            ? Math.max(0, reminder.nextAt - now)
            : null
      }));
      const firstReminder = reminders[0] || null;

      return {
        phase: this.phase,
        sessionId: this.sessionId,
        startedAt: this.startedAt,
        completedMain: this.completedMain,
        totalAlerts,
        mainNextAt: this.mainNextAt,
        mainRemainingMs:
          this.phase === "running" ? Math.max(0, this.mainNextAt - now) : null,
        reminders,
        // Snapshot aliases preserve the former single-reminder read API.
        secondaryEnabled: Boolean(firstReminder && firstReminder.enabled),
        secondaryNextAt: firstReminder ? firstReminder.nextAt : null,
        secondaryRemainingMs: firstReminder ? firstReminder.remainingMs : null
      };
    }

    getNextDeadline() {
      if (this.phase !== "running") {
        return null;
      }

      let deadline = this.mainNextAt;
      this.reminders.forEach((reminder) => {
        if (reminder.nextAt !== null) {
          deadline = Math.min(deadline, reminder.nextAt);
        }
      });
      return deadline;
    }

    _consumeMain(source, now, scheduledAt) {
      this.completedMain += 1;

      if (this.completedMain >= this.config.totalAlerts) {
        this.phase = "complete";
        this.completedMain = this.config.totalAlerts;
        this.mainNextAt = null;
        this.reminders.forEach((reminder) => {
          reminder.nextAt = null;
        });

        return {
          type: "completion",
          id: `${this.sessionId}:completion`,
          sessionId: this.sessionId,
          source,
          completedMain: this.completedMain,
          totalAlerts: this.config.totalAlerts,
          scheduledAt,
          firedAt: now,
          lateByMs: source === "scheduled" ? Math.max(0, now - scheduledAt) : 0
        };
      }

      // Both manual alerts and delayed scheduled alerts start a complete new interval.
      this.mainNextAt = now + this.config.mainIntervalMs;

      return {
        type: "main-alert",
        id: `${this.sessionId}:main:${this.completedMain}`,
        sessionId: this.sessionId,
        source,
        completedMain: this.completedMain,
        totalAlerts: this.config.totalAlerts,
        scheduledAt,
        firedAt: now,
        lateByMs: source === "scheduled" ? Math.max(0, now - scheduledAt) : 0
      };
    }

    _observe(value, reset = false) {
      const number = Number(value);
      const observed = Number.isFinite(number) ? number : defaultNow();

      if (reset || this.lastObservedAt === null) {
        this.lastObservedAt = observed;
        return observed;
      }

      // A monotonic browser clock should not move backward, but this guard keeps the
      // state deterministic under test doubles and unusual browser implementations.
      this.lastObservedAt = Math.max(this.lastObservedAt, observed);
      return this.lastObservedAt;
    }
  }

  return {
    TimerEngine,
    normalizeTimerConfig: normalizeConfig,
    normalizeReminderDefinitions
  };
});
