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
    timerHud: document.getElementById("timerHud"),
    hudDragHandle: document.getElementById("hudDragHandle"),
    hudFocusMode: document.getElementById("hudFocusMode"),
    hudSizeDown: document.getElementById("hudSizeDown"),
    hudSizeUp: document.getElementById("hudSizeUp"),
    hudShowStopped: document.getElementById("hudShowStopped"),
    hudStoppedLabel: document.getElementById("hudStoppedLabel"),
    hudTimerList: document.getElementById("hudTimerList"),
    hudEmpty: document.getElementById("hudEmpty"),
    alertTray: document.getElementById("alertTray"),
    alertTrayMessage: document.getElementById("alertTrayMessage"),
    hudAlertKicker: document.getElementById("hudAlertKicker"),
    hudAlertTitle: document.getElementById("hudAlertTitle"),
    hudAlertDismiss: document.getElementById("hudAlertDismiss"),
    hudAlertReset: document.getElementById("hudAlertReset"),
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
  const HUD_STATE_KEY = "interval-timer.hud-position.v1";

  const now = () => performance.now();
  let preferences = ensureTimersAvailable(loadPreferences());
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
  let hudRenderedTimerCount = -1;
  let hudShowStopped = false;
  let hudSizeLevel = 1;
  let hudFocusMode = false;
  let hudPreferredX = 18;
  let hudPreferredY = 92;

  const cardNodes = new Map();
  const hudRows = new Map();
  const cardMessages = new Map();
  const openSettings = new Set();
  const visualAlertHandles = new Map();
  const pageAlertHandles = new Map();
  const activeVisualOrder = new Map();
  const completionOrder = new Map();
  const completionNotices = new Map();
  let trayEvents = [];

  function timerDefinitions() {
    return preferences.timers.map((timer) => ({
      id: timer.id,
      enabled: true,
      intervalMs: timer.intervalSeconds * 1000,
      alertLimit: timer.alertMode === "finite" ? timer.alertCount : null
    }));
  }

  function ensureTimersAvailable(source) {
    if (!source.timers.some((timer) => !timer.enabled)) return source;
    return savePreferences({
      ...source,
      timers: source.timers.map((timer) => ({ ...timer, enabled: true }))
    });
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
      "settings-close",
      "settings-done",
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
    nodes.shell.tabIndex = -1;
    nodes.shell.setAttribute("aria-labelledby", titleId);
    nodes["settings-panel"].id = settingsId;
    nodes["settings-panel"].setAttribute("aria-label", `${timer.label} settings`);
    nodes["settings-close"].setAttribute("aria-label", `Close ${timer.label} settings`);
    nodes["settings-done"].setAttribute("aria-label", `Done editing ${timer.label}`);
    nodes["settings-toggle"].setAttribute("aria-controls", settingsId);
    nodes["settings-toggle"].setAttribute("aria-label", `Settings for ${timer.label}`);
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
    const dialog = nodes["settings-panel"];

    if (shouldOpen) {
      [...openSettings].forEach((openTimerId) => {
        if (openTimerId !== timerId) setSettingsOpen(openTimerId, false);
      });
      openSettings.add(timerId);
      if (!dialog.open) dialog.showModal();
    } else {
      openSettings.delete(timerId);
      if (dialog.open) dialog.close();
    }
    nodes["settings-toggle"].setAttribute("aria-expanded", String(shouldOpen));
    const timer = preferenceTimer(timerId);
    if (timer) {
      nodes["settings-toggle"].setAttribute(
        "aria-label",
        `${shouldOpen ? "Close" : "Open"} settings for ${timer.label}`
      );
    }

    if (shouldOpen && focusName) {
      window.requestAnimationFrame(() => {
        nodes.name.focus();
        nodes.name.select();
      });
    }
  }

  function configureCard(card, timer) {
    card.dataset.timerId = timer.id;
    const nodes = collectCardNodes(card);
    cardNodes.set(timer.id, nodes);
    applyCardIdentity(nodes, timer);
    applyTimerFormValues(nodes, timer);
    nodes["settings-toggle"].setAttribute("aria-expanded", "false");

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

    nodes["settings-toggle"].addEventListener("click", () => {
      setSettingsOpen(timer.id, !openSettings.has(timer.id));
    });
    const closeSettings = () => {
      setSettingsOpen(timer.id, false);
      nodes["settings-toggle"].focus();
    };
    nodes["settings-close"].addEventListener("click", closeSettings);
    nodes["settings-done"].addEventListener("click", closeSettings);
    nodes["settings-panel"].addEventListener("close", () => {
      openSettings.delete(timer.id);
      nodes["settings-toggle"].setAttribute("aria-expanded", "false");
      const current = preferenceTimer(timer.id);
      if (current) {
        nodes["settings-toggle"].setAttribute(
          "aria-label",
          `Open settings for ${current.label}`
        );
      }
    });
    let backdropPointerId = null;
    const isOutsideDialog = (event) => {
      const rect = nodes["settings-panel"].getBoundingClientRect();
      return (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      );
    };
    nodes["settings-panel"].addEventListener("pointerdown", (event) => {
      backdropPointerId =
        event.target === nodes["settings-panel"] && isOutsideDialog(event)
          ? event.pointerId
          : null;
    });
    nodes["settings-panel"].addEventListener("pointerup", (event) => {
      const shouldClose =
        backdropPointerId === event.pointerId &&
        event.target === nodes["settings-panel"] &&
        isOutsideDialog(event);
      backdropPointerId = null;
      if (shouldClose) closeSettings();
    });
    nodes["settings-panel"].addEventListener("pointercancel", () => {
      backdropPointerId = null;
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
      if (nodes["settings-panel"].open) nodes["settings-panel"].close();
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
    if (runtime.phase === "complete") return "Complete. Reset this timer to clear it.";
    return "";
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
      state === "running"
        ? "Running"
        : state === "complete"
          ? "Complete"
          : "Stopped";
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
      nodes["progress-text"].parentElement.dataset.mode = "finite";
      nodes["progress-text"].textContent = `${completed} of ${total} alerts`;
      nodes["progress-percent"].textContent = `${Math.round(percent)}%`;
      nodes["progress-percent"].hidden = false;
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
      nodes["progress-text"].parentElement.dataset.mode = "infinite";
      nodes["progress-text"].textContent = `${countText} · Until stopped`;
      nodes["progress-percent"].textContent = "";
      nodes["progress-percent"].hidden = true;
      nodes["progress-track"].hidden = true;
    }

    const statusMessage = cardMessages.get(timer.id) || defaultCardMessage(timer, runtime);
    nodes.status.textContent = statusMessage;
    nodes.status.hidden = statusMessage.length === 0;
    nodes.start.disabled = runtime.phase !== "idle";
    nodes["alert-now"].disabled = runtime.phase !== "running";
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

  function createHudRow(timerId) {
    const item = document.createElement("li");
    item.className = "timer-hud__item";

    const button = document.createElement("button");
    button.className = "timer-hud__timer";
    button.type = "button";

    const identity = document.createElement("span");
    identity.className = "timer-hud__identity";
    const dot = document.createElement("span");
    dot.className = "timer-hud__dot";
    dot.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "timer-hud__copy";
    const name = document.createElement("strong");
    const state = document.createElement("small");
    copy.append(name, state);
    identity.append(dot, copy);

    const time = document.createElement("span");
    time.className = "timer-hud__time";
    const progress = document.createElement("span");
    progress.className = "timer-hud__progress";
    const action = document.createElement("span");
    action.className = "timer-hud__action";
    action.textContent = "Alert now";
    button.append(identity, time, progress, action);
    item.append(button);
    button.addEventListener("click", () => {
      const runtime = runtimeTimer(timerId);
      if (runtime?.phase === "running") {
        alertNow(timerId);
        return;
      }
      if (runtime?.phase === "complete") {
        resetTimer(timerId);
        return;
      }
      startTimer(timerId);
    });

    const hudRow = { item, button, name, state, time, progress, action };
    hudRows.set(timerId, hudRow);
    return hudRow;
  }

  function renderHud(snapshot) {
    const activeIds = new Set(preferences.timers.map((timer) => timer.id));

    preferences.timers.forEach((timer, index) => {
      const runtime = runtimeTimer(timer.id, snapshot);
      if (!runtime) return;
      let hudRow = hudRows.get(timer.id);
      if (!hudRow) hudRow = createHudRow(timer.id);

      const isRunning = runtime.phase === "running";
      const display = runtime.phase === "complete"
        ? "DONE"
        : formatTime(isRunning ? runtime.remainingMs : timer.intervalSeconds * 1000);
      const state = runtime.phase === "complete"
          ? "Complete"
          : isRunning
            ? "Running"
            : "Stopped";
      const action = isRunning ? "Alert now" : runtime.phase === "complete" ? "Reset" : "Start";
      const progress = timer.alertMode === "finite"
        ? `${runtime.completedAlerts}/${timer.alertCount}`
        : "";

      hudRow.item.dataset.color = timer.alertColor;
      hudRow.item.dataset.state = runtime.phase;
      hudRow.item.hidden = !hudShowStopped && !isRunning;
      hudRow.name.textContent = timer.label;
      hudRow.state.textContent = state;
      hudRow.time.textContent = display;
      hudRow.progress.textContent = progress;
      hudRow.progress.hidden = progress.length === 0;
      hudRow.action.textContent = action;
      hudRow.button.setAttribute(
        "aria-label",
        isRunning
          ? `Alert now for ${timer.label}. ${display} remaining.${progress ? ` ${progress} alerts.` : ""}`
          : runtime.phase === "complete"
            ? `Reset ${timer.label}. Timer complete${progress ? ` at ${progress} alerts` : ""}.`
            : `Start ${timer.label}. Interval ${display}.${progress ? ` ${progress} alerts.` : ""}`
      );
      hudRow.button.title =
        isRunning
          ? `Alert now for ${timer.label}`
          : runtime.phase === "complete"
            ? `Reset ${timer.label}`
            : `Start ${timer.label}`;
      const currentAtIndex = elements.hudTimerList.children[index];
      if (currentAtIndex !== hudRow.item) {
        elements.hudTimerList.insertBefore(hudRow.item, currentAtIndex || null);
      }
    });

    hudRows.forEach((hudRow, timerId) => {
      if (activeIds.has(timerId)) return;
      hudRow.item.remove();
      hudRows.delete(timerId);
    });
    const visibleCount = preferences.timers.reduce((count, timer) => {
      const runtime = runtimeTimer(timer.id, snapshot);
      return count + (runtime && (hudShowStopped || runtime.phase === "running") ? 1 : 0);
    }, 0);
    elements.hudEmpty.hidden = visibleCount > 0;
    elements.hudEmpty.textContent =
      preferences.timers.length === 0
        ? "No timers configured."
        : "No timers running. Turn on Show stopped to start one.";
    if (hudRenderedTimerCount !== preferences.timers.length) {
      hudRenderedTimerCount = preferences.timers.length;
      window.requestAnimationFrame(() => {
        placeHud(hudPreferredX, hudPreferredY);
      });
    }
  }

  function readHudState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HUD_STATE_KEY));
      return parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)
        ? parsed
        : null;
    } catch (error) {
      return null;
    }
  }

  function saveHudState() {
    const state = {
      x: hudPreferredX,
      y: hudPreferredY,
      showStopped: hudShowStopped,
      sizeLevel: hudSizeLevel,
      focusMode: hudFocusMode
    };
    try {
      localStorage.setItem(HUD_STATE_KEY, JSON.stringify(state));
    } catch (error) {
      // The HUD remains interactive when browser storage is unavailable.
    }
  }

  function placeHud(x, y) {
    const margin = 8;
    const width = elements.timerHud.offsetWidth;
    const height = elements.timerHud.offsetHeight;
    const left = Math.min(
      Math.max(margin, Number(x) || margin),
      Math.max(margin, window.innerWidth - width - margin)
    );
    const top = Math.min(
      Math.max(margin, Number(y) || margin),
      Math.max(margin, window.innerHeight - height - margin)
    );
    elements.timerHud.style.left = `${Math.round(left)}px`;
    elements.timerHud.style.top = `${Math.round(top)}px`;
  }

  function rememberHudPosition(x, y) {
    hudPreferredX = Number.isFinite(Number(x)) ? Number(x) : hudPreferredX;
    hudPreferredY = Number.isFinite(Number(y)) ? Number(y) : hudPreferredY;
    placeHud(hudPreferredX, hudPreferredY);
    saveHudState();
  }

  function updateHudStoppedControl() {
    elements.hudShowStopped.setAttribute("aria-expanded", String(hudShowStopped));
    elements.hudStoppedLabel.textContent = hudShowStopped
      ? "Hide stopped"
      : "Show stopped";
  }

  function setHudSizeLevel(level, persist = true) {
    hudSizeLevel = Math.min(2, Math.max(0, Math.round(Number(level) || 0)));
    elements.timerHud.dataset.size = String(hudSizeLevel);
    elements.hudSizeDown.disabled = hudSizeLevel === 0;
    elements.hudSizeUp.disabled = hudSizeLevel === 2;
    if (!persist) return;
    window.requestAnimationFrame(() => {
      placeHud(hudPreferredX, hudPreferredY);
      saveHudState();
    });
  }

  function applyHudFocusMode() {
    elements.body.dataset.focusMode = String(hudFocusMode);
    elements.hudFocusMode.setAttribute("aria-pressed", String(hudFocusMode));
    elements.hudFocusMode.textContent = hudFocusMode ? "Show page" : "Hide page";
    elements.hudFocusMode.title = hudFocusMode
      ? "Show the timer dashboard"
      : "Hide the dashboard and keep only the overview";
  }

  function setHudFocusMode(shouldFocus) {
    hudFocusMode = Boolean(shouldFocus);
    if (hudFocusMode) {
      elements.globalSoundControl.open = false;
      [...openSettings].forEach((timerId) => setSettingsOpen(timerId, false));
    }
    applyHudFocusMode();
    saveHudState();
  }

  function initializeHudDrag() {
    const saved = readHudState();
    hudShowStopped = saved?.showStopped === true;
    hudSizeLevel = Number.isInteger(saved?.sizeLevel) ? saved.sizeLevel : 1;
    hudFocusMode = saved?.focusMode === true;
    hudPreferredX = saved?.x ?? 18;
    hudPreferredY = saved?.y ?? 92;
    updateHudStoppedControl();
    setHudSizeLevel(hudSizeLevel, false);
    applyHudFocusMode();
    window.requestAnimationFrame(() => {
      placeHud(hudPreferredX, hudPreferredY);
    });

    let drag = null;
    elements.hudDragHandle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = elements.timerHud.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: rect.left,
        originY: rect.top,
        moved: false
      };
      elements.hudDragHandle.setPointerCapture(event.pointerId);
      elements.timerHud.classList.add("is-dragging");
      event.preventDefault();
    });
    elements.hudDragHandle.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (
        Math.abs(event.clientX - drag.startX) > 2 ||
        Math.abs(event.clientY - drag.startY) > 2
      ) {
        drag.moved = true;
      }
      placeHud(
        drag.originX + event.clientX - drag.startX,
        drag.originY + event.clientY - drag.startY
      );
    });
    const finishDrag = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const moved = drag.moved;
      drag = null;
      elements.timerHud.classList.remove("is-dragging");
      if (!moved) {
        placeHud(hudPreferredX, hudPreferredY);
        return;
      }
      const left = Number.parseFloat(elements.timerHud.style.left);
      const top = Number.parseFloat(elements.timerHud.style.top);
      rememberHudPosition(left, top);
    };
    elements.hudDragHandle.addEventListener("pointerup", finishDrag);
    elements.hudDragHandle.addEventListener("pointercancel", finishDrag);
    elements.hudDragHandle.addEventListener("lostpointercapture", finishDrag);
    elements.hudDragHandle.addEventListener("keydown", (event) => {
      const directions = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1]
      };
      const direction = directions[event.key];
      if (!direction) return;
      event.preventDefault();
      const rect = elements.timerHud.getBoundingClientRect();
      const distance = event.shiftKey ? 40 : 12;
      rememberHudPosition(
        rect.left + direction[0] * distance,
        rect.top + direction[1] * distance
      );
    });
    window.addEventListener("resize", () => {
      placeHud(hudPreferredX, hudPreferredY);
    });

    elements.hudShowStopped.addEventListener("click", () => {
      hudShowStopped = !hudShowStopped;
      updateHudStoppedControl();
      saveHudState();
      render();
      window.requestAnimationFrame(() => placeHud(hudPreferredX, hudPreferredY));
    });

    elements.hudFocusMode.addEventListener("click", () => setHudFocusMode(!hudFocusMode));
    elements.hudSizeDown.addEventListener("click", () => setHudSizeLevel(hudSizeLevel - 1));
    elements.hudSizeUp.addEventListener("click", () => setHudSizeLevel(hudSizeLevel + 1));
  }

  function render() {
    const snapshot = engine.getSnapshot(now());
    preferences.timers.forEach((timer) => {
      renderCard(timer, runtimeTimer(timer.id, snapshot));
    });
    renderHud(snapshot);
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

  function concealTray() {
    trayRevision += 1;
    const revision = trayRevision;
    trayEvents = [];
    window.clearTimeout(trayHandle);
    elements.alertTray.classList.remove("is-visible");
    elements.hudAlertReset.hidden = true;
    trayHandle = window.setTimeout(() => {
      if (revision !== trayRevision) return;
      elements.alertTray.hidden = true;
      window.requestAnimationFrame(() => placeHud(hudPreferredX, hudPreferredY));
    }, 220);
  }

  function latestCompletionNotice() {
    const notices = [...completionNotices.values()];
    return notices.length > 0 ? notices[notices.length - 1] : null;
  }

  function renderHudAlert(message, color, events) {
    const revision = trayRevision;
    const event = events.length > 0 ? events[events.length - 1] : null;
    const timer = event ? preferenceTimer(event.timerId) : null;
    trayEvents = events.slice();
    elements.alertTray.dataset.color = timer ? timer.alertColor : color;
    elements.alertTray.hidden = false;

    if (event && timer) {
      const extraCount = Math.max(0, events.length - 1);
      elements.hudAlertKicker.textContent =
        event.type === "timer-complete"
          ? "Timer complete"
          : event.alertLimit === null
            ? `Alert ${event.completedAlerts}`
            : `Alert ${event.completedAlerts} of ${event.alertLimit}`;
      elements.hudAlertTitle.textContent = timer.label;
      const detail =
        event.type === "timer-complete"
          ? "Finished. Reset it when you want to run it again."
          : extraCount > 0
            ? `${extraCount} other timer${extraCount === 1 ? "" : "s"} also alerted.`
            : "";
      elements.alertTrayMessage.textContent = detail;
      elements.alertTrayMessage.hidden = detail.length === 0;
      elements.hudAlertReset.hidden = event.type !== "timer-complete";
      elements.hudAlertReset.dataset.timerId = event.timerId;
      elements.hudAlertReset.textContent = `Reset ${timer.label}`;
      elements.hudAlertDismiss.setAttribute("aria-label", `Dismiss ${timer.label} notice`);
      elements.hudAlertDismiss.title =
        event.type === "timer-complete"
          ? "Dismiss this prompt; the timer will remain complete."
          : "Dismiss this alert.";
    } else {
      elements.hudAlertKicker.textContent = "Timer notice";
      elements.hudAlertTitle.textContent = "Heads up";
      elements.alertTrayMessage.textContent = message;
      elements.alertTrayMessage.hidden = false;
      elements.hudAlertReset.hidden = true;
      delete elements.hudAlertReset.dataset.timerId;
      elements.hudAlertDismiss.setAttribute("aria-label", "Dismiss timer notice");
      elements.hudAlertDismiss.title = "Dismiss this notice.";
    }

    window.requestAnimationFrame(() => {
      if (revision !== trayRevision) return;
      elements.alertTray.classList.add("is-visible");
      placeHud(hudPreferredX, hudPreferredY);
    });
  }

  function showPendingCompletionNotice() {
    const pending = latestCompletionNotice();
    if (!pending) {
      concealTray();
      return;
    }
    const timer = preferenceTimer(pending.timerId);
    if (!timer) {
      completionNotices.delete(pending.timerId);
      showPendingCompletionNotice();
      return;
    }
    trayRevision += 1;
    window.clearTimeout(trayHandle);
    renderHudAlert(eventMessage(pending), timer.alertColor, [pending]);
  }

  function showTray(message, durationMs = 5000, color = "red", events = []) {
    trayRevision += 1;
    const revision = trayRevision;
    window.clearTimeout(trayHandle);
    const freshEvents = events.filter((event) => preferenceTimer(event.timerId));
    freshEvents.forEach((event) => {
      if (event.type === "timer-complete") completionNotices.set(event.timerId, event);
    });
    renderHudAlert(message, color, freshEvents);

    const selectedEvent = freshEvents[freshEvents.length - 1];
    if (selectedEvent?.type === "timer-complete") return;

    trayHandle = window.setTimeout(() => {
      if (revision !== trayRevision) return;
      elements.alertTray.classList.remove("is-visible");
      trayHandle = window.setTimeout(() => {
        if (revision !== trayRevision) return;
        trayEvents = [];
        showPendingCompletionNotice();
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
      window.clearTimeout(pageAlertHandles.get(timer.id));
      visualSequence += 1;
      activeVisualOrder.set(timer.id, visualSequence);
      nodes.card.dataset.alerting = "true";
      nodes.shell.dataset.alerting = "true";
      visualAlertHandles.set(
        timer.id,
        window.setTimeout(() => {
          visualAlertHandles.delete(timer.id);
          const currentNodes = cardNodes.get(timer.id);
          if (currentNodes) {
            currentNodes.card.dataset.alerting = "false";
            currentNodes.shell.dataset.alerting = "false";
          }
        }, durationMs)
      );
      pageAlertHandles.set(
        timer.id,
        window.setTimeout(() => {
          pageAlertHandles.delete(timer.id);
          activeVisualOrder.delete(timer.id);
          updatePageTone();
        }, Math.max(4200, durationMs))
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
    window.clearTimeout(pageAlertHandles.get(timerId));
    visualAlertHandles.delete(timerId);
    pageAlertHandles.delete(timerId);
    activeVisualOrder.delete(timerId);
    const nodes = cardNodes.get(timerId);
    if (nodes) {
      nodes.card.dataset.alerting = "false";
      nodes.shell.dataset.alerting = "false";
    }
    if (clearCompletion) {
      completionOrder.delete(timerId);
      completionNotices.delete(timerId);
    }
    if (trayEvents.some((event) => event.timerId === timerId)) {
      trayEvents = trayEvents.filter((event) => event.timerId !== timerId);
      if (trayEvents.length === 0) {
        showPendingCompletionNotice();
      } else {
        const lastEvent = trayEvents[trayEvents.length - 1];
        const trayTimer = preferenceTimer(lastEvent.timerId);
        renderHudAlert(
          combinedEventMessage(trayEvents),
          trayTimer ? trayTimer.alertColor : "red",
          trayEvents
        );
      }
    }
    updatePageTone();
  }

  function clearAllPresentations() {
    audio.stopAll();
    visualAlertHandles.forEach((handle) => window.clearTimeout(handle));
    pageAlertHandles.forEach((handle) => window.clearTimeout(handle));
    visualAlertHandles.clear();
    pageAlertHandles.clear();
    activeVisualOrder.clear();
    cardNodes.forEach((nodes) => {
      nodes.card.dataset.alerting = "false";
      nodes.shell.dataset.alerting = "false";
    });
    completionOrder.clear();
    completionNotices.clear();
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
    if (!timer) return;
    if (preferences.soundEnabled) observeAudioUnlock(audio.unlock());
    clearTimerPresentation(timerId);
    const started = engine.start(timerId, now());
    if (!started) return;
    cardMessages.delete(timerId);
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
    cardMessages.delete(timerId);
    render();
    syncRuntimeServices();
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
    if (trayEvents.some((event) => event.timerId === timerId)) {
      renderHudAlert(combinedEventMessage(trayEvents), saved.alertColor, trayEvents);
    }
    setCardFeedback(timerId, `${saved.label} name saved.`);
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
    if (trayEvents[trayEvents.length - 1]?.timerId === timerId) {
      elements.alertTray.dataset.color = saved.alertColor;
    }
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
    const removedNodes = cardNodes.get(timerId);
    if (removedNodes?.["settings-panel"].open) removedNodes["settings-panel"].close();
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
  elements.hudAlertDismiss.addEventListener("click", () => {
    const event = trayEvents[trayEvents.length - 1];
    if (event?.type === "timer-complete") completionNotices.delete(event.timerId);
    trayEvents = [];
    showPendingCompletionNotice();
  });
  elements.hudAlertReset.addEventListener("click", () => {
    const timerId = elements.hudAlertReset.dataset.timerId;
    if (timerId) resetTimer(timerId);
  });
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
    preferences = ensureTimersAvailable(restoreDefaultPreferences());
    openSettings.clear();
    cardMessages.clear();
    engine.syncTimers([], now());
    engine.syncTimers(timerDefinitions(), now());
    audio.setVolume(preferences.soundEnabled ? preferences.volume : 0);
    cardNodes.forEach((nodes) => {
      if (nodes["settings-panel"].open) nodes["settings-panel"].close();
      nodes.card.remove();
    });
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
  initializeHudDrag();
  updateGlobalControls();
  renderTimerCards();
})();
