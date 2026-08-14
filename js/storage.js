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

  const STORAGE_KEY = "interval-timer.preferences.v1";

  const DEFAULT_PREFERENCES = Object.freeze({
    mainIntervalSeconds: 62,
    totalAlerts: 29,
    mainSound: "glass-ping",
    mainAlertDurationSeconds: 3,
    soundEnabled: true,
    volume: 100,
    secondaryEnabled: false,
    secondaryIntervalSeconds: 90,
    secondarySound: "double-tap"
  });

  const MAIN_SOUNDS = new Set(["glass-ping", "bright-bell", "soft-chime"]);
  const SECONDARY_SOUNDS = new Set(["double-tap", "signal-drop", "wood-block"]);

  function finiteNumber(value, fallback) {
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
      volume: Math.round(clamp(finiteNumber(source.volume, DEFAULT_PREFERENCES.volume), 0, 100)),
      secondaryEnabled:
        typeof source.secondaryEnabled === "boolean"
          ? source.secondaryEnabled
          : DEFAULT_PREFERENCES.secondaryEnabled,
      secondaryIntervalSeconds: round(
        clamp(
          finiteNumber(
            source.secondaryIntervalSeconds,
            DEFAULT_PREFERENCES.secondaryIntervalSeconds
          ),
          0.1,
          86400
        ),
        1
      ),
      secondarySound: SECONDARY_SOUNDS.has(source.secondarySound)
        ? source.secondarySound
        : DEFAULT_PREFERENCES.secondarySound
    };
  }

  function getStorage() {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch (error) {
      return null;
    }
  }

  function loadPreferences(storage = getStorage()) {
    if (!storage) {
      return { ...DEFAULT_PREFERENCES };
    }

    try {
      const saved = storage.getItem(STORAGE_KEY);
      return saved ? sanitizePreferences(JSON.parse(saved)) : { ...DEFAULT_PREFERENCES };
    } catch (error) {
      return { ...DEFAULT_PREFERENCES };
    }
  }

  function savePreferences(preferences, storage = getStorage()) {
    const sanitized = sanitizePreferences(preferences);

    if (storage) {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
      } catch (error) {
        // Storage can be unavailable in privacy modes. The timer still works in memory.
      }
    }

    return sanitized;
  }

  function restoreDefaultPreferences(storage = getStorage()) {
    const defaults = { ...DEFAULT_PREFERENCES };

    if (storage) {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(defaults));
      } catch (error) {
        // Keep the restored in-memory preferences even if persistence is unavailable.
      }
    }

    return defaults;
  }

  return {
    STORAGE_KEY,
    DEFAULT_PREFERENCES,
    sanitizePreferences,
    loadPreferences,
    savePreferences,
    restoreDefaultPreferences
  };
});
