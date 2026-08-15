(function startApplication() {
  "use strict";

  const {
    TimerEngine,
    AudioManager,
    loadPreferences,
    savePreferences,
    restoreDefaultPreferences,
    sanitizePreferences,
    MAX_REMINDERS
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
    timer: document.getElementById("timer"),
    timerLabel: document.getElementById("timerLabel"),
    stateText: document.getElementById("stateText"),
    statusMessage: document.getElementById("statusMessage"),
    progressText: document.getElementById("progressText"),
    progressPercent: document.getElementById("progressPercent"),
    progressTrack: document.getElementById("progressTrack"),
    progressFill: document.getElementById("progressFill"),
    reminderStatuses: document.getElementById("reminderStatuses"),
    startButton: document.getElementById("startButton"),
    alertNowButton: document.getElementById("alertNowButton"),
    resetButton: document.getElementById("resetButton"),
    settingsButton: document.getElementById("settingsButton"),
    settingsDialog: document.getElementById("settingsDialog"),
    closeSettingsButton: document.getElementById("closeSettingsButton"),
    doneSettingsButton: document.getElementById("doneSettingsButton"),
    restoreDefaultsButton: document.getElementById("restoreDefaultsButton"),
    settingsHint: document.getElementById("settingsHint"),
    settingsFeedback: document.getElementById("settingsFeedback"),
    mainIntervalMinutesInput: document.getElementById("mainIntervalMinutesInput"),
    mainIntervalSecondsInput: document.getElementById("mainIntervalSecondsInput"),
    totalAlertsInput: document.getElementById("totalAlertsInput"),
    mainAlertDurationInput: document.getElementById("mainAlertDurationInput"),
    mainSoundSelect: document.getElementById("mainSoundSelect"),
    previewMainSoundButton: document.getElementById("previewMainSoundButton"),
    soundEnabledInput: document.getElementById("soundEnabledInput"),
    soundEnabledLabel: document.getElementById("soundEnabledLabel"),
    volumeInput: document.getElementById("volumeInput"),
    volumeValue: document.getElementById("volumeValue"),
    remindersList: document.getElementById("remindersList"),
    remindersEmpty: document.getElementById("remindersEmpty"),
    addReminderButton: document.getElementById("addReminderButton"),
    reminderSettingsTemplate: document.getElementById("reminderSettingsTemplate"),
    alertOverlay: document.getElementById("alertOverlay"),
    alertOverlayLabel: document.getElementById("alertOverlayLabel"),
    secondaryAlertAccent: document.getElementById("secondaryAlertAccent"),
    secondaryAlertAccentLabel: document.getElementById("secondaryAlertAccentLabel"),
    liveAnnouncements: document.getElementById("liveAnnouncements")
  };

  class VisualNotifier {
    constructor(body, overlay, label, reminderAccent, reminderAccentLabel) {
      this.body = body;
      this.overlay = overlay;
      this.label = label;
      this.reminderAccent = reminderAccent;
      this.reminderAccentLabel = reminderAccentLabel;
      this.current = null;
      this.endHandle = null;
      this.cleanupHandle = null;
      this.reminderAccentHandle = null;
      this.generation = 0;
      this.priorities = { secondary: 1, main: 2, completion: 3 };
    }

    show(kind, durationMs, text) {
      const notification = {
        kind,
        durationMs: Math.max(300, Number(durationMs) || 1000),
        text
      };

      if (!this.current) {
        this._activate(notification);
        return;
      }

      const incomingPriority = this.priorities[kind] || 0;
      const currentPriority = this.priorities[this.current.kind] || 0;

      if (incomingPriority < currentPriority) {
        if (kind === "secondary" && this.current.kind === "main") {
          this._showReminderAccent(notification);
        }
        return;
      }

      if (kind === "main" && this.current.kind === "secondary") {
        this._showReminderAccent(this.current);
      }

      this._activate(notification);
    }

    clear() {
      this.generation += 1;
      window.clearTimeout(this.endHandle);
      window.clearTimeout(this.cleanupHandle);
      window.clearTimeout(this.reminderAccentHandle);
      this.endHandle = null;
      this.cleanupHandle = null;
      this.reminderAccentHandle = null;
      this.current = null;
      this.overlay.classList.remove("is-active");
      this.overlay.removeAttribute("data-kind");
      this.label.textContent = "";
      this.reminderAccent.classList.remove("is-active");
      this.reminderAccentLabel.textContent = "Reminder";
      delete this.body.dataset.alertKind;
    }

    _activate(notification) {
      this.generation += 1;
      const generation = this.generation;
      window.clearTimeout(this.endHandle);
      window.clearTimeout(this.cleanupHandle);
      this.current = notification;
      this.overlay.dataset.kind = notification.kind;
      this.body.dataset.alertKind =
        notification.kind === "secondary" ? "reminder" : notification.kind;
      this.label.textContent = notification.text;
      this.overlay.classList.add("is-active");

      this.endHandle = window.setTimeout(() => {
        if (generation !== this.generation) return;

        this.overlay.classList.remove("is-active");
        this.cleanupHandle = window.setTimeout(() => {
          if (generation !== this.generation) return;

          this.current = null;
          this.overlay.removeAttribute("data-kind");
          this.label.textContent = "";
          delete this.body.dataset.alertKind;
        }, 440);
      }, notification.durationMs);
    }

    _showReminderAccent(notification) {
      window.clearTimeout(this.reminderAccentHandle);
      this.reminderAccentLabel.textContent = notification.text;
      this.reminderAccent.classList.add("is-active");
      this.reminderAccentHandle = window.setTimeout(() => {
        this.reminderAccent.classList.remove("is-active");
        this.reminderAccentHandle = null;
      }, notification.durationMs);
    }
  }

  const now = () => performance.now();
  const engine = new TimerEngine({ now });
  const audio = new AudioManager({ onUnavailable: reportAudioUnavailable });
  const visuals = new VisualNotifier(
    elements.body,
    elements.alertOverlay,
    elements.alertOverlayLabel,
    elements.secondaryAlertAccent,
    elements.secondaryAlertAccentLabel
  );

  let preferences = loadPreferences();
  let statusMessage = "Ready when you are.";
  let schedulerHandle = null;
  let schedulerRevision = 0;
  let renderFrame = null;
  let lastFrameRenderAt = 0;
  let announcementFrame = null;
  let announcementRevision = 0;
  let settingsFeedbackFrame = null;
  let handledEventIds = new Set();
  let reminderStatusNodes = new Map();
  let reminderIdCounter = 0;
  let reminderCueHandles = new Map();
  let reminderCueRevisions = new Map();
  let audioCueGeneration = 0;
  let lastMainAudioAt = Number.NEGATIVE_INFINITY;
  let audioWarningShown = false;
  let fallbackDialogActive = false;
  let wakeLock = null;
  let wakeLockRequestRevision = 0;
  const reminderLimit = Number.isFinite(MAX_REMINDERS) ? MAX_REMINDERS : 50;

  function roundedInputNumber(value) {
    return String(Math.round(Number(value) * 10) / 10);
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

  function timerRemindersFromPreferences() {
    return preferences.reminders.map((reminder) => ({
      id: reminder.id,
      enabled: reminder.enabled,
      intervalMs: reminder.intervalSeconds * 1000
    }));
  }

  function timerConfigFromPreferences() {
    return {
      mainIntervalMs: preferences.mainIntervalSeconds * 1000,
      totalAlerts: preferences.totalAlerts,
      reminders: timerRemindersFromPreferences()
    };
  }

  function soundOptions() {
    return {
      enabled: preferences.soundEnabled,
      volume: preferences.volume
    };
  }

  function preferenceReminder(reminderId) {
    return preferences.reminders.find((reminder) => reminder.id === reminderId) || null;
  }

  function applyMainIntervalToForm() {
    const interval = splitInterval(preferences.mainIntervalSeconds);
    restoreInput(elements.mainIntervalMinutesInput, interval.minutes);
    restoreInput(
      elements.mainIntervalSecondsInput,
      roundedInputNumber(interval.seconds)
    );
  }

  function applyPreferencesToForm() {
    applyMainIntervalToForm();
    restoreInput(elements.totalAlertsInput, preferences.totalAlerts);
    elements.mainSoundSelect.value = preferences.mainSound;
    restoreInput(
      elements.mainAlertDurationInput,
      preferences.mainAlertDurationSeconds
    );
    elements.soundEnabledInput.checked = preferences.soundEnabled;
    elements.volumeInput.value = preferences.volume;
    renderReminderSettings();
    updateSettingsControls();
  }

  function persistPreferences(nextPreferences) {
    const previousSoundEnabled = preferences.soundEnabled;
    const previousVolume = preferences.volume;
    preferences = savePreferences(nextPreferences);

    if (previousSoundEnabled && !preferences.soundEnabled) {
      cancelQueuedReminderCues();
      audio.stopAll();
      audioWarningShown = false;
    }

    audio.setVolume(preferences.soundEnabled ? preferences.volume : 0);
    if (
      preferences.soundEnabled &&
      preferences.volume > 0 &&
      (!previousSoundEnabled || previousVolume === 0)
    ) {
      observeAudioUnlock(audio.unlock());
    }

    updateSettingsControls();
    if (engine.getSnapshot(now()).phase === "idle") render();
    return preferences;
  }

  function updateSettingsControls() {
    const phase = engine.getSnapshot(now()).phase;
    const sessionLocked = phase !== "idle";

    document.querySelectorAll("[data-session-locked]").forEach((control) => {
      control.disabled = sessionLocked;
      if (sessionLocked) {
        control.setAttribute("aria-describedby", "settingsHint");
      } else {
        control.removeAttribute("aria-describedby");
      }
    });

    elements.previewMainSoundButton.disabled = !preferences.soundEnabled;
    elements.volumeInput.disabled = !preferences.soundEnabled;
    elements.restoreDefaultsButton.disabled = sessionLocked;
    elements.addReminderButton.disabled = preferences.reminders.length >= reminderLimit;
    elements.addReminderButton.title = elements.addReminderButton.disabled
      ? `The ${reminderLimit}-reminder limit has been reached.`
      : "Add another independent reminder";
    elements.soundEnabledLabel.textContent = preferences.soundEnabled ? "On" : "Off";
    elements.volumeValue.value = `${preferences.volume}%`;
    elements.volumeValue.textContent = `${preferences.volume}%`;

    elements.remindersList.querySelectorAll("[data-role='card']").forEach((card) => {
      const reminder = preferenceReminder(card.dataset.reminderId);
      if (!reminder) return;

      const enabledLabel = card.querySelector("[data-role='enabled-label']");
      const testButton = card.querySelector("[data-role='test']");
      if (enabledLabel) enabledLabel.textContent = reminder.enabled ? "On" : "Off";
      if (testButton) testButton.disabled = !preferences.soundEnabled;
    });

    elements.settingsHint.textContent = audioWarningShown
      ? "Sound could not start in this browser. Visual alerts will still work."
      : sessionLocked
        ? "Main timing is locked. Reminders stay editable; a timing change restarts only that reminder from now."
        : "Changes save automatically. Main timing locks during a session; reminders stay editable.";
  }

  function observeAudioUnlock(unlockPromise) {
    Promise.resolve(unlockPromise).then((available) => {
      if (available) {
        if (audioWarningShown) {
          audioWarningShown = false;
          if (isSettingsOpen()) setSettingsFeedback("Sound is ready.");
          updateSettingsControls();
        }
        return;
      }

      reportAudioUnavailable();
    });
  }

  function observeAlertPlayback(playPromise, sessionId, cueGeneration) {
    Promise.resolve(playPromise).then((played) => {
      if (played || cueGeneration !== audioCueGeneration) return;

      const snapshot = engine.getSnapshot(now());
      const sameSession = snapshot.sessionId === sessionId;
      const activePhase = snapshot.phase === "running" || snapshot.phase === "complete";
      if (
        sameSession &&
        activePhase &&
        preferences.soundEnabled &&
        preferences.volume > 0
      ) {
        reportAudioUnavailable();
      }
    });
  }

  function reportAudioUnavailable() {
    if (!preferences.soundEnabled || preferences.volume === 0 || audioWarningShown) return;

    audioWarningShown = true;
    statusMessage = "Sound is unavailable. Visual alerts will still work.";
    if (isSettingsOpen()) {
      setSettingsFeedback("Sound could not start. Visual alerts will still work.");
    }
    announce("Sound is unavailable in this browser. Visual alerts will still work.");
    render();
  }

  async function previewSound(playSound, successMessage) {
    if (preferences.volume === 0) {
      setSettingsFeedback("Volume is 0%. Raise it to hear a preview.");
      return;
    }

    const available = await audio.unlock();
    if (!available) {
      reportAudioUnavailable();
      return;
    }

    const played = await playSound();
    if (played) setSettingsFeedback(successMessage);
  }

  function createReminderStatusNode(reminderId) {
    const item = document.createElement("li");
    const dot = document.createElement("span");
    const name = document.createElement("span");
    const separator = document.createElement("span");
    const time = document.createElement("span");

    item.className = "reminder-status";
    item.dataset.reminderId = reminderId;
    dot.className = "reminder-status__dot";
    dot.setAttribute("aria-hidden", "true");
    name.className = "reminder-status__name";
    separator.className = "reminder-status__separator";
    separator.setAttribute("aria-hidden", "true");
    separator.textContent = "·";
    time.className = "reminder-status__time";
    item.append(dot, name, separator, time);
    return { item, name, time };
  }

  function renderReminderStatuses(snapshot) {
    const activeReminders =
      snapshot.phase === "running"
        ? snapshot.reminders.filter(
            (runtime) => runtime.enabled && runtime.remainingMs !== null
          )
        : [];
    const activeIds = new Set(activeReminders.map((runtime) => runtime.id));

    reminderStatusNodes.forEach((nodes, reminderId) => {
      if (activeIds.has(reminderId)) return;
      nodes.item.remove();
      reminderStatusNodes.delete(reminderId);
    });

    activeReminders.forEach((runtime) => {
      const reminder = preferenceReminder(runtime.id);
      if (!reminder) return;

      let nodes = reminderStatusNodes.get(runtime.id);
      if (!nodes) {
        nodes = createReminderStatusNode(runtime.id);
        reminderStatusNodes.set(runtime.id, nodes);
      }

      nodes.name.textContent = reminder.label;
      nodes.time.textContent = formatTime(runtime.remainingMs);
      nodes.item.setAttribute(
        "aria-label",
        `${reminder.label}, ${accessibleTime(runtime.remainingMs)}`
      );
      elements.reminderStatuses.append(nodes.item);
    });

    elements.reminderStatuses.hidden = activeReminders.length === 0;
  }

  function render() {
    const snapshot = engine.getSnapshot(now());
    let completed = 0;
    let total = preferences.totalAlerts;
    let displayTime = preferences.mainIntervalSeconds * 1000;
    let state = "ready";
    let stateText = "Ready";
    let timerLabel = "Next alert in";

    if (snapshot.phase === "running") {
      completed = snapshot.completedMain;
      total = snapshot.totalAlerts;
      displayTime = snapshot.mainRemainingMs;
      state = "running";
      stateText = "Running";
    } else if (snapshot.phase === "complete") {
      completed = snapshot.completedMain;
      total = snapshot.totalAlerts;
      state = "complete";
      stateText = "Complete";
      timerLabel = "Session complete";
    }

    const percent = total > 0 ? Math.min(100, (completed / total) * 100) : 0;
    elements.body.dataset.state = state;
    elements.stateText.textContent = stateText;
    elements.timerLabel.textContent = timerLabel;
    elements.timer.textContent = snapshot.phase === "complete" ? "DONE" : formatTime(displayTime);
    elements.timer.setAttribute(
      "aria-label",
      snapshot.phase === "complete" ? "Session complete" : accessibleTime(displayTime)
    );
    elements.progressText.textContent = `${completed} of ${total} alerts`;
    elements.progressPercent.textContent = `${Math.round(percent)}%`;
    elements.progressFill.style.width = `${percent}%`;
    elements.progressTrack.setAttribute("aria-valuemax", String(total));
    elements.progressTrack.setAttribute("aria-valuenow", String(completed));
    elements.progressTrack.setAttribute("aria-valuetext", `${completed} of ${total} alerts`);
    if (elements.statusMessage.textContent !== statusMessage) {
      elements.statusMessage.textContent = statusMessage;
    }
    elements.startButton.disabled = snapshot.phase !== "idle";
    elements.alertNowButton.disabled = snapshot.phase !== "running";
    renderReminderStatuses(snapshot);
    updateSettingsControls();
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

  function setSettingsFeedback(message) {
    if (settingsFeedbackFrame !== null) {
      window.cancelAnimationFrame(settingsFeedbackFrame);
      settingsFeedbackFrame = null;
    }

    elements.settingsFeedback.textContent = "";
    settingsFeedbackFrame = window.requestAnimationFrame(() => {
      elements.settingsFeedback.textContent = message;
      settingsFeedbackFrame = null;
    });
  }

  function cancelQueuedReminderCues(stopActiveAudio = false) {
    audioCueGeneration += 1;
    reminderCueHandles.forEach((handle) => window.clearTimeout(handle));
    reminderCueHandles.clear();
    reminderCueRevisions.clear();
    if (stopActiveAudio) audio.stopAll();
  }

  function cancelReminderCue(reminderId) {
    const handle = reminderCueHandles.get(reminderId);
    if (handle !== undefined) window.clearTimeout(handle);
    reminderCueHandles.delete(reminderId);
    reminderCueRevisions.set(
      reminderId,
      (reminderCueRevisions.get(reminderId) || 0) + 1
    );
  }

  function queueReminderSounds(reminderEvents, baseDelayMs) {
    if (!preferences.soundEnabled || preferences.volume === 0) return;
    const cueGeneration = audioCueGeneration;

    reminderEvents.forEach((event, index) => {
      const reminder = preferenceReminder(event.reminderId);
      if (!reminder) return;

      cancelReminderCue(event.reminderId);
      const cueRevision = reminderCueRevisions.get(event.reminderId);
      const sessionId = event.sessionId;
      const delayMs = Math.max(0, baseDelayMs + index * 450);
      const handle = window.setTimeout(() => {
        reminderCueHandles.delete(event.reminderId);
        if (
          cueGeneration !== audioCueGeneration ||
          cueRevision !== reminderCueRevisions.get(event.reminderId)
        ) {
          return;
        }

        const snapshot = engine.getSnapshot(now());
        const currentReminder = preferenceReminder(event.reminderId);
        if (
          snapshot.phase !== "running" ||
          snapshot.sessionId !== sessionId ||
          !currentReminder ||
          !currentReminder.enabled
        ) {
          return;
        }

        observeAlertPlayback(
          audio.playSecondary(currentReminder.sound, soundOptions()),
          sessionId,
          cueGeneration
        );
      }, delayMs);
      reminderCueHandles.set(event.reminderId, handle);
    });
  }

  function reminderAlertText(reminders) {
    const labels = reminders.map((reminder) => reminder.label);
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
    if (labels.length > 3) {
      return `${labels[0]}, ${labels[1]}, and ${labels.length - 2} more reminders`;
    }
    return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
  }

  function presentEvents(events) {
    const freshEvents = events.filter((event) => {
      if (handledEventIds.has(event.id)) return false;
      handledEventIds.add(event.id);
      return true;
    });
    if (freshEvents.length === 0) return;

    const completion = freshEvents.find((event) => event.type === "completion");
    if (completion) {
      stopScheduler();
      cancelQueuedReminderCues();
      audio.stopAll();
      audioCueGeneration += 1;
      const cueGeneration = audioCueGeneration;
      visuals.clear();
      visuals.show("completion", 2600, "Session complete");
      observeAlertPlayback(
        audio.playCompletion(soundOptions()),
        completion.sessionId,
        cueGeneration
      );
      statusMessage = "Session complete. Reset when you are ready.";
      announce(`Session complete. ${completion.totalAlerts} alerts finished.`);
      releaseWakeLock();
      return;
    }

    const statusParts = [];
    const announcementParts = [];
    const mainEvent = freshEvents.find((event) => event.type === "main-alert");
    const reminderEvents = freshEvents.filter((event) => event.type === "reminder-alert");

    if (mainEvent) {
      const durationMs = preferences.mainAlertDurationSeconds * 1000;
      cancelQueuedReminderCues();
      audio.stopAll();
      audioCueGeneration += 1;
      const cueGeneration = audioCueGeneration;
      lastMainAudioAt = now();
      visuals.show("main", durationMs, "Interval alert");
      observeAlertPlayback(
        audio.playMain(preferences.mainSound, soundOptions()),
        mainEvent.sessionId,
        cueGeneration
      );
      statusParts.push(`Alert ${mainEvent.completedMain} of ${mainEvent.totalAlerts}.`);
      announcementParts.push(`Alert ${mainEvent.completedMain} of ${mainEvent.totalAlerts}.`);
    }

    if (reminderEvents.length > 0) {
      const dueReminders = reminderEvents
        .map((event) => preferenceReminder(event.reminderId))
        .filter(Boolean);

      if (dueReminders.length > 0) {
        const labelText = reminderAlertText(dueReminders);
        visuals.show("secondary", 1400, labelText);
        const separationDelayMs = Math.max(0, 700 - (now() - lastMainAudioAt));
        queueReminderSounds(reminderEvents, separationDelayMs);
        statusParts.push(`${labelText}.`);
        announcementParts.push(`${labelText} now.`);
      }
    }

    if (statusParts.length > 0) {
      statusMessage = statusParts.join(" ");
      announce(announcementParts.join(" "));
    }
  }

  function reconcileAndPresent(at = now()) {
    const events = engine.reconcile(at);
    presentEvents(events);
    render();
    return events;
  }

  function scheduleWake() {
    schedulerRevision += 1;
    const revision = schedulerRevision;
    window.clearTimeout(schedulerHandle);
    schedulerHandle = null;

    const snapshot = engine.getSnapshot(now());
    const deadline = engine.getNextDeadline();
    if (snapshot.phase !== "running" || deadline === null) return;

    const delay = Math.min(2147483000, Math.max(0, deadline - now()));
    schedulerHandle = window.setTimeout(() => {
      if (revision !== schedulerRevision) return;
      schedulerHandle = null;
      reconcileAndPresent();
      scheduleWake();
    }, delay + 8);
  }

  function stopScheduler() {
    schedulerRevision += 1;
    window.clearTimeout(schedulerHandle);
    schedulerHandle = null;
    if (renderFrame !== null) {
      window.cancelAnimationFrame(renderFrame);
      renderFrame = null;
    }
  }

  function startRenderLoop() {
    if (renderFrame !== null) return;

    const frame = (frameTime) => {
      if (engine.getSnapshot(now()).phase !== "running") {
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

  async function requestWakeLock(sessionId) {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    if (wakeLock && !wakeLock.released) return;

    const requestRevision = ++wakeLockRequestRevision;

    try {
      const sentinel = await navigator.wakeLock.request("screen");
      const snapshot = engine.getSnapshot(now());

      if (
        requestRevision !== wakeLockRequestRevision ||
        snapshot.phase !== "running" ||
        snapshot.sessionId !== sessionId
      ) {
        await sentinel.release();
        return;
      }

      wakeLock = sentinel;
      sentinel.addEventListener(
        "release",
        () => {
          if (wakeLock === sentinel) wakeLock = null;
        },
        { once: true }
      );
    } catch (error) {
      console.warn("Screen wake lock is unavailable:", error);
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

  function startTimer() {
    if (engine.getSnapshot(now()).phase !== "idle") return;

    observeAudioUnlock(audio.unlock());
    handledEventIds = new Set();
    cancelQueuedReminderCues();
    lastMainAudioAt = Number.NEGATIVE_INFINITY;
    const snapshot = engine.start(timerConfigFromPreferences(), now());
    statusMessage = "Session running.";
    render();
    scheduleWake();
    startRenderLoop();
    requestWakeLock(snapshot.sessionId);
  }

  function alertNow() {
    if (engine.getSnapshot(now()).phase !== "running") return;

    presentEvents(engine.alertNow(now()));
    render();
    scheduleWake();
    startRenderLoop();
  }

  function resetTimer() {
    stopScheduler();
    engine.reset();
    handledEventIds = new Set();
    cancelQueuedReminderCues();
    lastMainAudioAt = Number.NEGATIVE_INFINITY;
    audio.stopAll();
    visuals.clear();
    releaseWakeLock();
    announcementRevision += 1;
    if (announcementFrame !== null) {
      window.cancelAnimationFrame(announcementFrame);
      announcementFrame = null;
    }
    elements.liveAnnouncements.textContent = "";
    statusMessage = "Ready when you are.";
    render();
  }

  function openSettings() {
    if (settingsFeedbackFrame !== null) {
      window.cancelAnimationFrame(settingsFeedbackFrame);
      settingsFeedbackFrame = null;
    }
    elements.settingsFeedback.textContent = audioWarningShown
      ? "Sound could not start. Visual alerts will still work."
      : "";
    if (typeof elements.settingsDialog.showModal === "function") {
      elements.settingsDialog.showModal();
    } else {
      fallbackDialogActive = true;
      elements.body.classList.add("settings-fallback-open");
      elements.settingsDialog.setAttribute("open", "");
      elements.appShell.setAttribute("inert", "");
      elements.appShell.setAttribute("aria-hidden", "true");
      document.addEventListener("keydown", handleFallbackDialogKeydown);
      elements.closeSettingsButton.focus();
    }
  }

  function closeSettings() {
    if (!fallbackDialogActive && typeof elements.settingsDialog.close === "function") {
      elements.settingsDialog.close();
    } else {
      fallbackDialogActive = false;
      elements.settingsDialog.removeAttribute("open");
      elements.body.classList.remove("settings-fallback-open");
      elements.appShell.removeAttribute("inert");
      elements.appShell.removeAttribute("aria-hidden");
      document.removeEventListener("keydown", handleFallbackDialogKeydown);
      elements.settingsButton.focus();
    }
  }

  function isSettingsOpen() {
    return Boolean(elements.settingsDialog.open || elements.settingsDialog.hasAttribute("open"));
  }

  function handleFallbackDialogKeydown(event) {
    if (!fallbackDialogActive || event.defaultPrevented) return;

    if (event.key === "Escape") {
      event.preventDefault();
      closeSettings();
      return;
    }

    if (event.key !== "Tab") return;
    const focusable = Array.from(
      elements.settingsDialog.querySelectorAll(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])"
      )
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
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

  function enhanceNumberInput(input, commit, restore, options = {}) {
    if (!input || input.dataset.numberEnhanced === "true") return;

    input.dataset.numberEnhanced = "true";
    const minimum = Number(options.min);
    const maximum = Number(options.max);
    const step = Number(options.step);
    const hasSpinbuttonBehavior =
      Number.isFinite(minimum) &&
      Number.isFinite(maximum) &&
      Number.isFinite(step) &&
      step > 0;

    if (hasSpinbuttonBehavior) {
      input.setAttribute("role", "spinbutton");
      input.setAttribute("aria-valuemin", String(minimum));
      input.setAttribute("aria-valuemax", String(maximum));
      updateNumericAria(input);
    }

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

    input.addEventListener("change", commit);
    input.addEventListener("input", () => updateNumericAria(input));
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
      } else if (
        hasSpinbuttonBehavior &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")
      ) {
        event.preventDefault();
        const current = Number(input.value);
        const lastGood = Number(input.dataset.lastGoodValue);
        const base = Number.isFinite(current)
          ? current
          : Number.isFinite(lastGood)
            ? lastGood
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

  function validDurationParts(minutesInput, secondsInput) {
    const minutesText = minutesInput.value.trim();
    const secondsText = secondsInput.value.trim();
    if (minutesText === "" || secondsText === "") return null;
    if (!/^\d+$/.test(minutesText) || !/^\d+(?:\.\d+)?$/.test(secondsText)) {
      return null;
    }

    const minutes = Number(minutesText);
    const seconds = Number(secondsText);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
    if (minutes < 0 || seconds < 0) return null;

    const totalSeconds = minutes * 60 + seconds;
    return totalSeconds >= 0.1 && totalSeconds <= 86400 ? totalSeconds : null;
  }

  function commitMainInterval() {
    const totalSeconds = validDurationParts(
      elements.mainIntervalMinutesInput,
      elements.mainIntervalSecondsInput
    );
    if (totalSeconds === null || engine.getSnapshot(now()).phase !== "idle") {
      applyMainIntervalToForm();
      return;
    }

    persistPreferences({ ...preferences, mainIntervalSeconds: totalSeconds });
    applyMainIntervalToForm();
  }

  function commitTotalAlerts() {
    const value = elements.totalAlertsInput.value.trim();
    const number = Number(value);
    if (
      !/^\d+$/.test(value) ||
      !Number.isFinite(number) ||
      engine.getSnapshot(now()).phase !== "idle"
    ) {
      restoreInput(elements.totalAlertsInput, preferences.totalAlerts);
      return;
    }

    persistPreferences({ ...preferences, totalAlerts: number });
    restoreInput(elements.totalAlertsInput, preferences.totalAlerts);
  }

  function commitMainAlertDuration() {
    const value = elements.mainAlertDurationInput.value.trim();
    const number = Number(value);
    if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(number)) {
      restoreInput(elements.mainAlertDurationInput, preferences.mainAlertDurationSeconds);
      return;
    }

    persistPreferences({ ...preferences, mainAlertDurationSeconds: number });
    restoreInput(elements.mainAlertDurationInput, preferences.mainAlertDurationSeconds);
  }

  function syncLiveReminders(at) {
    if (engine.getSnapshot(at).phase !== "running") return;
    engine.syncReminders(timerRemindersFromPreferences(), at);
    presentEvents(engine.reconcile(at));
    scheduleWake();
    startRenderLoop();
    render();
  }

  function commitReminderInterval(reminderId, card) {
    const reminder = preferenceReminder(reminderId);
    if (!reminder) return;

    const minutesInput = card.querySelector("[data-role='minutes']");
    const secondsInput = card.querySelector("[data-role='seconds']");
    const totalSeconds = validDurationParts(minutesInput, secondsInput);
    if (totalSeconds === null) {
      applyReminderIntervalToRow(card, reminder.intervalSeconds);
      return;
    }

    const sanitized = sanitizePreferences({
      ...preferences,
      reminders: preferences.reminders.map((entry) =>
        entry.id === reminderId ? { ...entry, intervalSeconds: totalSeconds } : entry
      )
    });
    const nextReminder = sanitized.reminders.find((entry) => entry.id === reminderId);
    if (!nextReminder || nextReminder.intervalSeconds === reminder.intervalSeconds) {
      applyReminderIntervalToRow(card, reminder.intervalSeconds);
      return;
    }

    const at = now();
    cancelReminderCue(reminderId);
    persistPreferences(sanitized);
    applyReminderIntervalToRow(card, nextReminder.intervalSeconds);
    syncLiveReminders(at);
    const timingPhase = engine.getSnapshot(at).phase;
    setSettingsFeedback(
      timingPhase === "running" && nextReminder.enabled
        ? `${nextReminder.label} restarts from now.`
        : timingPhase === "running"
          ? `${nextReminder.label} interval updated.`
          : `${nextReminder.label} interval saved for the next session.`
    );
  }

  function applyReminderIntervalToRow(card, intervalSeconds) {
    const interval = splitInterval(intervalSeconds);
    restoreInput(card.querySelector("[data-role='minutes']"), interval.minutes);
    restoreInput(
      card.querySelector("[data-role='seconds']"),
      roundedInputNumber(interval.seconds)
    );
  }

  function configureReminderRow(card, reminder) {
    card.dataset.reminderId = reminder.id;
    const title = card.querySelector("[data-role='title']");
    const labelInput = card.querySelector("[data-role='label']");
    const enabledInput = card.querySelector("[data-role='enabled']");
    const enabledLabel = card.querySelector("[data-role='enabled-label']");
    const minutesInput = card.querySelector("[data-role='minutes']");
    const secondsInput = card.querySelector("[data-role='seconds']");
    const soundSelect = card.querySelector("[data-role='sound']");
    const testButton = card.querySelector("[data-role='test']");
    const removeButton = card.querySelector("[data-role='remove']");
    const suffix = reminder.id.replace(/[^A-Za-z0-9_-]/g, "-");

    title.textContent = `${reminder.label} settings`;
    labelInput.value = reminder.label;
    labelInput.id = `reminder-label-${suffix}`;
    enabledInput.checked = reminder.enabled;
    enabledInput.setAttribute("aria-label", `${reminder.label} enabled`);
    enabledLabel.textContent = reminder.enabled ? "On" : "Off";
    minutesInput.setAttribute("aria-label", `${reminder.label} interval minutes`);
    secondsInput.setAttribute("aria-label", `${reminder.label} interval seconds`);
    soundSelect.value = reminder.sound;
    soundSelect.setAttribute("aria-label", `${reminder.label} sound`);
    testButton.setAttribute("aria-label", `Test ${reminder.label} sound`);
    removeButton.setAttribute("aria-label", `Remove ${reminder.label}`);
    applyReminderIntervalToRow(card, reminder.intervalSeconds);

    enhanceNumberInput(
      minutesInput,
      () => commitReminderInterval(reminder.id, card),
      () => {
        const current = preferenceReminder(reminder.id);
        if (current) applyReminderIntervalToRow(card, current.intervalSeconds);
      },
      { min: 0, max: 1440, step: 1 }
    );
    enhanceNumberInput(
      secondsInput,
      () => commitReminderInterval(reminder.id, card),
      () => {
        const current = preferenceReminder(reminder.id);
        if (current) applyReminderIntervalToRow(card, current.intervalSeconds);
      },
      { min: 0, max: 59.9, step: 0.1 }
    );

    labelInput.addEventListener("change", () => {
      const current = preferenceReminder(reminder.id);
      if (!current) return;
      const label = labelInput.value.trim();
      if (!label) {
        labelInput.value = current.label;
        return;
      }

      persistPreferences({
        ...preferences,
        reminders: preferences.reminders.map((entry) =>
          entry.id === reminder.id ? { ...entry, label } : entry
        )
      });
      const saved = preferenceReminder(reminder.id);
      labelInput.value = saved.label;
      title.textContent = `${saved.label} settings`;
      enabledInput.setAttribute("aria-label", `${saved.label} enabled`);
      minutesInput.setAttribute("aria-label", `${saved.label} interval minutes`);
      secondsInput.setAttribute("aria-label", `${saved.label} interval seconds`);
      soundSelect.setAttribute("aria-label", `${saved.label} sound`);
      testButton.setAttribute("aria-label", `Test ${saved.label} sound`);
      removeButton.setAttribute("aria-label", `Remove ${saved.label}`);
      render();
    });

    enabledInput.addEventListener("change", () => {
      const at = now();
      cancelReminderCue(reminder.id);
      persistPreferences({
        ...preferences,
        reminders: preferences.reminders.map((entry) =>
          entry.id === reminder.id ? { ...entry, enabled: enabledInput.checked } : entry
        )
      });
      const saved = preferenceReminder(reminder.id);
      enabledInput.checked = saved.enabled;
      enabledLabel.textContent = saved.enabled ? "On" : "Off";
      syncLiveReminders(at);
      const isRunning = engine.getSnapshot(at).phase === "running";
      setSettingsFeedback(
        isRunning && saved.enabled
          ? `${saved.label} starts a full interval from now.`
          : isRunning
            ? `${saved.label} stopped.`
            : `${saved.label} saved for the next session.`
      );
    });

    soundSelect.addEventListener("change", () => {
      persistPreferences({
        ...preferences,
        reminders: preferences.reminders.map((entry) =>
          entry.id === reminder.id ? { ...entry, sound: soundSelect.value } : entry
        )
      });
      soundSelect.value = preferenceReminder(reminder.id).sound;
    });

    testButton.addEventListener("click", () => {
      const current = preferenceReminder(reminder.id);
      if (!current) return;
      previewSound(
        () => audio.playSecondary(current.sound, soundOptions()),
        `${current.label} sound preview played.`
      );
    });

    removeButton.addEventListener("click", () => removeReminder(reminder.id));
  }

  function renderReminderSettings(focusReminderId = null) {
    elements.remindersList.replaceChildren();

    preferences.reminders.forEach((reminder) => {
      const fragment = elements.reminderSettingsTemplate.content.cloneNode(true);
      const card = fragment.querySelector("[data-role='card']");
      configureReminderRow(card, reminder);
      elements.remindersList.append(fragment);
    });

    elements.remindersEmpty.hidden = preferences.reminders.length > 0;
    updateSettingsControls();

    if (focusReminderId) {
      const card = Array.from(
        elements.remindersList.querySelectorAll("[data-role='card']")
      ).find((item) => item.dataset.reminderId === focusReminderId);
      if (card) card.querySelector("[data-role='label']").focus();
    }
  }

  function nextReminderId() {
    const existing = new Set(preferences.reminders.map((reminder) => reminder.id));
    let id;
    do {
      reminderIdCounter += 1;
      id = `reminder-${Date.now().toString(36)}-${reminderIdCounter.toString(36)}`;
    } while (existing.has(id));
    return id;
  }

  function nextReminderLabel() {
    const labels = new Set(preferences.reminders.map((reminder) => reminder.label));
    let number = preferences.reminders.length + 1;
    let label = `Reminder ${number}`;
    while (labels.has(label)) {
      number += 1;
      label = `Reminder ${number}`;
    }
    return label;
  }

  function addReminder() {
    if (preferences.reminders.length >= reminderLimit) {
      setSettingsFeedback(`You can configure up to ${reminderLimit} reminders.`);
      return;
    }

    const reminder = {
      id: nextReminderId(),
      label: nextReminderLabel(),
      enabled: true,
      intervalSeconds: 90,
      sound: "double-tap"
    };
    const at = now();
    persistPreferences({
      ...preferences,
      reminders: [...preferences.reminders, reminder]
    });
    const saved = preferences.reminders[preferences.reminders.length - 1];
    renderReminderSettings(saved.id);
    syncLiveReminders(at);
    const isRunning = engine.getSnapshot(at).phase === "running";
    setSettingsFeedback(
      isRunning
        ? `${saved.label} added and counting from now.`
        : `${saved.label} added.`
    );
  }

  function removeReminder(reminderId) {
    const reminder = preferenceReminder(reminderId);
    if (!reminder) return;

    const oldIndex = preferences.reminders.findIndex((entry) => entry.id === reminderId);
    const at = now();
    cancelReminderCue(reminderId);
    persistPreferences({
      ...preferences,
      reminders: preferences.reminders.filter((entry) => entry.id !== reminderId)
    });
    renderReminderSettings();
    syncLiveReminders(at);
    setSettingsFeedback(`${reminder.label} removed.`);

    const remainingCards = elements.remindersList.querySelectorAll("[data-role='card']");
    const focusCard = remainingCards[Math.min(oldIndex, remainingCards.length - 1)];
    if (focusCard) {
      focusCard.querySelector("[data-role='label']").focus();
    } else {
      elements.addReminderButton.focus();
    }
  }

  elements.startButton.addEventListener("click", startTimer);
  elements.alertNowButton.addEventListener("click", alertNow);
  elements.resetButton.addEventListener("click", resetTimer);
  elements.settingsButton.addEventListener("click", openSettings);
  elements.closeSettingsButton.addEventListener("click", closeSettings);
  elements.doneSettingsButton.addEventListener("click", closeSettings);
  elements.addReminderButton.addEventListener("click", addReminder);

  // Deliberately no backdrop-click handler: dragging a numeric selection outside the
  // dialog must never dismiss settings. Done, ×, and Escape remain available.

  enhanceNumberInput(
    elements.mainIntervalMinutesInput,
    commitMainInterval,
    applyMainIntervalToForm,
    { min: 0, max: 1440, step: 1 }
  );
  enhanceNumberInput(
    elements.mainIntervalSecondsInput,
    commitMainInterval,
    applyMainIntervalToForm,
    { min: 0, max: 59.9, step: 0.1 }
  );
  enhanceNumberInput(
    elements.totalAlertsInput,
    commitTotalAlerts,
    () => restoreInput(elements.totalAlertsInput, preferences.totalAlerts),
    { min: 1, max: 9999, step: 1 }
  );
  enhanceNumberInput(
    elements.mainAlertDurationInput,
    commitMainAlertDuration,
    () =>
      restoreInput(
        elements.mainAlertDurationInput,
        preferences.mainAlertDurationSeconds
      ),
    { min: 0.5, max: 15, step: 0.1 }
  );

  elements.mainSoundSelect.addEventListener("change", () => {
    persistPreferences({ ...preferences, mainSound: elements.mainSoundSelect.value });
    elements.mainSoundSelect.value = preferences.mainSound;
  });

  elements.soundEnabledInput.addEventListener("change", () => {
    persistPreferences({ ...preferences, soundEnabled: elements.soundEnabledInput.checked });
    elements.soundEnabledInput.checked = preferences.soundEnabled;
  });

  elements.volumeInput.addEventListener("input", () => {
    persistPreferences({ ...preferences, volume: elements.volumeInput.value });
    elements.volumeInput.value = preferences.volume;
  });

  elements.restoreDefaultsButton.addEventListener("click", () => {
    if (engine.getSnapshot(now()).phase !== "idle") return;
    cancelQueuedReminderCues();
    audio.stopAll();
    preferences = restoreDefaultPreferences();
    audio.setVolume(preferences.volume);
    observeAudioUnlock(audio.unlock());
    applyPreferencesToForm();
    statusMessage = "Default settings restored.";
    setSettingsFeedback(statusMessage);
    render();
  });

  elements.previewMainSoundButton.addEventListener("click", () => {
    previewSound(
      () => audio.playMain(preferences.mainSound, soundOptions()),
      "Main sound preview played."
    );
  });

  document.addEventListener("keydown", (event) => {
    const typing =
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement ||
      event.target instanceof HTMLTextAreaElement;

    if (
      !typing &&
      !event.repeat &&
      !isSettingsOpen() &&
      engine.getSnapshot(now()).phase === "running" &&
      event.key.toLowerCase() === "f"
    ) {
      event.preventDefault();
      alertNow();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;

    const snapshot = engine.getSnapshot(now());
    if (snapshot.phase !== "running") return;

    reconcileAndPresent();
    scheduleWake();
    startRenderLoop();
    requestWakeLock(snapshot.sessionId);
  });

  window.addEventListener("focus", () => {
    if (engine.getSnapshot(now()).phase !== "running") return;
    reconcileAndPresent();
    scheduleWake();
  });

  window.addEventListener("pagehide", releaseWakeLock);
  window.addEventListener("beforeunload", releaseWakeLock);

  applyPreferencesToForm();
  render();
})();
