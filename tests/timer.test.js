const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TimerEngine,
  normalizeTimerConfig,
  normalizeReminderDefinitions
} = require("../js/timer.js");

function createEngine() {
  let clock = 0;
  const engine = new TimerEngine({ now: () => clock });

  return {
    engine,
    setClock(value) {
      clock = value;
    }
  };
}

function reminder(id, intervalMs, enabled = true) {
  return { id, intervalMs, enabled };
}

test("start schedules several reminders from the same monotonic timestamp", () => {
  const { engine } = createEngine();
  const snapshot = engine.start({
    mainIntervalMs: 62000,
    totalAlerts: 29,
    reminders: [
      reminder("item", 90000),
      reminder("buff", 150000),
      reminder("disabled", 30000, false)
    ]
  });

  assert.equal(snapshot.phase, "running");
  assert.equal(snapshot.mainNextAt, 62000);
  assert.deepEqual(
    snapshot.reminders.map(({ id, nextAt }) => ({ id, nextAt })),
    [
      { id: "item", nextAt: 90000 },
      { id: "buff", nextAt: 150000 },
      { id: "disabled", nextAt: null }
    ]
  );
  assert.equal(snapshot.completedMain, 0);
  assert.equal(engine.getNextDeadline(), 62000);
});

test("legacy single-reminder config and snapshot aliases remain available", () => {
  const { engine } = createEngine();
  const snapshot = engine.start({
    mainIntervalMs: 2000,
    totalAlerts: 2,
    secondaryEnabled: true,
    secondaryIntervalMs: 1500
  });

  assert.deepEqual(snapshot.reminders.map((entry) => entry.id), ["item-reminder"]);
  assert.equal(snapshot.secondaryEnabled, true);
  assert.equal(snapshot.secondaryNextAt, 1500);
  assert.equal(snapshot.secondaryRemainingMs, 1500);
});

test("normalization repairs duplicate reminder ids without mutating the input", () => {
  const input = [reminder("same", 1000), reminder("same", 2000), reminder("", 50)];
  const normalized = normalizeReminderDefinitions(input);

  assert.deepEqual(
    normalized.map(({ id, intervalMs }) => ({ id, intervalMs })),
    [
      { id: "same", intervalMs: 1000 },
      { id: "same-2", intervalMs: 2000 },
      { id: "reminder-3", intervalMs: 90000 }
    ]
  );
  assert.equal(input[1].id, "same");
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalizeTimerConfig({ reminders: input })));
});

test("an exact main deadline produces one alert with no duplicate", () => {
  const { engine, setClock } = createEngine();
  engine.start({ mainIntervalMs: 1000, totalAlerts: 3 });

  setClock(999);
  assert.deepEqual(engine.reconcile(), []);

  setClock(1000);
  const first = engine.reconcile();
  assert.equal(first.length, 1);
  assert.equal(first[0].type, "main-alert");
  assert.equal(first[0].completedMain, 1);
  assert.equal(engine.getSnapshot().mainNextAt, 2000);
  assert.deepEqual(engine.reconcile(), []);
});

test("a late main callback collapses backlog and gives a full next interval", () => {
  const { engine, setClock } = createEngine();
  engine.start({ mainIntervalMs: 1000, totalAlerts: 10 });

  setClock(5500);
  const events = engine.reconcile();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "main-alert");
  assert.equal(events[0].lateByMs, 4500);
  assert.equal(engine.getSnapshot().completedMain, 1);
  assert.equal(engine.getSnapshot().mainNextAt, 6500);

  setClock(6499);
  assert.deepEqual(engine.reconcile(), []);
});

test("a late callback emits once per overdue reminder and rebases each", () => {
  const { engine, setClock } = createEngine();
  engine.start({
    mainIntervalMs: 20000,
    totalAlerts: 3,
    reminders: [reminder("one", 1000), reminder("two", 1500)]
  });

  setClock(5500);
  const events = engine.reconcile();
  const snapshot = engine.getSnapshot();

  assert.deepEqual(events.map((event) => event.reminderId), ["one", "two"]);
  assert.deepEqual(events.map((event) => event.lateByMs), [4500, 4000]);
  assert.deepEqual(snapshot.reminders.map((entry) => entry.nextAt), [6500, 7000]);
  assert.deepEqual(engine.reconcile(), []);
});

test("Alert Now rebases main and leaves every reminder unchanged", () => {
  const { engine, setClock } = createEngine();
  engine.start({
    mainIntervalMs: 1000,
    totalAlerts: 4,
    reminders: [reminder("one", 1500), reminder("two", 2300)]
  });

  setClock(400);
  const events = engine.alertNow();
  const snapshot = engine.getSnapshot();

  assert.equal(events[0].type, "main-alert");
  assert.equal(events[0].source, "manual");
  assert.equal(snapshot.completedMain, 1);
  assert.equal(snapshot.mainNextAt, 1400);
  assert.deepEqual(snapshot.reminders.map((entry) => entry.nextAt), [1500, 2300]);
});

test("main and several reminders due together fire once in priority order", () => {
  const { engine, setClock } = createEngine();
  engine.start({
    mainIntervalMs: 1000,
    totalAlerts: 3,
    reminders: [reminder("first", 1000), reminder("second", 1000)]
  });

  setClock(1000);
  const events = engine.reconcile();

  assert.deepEqual(
    events.map((event) => [event.type, event.reminderId || null]),
    [
      ["main-alert", null],
      ["reminder-alert", "first"],
      ["reminder-alert", "second"]
    ]
  );
  assert.deepEqual(engine.getSnapshot().reminders.map((entry) => entry.nextAt), [2000, 2000]);
  assert.deepEqual(engine.reconcile(), []);
});

test("the final main deadline emits one completion and suppresses all reminders", () => {
  const { engine, setClock } = createEngine();
  engine.start({
    mainIntervalMs: 1000,
    totalAlerts: 1,
    reminders: [reminder("first", 1000), reminder("second", 500)]
  });

  setClock(1000);
  const events = engine.reconcile();
  const snapshot = engine.getSnapshot();

  assert.deepEqual(events.map((event) => event.type), ["completion"]);
  assert.equal(snapshot.phase, "complete");
  assert.equal(snapshot.completedMain, 1);
  assert.equal(snapshot.mainNextAt, null);
  assert.deepEqual(snapshot.reminders.map((entry) => entry.nextAt), [null, null]);
  assert.equal(engine.getNextDeadline(), null);

  setClock(100000);
  assert.deepEqual(engine.reconcile(), []);
  assert.deepEqual(engine.alertNow(), []);
});

test("manual final alert also completes exactly once and stops reminders", () => {
  const { engine, setClock } = createEngine();
  engine.start({
    mainIntervalMs: 1000,
    totalAlerts: 2,
    reminders: [reminder("item", 500)]
  });

  setClock(100);
  assert.equal(engine.alertNow()[0].type, "main-alert");
  setClock(200);
  assert.equal(engine.alertNow()[0].type, "completion");
  assert.equal(engine.getSnapshot().reminders[0].nextAt, null);
  assert.deepEqual(engine.alertNow(), []);
});

test("a live reminder can be added without changing the main schedule", () => {
  const { engine, setClock } = createEngine();
  engine.start({ mainIntervalMs: 5000, totalAlerts: 3, reminders: [] });

  setClock(400);
  const snapshot = engine.syncReminders([reminder("new", 1200)]);

  assert.equal(snapshot.mainNextAt, 5000);
  assert.equal(snapshot.reminders[0].nextAt, 1600);
  assert.equal(engine.getNextDeadline(), 1600);
});

test("enable, disable, and retime changes start or cancel full reminder intervals", () => {
  const { engine, setClock } = createEngine();
  engine.start({
    mainIntervalMs: 10000,
    totalAlerts: 3,
    reminders: [reminder("item", 1000, false)]
  });

  setClock(200);
  let snapshot = engine.syncReminders([reminder("item", 1000, true)]);
  assert.equal(snapshot.reminders[0].nextAt, 1200);

  setClock(400);
  snapshot = engine.syncReminders([reminder("item", 2500, true)]);
  assert.equal(snapshot.reminders[0].nextAt, 2900);

  setClock(3000);
  snapshot = engine.syncReminders([reminder("item", 2500, false)]);
  assert.equal(snapshot.reminders[0].nextAt, null);
  assert.deepEqual(engine.reconcile(), []);
  assert.equal(engine.getNextDeadline(), 10000);
});

test("no-op edits and reordering preserve deadlines while changing collision order", () => {
  const { engine, setClock } = createEngine();
  engine.start({
    mainIntervalMs: 10000,
    totalAlerts: 3,
    reminders: [reminder("one", 1000), reminder("two", 1000)]
  });

  setClock(400);
  let snapshot = engine.syncReminders([
    reminder("two", 1000),
    reminder("one", 1000)
  ]);
  assert.deepEqual(snapshot.reminders.map((entry) => entry.nextAt), [1000, 1000]);

  setClock(1000);
  assert.deepEqual(engine.reconcile().map((event) => event.reminderId), ["two", "one"]);
  snapshot = engine.getSnapshot();
  assert.deepEqual(snapshot.reminders.map((entry) => entry.nextAt), [2000, 2000]);
});

test("editing one reminder does not rebase any other reminder", () => {
  const { engine, setClock } = createEngine();
  engine.start({
    mainIntervalMs: 10000,
    totalAlerts: 3,
    reminders: [reminder("one", 1000), reminder("two", 2000)]
  });

  setClock(500);
  const snapshot = engine.syncReminders([
    reminder("one", 3000),
    reminder("two", 2000)
  ]);

  assert.equal(snapshot.mainNextAt, 10000);
  assert.deepEqual(snapshot.reminders.map((entry) => entry.nextAt), [3500, 2000]);
});

test("removing and re-adding an id cannot reuse an event id", () => {
  const { engine, setClock } = createEngine();
  engine.start({
    mainIntervalMs: 10000,
    totalAlerts: 3,
    reminders: [reminder("item", 1000)]
  });

  setClock(1000);
  const first = engine.reconcile()[0];
  setClock(1100);
  engine.syncReminders([]);
  engine.syncReminders([reminder("item", 100)]);
  setClock(1200);
  const second = engine.reconcile()[0];

  assert.equal(first.reminderId, "item");
  assert.equal(second.reminderId, "item");
  assert.notEqual(first.id, second.id);
});

test("reset clears all active state and a new session gets a new id", () => {
  const { engine, setClock } = createEngine();
  const first = engine.start({
    mainIntervalMs: 1000,
    totalAlerts: 2,
    reminders: [reminder("item", 500)]
  });
  setClock(400);
  engine.reset();

  const idle = engine.getSnapshot();
  assert.equal(idle.phase, "idle");
  assert.equal(idle.mainNextAt, null);
  assert.deepEqual(idle.reminders, []);
  assert.equal(idle.completedMain, 0);

  setClock(600);
  const second = engine.start({ mainIntervalMs: 2000, totalAlerts: 2, reminders: [] });
  assert.equal(second.sessionId, first.sessionId + 1);
  assert.equal(second.mainNextAt, 2600);
});
