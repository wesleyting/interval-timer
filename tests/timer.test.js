const test = require("node:test");
const assert = require("node:assert/strict");
const { TimerEngine } = require("../js/timer.js");

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

test("start schedules both timers from one monotonic timestamp", () => {
  const { engine } = createEngine();
  const snapshot = engine.start({
    mainIntervalMs: 62000,
    totalAlerts: 29,
    secondaryEnabled: true,
    secondaryIntervalMs: 90000
  });

  assert.equal(snapshot.phase, "running");
  assert.equal(snapshot.mainNextAt, 62000);
  assert.equal(snapshot.secondaryNextAt, 90000);
  assert.equal(snapshot.completedMain, 0);
});

test("an exact deadline produces one main alert with no duplicate", () => {
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
  assert.equal(engine.getSnapshot().completedMain, 1);
});

test("a late callback collapses backlog and gives a full next interval", () => {
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

test("Alert Now counts once, rebases main, and leaves secondary unchanged", () => {
  const { engine, setClock } = createEngine();
  engine.start({
    mainIntervalMs: 1000,
    totalAlerts: 4,
    secondaryEnabled: true,
    secondaryIntervalMs: 1500
  });

  setClock(400);
  const events = engine.alertNow();
  const snapshot = engine.getSnapshot();

  assert.equal(events[0].type, "main-alert");
  assert.equal(events[0].source, "manual");
  assert.equal(snapshot.completedMain, 1);
  assert.equal(snapshot.mainNextAt, 1400);
  assert.equal(snapshot.secondaryNextAt, 1500);
});

test("main and secondary reminders due together fire once in priority order", () => {
  const { engine, setClock } = createEngine();
  engine.start({
    mainIntervalMs: 1000,
    totalAlerts: 3,
    secondaryEnabled: true,
    secondaryIntervalMs: 1000
  });

  setClock(1000);
  const events = engine.reconcile();

  assert.deepEqual(
    events.map((event) => event.type),
    ["main-alert", "secondary-alert"]
  );
  assert.equal(engine.getSnapshot().completedMain, 1);
  assert.equal(engine.getSnapshot().mainNextAt, 2000);
  assert.equal(engine.getSnapshot().secondaryNextAt, 2000);
  assert.deepEqual(engine.reconcile(), []);
});

test("the final main deadline emits one completion and suppresses secondary", () => {
  const { engine, setClock } = createEngine();
  engine.start({
    mainIntervalMs: 1000,
    totalAlerts: 1,
    secondaryEnabled: true,
    secondaryIntervalMs: 1000
  });

  setClock(1000);
  const events = engine.reconcile();
  const snapshot = engine.getSnapshot();

  assert.deepEqual(events.map((event) => event.type), ["completion"]);
  assert.equal(snapshot.phase, "complete");
  assert.equal(snapshot.completedMain, 1);
  assert.equal(snapshot.mainNextAt, null);
  assert.equal(snapshot.secondaryNextAt, null);

  setClock(100000);
  assert.deepEqual(engine.reconcile(), []);
  assert.deepEqual(engine.alertNow(), []);
});

test("manual final alert also completes exactly once", () => {
  const { engine, setClock } = createEngine();
  engine.start({ mainIntervalMs: 1000, totalAlerts: 2 });

  setClock(100);
  assert.equal(engine.alertNow()[0].type, "main-alert");
  setClock(200);
  assert.equal(engine.alertNow()[0].type, "completion");
  assert.deepEqual(engine.alertNow(), []);
});

test("reset clears all active session state and a new session gets a new id", () => {
  const { engine, setClock } = createEngine();
  const first = engine.start({ mainIntervalMs: 1000, totalAlerts: 2 });
  setClock(500);
  engine.reset();

  const idle = engine.getSnapshot();
  assert.equal(idle.phase, "idle");
  assert.equal(idle.mainNextAt, null);
  assert.equal(idle.secondaryNextAt, null);
  assert.equal(idle.completedMain, 0);

  setClock(600);
  const second = engine.start({ mainIntervalMs: 2000, totalAlerts: 2 });
  assert.equal(second.sessionId, first.sessionId + 1);
  assert.equal(second.mainNextAt, 2600);
});
