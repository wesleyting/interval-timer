(function attachStorage(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.IntervalTimer = Object.assign(root.IntervalTimer || {}, api);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createStorageApi() {
  "use strict";

  const STORAGE_KEY = "interval-timer.preferences.v3";
  const V2_STORAGE_KEY = "interval-timer.preferences.v2";
  const V1_STORAGE_KEY = "interval-timer.preferences.v1";
  const MAX_TIMERS = 64;
  const MAX_V2_REMINDERS = 50;

  const ALERT_COLORS = Object.freeze([
    "red",
    "amber",
    "cyan",
    "blue",
    "violet",
    "green",
    "pink"
  ]);
  const ALERT_COLOR_SET = new Set(ALERT_COLORS);

  const TIMER_SOUNDS = new Set([
    "glass-ping",
    "bright-bell",
    "soft-chime",
    "double-tap",
    "signal-drop",
    "wood-block"
  ]);
  const MAIN_SOUNDS = new Set(["glass-ping", "bright-bell", "soft-chime"]);
  const REMINDER_SOUNDS = new Set(["double-tap", "signal-drop", "wood-block"]);

  const DEFAULT_TIMERS = Object.freeze([
    Object.freeze({
      id: "main-timer",
      label: "Main timer",
      enabled: true,
      intervalSeconds: 62,
      alertMode: "finite",
      alertCount: 29,
      sound: "glass-ping",
      alertColor: ALERT_COLORS[0],
      alertDurationSeconds: 3,
      persistCompletionBackground: true
    }),
    Object.freeze({
      id: "item-reminder",
      label: "Item reminder",
      enabled: false,
      intervalSeconds: 90,
      alertMode: "infinite",
      alertCount: 1,
      sound: "double-tap",
      alertColor: ALERT_COLORS[1],
      alertDurationSeconds: 1.4,
      persistCompletionBackground: false
    })
  ]);

  const DEFAULT_PREFERENCES = Object.freeze({
    soundEnabled: true,
    volume: 100,
    timers: DEFAULT_TIMERS
  });

  function finiteNumber(value, fallback) {
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "string" && value.trim() === "")
    ) {
      return fallback;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function round(value, places) {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
  }

  function cleanLabel(value, fallback) {
    if (typeof value !== "string") return fallback;
    const label = value.trim().replace(/\s+/g, " ").slice(0, 60);
    return label || fallback;
  }

  function cleanId(value, index, usedIds, prefix = "timer") {
    const raw = typeof value === "string" ? value.trim() : "";
    const cleaned = raw
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    const base = cleaned || `${prefix}-${index + 1}`;
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

  function cleanColor(value, fallback) {
    return ALERT_COLOR_SET.has(value) ? value : fallback;
  }

  function timerFallback(index) {
    if (DEFAULT_TIMERS[index]) return DEFAULT_TIMERS[index];

    return {
      id: `timer-${index + 1}`,
      label: `Timer ${index + 1}`,
      enabled: false,
      intervalSeconds: 90,
      alertMode: "infinite",
      alertCount: 1,
      sound: "double-tap",
      alertColor: ALERT_COLORS[index % ALERT_COLORS.length],
      alertDurationSeconds: 1.4,
      persistCompletionBackground: false
    };
  }

  function timerSources(source) {
    return Array.isArray(source.timers)
      ? source.timers.slice(0, MAX_TIMERS)
      : DEFAULT_TIMERS;
  }

  function sanitizeTimers(source) {
    const usedIds = new Set();

    return timerSources(source).map((entry, index) => {
      const timer = entry && typeof entry === "object" ? entry : {};
      const fallback = timerFallback(index);
      const alertMode = timer.alertMode === "finite" || timer.alertMode === "infinite"
        ? timer.alertMode
        : fallback.alertMode;

      return {
        id: cleanId(timer.id, index, usedIds),
        label: cleanLabel(timer.label, fallback.label),
        enabled: typeof timer.enabled === "boolean" ? timer.enabled : fallback.enabled,
        intervalSeconds: round(
          clamp(finiteNumber(timer.intervalSeconds, fallback.intervalSeconds), 0.1, 86400),
          1
        ),
        alertMode,
        alertCount: Math.round(
          clamp(finiteNumber(timer.alertCount, fallback.alertCount), 1, 9999)
        ),
        sound: TIMER_SOUNDS.has(timer.sound) ? timer.sound : fallback.sound,
        alertColor: cleanColor(
          timer.alertColor,
          ALERT_COLORS[index % ALERT_COLORS.length]
        ),
        alertDurationSeconds: round(
          clamp(
            finiteNumber(timer.alertDurationSeconds, fallback.alertDurationSeconds),
            0.5,
            15
          ),
          1
        ),
        persistCompletionBackground:
          typeof timer.persistCompletionBackground === "boolean"
            ? timer.persistCompletionBackground
            : fallback.persistCompletionBackground
      };
    });
  }

  function sanitizePreferences(value) {
    const source = value && typeof value === "object" ? value : {};

    return {
      soundEnabled:
        typeof source.soundEnabled === "boolean"
          ? source.soundEnabled
          : DEFAULT_PREFERENCES.soundEnabled,
      volume: Math.round(
        clamp(finiteNumber(source.volume, DEFAULT_PREFERENCES.volume), 0, 100)
      ),
      timers: sanitizeTimers(source)
    };
  }

  function legacyReminderSource(source) {
    const hasLegacyReminder =
      Object.prototype.hasOwnProperty.call(source, "secondaryEnabled") ||
      Object.prototype.hasOwnProperty.call(source, "secondaryIntervalSeconds") ||
      Object.prototype.hasOwnProperty.call(source, "secondarySound");

    if (!hasLegacyReminder) return null;

    return {
      id: "item-reminder",
      label: "Item reminder",
      enabled: typeof source.secondaryEnabled === "boolean" ? source.secondaryEnabled : false,
      intervalSeconds: source.secondaryIntervalSeconds,
      sound: source.secondarySound
    };
  }

  function v2ReminderSources(source) {
    if (Array.isArray(source.reminders)) {
      return source.reminders.slice(0, MAX_V2_REMINDERS);
    }

    const legacy = legacyReminderSource(source);
    return legacy
      ? [legacy]
      : [
          {
            id: "item-reminder",
            label: "Item reminder",
            enabled: false,
            intervalSeconds: 90,
            sound: "double-tap"
          }
        ];
  }

  function sanitizeV2Preferences(value) {
    const source = value && typeof value === "object" ? value : {};
    const usedIds = new Set();
    const reminders = v2ReminderSources(source).map((entry, index) => {
      const reminder = entry && typeof entry === "object" ? entry : {};

      return {
        id: cleanId(reminder.id, index, usedIds, "reminder"),
        label: cleanLabel(reminder.label, `Reminder ${index + 1}`),
        enabled: typeof reminder.enabled === "boolean" ? reminder.enabled : false,
        intervalSeconds: round(
          clamp(finiteNumber(reminder.intervalSeconds, 90), 0.1, 86400),
          1
        ),
        sound: REMINDER_SOUNDS.has(reminder.sound) ? reminder.sound : "double-tap"
      };
    });

    return {
      mainIntervalSeconds: round(
        clamp(finiteNumber(source.mainIntervalSeconds, 62), 0.1, 86400),
        1
      ),
      totalAlerts: Math.round(clamp(finiteNumber(source.totalAlerts, 29), 1, 9999)),
      mainSound: MAIN_SOUNDS.has(source.mainSound) ? source.mainSound : "glass-ping",
      mainAlertDurationSeconds: round(
        clamp(finiteNumber(source.mainAlertDurationSeconds, 3), 0.5, 15),
        1
      ),
      soundEnabled: typeof source.soundEnabled === "boolean" ? source.soundEnabled : true,
      volume: Math.round(clamp(finiteNumber(source.volume, 100), 0, 100)),
      reminders
    };
  }

  function migrateV2Preferences(value) {
    const legacy = sanitizeV2Preferences(value);
    const timers = [
      {
        id: "main-timer",
        label: "Main timer",
        enabled: true,
        intervalSeconds: legacy.mainIntervalSeconds,
        alertMode: "finite",
        alertCount: legacy.totalAlerts,
        sound: legacy.mainSound,
        alertColor: ALERT_COLORS[0],
        alertDurationSeconds: legacy.mainAlertDurationSeconds,
        persistCompletionBackground: true
      },
      ...legacy.reminders.map((reminder, index) => ({
        id: reminder.id,
        label: reminder.label,
        enabled: reminder.enabled,
        intervalSeconds: reminder.intervalSeconds,
        alertMode: "infinite",
        alertCount: 1,
        sound: reminder.sound,
        alertColor: ALERT_COLORS[(index + 1) % ALERT_COLORS.length],
        alertDurationSeconds: 1.4,
        persistCompletionBackground: false
      }))
    ];

    return sanitizePreferences({
      soundEnabled: legacy.soundEnabled,
      volume: legacy.volume,
      timers
    });
  }

  function cloneDefaultPreferences() {
    return sanitizePreferences(DEFAULT_PREFERENCES);
  }

  function getStorage() {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch (error) {
      return null;
    }
  }

  function readStoredObject(storage, key) {
    try {
      const saved = storage.getItem(key);
      if (saved === null) return null;
      const parsed = JSON.parse(saved);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  function writeStoredPreferences(storage, preferences) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch (error) {
      // The in-memory preferences remain usable when storage is unavailable.
    }
  }

  function loadPreferences(storage = getStorage()) {
    if (!storage) return cloneDefaultPreferences();

    const saved = readStoredObject(storage, STORAGE_KEY);
    if (saved) return sanitizePreferences(saved);

    const v2 = readStoredObject(storage, V2_STORAGE_KEY);
    if (v2) {
      const migrated = migrateV2Preferences(v2);
      writeStoredPreferences(storage, migrated);
      return migrated;
    }

    const v1 = readStoredObject(storage, V1_STORAGE_KEY);
    if (v1) {
      const migrated = migrateV2Preferences(v1);
      writeStoredPreferences(storage, migrated);
      return migrated;
    }

    return cloneDefaultPreferences();
  }

  function savePreferences(preferences, storage = getStorage()) {
    const sanitized = sanitizePreferences(preferences);
    if (storage) writeStoredPreferences(storage, sanitized);
    return sanitized;
  }

  function restoreDefaultPreferences(storage = getStorage()) {
    const defaults = cloneDefaultPreferences();
    if (storage) writeStoredPreferences(storage, defaults);
    return defaults;
  }

  return {
    STORAGE_KEY,
    V2_STORAGE_KEY,
    V1_STORAGE_KEY,
    MAX_TIMERS,
    ALERT_COLORS,
    DEFAULT_PREFERENCES,
    sanitizePreferences,
    migrateV2Preferences,
    loadPreferences,
    savePreferences,
    restoreDefaultPreferences
  };
});
