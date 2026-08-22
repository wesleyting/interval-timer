const test = require("node:test");
const assert = require("node:assert/strict");
const { AudioManager } = require("../js/audio.js");

class FakeAudioParam {
  constructor(value = 0) {
    this.value = value;
    this.lastTarget = null;
  }

  setValueAtTime(value) {
    this.value = value;
  }

  exponentialRampToValueAtTime(value) {
    this.value = value;
  }

  setTargetAtTime(value) {
    this.value = value;
    this.lastTarget = value;
  }
}

class FakeNode {
  connect() {
    return this;
  }

  disconnect() {}
}

class FakeSource extends FakeNode {
  constructor(context) {
    super();
    this.context = context;
    this.frequency = new FakeAudioParam();
    this.stoppedImmediately = false;
    this.listeners = new Map();
    context.sources.push(this);
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  start() {}

  stop(at) {
    if (at === 0) {
      this.stoppedImmediately = true;
      const listener = this.listeners.get("ended");
      if (listener) listener();
    }
  }
}

class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.currentTime = 1;
    this.destination = new FakeNode();
    this.sources = [];
  }

  createGain() {
    const node = new FakeNode();
    node.gain = new FakeAudioParam(1);
    return node;
  }

  createDynamicsCompressor() {
    const node = new FakeNode();
    node.threshold = new FakeAudioParam();
    node.knee = new FakeAudioParam();
    node.ratio = new FakeAudioParam();
    node.attack = new FakeAudioParam();
    node.release = new FakeAudioParam();
    return node;
  }

  createOscillator() {
    return new FakeSource(this);
  }

  async resume() {
    this.state = "running";
  }
}

class DeferredAudioContext extends FakeAudioContext {
  constructor() {
    super();
    this.state = "suspended";
    this.resumePromise = new Promise((resolve) => {
      this.finishResume = () => {
        this.state = "running";
        resolve();
      };
    });
    DeferredAudioContext.lastInstance = this;
  }

  resume() {
    return this.resumePromise;
  }
}

class UnstartableAudioContext extends FakeAudioContext {
  constructor() {
    super();
    this.state = "suspended";
  }

  async resume() {
    // Simulate a browser that refuses background playback without throwing.
  }
}

test("disabled sound does not create an audio context", async () => {
  const previousAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;

  try {
    const audio = new AudioManager();
    const played = await audio.playMain("glass-ping", { enabled: false, volume: 100 });
    assert.equal(played, false);
    assert.equal(audio.context, null);
  } finally {
    globalThis.AudioContext = previousAudioContext;
  }
});

test("main, secondary, and completion cues build distinct local sound patterns", async () => {
  const previousAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;

  try {
    const audio = new AudioManager();

    assert.equal(
      await audio.playMain("glass-ping", { enabled: true, volume: 100 }),
      true
    );
    const mainSourceCount = audio.context.sources.length;

    assert.equal(
      await audio.playSecondary("double-tap", { enabled: true, volume: 100 }),
      true
    );
    const secondarySourceCount = audio.context.sources.length - mainSourceCount;

    assert.equal(await audio.playCompletion({ enabled: true, volume: 100 }), true);
    const completionSourceCount =
      audio.context.sources.length - mainSourceCount - secondarySourceCount;

    assert.equal(mainSourceCount, 4);
    assert.equal(secondarySourceCount, 4);
    assert.equal(completionSourceCount, 8);
    assert.equal(audio.masterGain.gain.lastTarget, 0.9);
  } finally {
    globalThis.AudioContext = previousAudioContext;
  }
});

test("high-pitched cues use distinct rhythmic patterns", async () => {
  const previousAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;

  try {
    const audio = new AudioManager();

    await audio.playMain("crystal-chirp", { enabled: true, volume: 100 });
    assert.equal(audio.context.sources.length, 2);

    await audio.playMain("triple-spark", { enabled: true, volume: 100 });
    assert.equal(audio.context.sources.length, 5);

    await audio.playMain("high-beacon", { enabled: true, volume: 100 });
    assert.equal(audio.context.sources.length, 9);
  } finally {
    globalThis.AudioContext = previousAudioContext;
  }
});

test("stopAll invalidates and stops every active scheduled source", async () => {
  const previousAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;

  try {
    const audio = new AudioManager();
    await audio.playCompletion({ enabled: true, volume: 70 });
    const sources = [...audio.context.sources];

    assert.ok(audio.activeSources.size > 0);
    audio.stopAll();

    assert.equal(audio.activeSources.size, 0);
    assert.ok(sources.every((source) => source.stoppedImmediately));
  } finally {
    globalThis.AudioContext = previousAudioContext;
  }
});

test("stopping one owner leaves another owner's active sources playing", async () => {
  const previousAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;

  try {
    const audio = new AudioManager();
    await audio.playMain("glass-ping", {
      enabled: true,
      volume: 80,
      ownerId: "timer-a"
    });
    const timerASources = [...audio.context.sources];

    await audio.playSecondary("double-tap", {
      enabled: true,
      volume: 80,
      ownerId: "timer-b"
    });
    const timerBSources = audio.context.sources.slice(timerASources.length);

    audio.stop("timer-a");

    assert.ok(timerASources.every((source) => source.stoppedImmediately));
    assert.ok(timerBSources.every((source) => !source.stoppedImmediately));
    assert.equal(audio.activeSources.size, timerBSources.length);
  } finally {
    globalThis.AudioContext = previousAudioContext;
  }
});

test("stopping one owner during resume invalidates only that pending playback", async () => {
  const previousAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = DeferredAudioContext;

  try {
    const audio = new AudioManager();
    const timerAPlayback = audio.playMain("glass-ping", {
      enabled: true,
      volume: 100,
      ownerId: "timer-a"
    });
    const timerBPlayback = audio.playSecondary("double-tap", {
      enabled: true,
      volume: 100,
      ownerId: "timer-b"
    });
    await Promise.resolve();

    audio.stop("timer-a");
    DeferredAudioContext.lastInstance.finishResume();

    assert.deepEqual(await Promise.all([timerAPlayback, timerBPlayback]), [false, true]);
    assert.equal(audio.context.sources.length, 4);
    assert.equal(audio.activeSources.size, 4);
  } finally {
    globalThis.AudioContext = previousAudioContext;
  }
});

test("a volume change wins while audio resume is pending", async () => {
  const previousAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = DeferredAudioContext;

  try {
    const audio = new AudioManager();
    const playPromise = audio.playMain("glass-ping", { enabled: true, volume: 100 });
    await Promise.resolve();

    audio.setVolume(25);
    DeferredAudioContext.lastInstance.finishResume();
    assert.equal(await playPromise, true);

    const expectedLevel = Math.pow(0.25, 1.55) * 0.9;
    assert.ok(Math.abs(audio.masterGain.gain.lastTarget - expectedLevel) < 0.000001);
  } finally {
    globalThis.AudioContext = previousAudioContext;
  }
});

test("a runtime resume failure calls the availability warning hook", async () => {
  const previousAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = UnstartableAudioContext;

  try {
    let warningCount = 0;
    const audio = new AudioManager({
      onUnavailable() {
        warningCount += 1;
      }
    });

    const played = await audio.playMain("glass-ping", { enabled: true, volume: 100 });
    assert.equal(played, false);
    assert.equal(warningCount, 1);
  } finally {
    globalThis.AudioContext = previousAudioContext;
  }
});
