const test = require("node:test");
const assert = require("node:assert/strict");
const {
  STORAGE_KEY,
  DEFAULT_PREFERENCES,
  sanitizePreferences,
  loadPreferences,
  savePreferences,
  restoreDefaultPreferences
} = require("../js/storage.js");

function memoryStorage(initialValue) {
  const values = new Map();
  if (initialValue !== undefined) values.set(STORAGE_KEY, initialValue);

  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}

test("missing or broken saved data falls back to defaults", () => {
  assert.deepEqual(loadPreferences(memoryStorage()), DEFAULT_PREFERENCES);
  assert.deepEqual(loadPreferences(memoryStorage("not json")), DEFAULT_PREFERENCES);
});

test("preferences are clamped and unknown sounds use defaults", () => {
  const preferences = sanitizePreferences({
    mainIntervalSeconds: -10,
    totalAlerts: 2.7,
    mainSound: "remote-url",
    mainAlertDurationSeconds: 99,
    soundEnabled: false,
    volume: 180,
    secondaryEnabled: true,
    secondaryIntervalSeconds: 0,
    secondarySound: "main-sound"
  });

  assert.equal(preferences.mainIntervalSeconds, 0.1);
  assert.equal(preferences.totalAlerts, 3);
  assert.equal(preferences.mainSound, "glass-ping");
  assert.equal(preferences.mainAlertDurationSeconds, 15);
  assert.equal(preferences.soundEnabled, false);
  assert.equal(preferences.volume, 100);
  assert.equal(preferences.secondaryEnabled, true);
  assert.equal(preferences.secondaryIntervalSeconds, 0.1);
  assert.equal(preferences.secondarySound, "double-tap");
});

test("saved preferences round-trip and defaults can be restored", () => {
  const storage = memoryStorage();
  savePreferences(
    {
      ...DEFAULT_PREFERENCES,
      mainIntervalSeconds: 12.5,
      totalAlerts: 4,
      volume: 44,
      secondaryEnabled: true
    },
    storage
  );

  const saved = loadPreferences(storage);
  assert.equal(saved.mainIntervalSeconds, 12.5);
  assert.equal(saved.totalAlerts, 4);
  assert.equal(saved.volume, 44);
  assert.equal(saved.secondaryEnabled, true);

  assert.deepEqual(restoreDefaultPreferences(storage), DEFAULT_PREFERENCES);
  assert.deepEqual(loadPreferences(storage), DEFAULT_PREFERENCES);
});
