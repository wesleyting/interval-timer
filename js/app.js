(function startMultiTimerDashboard() {
  "use strict";

  const {
    TimerEngine,
    AudioManager,
    loadPreferences,
    savePreferences,
    restoreDefaultPreferences,
    sanitizePreferences,
    MAX_TIMERS,
    ALERT_COLORS
  } = window.IntervalTimer || {};

  if (
    !TimerEngine ||
    !AudioManager ||
    !loadPreferences ||
    !savePreferences ||
    !restoreDefaultPreferences ||
    !sanitizePreferences
  ) {
    console.error("Interval Timer could not load its application modules.");
    return;
  }

  const elements = {
    body: document.body,
    appShell: document.querySelector(".app-shell"),
    globalSoundControl: document.getElementById("globalSoundControl"),
    timerStack: document.getElementById("timerStack"),
    timersEmpty: document.getElementById("timersEmpty"),
    timerCardTemplate: document.getElementById("timerCardTemplate"),
    addTimerButton: document.getElementById("addTimerButton"),
    alertTray: document.getElementById("alertTray"),
    alertTrayMessage: document.getElementById("alertTrayMessage"),
    soundEnabledInput: document.getElementById("soundEnabledInput"),
    soundEnabledLabel: document.getElementById("soundEnabledLabel"),
    volumeInput: document.getElementById("volumeInput"),
    volumeValue: document.getElementById("volumeValue"),
    soundSwitchLabel: document.getElementById("soundSwitchLabel"),
    restoreDefaultsButton: document.getElementById("restoreDefaultsButton"),
    globalFeedback: document.getElementById("globalFeedback"),
    liveAnnouncements: document.getElementById("liveAnnouncements")
  };

  const palette = Array.isArray(ALERT_COLORS)
    ? ALERT_COLORS
    : ["red", "amber", "cyan", "blue", "violet", "green", "pink"];
  const timerLimit = Number.isFinite(MAX_TIMERS) ? MAX_TIMERS : 64;
  const mainSounds = new Set(["glass-ping", "bright-bell", "soft-chime"]);

  const now = () => performance.now();
  let preferences = loadPreferences();
  const engine = new TimerEngine({ now });
  const audio = new AudioManager({ onUnavailable: reportAudioUnavailable });

  let schedulerHandle = null;
  let schedulerRevision = 0;
  let renderFrame = null;
  let lastFrameRenderAt = 0;
  let wakeLock = null;
  let wakeLockRequestRevision = 0;
  let wakeLockRequestPendingRevision = null;
  let announcementFrame = null;
  let announcementRevision = 0;
  let trayHandle = null;
  let trayRevision = 0;
  let completionSequence = 0;
  let visualSequence = 0;
  let audioWarningShown = false;
  let timerIdSequence = 0;

  const cardNodes = new Map();
  const cardMessages = new Map();
  const openSettings = new Set();
  const visualAlertHandles = new Map();
  const activeVisualOrder = new Map();
  const completionOrder = new Map();
  let trayEvents = [];

  function timerDefinitions() {
    return preferences.timers.map((timer) => ({
      id: timer.id,
      enabled: timer.enabled,
      intervalMs: timer.intervalSeconds * 1000,
      alertLimit: timer.alertMode === "finite" ? timer.alertCount : null
    }));
  }

  function preferenceTimer(timerId) {
    return preferences.timers.find((timer) => timer.id === timerId) || null;
  }

  function runtimeTimer(timerId, snapshot = engine.getSnapshot(now())) {
    return snapshot.timers.find((timer) => timer.id === timerId) || null;
  }

  function splitInterval(totalSeconds) {
    const normalized = Math.max(0, Number(totalSeconds) || 0);
    let minutes = Math.floor(normalized / 60);
    let seconds = Math.round((normalized - minutes * 60) * 10) / 10;

    if (seconds >= 60) {
      minutes += 1;
      seconds = 0;
    }

    return { minutes, seconds };
  }

  function inputNumber(value) {
    return String(Math.round(Number(value) * 10) / 10);
  }

  function formatTime(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function accessibleTime(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];

    if (hours > 0) parts.push(hours === 1 ? "1 hour" : `${hours} hours`);
    if (minutes > 0) parts.push(minutes === 1 ? "1 minute" : `${minutes} minutes`);
    if (seconds > 0 || parts.length === 0) {
      parts.push(seconds === 1 ? "1 second" : `${seconds} seconds`);
    }

    return `${parts.join(" ")} remaining`;
  }

  function safeSuffix(value) {
    return String(value).replace(/[^A-Za-z0-9_-]/g, "-");
  }

  function persistPreferences(nextPreferences) {
    const soundWasEnabled = preferences.soundEnabled;
    preferences = savePreferences(nextPreferences);

    if (soundWasEnabled && !preferences.soundEnabled) {
      audio.stopAll();
      audioWarningShown = false;
    }

    audio.setVolume(preferences.soundEnabled ? preferences.volume : 0);
    updateGlobalControls();
    return preferences;
  }

  function updateTimerPreference(timerId, patch) {
    persistPreferences({
      ...preferences,
      timers: preferences.timers.map((timer) =>
        timer.id === timerId ? { ...timer, ...patch } : timer
      )
    });
    return preferenceTimer(timerId);
  }

  function updateGlobalControls() {
    elements.soundEnabledInput.checked = preferences.soundEnabled;
    elements.soundEnabledLabel.textContent = preferences.soundEnabled ? "Sound on" : "Sound off";
    elements.soundSwitchLabel.textContent = preferences.soundEnabled ? "On" : "Off";
    elements.volumeInput.value = preferences.volume;
    elements.volumeInput.disabled = !preferences.soundEnabled;
    elements.volumeValue.value = `${preferences.volume}%`;
    elements.volumeValue.textContent = `${preferences.volume}%`;
    elements.addTimerButton.disabled = preferences.timers.length >= timerLimit;
    elements.addTimerButton.title = elements.addTimerButton.disabled
      ? `The ${timerLimit}-timer limit has been reached.`
      : "Add an independent timer";
    elements.restoreDefaultsButton.disabled = engine.getSnapshot(now()).hasRunningTimers;
    elements.restoreDefaultsButton.title = elements.restoreDefaultsButton.disabled
      ? "Reset running timers before restoring defaults."
      : "Restore the default timer cards";
    const soundSummary = elements.globalSoundControl.querySelector("summary");
    soundSummary.setAttribute(
      "aria-label",
      `${elements.globalSoundControl.open ? "Close" : "Open"} sound controls. Sound ${
        preferences.soundEnabled ? "on" : "off"
      }.`
    );
  }

  function role(card, name) {
    return card.querySelector(`[data-role='${name}']`);
  }

  function collectCardNodes(card) {
    const names = [
      "shell",
      "title",
      "color-dot",
      "state",
      "enabled",
      "enabled-label",
      "settings-toggle",
      "countdown-label",
      "countdown",
      "progress-text",
      "progress-percent",
      "progress-track",
      "progress-fill",
      "status",
      "start",
      "alert-now",
      "reset",
      "settings-panel",
      "name",
      "minutes",
      "seconds",
      "repeat-mode",
      "total-alerts-field",
      "total-alerts",
      "sound",
      "test-sound",
      "alert-duration",
      "persistent-completion",
      "remove",
      "feedback"
    ];
    const nodes = { card, colors: Array.from(card.querySelectorAll("[data-role='color']")) };
    names.forEach((name) => {
      nodes[name] = role(card, name);
    });
    return nodes;
  }

  function applyCardIdentity(nodes, timer) {
    const suffix = safeSuffix(timer.id);
    const titleId = `timer-title-${suffix}`;
    const settingsId = `timer-settings-${suffix}`;

    nodes.title.id = titleId;
    nodes.title.textContent = timer.label;
    nodes.shell.setAttribute("aria-labelledby", titleId);
    nodes["settings-panel"].id = settingsId;
    nodes["settings-panel"].setAttribute("aria-label", `${timer.label} settings`);
    nodes["settings-toggle"].setAttribute("aria-controls", settingsId);
    nodes["settings-toggle"].setAttribute("aria-label", `Settings for ${timer.label}`);
    nodes.enabled.setAttribute("aria-label", `Enable ${timer.label}`);
    nodes.countdown.setAttribute("aria-label", `${timer.label} interval`);
    nodes["progress-track"].setAttribute("aria-label", `${timer.label} progress`);
    nodes.start.setAttribute("aria-label", `Start ${timer.label}`);
    nodes["alert-now"].setAttribute("aria-label", `Alert now for ${timer.label}`);
    nodes.reset.setAttribute("aria-label", `Reset ${timer.label}`);
    nodes["test-sound"].setAttribute("aria-label", `Test ${timer.label} sound`);
    nodes.remove.setAttribute("aria-label", `Remove ${timer.label}`);
    nodes.minutes.setAttribute("aria-label", `${timer.label} interval minutes`);
    nodes.seconds.setAttribute("aria-label", `${timer.label} interval seconds`);
    nodes["total-alerts"].setAttribute("aria-label", `${timer.label} number of alerts`);
    nodes["alert-duration"].setAttribute(
      "aria-label",
      `${timer.label} visual alert duration in seconds`
    );
    nodes.sound.setAttribute("aria-label", `${timer.label} sound`);
    nodes["repeat-mode"].setAttribute("aria-label", `${timer.label} repeat mode`);
    nodes["persistent-completion"].setAttribute(
      "aria-label",
      `Keep ${timer.label} completion color until reset`
    );
    nodes.colors.forEach((input) => {
      input.name = `timer-color-${suffix}`;
      input.setAttribute("aria-label", `${timer.label} ${input.value} alert color`);
    });
  }

  function applyTimerFormValues(nodes, timer) {
    const interval = splitInterval(timer.intervalSeconds);
    nodes.name.value = timer.label;
    restoreInput(nodes.minutes, interval.minutes);
    restoreInput(nodes.seconds, inputNumber(interval.seconds));
    nodes["repeat-mode"].value = timer.alertMode;
    restoreInput(nodes["total-alerts"], timer.alertCount);
    nodes.sound.value = timer.sound;
    restoreInput(nodes["alert-duration"], timer.alertDurationSeconds);
    nodes["persistent-completion"].checked = timer.persistCompletionBackground;
    nodes.colors.forEach((input) => {
      input.checked = input.value === timer.alertColor;
    });
  }

  function setSettingsOpen(timerId, shouldOpen, focusName = false) {
    const nodes = cardNodes.get(timerId);
    if (!nodes) return;

    if (shouldOpen) openSettings.add(timerId);
    else openSettings.delete(timerId);
    nodes["settings-panel"].hidden = !shouldOpen;
    nodes["settings-toggle"].setAttribute("aria-expanded", String(shouldOpen));

    if (shouldOpen && focusName) nodes.name.focus();
  }

  function configureCard(card, timer) {
    card.dataset.timerId = timer.id;
    const nodes = collectCardNodes(card);
    cardNodes.set(timer.id, nodes);
    applyCardIdentity(nodes, timer);
    applyTimerFormValues(nodes, timer);
    setSettingsOpen(timer.id, openSettings.has(timer.id));

    enhanceNumberInput(
      nodes.minutes,
      () => commitInterval(timer.id),
      () => restoreIntervalInputs(timer.id),
      { min: 0, max: 1440, step: 1 }
    );
    enhanceNumberInput(
      nodes.seconds,
      () => commitInterval(timer.id),
      () => restoreIntervalInputs(timer.id),
      { min: 0, max: 59.9, step: 0.1 }
    );
    enhanceNumberInput(
      nodes["total-alerts"],
      () => commitAlertCount(timer.id),
      () => {
        const current = preferenceTimer(timer.id);
        if (current) restoreInput(nodes["total-alerts"], current.alertCount);
      },
      { min: 1, max: 9999, step: 1 }
    );
    enhanceNumberInput(
      nodes["alert-duration"],
      () => commitAlertDuration(timer.id),
      () => {
        const current = preferenceTimer(timer.id);
        if (current) restoreInput(nodes["alert-duration"], current.alertDurationSeconds);
      },
      { min: 0.5, max: 15, step: 0.1 }
    );

    nodes.enabled.addEventListener("change", () => toggleTimerEnabled(timer.id));
    nodes["settings-toggle"].addEventListener("click", () => {
      setSettingsOpen(timer.id, !openSettings.has(timer.id));
    });
    nodes.start.addEventListener("click", () => startTimer(timer.id));
    nodes["alert-now"].addEventListener("click", () => alertNow(timer.id));
    nodes.reset.addEventListener("click", () => resetTimer(timer.id));
    nodes.name.addEventListener("change", () => commitTimerName(timer.id));
    nodes["repeat-mode"].addEventListener("change", () => commitRepeatMode(timer.id));
    nodes.sound.addEventListener("change", () => commitSound(timer.id));
    nodes["test-sound"].addEventListener("click", () => previewTimerSound(timer.id));
    nodes["persistent-completion"].addEventListener("change", () => {
      commitPersistentCompletion(timer.id);
    });
    nodes.colors.forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) commitColor(timer.id, input.value);
      });
    });
    nodes.remove.addEventListener("click", () => removeTimer(timer.id));
  }

  function renderTimerCards(focusTimerId = null) {
    const activeIds = new Set(preferences.timers.map((timer) => timer.id));
    preferences.timers.forEach((timer) => {
      let nodes = cardNodes.get(timer.id);
      if (!nodes) {
        const fragment = elements.timerCardTemplate.content.cloneNode(true);
        const card = fragment.querySelector("[data-role='card']");
        configureCard(card, timer);
        nodes = cardNodes.get(timer.id);
      }
      elements.timerStack.append(nodes.card);
    });

    cardNodes.forEach((nodes, timerId) => {
      if (activeIds.has(timerId)) return;
      nodes.card.remove();
      cardNodes.delete(timerId);
    });

    elements.timersEmpty.hidden = preferences.timers.length > 0;
    updateGlobalControls();
    render();

    if (focusTimerId) {
      setSettingsOpen(focusTimerId, true, true);
    }
  }

  function defaultCardMessage(timer, runtime) {
    if (!timer.enabled) return "Disabled. Enable this timer when you need it.";
    if (runtime.phase === "running") return "Counting independently.";
    if (runtime.phase === "complete") return "Complete. Reset this timer to clear it.";
    return "Ready when you are.";
  }

  function renderCard(timer, runtime) {
    const nodes = cardNodes.get(timer.id);
    if (!nodes || !runtime) return;

    const state = runtime.phase;
    const isRunning = state === "running";
    const isComplete = state === "complete";
    const isFinite = timer.alertMode === "finite";
    const displayMs = isRunning ? runtime.remainingMs : timer.intervalSeconds * 1000;
    const completed = runtime.completedAlerts;
    const total = timer.alertCount;
    const percent = isFinite ? Math.min(100, (completed / total) * 100) : 0;

    nodes.card.dataset.state = state;
    nodes.card.dataset.color = timer.alertColor;
    nodes.card.dataset.enabled = String(timer.enabled);
    nodes.card.dataset.holdCompletion = String(
      isComplete && timer.persistCompletionBackground
    );
    nodes.shell.dataset.state = state;
    nodes.shell.dataset.color = timer.alertColor;
    nodes.shell.dataset.holdCompletion = String(
      isComplete && timer.persistCompletionBackground
    );
    nodes.title.textContent = timer.label;
    nodes.state.textContent =
      !timer.enabled
        ? "Disabled"
        : state === "running"
        ? "Running"
        : state === "complete"
          ? "Complete"
          : state === "disabled"
            ? "Disabled"
            : "Ready";
    nodes.enabled.checked = timer.enabled;
    nodes["enabled-label"].textContent = timer.enabled ? "Enabled" : "Disabled";
    nodes["countdown-label"].textContent = isComplete
      ? "Timer complete"
      : isRunning
        ? "Next alert in"
        : "Interval";
    nodes.countdown.textContent = isComplete ? "DONE" : formatTime(displayMs);
    nodes.countdown.setAttribute(
      "aria-label",
      isComplete ? `${timer.label} complete` : `${timer.label}, ${accessibleTime(displayMs)}`
    );

    if (isFinite) {
      nodes["progress-text"].textContent = `${completed} of ${total} alerts`;
      nodes["progress-percent"].textContent = `${Math.round(percent)}%`;
      nodes["progress-track"].hidden = false;
      nodes["progress-fill"].style.width = `${percent}%`;
      nodes["progress-track"].setAttribute("aria-valuemax", String(total));
      nodes["progress-track"].setAttribute("aria-valuenow", String(completed));
      nodes["progress-track"].setAttribute(
        "aria-valuetext",
        `${completed} of ${total} alerts`
      );
    } else {
      const countText = completed === 1 ? "1 alert" : `${completed} alerts`;
      nodes["progress-text"].textContent = `${countText} · Until stopped`;
      nodes["progress-percent"].textContent = "∞";
      nodes["progress-track"].hidden = true;
    }

    nodes.status.textContent = cardMessages.get(timer.id) || defaultCardMessage(timer, runtime);
    nodes.start.disabled = !timer.enabled || runtime.phase !== "idle";
    nodes["alert-now"].disabled = !timer.enabled || runtime.phase !== "running";
    nodes.reset.disabled = runtime.phase === "idle";
    nodes["repeat-mode"].disabled = false;
    nodes["total-alerts"].disabled = timer.alertMode !== "finite";
    nodes["total-alerts-field"].hidden = timer.alertMode !== "finite";
    nodes["test-sound"].disabled = !preferences.soundEnabled || preferences.volume === 0;
    nodes["test-sound"].title = nodes["test-sound"].disabled
      ? "Turn on sound and raise the volume to test this cue."
      : `Test ${timer.label} sound`;
    nodes["settings-toggle"].setAttribute(
      "aria-label",
      `${openSettings.has(timer.id) ? "Close" : "Open"} settings for ${timer.label}`
    );
  }

  function render() {
    const snapshot = engine.getSnapshot(now());
    preferences.timers.forEach((timer) => {
      renderCard(timer, runtimeTimer(timer.id, snapshot));
    });
    updateGlobalControls();
    updatePageTone(snapshot);
  }

  function setCardFeedback(timerId, message) {
    cardMessages.set(timerId, message);
    const nodes = cardNodes.get(timerId);
    if (nodes && nodes.feedback) {
      nodes.status.textContent = message;
      nodes.feedback.textContent = "";
      window.requestAnimationFrame(() => {
        if (cardNodes.get(timerId) === nodes) nodes.feedback.textContent = message;
      });
    }
  }

  function announce(message) {
    announcementRevision += 1;
    const revision = announcementRevision;
    if (announcementFrame !== null) window.cancelAnimationFrame(announcementFrame);
    elements.liveAnnouncements.textContent = "";
    announcementFrame = window.requestAnimationFrame(() => {
      if (revision !== announcementRevision) return;
      elements.liveAnnouncements.textContent = message;
      announcementFrame = null;
    });
  }

  function hideTray() {
    trayRevision += 1;
    const revision = trayRevision;
    trayEvents = [];
    window.clearTimeout(trayHandle);
    elements.alertTray.classList.remove("is-visible");
    trayHandle = window.setTimeout(() => {
      if (revision === trayRevision) elements.alertTray.hidden = true;
    }, 220);
  }

  function showTray(message, durationMs = 5000, color = "red", events = []) {
    trayRevision += 1;
    const revision = trayRevision;
    window.clearTimeout(trayHandle);
    trayEvents = events.slice();
    elements.alertTrayMessage.textContent = message;
    elements.alertTray.dataset.color = color;
    elements.alertTray.hidden = false;
    window.requestAnimationFrame(() => {
      if (revision === trayRevision) elements.alertTray.classList.add("is-visible");
    });
    trayHandle = window.setTimeout(() => {
      if (revision !== trayRevision) return;
      trayEvents = [];
      elements.alertTray.classList.remove("is-visible");
      trayHandle = window.setTimeout(() => {
        if (revision !== trayRevision) return;
        elements.alertTray.hidden = true;
      }, 220);
    }, Math.max(1800, durationMs));
  }

  function eventMessage(event) {
    const timer = preferenceTimer(event.timerId);
    if (!timer) return "Timer alert";
    if (event.type === "timer-complete") return `${timer.label} — complete`;
    if (event.alertLimit === null) return `${timer.label} — alert ${event.completedAlerts}`;
    return `${timer.label} — alert ${event.completedAlerts} of ${event.alertLimit}`;
  }

  function combinedEventMessage(events) {
    const messages = events.slice(0, 3).map(eventMessage);
    if (events.length > 3) messages.push(`+${events.length - 3} more`);
    return messages.join(" · ");
  }

  function activateEventVisuals(events) {
    events.forEach((event) => {
      const timer = preferenceTimer(event.timerId);
      const nodes = cardNodes.get(event.timerId);
      if (!timer || !nodes) return;

      const durationMs = timer.alertDurationSeconds * 1000;
      window.clearTimeout(visualAlertHandles.get(timer.id));
      visualSequence += 1;
      activeVisualOrder.set(timer.id, visualSequence);
      nodes.card.dataset.alerting = "true";
      nodes.shell.dataset.alerting = "true";
      visualAlertHandles.set(
        timer.id,
        window.setTimeout(() => {
          visualAlertHandles.delete(timer.id);
          activeVisualOrder.delete(timer.id);
          const currentNodes = cardNodes.get(timer.id);
          if (currentNodes) {
            currentNodes.card.dataset.alerting = "false";
            currentNodes.shell.dataset.alerting = "false";
          }
          updatePageTone();
        }, durationMs)
      );

      if (event.type === "timer-complete") {
        completionSequence += 1;
        completionOrder.set(timer.id, completionSequence);
      }
    });

    updatePageTone();
  }

  function updatePageTone(snapshot = engine.getSnapshot(now())) {
    let activeTimer = null;
    let activeOrder = Number.NEGATIVE_INFINITY;
    activeVisualOrder.forEach((order, timerId) => {
      const timer = preferenceTimer(timerId);
      if (timer && order > activeOrder) {
        activeTimer = timer;
        activeOrder = order;
      }
    });

    if (activeTimer) {
      elements.body.dataset.alertMode = "alert";
      elements.body.dataset.alertColor = activeTimer.alertColor;
      return;
    }

    let selected = null;
    let selectedOrder = Number.NEGATIVE_INFINITY;
    preferences.timers.forEach((timer) => {
      const runtime = runtimeTimer(timer.id, snapshot);
      const order = completionOrder.get(timer.id);
      if (
        runtime &&
        runtime.phase === "complete" &&
        timer.persistCompletionBackground &&
        Number.isFinite(order) &&
        order > selectedOrder
      ) {
        selected = timer;
        selectedOrder = order;
      }
    });

    if (selected) {
      elements.body.dataset.alertMode = "complete";
      elements.body.dataset.alertColor = selected.alertColor;
    } else {
      delete elements.body.dataset.alertMode;
      delete elements.body.dataset.alertColor;
    }
  }

  function clearTimerPresentation(timerId, clearCompletion = true) {
    audio.stop(timerId);
    window.clearTimeout(visualAlertHandles.get(timerId));
    visualAlertHandles.delete(timerId);
    activeVisualOrder.delete(timerId);
    const nodes = cardNodes.get(timerId);
    if (nodes) {
      nodes.card.dataset.alerting = "false";
      nodes.shell.dataset.alerting = "false";
    }
    if (clearCompletion) completionOrder.delete(timerId);
    if (trayEvents.some((event) => event.timerId === timerId)) {
      trayEvents = trayEvents.filter((event) => event.timerId !== timerId);
      if (trayEvents.length === 0) {
        hideTray();
      } else {
        const lastEvent = trayEvents[trayEvents.length - 1];
        const trayTimer = preferenceTimer(lastEvent.timerId);
        elements.alertTrayMessage.textContent = combinedEventMessage(trayEvents);
        elements.alertTray.dataset.color = trayTimer ? trayTimer.alertColor : "red";
      }
    }
    updatePageTone();
  }

  function clearAllPresentations() {
    audio.stopAll();
    visualAlertHandles.forEach((handle) => window.clearTimeout(handle));
    visualAlertHandles.clear();
    activeVisualOrder.clear();
    cardNodes.forEach((nodes) => {
      nodes.card.dataset.alerting = "false";
      nodes.shell.dataset.alerting = "false";
    });
    completionOrder.clear();
    trayRevision += 1;
    trayEvents = [];
    window.clearTimeout(trayHandle);
    elements.alertTray.hidden = true;
    elements.alertTray.classList.remove("is-visible");
    delete elements.body.dataset.alertMode;
    delete elements.body.dataset.alertColor;
  }

  function eventIsCurrent(event) {
    const runtime = runtimeTimer(event.timerId);
    if (!runtime) return false;
    if (runtime.runId !== event.runId || runtime.revision !== event.revision) return false;
    return event.type === "timer-complete"
      ? runtime.phase === "complete"
      : runtime.phase === "running";
  }

  function soundOptions(timerId) {
    return {
      enabled: preferences.soundEnabled,
      volume: preferences.volume,
      ownerId: timerId
    };
  }

  function playSelectedSound(timer) {
    return mainSounds.has(timer.sound)
      ? audio.playMain(timer.sound, soundOptions(timer.id))
      : audio.playSecondary(timer.sound, soundOptions(timer.id));
  }

  function queueEventAudio(events) {
    if (!preferences.soundEnabled || preferences.volume === 0) return;

    events.forEach((event) => {
      if (!eventIsCurrent(event)) return;
      const timer = preferenceTimer(event.timerId);
      if (!timer) return;
      audio.stop(timer.id);
      if (event.type === "timer-complete") {
        audio.playCompletion(soundOptions(timer.id));
      } else {
        playSelectedSound(timer);
      }
    });
  }

  function presentEvents(events) {
    if (!Array.isArray(events) || events.length === 0) return;
    const freshEvents = events.filter((event) => preferenceTimer(event.timerId));
    if (freshEvents.length === 0) return;

    const message = combinedEventMessage(freshEvents);
    const maximumDuration = Math.max(
      ...freshEvents.map((event) => preferenceTimer(event.timerId).alertDurationSeconds * 1000)
    );
    activateEventVisuals(freshEvents);
    queueEventAudio(freshEvents);
    const lastTimer = preferenceTimer(freshEvents[freshEvents.length - 1].timerId);
    showTray(
      message,
      Math.max(4200, maximumDuration + 500),
      lastTimer ? lastTimer.alertColor : "red",
      freshEvents
    );
    announce(message);

    freshEvents.forEach((event) => {
      const eventText = eventMessage(event);
      cardMessages.set(event.timerId, eventText);
      const nodes = cardNodes.get(event.timerId);
      if (nodes) nodes.status.textContent = eventText;
    });
  }

  function reportAudioUnavailable() {
    if (audioWarningShown || !preferences.soundEnabled || preferences.volume === 0) return;
    audioWarningShown = true;
    const message = "Sound is unavailable. Visual alerts will still work.";
    showTray(message, 6000);
    announce(message);
  }

  function observeAudioUnlock(unlockPromise) {
    Promise.resolve(unlockPromise).then((available) => {
      if (available) audioWarningShown = false;
      else reportAudioUnavailable();
    });
  }

  async function previewTimerSound(timerId) {
    const timer = preferenceTimer(timerId);
    if (!timer) return;
    if (!preferences.soundEnabled || preferences.volume === 0) {
      setCardFeedback(timerId, "Turn sound on and raise the volume to hear a preview.");
      return;
    }

    audio.stop(timerId);
    const played = await playSelectedSound(timer);
    if (played && preferenceTimer(timerId)) {
      setCardFeedback(timerId, `${timer.label} sound preview played.`);
    }
  }

  function scheduleWake() {
    schedulerRevision += 1;
    const revision = schedulerRevision;
    window.clearTimeout(schedulerHandle);
    schedulerHandle = null;
    const deadline = engine.getNextDeadline();
    if (deadline === null) return;

    const delay = Math.min(2147483000, Math.max(0, deadline - now()));
    schedulerHandle = window.setTimeout(() => {
      if (revision !== schedulerRevision) return;
      schedulerHandle = null;
      presentEvents(engine.reconcile(now()));
      render();
      syncRuntimeServices();
    }, delay + 8);
  }

  function stopScheduler() {
    schedulerRevision += 1;
    window.clearTimeout(schedulerHandle);
    schedulerHandle = null;
  }

  function startRenderLoop() {
    if (renderFrame !== null) return;

    const frame = (frameTime) => {
      if (!engine.getSnapshot(now()).hasRunningTimers) {
        renderFrame = null;
        return;
      }

      if (frameTime - lastFrameRenderAt >= 100) {
        lastFrameRenderAt = frameTime;
        render();
      }
      renderFrame = window.requestAnimationFrame(frame);
    };
    renderFrame = window.requestAnimationFrame(frame);
  }

  function stopRenderLoop() {
    if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
    renderFrame = null;
  }

  async function requestWakeLock() {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    if (
      (wakeLock && !wakeLock.released) ||
      wakeLockRequestPendingRevision === wakeLockRequestRevision
    ) {
      return;
    }
    const revision = ++wakeLockRequestRevision;
    wakeLockRequestPendingRevision = revision;

    try {
      const sentinel = await navigator.wakeLock.request("screen");
      if (
        revision !== wakeLockRequestRevision ||
        !engine.getSnapshot(now()).hasRunningTimers
      ) {
        await sentinel.release();
        return;
      }
      wakeLock = sentinel;
      sentinel.addEventListener(
        "release",
        () => {
          if (wakeLock !== sentinel) return;
          wakeLock = null;
          if (
            engine.getSnapshot(now()).hasRunningTimers &&
            document.visibilityState === "visible"
          ) {
            window.setTimeout(requestWakeLock, 0);
          }
        },
        { once: true }
      );
    } catch (error) {
      console.warn("Screen wake lock is unavailable:", error);
    } finally {
      if (wakeLockRequestPendingRevision === revision) {
        wakeLockRequestPendingRevision = null;
      }
    }
  }

  async function releaseWakeLock() {
    wakeLockRequestRevision += 1;
    const sentinel = wakeLock;
    wakeLock = null;
    if (sentinel && !sentinel.released) {
      try {
        await sentinel.release();
      } catch (error) {
        console.warn("Screen wake lock could not be released:", error);
      }
    }
  }

  function syncRuntimeServices() {
    const snapshot = engine.getSnapshot(now());
    scheduleWake();
    if (snapshot.hasRunningTimers) {
      startRenderLoop();
      requestWakeLock();
    } else {
      stopRenderLoop();
      releaseWakeLock();
    }
  }

  function syncEngine(at = now()) {
    const events = engine.syncTimers(timerDefinitions(), at);
    presentEvents(events);
    render();
    syncRuntimeServices();
    return events;
  }

  function startTimer(timerId) {
    const timer = preferenceTimer(timerId);
    if (!timer || !timer.enabled) return;
    if (preferences.soundEnabled) observeAudioUnlock(audio.unlock());
    clearTimerPresentation(timerId);
    const started = engine.start(timerId, now());
    if (!started) return;
    cardMessages.set(timerId, "Timer running.");
    render();
    syncRuntimeServices();
  }

  function alertNow(timerId) {
    const events = engine.alertNow(timerId, now());
    presentEvents(events);
    render();
    syncRuntimeServices();
  }

  function resetTimer(timerId) {
    clearTimerPresentation(timerId);
    const reset = engine.reset(timerId, now());
    if (!reset) return;
    cardMessages.set(timerId, "Timer reset. Ready when you are.");
    render();
    syncRuntimeServices();
  }

  function toggleTimerEnabled(timerId) {
    const nodes = cardNodes.get(timerId);
    if (!nodes) return;
    const enabled = nodes.enabled.checked;
    if (!enabled) clearTimerPresentation(timerId);
    const timer = updateTimerPreference(timerId, { enabled });
    syncEngine(now());
    setCardFeedback(
      timerId,
      enabled ? `${timer.label} enabled and ready.` : `${timer.label} disabled.`
    );
    render();
  }

  function validDurationParts(minutesInput, secondsInput) {
    const minutesText = minutesInput.value.trim();
    const secondsText = secondsInput.value.trim();
    if (!/^\d+$/.test(minutesText) || !/^\d+(?:\.\d+)?$/.test(secondsText)) {
      return null;
    }
    const total = Number(minutesText) * 60 + Number(secondsText);
    return Number.isFinite(total) && total >= 0.1 && total <= 86400 ? total : null;
  }

  function restoreIntervalInputs(timerId) {
    const timer = preferenceTimer(timerId);
    const nodes = cardNodes.get(timerId);
    if (!timer || !nodes) return;
    const interval = splitInterval(timer.intervalSeconds);
    restoreInput(nodes.minutes, interval.minutes);
    restoreInput(nodes.seconds, inputNumber(interval.seconds));
  }

  function commitInterval(timerId) {
    const timer = preferenceTimer(timerId);
    const nodes = cardNodes.get(timerId);
    if (!timer || !nodes) return;
    const total = validDurationParts(nodes.minutes, nodes.seconds);
    if (total === null) {
      restoreIntervalInputs(timerId);
      return;
    }

    const sanitized = sanitizePreferences({
      ...preferences,
      timers: preferences.timers.map((entry) =>
        entry.id === timerId ? { ...entry, intervalSeconds: total } : entry
      )
    });
    const nextTimer = sanitized.timers.find((entry) => entry.id === timerId);
    if (!nextTimer || nextTimer.intervalSeconds === timer.intervalSeconds) {
      restoreIntervalInputs(timerId);
      return;
    }

    clearTimerPresentation(timerId, runtimeTimer(timerId)?.phase === "complete");
    persistPreferences(sanitized);
    restoreIntervalInputs(timerId);
    syncEngine(now());
    setCardFeedback(
      timerId,
      runtimeTimer(timerId)?.phase === "running"
        ? `${nextTimer.label} restarts its interval from now.`
        : `${nextTimer.label} interval saved.`
    );
  }

  function commitTimerName(timerId) {
    const timer = preferenceTimer(timerId);
    const nodes = cardNodes.get(timerId);
    if (!timer || !nodes) return;
    const label = nodes.name.value.trim();
    if (!label) {
      nodes.name.value = timer.label;
      return;
    }
    const saved = updateTimerPreference(timerId, { label });
    nodes.name.value = saved.label;
    applyCardIdentity(nodes, saved);
    render();
  }

  function commitRepeatMode(timerId) {
    const timer = preferenceTimer(timerId);
    const nodes = cardNodes.get(timerId);
    if (!timer || !nodes) return;
    const alertMode = nodes["repeat-mode"].value;
    if (alertMode === timer.alertMode) return;
    const runtime = runtimeTimer(timerId);
    const alertCount =
      alertMode === "finite" &&
      timer.alertMode === "infinite" &&
      runtime?.phase === "running" &&
      runtime.completedAlerts >= timer.alertCount
        ? Math.min(9999, runtime.completedAlerts + 1)
        : timer.alertCount;
    clearTimerPresentation(timerId);
    const saved = updateTimerPreference(timerId, {
      alertMode,
      alertCount
    });
    nodes["repeat-mode"].value = saved.alertMode;
    restoreInput(nodes["total-alerts"], saved.alertCount);
    syncEngine(now());
    if (runtimeTimer(timerId)?.phase !== "complete") {
      setCardFeedback(
        timerId,
        runtime?.phase === "running" && alertMode === "finite"
          ? `${saved.label} will complete at alert ${saved.alertCount}.`
          : `${saved.label} repeat mode saved.`
      );
    }
  }

  function commitAlertCount(timerId) {
    const timer = preferenceTimer(timerId);
    const nodes = cardNodes.get(timerId);
    if (!timer || !nodes) return;
    const text = nodes["total-alerts"].value.trim();
    if (!/^\d+$/.test(text)) {
      restoreInput(nodes["total-alerts"], timer.alertCount);
      return;
    }
    const sanitized = sanitizePreferences({
      ...preferences,
      timers: preferences.timers.map((entry) =>
        entry.id === timerId ? { ...entry, alertCount: Number(text) } : entry
      )
    });
    const nextTimer = sanitized.timers.find((entry) => entry.id === timerId);
    if (!nextTimer || nextTimer.alertCount === timer.alertCount) {
      restoreInput(nodes["total-alerts"], timer.alertCount);
      return;
    }
    clearTimerPresentation(timerId);
    persistPreferences(sanitized);
    const saved = preferenceTimer(timerId);
    restoreInput(nodes["total-alerts"], saved.alertCount);
    syncEngine(now());
    if (runtimeTimer(timerId)?.phase !== "complete") {
      setCardFeedback(timerId, `${saved.label} alert count saved.`);
    }
  }

  function commitSound(timerId) {
    const nodes = cardNodes.get(timerId);
    if (!nodes) return;
    const saved = updateTimerPreference(timerId, { sound: nodes.sound.value });
    nodes.sound.value = saved.sound;
  }

  function commitColor(timerId, color) {
    const saved = updateTimerPreference(timerId, { alertColor: color });
    const nodes = cardNodes.get(timerId);
    if (!saved || !nodes) return;
    nodes.colors.forEach((input) => {
      input.checked = input.value === saved.alertColor;
    });
    render();
  }

  function commitAlertDuration(timerId) {
    const timer = preferenceTimer(timerId);
    const nodes = cardNodes.get(timerId);
    if (!timer || !nodes) return;
    const text = nodes["alert-duration"].value.trim();
    if (!/^\d+(?:\.\d+)?$/.test(text)) {
      restoreInput(nodes["alert-duration"], timer.alertDurationSeconds);
      return;
    }
    const saved = updateTimerPreference(timerId, {
      alertDurationSeconds: Number(text)
    });
    restoreInput(nodes["alert-duration"], saved.alertDurationSeconds);
  }

  function commitPersistentCompletion(timerId) {
    const nodes = cardNodes.get(timerId);
    if (!nodes) return;
    const saved = updateTimerPreference(timerId, {
      persistCompletionBackground: nodes["persistent-completion"].checked
    });
    nodes["persistent-completion"].checked = saved.persistCompletionBackground;
    if (runtimeTimer(timerId)?.phase === "complete" && saved.persistCompletionBackground) {
      completionSequence += 1;
      completionOrder.set(timerId, completionSequence);
    }
    render();
  }

  function nextTimerId() {
    const existing = new Set(preferences.timers.map((timer) => timer.id));
    let id;
    do {
      timerIdSequence += 1;
      id = `timer-${Date.now().toString(36)}-${timerIdSequence.toString(36)}`;
    } while (existing.has(id));
    return id;
  }

  function nextTimerLabel() {
    const labels = new Set(preferences.timers.map((timer) => timer.label));
    let index = preferences.timers.length + 1;
    while (labels.has(`Timer ${index}`)) index += 1;
    return `Timer ${index}`;
  }

  function nextTimerColor() {
    const used = new Set(preferences.timers.map((timer) => timer.alertColor));
    return palette.find((color) => !used.has(color)) || palette[preferences.timers.length % palette.length];
  }

  function addTimer() {
    if (preferences.timers.length >= timerLimit) {
      showTray(`You can configure up to ${timerLimit} timers.`, 4500);
      return;
    }
    const timer = {
      id: nextTimerId(),
      label: nextTimerLabel(),
      enabled: true,
      intervalSeconds: 90,
      alertMode: "infinite",
      alertCount: 10,
      sound: "double-tap",
      alertColor: nextTimerColor(),
      alertDurationSeconds: 1.4,
      persistCompletionBackground: true
    };
    persistPreferences({ ...preferences, timers: [...preferences.timers, timer] });
    engine.syncTimers(timerDefinitions(), now());
    openSettings.add(timer.id);
    cardMessages.set(timer.id, "New timer added. Adjust its settings, then press Start.");
    renderTimerCards(timer.id);
    announce(`${timer.label} added.`);
  }

  function removeTimer(timerId) {
    const timer = preferenceTimer(timerId);
    if (!timer) return;
    const index = preferences.timers.findIndex((entry) => entry.id === timerId);
    clearTimerPresentation(timerId);
    openSettings.delete(timerId);
    cardMessages.delete(timerId);
    persistPreferences({
      ...preferences,
      timers: preferences.timers.filter((entry) => entry.id !== timerId)
    });
    engine.syncTimers(timerDefinitions(), now());
    renderTimerCards();
    syncRuntimeServices();
    announce(`${timer.label} removed.`);

    const remaining = preferences.timers[Math.min(index, preferences.timers.length - 1)];
    if (remaining) {
      const nodes = cardNodes.get(remaining.id);
      if (nodes) nodes["settings-toggle"].focus();
    } else {
      elements.addTimerButton.focus();
    }
  }

  function restoreInput(input, value) {
    input.value = value;
    input.dataset.lastGoodValue = String(value);
    updateNumericAria(input);
  }

  function updateNumericAria(input) {
    if (!input || input.getAttribute("role") !== "spinbutton") return;
    const value = Number(input.value);
    if (input.value.trim() !== "" && Number.isFinite(value)) {
      input.setAttribute("aria-valuenow", String(value));
    } else {
      input.removeAttribute("aria-valuenow");
    }
  }

  function enhanceNumberInput(input, commit, restore, options) {
    if (!input || input.dataset.numberEnhanced === "true") return;
    input.dataset.numberEnhanced = "true";
    const minimum = Number(options.min);
    const maximum = Number(options.max);
    const step = Number(options.step);
    input.setAttribute("role", "spinbutton");
    input.setAttribute("aria-valuemin", String(minimum));
    input.setAttribute("aria-valuemax", String(maximum));
    updateNumericAria(input);
    let selectOnFocus = true;

    input.addEventListener("pointerdown", () => {
      selectOnFocus = document.activeElement !== input;
    });
    input.addEventListener("focus", () => {
      input.dataset.lastGoodValue = input.value;
      if (selectOnFocus) {
        window.requestAnimationFrame(() => {
          if (document.activeElement === input) input.select();
        });
      }
      selectOnFocus = true;
    });
    input.addEventListener("input", () => updateNumericAria(input));
    input.addEventListener("change", commit);
    input.addEventListener("blur", () => {
      selectOnFocus = true;
      if (input.value.trim() === "") restore();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
        input.blur();
      } else if (event.key === "Escape") {
        if (input.value === input.dataset.lastGoodValue) return;
        event.preventDefault();
        restore();
        input.blur();
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const current = Number(input.value);
        const fallback = Number(input.dataset.lastGoodValue);
        const base = Number.isFinite(current)
          ? current
          : Number.isFinite(fallback)
            ? fallback
            : minimum;
        const direction = event.key === "ArrowUp" ? 1 : -1;
        const decimals = (String(step).split(".")[1] || "").length;
        const next = Math.min(
          maximum,
          Math.max(minimum, Number((base + direction * step).toFixed(decimals)))
        );
        input.value = String(next);
        updateNumericAria(input);
        commit();
        input.select();
      }
    });
  }

  elements.addTimerButton.addEventListener("click", addTimer);
  elements.globalSoundControl.addEventListener("toggle", updateGlobalControls);
  elements.soundEnabledInput.addEventListener("change", () => {
    persistPreferences({
      ...preferences,
      soundEnabled: elements.soundEnabledInput.checked
    });
    if (preferences.soundEnabled && preferences.volume > 0) {
      observeAudioUnlock(audio.unlock());
    }
    render();
  });
  elements.volumeInput.addEventListener("input", () => {
    persistPreferences({ ...preferences, volume: elements.volumeInput.value });
    render();
  });
  elements.restoreDefaultsButton.addEventListener("click", () => {
    if (engine.getSnapshot(now()).hasRunningTimers) return;
    clearAllPresentations();
    preferences = restoreDefaultPreferences();
    openSettings.clear();
    cardMessages.clear();
    engine.syncTimers([], now());
    engine.syncTimers(timerDefinitions(), now());
    audio.setVolume(preferences.soundEnabled ? preferences.volume : 0);
    cardNodes.forEach((nodes) => nodes.card.remove());
    cardNodes.clear();
    renderTimerCards();
    elements.globalFeedback.textContent = "Default timers restored.";
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!engine.getSnapshot(now()).hasRunningTimers) return;
    presentEvents(engine.reconcile(now()));
    render();
    syncRuntimeServices();
  });
  window.addEventListener("focus", () => {
    if (!engine.getSnapshot(now()).hasRunningTimers) return;
    presentEvents(engine.reconcile(now()));
    render();
    syncRuntimeServices();
  });
  window.addEventListener("pagehide", releaseWakeLock);
  window.addEventListener("beforeunload", releaseWakeLock);

  engine.syncTimers(timerDefinitions(), now());
  audio.setVolume(preferences.soundEnabled ? preferences.volume : 0);
  updateGlobalControls();
  renderTimerCards();
})();
