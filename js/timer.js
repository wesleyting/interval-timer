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

  const DEFAULT_INTERVAL_MS = 62000;
  const DEFAULT_ALERT_LIMIT = 29;

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

  function uniqueTimerId(value, index, usedIds) {
    const supplied = typeof value === "string" ? value.trim().slice(0, 64) : "";
    const base = supplied || `timer-${index + 1}`;
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

  function normalizeTimerDefinitions(value) {
    if (!Array.isArray(value)) return Object.freeze([]);

    const usedIds = new Set();
    const definitions = value.map((entry, index) => {
      const source = entry && typeof entry === "object" ? entry : {};

      return Object.freeze({
        id: uniqueTimerId(source.id, index, usedIds),
        enabled: typeof source.enabled === "boolean" ? source.enabled : false,
        intervalMs: positiveMilliseconds(source.intervalMs, DEFAULT_INTERVAL_MS),
        alertLimit:
          source.alertLimit === null
            ? null
            : positiveInteger(source.alertLimit, DEFAULT_ALERT_LIMIT)
      });
    });

    return Object.freeze(definitions);
  }

  class TimerEngine {
    constructor(options = {}) {
      this.now = typeof options.now === "function" ? options.now : defaultNow;
      this.timers = new Map();
      this.order = [];
      this.eventSequence = 0;
      this.runSequence = 0;
      this.lastObservedAt = null;

      if (Array.isArray(options.timers)) {
        this.syncTimers(options.timers, this.now());
      }
    }

    syncTimers(definitions, at = this.now()) {
      const now = this._observe(at);
      const normalized = normalizeTimerDefinitions(definitions);
      const nextTimers = new Map();
      const events = [];

      normalized.forEach((definition) => {
        const previous = this.timers.get(definition.id);

        if (!previous) {
          nextTimers.set(definition.id, this._newState(definition));
          return;
        }

        const state = { ...previous };
        const enabledChanged = state.enabled !== definition.enabled;
        const intervalChanged = state.intervalMs !== definition.intervalMs;
        const limitChanged = state.alertLimit !== definition.alertLimit;
        const scheduleChanged = intervalChanged || limitChanged;

        state.enabled = definition.enabled;
        state.intervalMs = definition.intervalMs;
        state.alertLimit = definition.alertLimit;

        if (!definition.enabled) {
          if (enabledChanged || state.phase !== "idle" || scheduleChanged) {
            state.revision += 1;
            this._makeIdle(state);
          }
          nextTimers.set(definition.id, state);
          return;
        }

        if (enabledChanged) {
          state.revision += 1;
          this._makeIdle(state);
          nextTimers.set(definition.id, state);
          return;
        }

        if (scheduleChanged) {
          state.revision += 1;

          if (state.phase === "complete") {
            // A completed result belongs to the definition that produced it. Editing
            // its schedule prepares a fresh idle run instead of showing stale progress.
            this._makeIdle(state);
          } else if (
            state.phase === "running" &&
            state.alertLimit !== null &&
            state.completedAlerts >= state.alertLimit
          ) {
            state.phase = "complete";
            state.completedAlerts = state.alertLimit;
            state.nextAt = null;
            events.push(this._makeEvent(state, "timer-complete", "configuration", now, now));
          } else if (state.phase === "running" && intervalChanged) {
            // A live retime gives only this timer a complete new interval.
            state.nextAt = now + state.intervalMs;
          }
        }

        nextTimers.set(definition.id, state);
      });

      this.timers = nextTimers;
      this.order = normalized.map((definition) => definition.id);
      return events;
    }

    start(timerId, at = this.now()) {
      const now = this._observe(at);
      const timer = this.timers.get(timerId);

      if (!timer || !timer.enabled || timer.phase !== "idle") return null;

      timer.phase = "running";
      timer.runId = ++this.runSequence;
      timer.revision += 1;
      timer.startedAt = now;
      timer.completedAlerts = 0;
      timer.nextAt = now + timer.intervalMs;
      return this._snapshotTimer(timer, now);
    }

    reset(timerId, at = this.now()) {
      const now = this._observe(at);
      const timer = this.timers.get(timerId);

      if (!timer) return null;

      timer.revision += 1;
      this._makeIdle(timer);
      return this._snapshotTimer(timer, now);
    }

    alertNow(timerId, at = this.now()) {
      const now = this._observe(at);
      const timer = this.timers.get(timerId);

      if (!timer || !timer.enabled || timer.phase !== "running") return [];

      return [this._consume(timer, "manual", now, now)];
    }

    reconcile(at = this.now()) {
      const now = this._observe(at);
      const events = [];

      this.order.forEach((timerId) => {
        const timer = this.timers.get(timerId);
        if (
          !timer ||
          !timer.enabled ||
          timer.phase !== "running" ||
          timer.nextAt === null ||
          now < timer.nextAt
        ) {
          return;
        }

        events.push(this._consume(timer, "scheduled", now, timer.nextAt));
      });

      return events;
    }

    getSnapshot(at = this.now()) {
      const now = this._observe(at);
      const timers = this.order
        .map((timerId) => this.timers.get(timerId))
        .filter(Boolean)
        .map((timer) => this._snapshotTimer(timer, now));
      const runningCount = timers.reduce(
        (count, timer) => count + (timer.phase === "running" ? 1 : 0),
        0
      );

      return {
        timers,
        runningCount,
        hasRunningTimers: runningCount > 0
      };
    }

    snapshot(at = this.now()) {
      return this.getSnapshot(at);
    }

    getNextDeadline() {
      let deadline = null;

      this.order.forEach((timerId) => {
        const timer = this.timers.get(timerId);
        if (!timer || timer.phase !== "running" || timer.nextAt === null) return;
        deadline = deadline === null ? timer.nextAt : Math.min(deadline, timer.nextAt);
      });

      return deadline;
    }

    deadline() {
      return this.getNextDeadline();
    }

    _newState(definition) {
      return {
        id: definition.id,
        enabled: definition.enabled,
        intervalMs: definition.intervalMs,
        alertLimit: definition.alertLimit,
        phase: "idle",
        runId: null,
        revision: 0,
        startedAt: null,
        completedAlerts: 0,
        nextAt: null
      };
    }

    _makeIdle(timer) {
      timer.phase = "idle";
      timer.runId = null;
      timer.startedAt = null;
      timer.completedAlerts = 0;
      timer.nextAt = null;
    }

    _consume(timer, source, now, scheduledAt) {
      timer.completedAlerts = Math.min(
        Number.MAX_SAFE_INTEGER,
        timer.completedAlerts + 1
      );
      const isComplete =
        timer.alertLimit !== null && timer.completedAlerts >= timer.alertLimit;

      if (isComplete) {
        timer.phase = "complete";
        timer.completedAlerts = timer.alertLimit;
        timer.nextAt = null;
      } else {
        // Scheduled and manual alerts both give this timer a full next interval.
        timer.nextAt = now + timer.intervalMs;
      }

      return this._makeEvent(
        timer,
        isComplete ? "timer-complete" : "timer-alert",
        source,
        now,
        scheduledAt
      );
    }

    _makeEvent(timer, type, source, now, scheduledAt) {
      this.eventSequence += 1;

      return {
        type,
        id: `timer-event:${this.eventSequence}`,
        timerId: timer.id,
        runId: timer.runId,
        revision: timer.revision,
        source,
        sequence: timer.completedAlerts,
        completedAlerts: timer.completedAlerts,
        alertLimit: timer.alertLimit,
        scheduledAt,
        firedAt: now,
        lateByMs: source === "scheduled" ? Math.max(0, now - scheduledAt) : 0
      };
    }

    _snapshotTimer(timer, now) {
      return {
        id: timer.id,
        enabled: timer.enabled,
        intervalMs: timer.intervalMs,
        alertLimit: timer.alertLimit,
        phase: timer.phase,
        runId: timer.runId,
        revision: timer.revision,
        startedAt: timer.startedAt,
        completedAlerts: timer.completedAlerts,
        nextAt: timer.nextAt,
        remainingMs:
          timer.phase === "running" && timer.nextAt !== null
            ? Math.max(0, timer.nextAt - now)
            : null
      };
    }

    _observe(value) {
      const number = Number(value);
      const observed = Number.isFinite(number) ? number : defaultNow();

      if (this.lastObservedAt === null) {
        this.lastObservedAt = observed;
        return observed;
      }

      this.lastObservedAt = Math.max(this.lastObservedAt, observed);
      return this.lastObservedAt;
    }
  }

  return {
    TimerEngine,
    normalizeTimerDefinitions
  };
});
