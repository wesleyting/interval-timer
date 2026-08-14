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

  function normalizeConfig(config) {
    const source = config && typeof config === "object" ? config : {};

    return Object.freeze({
      mainIntervalMs: positiveMilliseconds(source.mainIntervalMs, 62000),
      totalAlerts: positiveInteger(source.totalAlerts, 29),
      secondaryEnabled: Boolean(source.secondaryEnabled),
      secondaryIntervalMs: positiveMilliseconds(source.secondaryIntervalMs, 90000)
    });
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
      this.secondaryNextAt = null;
      this.secondarySequence = 0;
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
      this.secondarySequence = 0;
      this.mainNextAt = now + this.config.mainIntervalMs;
      this.secondaryNextAt = this.config.secondaryEnabled
        ? now + this.config.secondaryIntervalMs
        : null;
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

        // Completion stops the independent reminder immediately. If both were overdue,
        // the final completion cue wins and there is no stale secondary notification.
        if (mainEvent.type === "completion") {
          return events;
        }
      }

      if (
        this.phase === "running" &&
        this.secondaryNextAt !== null &&
        now >= this.secondaryNextAt
      ) {
        const scheduledAt = this.secondaryNextAt;
        this.secondarySequence += 1;

        const secondaryEvent = {
          type: "secondary-alert",
          id: `${this.sessionId}:secondary:${this.secondarySequence}`,
          sessionId: this.sessionId,
          sequence: this.secondarySequence,
          scheduledAt,
          firedAt: now,
          lateByMs: Math.max(0, now - scheduledAt)
        };

        // A delayed browser callback produces one notification, not a replay of every
        // missed slot. Rebasing gives the user a full interval after the delivered cue.
        this.secondaryNextAt = now + this.config.secondaryIntervalMs;
        events.push(secondaryEvent);
      }

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

      return {
        phase: this.phase,
        sessionId: this.sessionId,
        startedAt: this.startedAt,
        completedMain: this.completedMain,
        totalAlerts,
        mainNextAt: this.mainNextAt,
        mainRemainingMs:
          this.phase === "running" ? Math.max(0, this.mainNextAt - now) : null,
        secondaryEnabled: Boolean(this.config && this.config.secondaryEnabled),
        secondaryNextAt: this.secondaryNextAt,
        secondaryRemainingMs:
          this.phase === "running" && this.secondaryNextAt !== null
            ? Math.max(0, this.secondaryNextAt - now)
            : null
      };
    }

    getNextDeadline() {
      if (this.phase !== "running") {
        return null;
      }

      return this.secondaryNextAt === null
        ? this.mainNextAt
        : Math.min(this.mainNextAt, this.secondaryNextAt);
    }

    _consumeMain(source, now, scheduledAt) {
      this.completedMain += 1;

      if (this.completedMain >= this.config.totalAlerts) {
        this.phase = "complete";
        this.completedMain = this.config.totalAlerts;
        this.mainNextAt = null;
        this.secondaryNextAt = null;

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
      // This removes the legacy short-countdown behavior after background throttling.
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
    normalizeTimerConfig: normalizeConfig
  };
});
