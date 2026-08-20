const test = require("node:test");
const assert = require("node:assert/strict");
const { TimerEngine, normalizeTimerDefinitions } = require("../js/timer.js");

function createEngine(definitions = []) {
  let clock = 0;
  const engine = new TimerEngine({ now: () => clock });
  engine.syncTimers(definitions, clock);

  return {
    engine,
    setClock(value) {
      clock = value;
    }
  };
}

function timer(id, intervalMs = 1000, alertLimit = 3, enabled = true) {
  return { id, intervalMs, alertLimit, enabled };
}

function byId(snapshot, id) {
  return snapshot.timers.find((entry) => entry.id === id);
}

test("normalization supports infinite timers and repairs duplicate ids", () => {
  const input = [timer("same", 1000, null), timer("same", 50, 2), timer("", 2000, 4)];
  const normalized = normalizeTimerDefinitions(input);

  assert.deepEqual(normalized, [
    { id: "same", enabled: true, intervalMs: 1000, alertLimit: null },
    { id: "same-2", enabled: true, intervalMs: 62000, alertLimit: 2 },
    { id: "timer-3", enabled: true, intervalMs: 2000, alertLimit: 4 }
  ]);
  assert.equal(input[1].id, "same");
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized[0]));
});

test("sync initializes peer timers idle without scheduling disabled timers", () => {
  const { engine } = createEngine([
    timer("one", 1000, 3),
    timer("two", 1500, null),
    timer("off", 500, 2, false)
  ]);
  const snapshot = engine.getSnapshot();

  assert.equal(snapshot.runningCount, 0);
  assert.equal(snapshot.hasRunningTimers, false);
  assert.deepEqual(snapshot.timers.map((entry) => entry.phase), ["idle", "idle", "idle"]);
  assert.deepEqual(snapshot.timers.map((entry) => entry.nextAt), [null, null, null]);
  assert.equal(engine.getNextDeadline(), null);
});

test("timers start independently from their own timestamps", () => {
  const { engine, setClock } = createEngine([
    timer("one", 1000, 3),
    timer("two", 1500, null)
  ]);

  const first = engine.start("one");
  setClock(400);
  const second = engine.start("two");
  const snapshot = engine.getSnapshot();

  assert.equal(first.nextAt, 1000);
  assert.equal(second.nextAt, 1900);
  assert.notEqual(first.runId, second.runId);
  assert.equal(snapshot.runningCount, 2);
  assert.equal(engine.getNextDeadline(), 1000);
  assert.equal(engine.deadline(), 1000);
});

test("an exact deadline emits one alert with no duplicate", () => {
  const { engine, setClock } = createEngine([timer("one", 1000, 3)]);
  engine.start("one");

  setClock(999);
  assert.deepEqual(engine.reconcile(), []);

  setClock(1000);
  const first = engine.reconcile();
  assert.equal(first.length, 1);
  assert.equal(first[0].type, "timer-alert");
  assert.equal(first[0].timerId, "one");
  assert.equal(first[0].completedAlerts, 1);
  assert.equal(byId(engine.getSnapshot(), "one").nextAt, 2000);
  assert.deepEqual(engine.reconcile(), []);
});

test("a delayed callback emits once per overdue timer and rebases each", () => {
  const { engine, setClock } = createEngine([
    timer("one", 1000, null),
    timer("two", 1500, null)
  ]);
  engine.start("one");
  engine.start("two");

  setClock(5500);
  const events = engine.reconcile();
  const snapshot = engine.getSnapshot();

  assert.deepEqual(events.map((event) => event.timerId), ["one", "two"]);
  assert.deepEqual(events.map((event) => event.lateByMs), [4500, 4000]);
  assert.equal(byId(snapshot, "one").nextAt, 6500);
  assert.equal(byId(snapshot, "two").nextAt, 7000);
  assert.deepEqual(engine.reconcile(), []);
});

test("simultaneous completion never suppresses another timer", () => {
  const { engine, setClock } = createEngine([
    timer("finite", 1000, 1),
    timer("infinite", 1000, null),
    timer("also-finite", 1000, 1)
  ]);
  engine.start("finite");
  engine.start("infinite");
  engine.start("also-finite");

  setClock(1000);
  const events = engine.reconcile();

  assert.deepEqual(
    events.map((event) => [event.timerId, event.type]),
    [
      ["finite", "timer-complete"],
      ["infinite", "timer-alert"],
      ["also-finite", "timer-complete"]
    ]
  );
  assert.equal(byId(engine.getSnapshot(), "infinite").nextAt, 2000);
  assert.equal(engine.getNextDeadline(), 2000);
});

test("Alert Now affects only its timer and wins over an overdue deadline", () => {
  const { engine, setClock } = createEngine([
    timer("one", 1000, 4),
    timer("two", 1500, null)
  ]);
  engine.start("one");
  engine.start("two");

  setClock(1200);
  const event = engine.alertNow("one")[0];
  const snapshot = engine.getSnapshot();

  assert.equal(event.type, "timer-alert");
  assert.equal(event.source, "manual");
  assert.equal(event.lateByMs, 0);
  assert.equal(byId(snapshot, "one").nextAt, 2200);
  assert.equal(byId(snapshot, "two").nextAt, 1500);
  assert.deepEqual(engine.reconcile(), []);
});

test("a finite timer completes once while an infinite timer never completes", () => {
  const { engine, setClock } = createEngine([
    timer("finite", 1000, 2),
    timer("infinite", 1000, null)
  ]);
  engine.start("finite");
  engine.start("infinite");

  setClock(1000);
  assert.deepEqual(engine.reconcile().map((event) => event.type), [
    "timer-alert",
    "timer-alert"
  ]);
  setClock(2000);
  assert.deepEqual(engine.reconcile().map((event) => event.type), [
    "timer-complete",
    "timer-alert"
  ]);
  setClock(3000);
  assert.deepEqual(engine.reconcile().map((event) => event.type), ["timer-alert"]);

  const snapshot = engine.getSnapshot();
  assert.equal(byId(snapshot, "finite").phase, "complete");
  assert.equal(byId(snapshot, "finite").nextAt, null);
  assert.equal(byId(snapshot, "infinite").completedAlerts, 3);
});

test("reset clears only one timer and a later start gets a new run id", () => {
  const { engine, setClock } = createEngine([
    timer("one", 1000, 3),
    timer("two", 2000, null)
  ]);
  const firstRun = engine.start("one").runId;
  engine.start("two");

  setClock(500);
  const reset = engine.reset("one");
  assert.equal(reset.phase, "idle");
  assert.equal(reset.nextAt, null);
  assert.equal(byId(engine.getSnapshot(), "two").nextAt, 2000);
  assert.equal(engine.getNextDeadline(), 2000);

  setClock(600);
  const secondRun = engine.start("one").runId;
  assert.notEqual(secondRun, firstRun);
  assert.equal(byId(engine.getSnapshot(), "one").nextAt, 1600);
});

test("disabled timers cannot start and disabling a run resets only that timer", () => {
  const definitions = [timer("one", 1000, 3), timer("off", 500, 2, false)];
  const { engine, setClock } = createEngine(definitions);

  assert.equal(engine.start("off"), null);
  assert.deepEqual(engine.alertNow("off"), []);
  engine.start("one");

  setClock(400);
  engine.syncTimers([timer("one", 1000, 3, false), timer("off", 500, 2, true)]);
  const snapshot = engine.getSnapshot();

  assert.equal(byId(snapshot, "one").phase, "idle");
  assert.equal(byId(snapshot, "one").enabled, false);
  assert.equal(byId(snapshot, "off").phase, "idle");
  assert.equal(byId(snapshot, "off").enabled, true);
  assert.equal(engine.getNextDeadline(), null);
  assert.equal(engine.start("off").nextAt, 900);
});

test("live retiming touches one deadline while no-op edits and reordering preserve others", () => {
  const original = [timer("one", 1000, 4), timer("two", 2000, null)];
  const { engine, setClock } = createEngine(original);
  engine.start("one");
  engine.start("two");

  setClock(400);
  assert.deepEqual(engine.syncTimers([timer("two", 2000, null), timer("one", 1000, 4)]), []);
  assert.deepEqual(engine.getSnapshot().timers.map((entry) => entry.nextAt), [2000, 1000]);

  setClock(500);
  engine.syncTimers([timer("two", 2000, null), timer("one", 3000, 4)]);
  const snapshot = engine.getSnapshot();
  assert.equal(byId(snapshot, "one").nextAt, 3500);
  assert.equal(byId(snapshot, "two").nextAt, 2000);
});

test("sync before reconcile suppresses a changed stale timer but delivers unrelated due timers", () => {
  const { engine, setClock } = createEngine([
    timer("remove", 1000, null),
    timer("disable", 1000, null),
    timer("keep", 1000, null)
  ]);
  engine.start("remove");
  engine.start("disable");
  engine.start("keep");

  setClock(1100);
  engine.syncTimers([timer("disable", 1000, null, false), timer("keep", 1000, null)]);
  const events = engine.reconcile();

  assert.deepEqual(events.map((event) => event.timerId), ["keep"]);
  assert.equal(events[0].lateByMs, 100);
  assert.equal(byId(engine.getSnapshot(), "disable").phase, "idle");
});

test("finite and infinite mode edits preserve deadlines or complete once as appropriate", () => {
  const { engine, setClock } = createEngine([timer("one", 1000, null)]);
  engine.start("one");

  setClock(100);
  engine.alertNow("one");
  setClock(200);
  engine.alertNow("one");
  const deadlineBeforeModeChange = byId(engine.getSnapshot(), "one").nextAt;

  setClock(300);
  const completion = engine.syncTimers([timer("one", 1000, 2)]);
  assert.equal(completion.length, 1);
  assert.equal(completion[0].type, "timer-complete");
  assert.equal(completion[0].source, "configuration");
  assert.equal(completion[0].completedAlerts, 2);
  assert.equal(byId(engine.getSnapshot(), "one").phase, "complete");
  assert.deepEqual(engine.syncTimers([timer("one", 1000, 2)]), []);

  setClock(400);
  engine.syncTimers([timer("one", 1000, 5)]);
  assert.equal(byId(engine.getSnapshot(), "one").phase, "idle");

  engine.start("one");
  const finiteDeadline = byId(engine.getSnapshot(), "one").nextAt;
  engine.syncTimers([timer("one", 1000, null)]);
  assert.equal(byId(engine.getSnapshot(), "one").nextAt, finiteDeadline);
  assert.ok(deadlineBeforeModeChange > 0);
});

test("remove and re-add cannot reuse run ids or event ids", () => {
  const { engine, setClock } = createEngine([timer("one", 1000, null)]);
  const firstRun = engine.start("one").runId;

  setClock(1000);
  const firstEvent = engine.reconcile()[0];
  engine.syncTimers([]);
  engine.syncTimers([timer("one", 100, null)]);
  const secondRun = engine.start("one").runId;
  setClock(1100);
  const secondEvent = engine.reconcile()[0];

  assert.notEqual(secondRun, firstRun);
  assert.notEqual(secondEvent.id, firstEvent.id);
  assert.equal(secondEvent.timerId, "one");
});

test("next deadline updates as timers complete, reset, and are removed", () => {
  const { engine, setClock } = createEngine([
    timer("short", 500, 1),
    timer("long", 1500, null)
  ]);
  engine.start("short");
  engine.start("long");
  assert.equal(engine.getNextDeadline(), 500);

  setClock(500);
  engine.reconcile();
  assert.equal(engine.getNextDeadline(), 1500);
  engine.reset("long");
  assert.equal(engine.getNextDeadline(), null);
  engine.syncTimers([]);
  assert.deepEqual(engine.snapshot().timers, []);
});

test("the monotonic guard prevents a backward clock from extending a countdown", () => {
  const { engine, setClock } = createEngine([timer("one", 1000, null)]);
  setClock(1000);
  engine.start("one");
  setClock(1500);
  assert.equal(byId(engine.getSnapshot(), "one").remainingMs, 500);
  setClock(1200);
  assert.equal(byId(engine.getSnapshot(), "one").remainingMs, 500);
  setClock(2000);
  assert.equal(engine.reconcile().length, 1);
});

test("unknown timer commands and an empty dashboard are harmless", () => {
  const { engine } = createEngine([]);

  assert.equal(engine.start("missing"), null);
  assert.equal(engine.reset("missing"), null);
  assert.deepEqual(engine.alertNow("missing"), []);
  assert.deepEqual(engine.reconcile(), []);
  assert.deepEqual(engine.getSnapshot(), {
    timers: [],
    runningCount: 0,
    hasRunningTimers: false
  });
  assert.equal(engine.getNextDeadline(), null);
});
