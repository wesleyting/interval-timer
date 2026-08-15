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

  const STORAGE_KEY = "interval-timer.preferences.v2";
  const LEGACY_STORAGE_KEY = "interval-timer.preferences.v1";
  const MAX_REMINDERS = 50;

  const DEFAULT_REMINDERS = Object.freeze([
    Object.freeze({
      id: "item-reminder",
      label: "Item reminder",
      enabled: false,
      intervalSeconds: 90,
      sound: "double-tap"
    })
  ]);

  const DEFAULT_PREFERENCES = Object.freeze({
    mainIntervalSeconds: 62,
    totalAlerts: 29,
    mainSound: "glass-ping",
    mainAlertDurationSeconds: 3,
    soundEnabled: true,
    volume: 100,
    reminders: DEFAULT_REMINDERS
  });

  const MAIN_SOUNDS = new Set(["glass-ping", "bright-bell", "soft-chime"]);
  const REMINDER_SOUNDS = new Set(["double-tap", "signal-drop", "wood-block"]);

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

  function cleanId(value, index, usedIds) {
    const raw = typeof value === "string" ? value.trim() : "";
    const cleaned = raw
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    const base = cleaned || `reminder-${index + 1}`;
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

  function legacyReminderSource(source) {
    const hasLegacyReminder =
      Object.prototype.hasOwnProperty.call(source, "secondaryEnabled") ||
      Object.prototype.hasOwnProperty.call(source, "secondaryIntervalSeconds") ||
      Object.prototype.hasOwnProperty.call(source, "secondarySound");

    if (!hasLegacyReminder) return null;

    return {
      id: "item-reminder",
      label: "Item reminder",
      enabled:
        typeof source.secondaryEnabled === "boolean"
          ? source.secondaryEnabled
          : DEFAULT_REMINDERS[0].enabled,
      intervalSeconds: source.secondaryIntervalSeconds,
      sound: source.secondarySound
    };
  }

  function reminderSources(source) {
    if (Array.isArray(source.reminders)) {
      return source.reminders.slice(0, MAX_REMINDERS);
    }

    const legacy = legacyReminderSource(source);
    return legacy ? [legacy] : DEFAULT_REMINDERS;
  }

  function sanitizeReminders(source) {
    const usedIds = new Set();

    return reminderSources(source).map((entry, index) => {
      const reminder = entry && typeof entry === "object" ? entry : {};
      const defaultLabel = `Reminder ${index + 1}`;

      return {
        id: cleanId(reminder.id, index, usedIds),
        label: cleanLabel(reminder.label, defaultLabel),
        enabled: typeof reminder.enabled === "boolean" ? reminder.enabled : false,
        intervalSeconds: round(
          clamp(
            finiteNumber(reminder.intervalSeconds, DEFAULT_REMINDERS[0].intervalSeconds),
            0.1,
            86400
          ),
          1
        ),
        sound: REMINDER_SOUNDS.has(reminder.sound)
          ? reminder.sound
          : DEFAULT_REMINDERS[0].sound
      };
    });
  }

  function sanitizePreferences(value) {
    const source = value && typeof value === "object" ? value : {};

    return {
      mainIntervalSeconds: round(
        clamp(
          finiteNumber(source.mainIntervalSeconds, DEFAULT_PREFERENCES.mainIntervalSeconds),
          0.1,
          86400
        ),
        1
      ),
      totalAlerts: Math.round(
        clamp(finiteNumber(source.totalAlerts, DEFAULT_PREFERENCES.totalAlerts), 1, 9999)
      ),
      mainSound: MAIN_SOUNDS.has(source.mainSound)
        ? source.mainSound
        : DEFAULT_PREFERENCES.mainSound,
      mainAlertDurationSeconds: round(
        clamp(
          finiteNumber(
            source.mainAlertDurationSeconds,
            DEFAULT_PREFERENCES.mainAlertDurationSeconds
          ),
          0.5,
          15
        ),
        1
      ),
      soundEnabled:
        typeof source.soundEnabled === "boolean"
          ? source.soundEnabled
          : DEFAULT_PREFERENCES.soundEnabled,
      volume: Math.round(
        clamp(finiteNumber(source.volume, DEFAULT_PREFERENCES.volume), 0, 100)
      ),
      reminders: sanitizeReminders(source)
    };
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
      // Storage can be unavailable in privacy modes. The timer still works in memory.
    }
  }

  function loadPreferences(storage = getStorage()) {
    if (!storage) {
      return cloneDefaultPreferences();
    }

    const saved = readStoredObject(storage, STORAGE_KEY);
    if (saved) {
      return sanitizePreferences(saved);
    }

    const legacy = readStoredObject(storage, LEGACY_STORAGE_KEY);
    if (legacy) {
      const migrated = sanitizePreferences(legacy);
      writeStoredPreferences(storage, migrated);
      return migrated;
    }

    return cloneDefaultPreferences();
  }

  function savePreferences(preferences, storage = getStorage()) {
    const sanitized = sanitizePreferences(preferences);

    if (storage) {
      writeStoredPreferences(storage, sanitized);
    }

    return sanitized;
  }

  function restoreDefaultPreferences(storage = getStorage()) {
    const defaults = cloneDefaultPreferences();

    if (storage) {
      writeStoredPreferences(storage, defaults);
    }

    return defaults;
  }

  return {
    STORAGE_KEY,
    LEGACY_STORAGE_KEY,
    MAX_REMINDERS,
    DEFAULT_PREFERENCES,
    sanitizePreferences,
    loadPreferences,
    savePreferences,
    restoreDefaultPreferences
  };
});
