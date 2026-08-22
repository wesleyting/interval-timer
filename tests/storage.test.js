const test = require("node:test");
const assert = require("node:assert/strict");
const {
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

test("missing or broken data returns fresh v3 defaults", () => {
  const missing = loadPreferences(memoryStorage());
  const broken = loadPreferences(memoryStorage({ [STORAGE_KEY]: "not json" }));

  assert.deepEqual(missing, DEFAULT_PREFERENCES);
  assert.deepEqual(broken, DEFAULT_PREFERENCES);
  assert.notStrictEqual(missing, DEFAULT_PREFERENCES);
  assert.notStrictEqual(missing.timers, DEFAULT_PREFERENCES.timers);
  assert.deepEqual(
    missing.timers.map((timer) => [timer.label, timer.alertMode, timer.alertColor]),
    [
      ["Main timer", "finite", "red"],
      ["Item reminder", "infinite", "amber"]
    ]
  );
  assert.equal(missing.timers[0].alertDurationSeconds, 3);
  assert.equal(missing.timers[1].alertDurationSeconds, 1.4);
});

test("v3 timer fields are sanitized and duplicate ids are repaired", () => {
  const input = {
    soundEnabled: false,
    volume: 180,
    timers: [
      {
        id: "same!",
        label: "   ",
        enabled: "yes",
        intervalSeconds: null,
        alertMode: "sometimes",
        alertCount: null,
        sound: "remote-url",
        alertColor: "#ff0000",
        alertDurationSeconds: 99,
        persistCompletionBackground: "yes"
      },
      {
        id: "same@",
        label: "  Buff    timer  ",
        enabled: true,
        intervalSeconds: -5,
        alertMode: "infinite",
        alertCount: 0,
        sound: "wood-block",
        alertColor: "cyan",
        alertDurationSeconds: null,
        persistCompletionBackground: true
      }
    ]
  };
  const preferences = sanitizePreferences(input);

  assert.equal(preferences.soundEnabled, false);
  assert.equal(preferences.volume, 100);
  assert.deepEqual(preferences.timers, [
    {
      id: "same",
      label: "Main timer",
      enabled: true,
      intervalSeconds: 62,
      alertMode: "finite",
      alertCount: 29,
      sound: "glass-ping",
      alertColor: "red",
      alertDurationSeconds: 15,
      persistCompletionBackground: true
    },
    {
      id: "same-2",
      label: "Buff timer",
      enabled: true,
      intervalSeconds: 0.1,
      alertMode: "infinite",
      alertCount: 1,
      sound: "wood-block",
      alertColor: "cyan",
      alertDurationSeconds: 1.4,
      persistCompletionBackground: true
    }
  ]);
  assert.equal(input.timers[1].id, "same@");
});

test("v3 preserves an empty timer list and caps corrupted oversized lists", () => {
  assert.deepEqual(sanitizePreferences({ timers: [] }).timers, []);

  const oversized = Array.from({ length: MAX_TIMERS + 10 }, (_, index) => ({
    id: `timer-${index}`,
    label: `Timer ${index}`,
    enabled: true,
    intervalSeconds: index + 1,
    alertMode: "infinite",
    alertCount: 1,
    sound: "double-tap",
    alertColor: ALERT_COLORS[index % ALERT_COLORS.length],
    alertDurationSeconds: 1.4,
    persistCompletionBackground: false
  }));

  assert.equal(sanitizePreferences({ timers: oversized }).timers.length, MAX_TIMERS);
});

test("v3 preserves the additional high-pitched timer sounds", () => {
  for (const sound of ["crystal-chirp", "triple-spark", "high-beacon"]) {
    const preferences = sanitizePreferences({
      timers: [{ ...DEFAULT_PREFERENCES.timers[0], sound }]
    });
    assert.equal(preferences.timers[0].sound, sound);
  }
});

test("v3 preferences round-trip finite and infinite timers", () => {
  const storage = memoryStorage();
  const saved = savePreferences(
    {
      soundEnabled: true,
      volume: 44,
      timers: [
        {
          id: "work",
          label: "Work",
          enabled: true,
          intervalSeconds: 90,
          alertMode: "finite",
          alertCount: 7,
          sound: "bright-bell",
          alertColor: "blue",
          alertDurationSeconds: 4.5,
          persistCompletionBackground: true
        },
        {
          id: "buff",
          label: "Buff",
          enabled: false,
          intervalSeconds: 125.5,
          alertMode: "infinite",
          alertCount: 12,
          sound: "signal-drop",
          alertColor: "violet",
          alertDurationSeconds: 1.2,
          persistCompletionBackground: false
        }
      ]
    },
    storage
  );

  assert.deepEqual(loadPreferences(storage), saved);
  assert.equal(storage.getItem(V2_STORAGE_KEY), null);
});

test("v2 main and reminders migrate into independent timers", () => {
  const v2 = {
    mainIntervalSeconds: 12.5,
    totalAlerts: 4,
    mainSound: "soft-chime",
    mainAlertDurationSeconds: 2.5,
    soundEnabled: false,
    volume: 44,
    reminders: [
      {
        id: "main-timer",
        label: "Item",
        enabled: true,
        intervalSeconds: 75.5,
        sound: "signal-drop"
      },
      {
        id: "buff",
        label: "Buff",
        enabled: false,
        intervalSeconds: 130,
        sound: "wood-block"
      }
    ]
  };
  const migrated = migrateV2Preferences(v2);

  assert.equal(migrated.soundEnabled, false);
  assert.equal(migrated.volume, 44);
  assert.deepEqual(migrated.timers, [
    {
      id: "main-timer",
      label: "Main timer",
      enabled: true,
      intervalSeconds: 12.5,
      alertMode: "finite",
      alertCount: 4,
      sound: "soft-chime",
      alertColor: "red",
      alertDurationSeconds: 2.5,
      persistCompletionBackground: true
    },
    {
      id: "main-timer-2",
      label: "Item",
      enabled: true,
      intervalSeconds: 75.5,
      alertMode: "infinite",
      alertCount: 1,
      sound: "signal-drop",
      alertColor: "amber",
      alertDurationSeconds: 1.4,
      persistCompletionBackground: false
    },
    {
      id: "buff",
      label: "Buff",
      enabled: false,
      intervalSeconds: 130,
      alertMode: "infinite",
      alertCount: 1,
      sound: "wood-block",
      alertColor: "cyan",
      alertDurationSeconds: 1.4,
      persistCompletionBackground: false
    }
  ]);
});

test("v2 migration preserves all fifty reminders plus the main timer", () => {
  const reminders = Array.from({ length: 50 }, (_, index) => ({
    id: `old-${index}`,
    label: `Old ${index}`,
    enabled: index % 2 === 0,
    intervalSeconds: index + 1,
    sound: "double-tap"
  }));
  const migrated = migrateV2Preferences({ reminders });

  assert.equal(migrated.timers.length, 51);
  assert.equal(migrated.timers[50].id, "old-49");
  assert.equal(migrated.timers[1].alertColor, "amber");
  assert.equal(migrated.timers[2].alertColor, "cyan");
  assert.equal(migrated.timers[3].alertColor, "blue");
});

test("load prefers valid v3, falls back through v2, and writes migrated v3", () => {
  const v2 = JSON.stringify({
    mainIntervalSeconds: 70,
    totalAlerts: 2,
    reminders: []
  });
  const fallbackStorage = memoryStorage({
    [STORAGE_KEY]: "broken",
    [V2_STORAGE_KEY]: v2
  });
  const migrated = loadPreferences(fallbackStorage);

  assert.equal(migrated.timers.length, 1);
  assert.equal(migrated.timers[0].intervalSeconds, 70);
  assert.deepEqual(JSON.parse(fallbackStorage.value(STORAGE_KEY)), migrated);

  const preferredStorage = memoryStorage({
    [STORAGE_KEY]: JSON.stringify({ soundEnabled: true, volume: 20, timers: [] }),
    [V2_STORAGE_KEY]: v2
  });
  assert.deepEqual(loadPreferences(preferredStorage).timers, []);
});

test("v1 secondary fields migrate directly when no newer data exists", () => {
  const storage = memoryStorage({
    [V1_STORAGE_KEY]: JSON.stringify({
      mainIntervalSeconds: 45,
      totalAlerts: 3,
      secondaryEnabled: true,
      secondaryIntervalSeconds: 80,
      secondarySound: "wood-block"
    })
  });
  const migrated = loadPreferences(storage);

  assert.equal(migrated.timers[0].intervalSeconds, 45);
  assert.equal(migrated.timers[0].alertCount, 3);
  assert.deepEqual(
    migrated.timers.slice(1).map((timer) => [timer.enabled, timer.intervalSeconds, timer.sound]),
    [[true, 80, "wood-block"]]
  );
  assert.deepEqual(JSON.parse(storage.value(STORAGE_KEY)), migrated);
});

test("restore defaults writes v3 and returns independent nested objects", () => {
  const storage = memoryStorage();
  const first = restoreDefaultPreferences(storage);
  const second = loadPreferences(storage);

  assert.deepEqual(first, DEFAULT_PREFERENCES);
  assert.deepEqual(second, DEFAULT_PREFERENCES);
  assert.notStrictEqual(first.timers, second.timers);
  first.timers[0].label = "Changed locally";
  assert.equal(second.timers[0].label, "Main timer");
  assert.deepEqual(JSON.parse(storage.value(STORAGE_KEY)), DEFAULT_PREFERENCES);
});
