const test = require("node:test");
const assert = require("node:assert/strict");
const {
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  MAX_REMINDERS,
  DEFAULT_PREFERENCES,
  sanitizePreferences,
  loadPreferences,
  savePreferences,
  restoreDefaultPreferences
} = require("../js/storage.js");

function memoryStorage(initialValues = {}) {
  const values = new Map(Object.entries(initialValues));

  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    value(key) {
      return values.get(key);
    }
  };
}

test("missing or broken saved data falls back to fresh defaults", () => {
  const missing = loadPreferences(memoryStorage());
  const broken = loadPreferences(memoryStorage({ [STORAGE_KEY]: "not json" }));

  assert.deepEqual(missing, DEFAULT_PREFERENCES);
  assert.deepEqual(broken, DEFAULT_PREFERENCES);
  assert.notStrictEqual(missing, DEFAULT_PREFERENCES);
  assert.notStrictEqual(missing.reminders, DEFAULT_PREFERENCES.reminders);
});

test("preferences and reminder fields are sanitized without mutating input", () => {
  const input = {
    mainIntervalSeconds: -10,
    totalAlerts: 2.7,
    mainSound: "remote-url",
    mainAlertDurationSeconds: 99,
    soundEnabled: false,
    volume: 180,
    reminders: [
      {
        id: "same!",
        label: "   ",
        enabled: "yes",
        intervalSeconds: null,
        sound: "main-sound"
      },
      {
        id: "same@",
        label: "  Buff    check  ",
        enabled: true,
        intervalSeconds: -5,
        sound: "wood-block"
      }
    ]
  };
  const preferences = sanitizePreferences(input);

  assert.equal(preferences.mainIntervalSeconds, 0.1);
  assert.equal(preferences.totalAlerts, 3);
  assert.equal(preferences.mainSound, "glass-ping");
  assert.equal(preferences.mainAlertDurationSeconds, 15);
  assert.equal(preferences.soundEnabled, false);
  assert.equal(preferences.volume, 100);
  assert.deepEqual(preferences.reminders, [
    {
      id: "same",
      label: "Reminder 1",
      enabled: false,
      intervalSeconds: 90,
      sound: "double-tap"
    },
    {
      id: "same-2",
      label: "Buff check",
      enabled: true,
      intervalSeconds: 0.1,
      sound: "wood-block"
    }
  ]);
  assert.equal(input.reminders[1].id, "same@");
});

test("blank and null numeric values restore defaults instead of becoming zero", () => {
  const preferences = sanitizePreferences({
    mainIntervalSeconds: "",
    totalAlerts: null,
    mainAlertDurationSeconds: "   ",
    volume: false,
    reminders: [{ intervalSeconds: "" }]
  });

  assert.equal(preferences.mainIntervalSeconds, 62);
  assert.equal(preferences.totalAlerts, 29);
  assert.equal(preferences.mainAlertDurationSeconds, 3);
  assert.equal(preferences.volume, 100);
  assert.equal(preferences.reminders[0].intervalSeconds, 90);
});

test("legacy v1 secondary settings migrate to one v2 reminder", () => {
  const legacy = {
    mainIntervalSeconds: 12.5,
    totalAlerts: 4,
    mainSound: "soft-chime",
    mainAlertDurationSeconds: 2.5,
    soundEnabled: false,
    volume: 44,
    secondaryEnabled: true,
    secondaryIntervalSeconds: 75.5,
    secondarySound: "signal-drop"
  };
  const storage = memoryStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify(legacy) });
  const migrated = loadPreferences(storage);

  assert.equal(migrated.mainIntervalSeconds, 12.5);
  assert.equal(migrated.totalAlerts, 4);
  assert.deepEqual(migrated.reminders, [
    {
      id: "item-reminder",
      label: "Item reminder",
      enabled: true,
      intervalSeconds: 75.5,
      sound: "signal-drop"
    }
  ]);
  assert.deepEqual(JSON.parse(storage.value(STORAGE_KEY)), migrated);
});

test("corrupt v2 falls back to legacy while valid v2 takes precedence", () => {
  const legacy = JSON.stringify({
    secondaryEnabled: true,
    secondaryIntervalSeconds: 70,
    secondarySound: "wood-block"
  });
  const fallbackStorage = memoryStorage({
    [STORAGE_KEY]: "broken",
    [LEGACY_STORAGE_KEY]: legacy
  });

  assert.equal(loadPreferences(fallbackStorage).reminders[0].intervalSeconds, 70);

  const preferredStorage = memoryStorage({
    [STORAGE_KEY]: JSON.stringify({ ...DEFAULT_PREFERENCES, reminders: [] }),
    [LEGACY_STORAGE_KEY]: legacy
  });
  assert.deepEqual(loadPreferences(preferredStorage).reminders, []);
});

test("a valid empty reminder list stays empty and oversized corrupt lists are capped", () => {
  assert.deepEqual(sanitizePreferences({ reminders: [] }).reminders, []);

  const oversized = Array.from({ length: MAX_REMINDERS + 10 }, (_, index) => ({
    id: `reminder-${index}`,
    label: `Reminder ${index}`,
    enabled: true,
    intervalSeconds: index + 1,
    sound: "double-tap"
  }));
  assert.equal(sanitizePreferences({ reminders: oversized }).reminders.length, MAX_REMINDERS);
});

test("saved v2 preferences round-trip with several reminders", () => {
  const storage = memoryStorage();
  const saved = savePreferences(
    {
      ...DEFAULT_PREFERENCES,
      mainIntervalSeconds: 90,
      totalAlerts: 7,
      volume: 44,
      reminders: [
        {
          id: "item",
          label: "Item",
          enabled: true,
          intervalSeconds: 90,
          sound: "double-tap"
        },
        {
          id: "buff",
          label: "Buff",
          enabled: true,
          intervalSeconds: 125.5,
          sound: "signal-drop"
        }
      ]
    },
    storage
  );

  assert.deepEqual(loadPreferences(storage), saved);
  assert.equal(storage.getItem(LEGACY_STORAGE_KEY), null);
});

test("restore defaults writes v2 and returns independent nested data", () => {
  const storage = memoryStorage();
  const first = restoreDefaultPreferences(storage);
  const second = loadPreferences(storage);

  assert.deepEqual(first, DEFAULT_PREFERENCES);
  assert.deepEqual(second, DEFAULT_PREFERENCES);
  assert.notStrictEqual(first.reminders, second.reminders);
  first.reminders[0].label = "Changed locally";
  assert.equal(second.reminders[0].label, "Item reminder");
  assert.deepEqual(JSON.parse(storage.value(STORAGE_KEY)), DEFAULT_PREFERENCES);
});
