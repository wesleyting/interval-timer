(function startApplication() {
  "use strict";

  const {
    TimerEngine,
    AudioManager,
    loadPreferences,
    savePreferences,
    restoreDefaultPreferences,
    sanitizePreferences
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
    secondaryStatus: document.getElementById("secondaryStatus"),
    secondaryTime: document.getElementById("secondaryTime"),
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
    mainIntervalInput: document.getElementById("mainIntervalInput"),
    totalAlertsInput: document.getElementById("totalAlertsInput"),
    mainAlertDurationInput: document.getElementById("mainAlertDurationInput"),
    mainSoundSelect: document.getElementById("mainSoundSelect"),
    previewMainSoundButton: document.getElementById("previewMainSoundButton"),
    soundEnabledInput: document.getElementById("soundEnabledInput"),
    soundEnabledLabel: document.getElementById("soundEnabledLabel"),
    volumeInput: document.getElementById("volumeInput"),
    volumeValue: document.getElementById("volumeValue"),
    secondaryEnabledInput: document.getElementById("secondaryEnabledInput"),
    secondaryEnabledLabel: document.getElementById("secondaryEnabledLabel"),
    secondaryIntervalInput: document.getElementById("secondaryIntervalInput"),
    secondarySoundSelect: document.getElementById("secondarySoundSelect"),
    previewSecondarySoundButton: document.getElementById("previewSecondarySoundButton"),
    alertOverlay: document.getElementById("alertOverlay"),
    alertOverlayLabel: document.getElementById("alertOverlayLabel"),
    secondaryAlertAccent: document.getElementById("secondaryAlertAccent"),
    secondaryAlertAccentLabel: document.getElementById("secondaryAlertAccentLabel"),
    liveAnnouncements: document.getElementById("liveAnnouncements")
  };

  class VisualNotifier {
    constructor(overlay, label, secondaryAccent, secondaryAccentLabel) {
      this.overlay = overlay;
      this.label = label;
      this.secondaryAccent = secondaryAccent;
      this.secondaryAccentLabel = secondaryAccentLabel;
      this.current = null;
      this.endHandle = null;
      this.cleanupHandle = null;
      this.secondaryAccentHandle = null;
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
        // When both reminders are due close together, keep red dominant while an
        // independent amber frame makes the secondary cue visible immediately.
        if (kind === "secondary" && this.current.kind === "main") {
          this._showSecondaryAccent(notification);
        }
        return;
      }

      if (kind === "main" && this.current.kind === "secondary") {
        this._showSecondaryAccent(this.current);
      }

      // A main alert interrupts amber, and completion interrupts every other visual.
      // Repeated alerts at the same priority restart the full visible duration.
      this._activate(notification);
    }

    clear() {
      this.generation += 1;
      window.clearTimeout(this.endHandle);
      window.clearTimeout(this.cleanupHandle);
      window.clearTimeout(this.secondaryAccentHandle);
      this.endHandle = null;
      this.cleanupHandle = null;
      this.secondaryAccentHandle = null;
      this.current = null;
      this.overlay.classList.remove("is-active");
      this.overlay.removeAttribute("data-kind");
      this.label.textContent = "";
      this.secondaryAccent.classList.remove("is-active");
      this.secondaryAccentLabel.textContent = "Item reminder";
    }

    _activate(notification) {
      this.generation += 1;
      const generation = this.generation;
      window.clearTimeout(this.endHandle);
      window.clearTimeout(this.cleanupHandle);
      this.current = notification;
      this.overlay.dataset.kind = notification.kind;
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
        }, 440);
      }, notification.durationMs);
    }

    _showSecondaryAccent(notification) {
      window.clearTimeout(this.secondaryAccentHandle);
      this.secondaryAccentLabel.textContent = notification.text;
      this.secondaryAccent.classList.add("is-active");
      this.secondaryAccentHandle = window.setTimeout(() => {
        this.secondaryAccent.classList.remove("is-active");
        this.secondaryAccentHandle = null;
      }, notification.durationMs);
    }
  }

  const now = () => performance.now();
  const engine = new TimerEngine({ now });
  const audio = new AudioManager({ onUnavailable: reportAudioUnavailable });
  const visuals = new VisualNotifier(
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
  let handledEventIds = new Set();
  let lastMainAudioAt = Number.NEGATIVE_INFINITY;
  let audioWarningShown = false;
  let fallbackDialogActive = false;
  let wakeLock = null;
  let wakeLockRequestRevision = 0;

  function formatTime(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function accessibleTime(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const minuteText = minutes === 1 ? "1 minute" : `${minutes} minutes`;
    const secondText = seconds === 1 ? "1 second" : `${seconds} seconds`;

    if (minutes === 0) return `${secondText} remaining`;
    if (seconds === 0) return `${minuteText} remaining`;
    return `${minuteText} ${secondText} remaining`;
  }

  function timerConfigFromPreferences() {
    return {
      mainIntervalMs: preferences.mainIntervalSeconds * 1000,
      totalAlerts: preferences.totalAlerts,
      secondaryEnabled: preferences.secondaryEnabled,
      secondaryIntervalMs: preferences.secondaryIntervalSeconds * 1000
    };
  }

  function soundOptions(delaySeconds = 0) {
    return {
      enabled: preferences.soundEnabled,
      volume: preferences.volume,
      delaySeconds
    };
  }

  function readPreferencesFromForm() {
    return sanitizePreferences({
      mainIntervalSeconds: elements.mainIntervalInput.value,
      totalAlerts: elements.totalAlertsInput.value,
      mainSound: elements.mainSoundSelect.value,
      mainAlertDurationSeconds: elements.mainAlertDurationInput.value,
      soundEnabled: elements.soundEnabledInput.checked,
      volume: elements.volumeInput.value,
      secondaryEnabled: elements.secondaryEnabledInput.checked,
      secondaryIntervalSeconds: elements.secondaryIntervalInput.value,
      secondarySound: elements.secondarySoundSelect.value
    });
  }

  function applyPreferencesToForm() {
    elements.mainIntervalInput.value = preferences.mainIntervalSeconds;
    elements.totalAlertsInput.value = preferences.totalAlerts;
    elements.mainSoundSelect.value = preferences.mainSound;
    elements.mainAlertDurationInput.value = preferences.mainAlertDurationSeconds;
    elements.soundEnabledInput.checked = preferences.soundEnabled;
    elements.volumeInput.value = preferences.volume;
    elements.secondaryEnabledInput.checked = preferences.secondaryEnabled;
    elements.secondaryIntervalInput.value = preferences.secondaryIntervalSeconds;
    elements.secondarySoundSelect.value = preferences.secondarySound;
    updateSettingsControls();
  }

  function persistFormPreferences(normalizeForm = false) {
    const previousSoundEnabled = preferences.soundEnabled;
    const previousVolume = preferences.volume;
    preferences = savePreferences(readPreferencesFromForm());

    if (normalizeForm) {
      applyPreferencesToForm();
    } else {
      updateSettingsControls();
    }

    if (previousSoundEnabled && !preferences.soundEnabled) {
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

    if (engine.getSnapshot().phase === "idle") {
      render();
    }
  }

  function updateSettingsControls() {
    const phase = engine.getSnapshot().phase;
    const sessionLocked = phase !== "idle";

    document.querySelectorAll("[data-session-locked]").forEach((control) => {
      control.disabled = sessionLocked;
    });

    elements.secondaryIntervalInput.disabled = sessionLocked || !preferences.secondaryEnabled;
    elements.secondarySoundSelect.disabled = !preferences.secondaryEnabled;
    elements.previewSecondarySoundButton.disabled =
      !preferences.secondaryEnabled || !preferences.soundEnabled;
    elements.previewMainSoundButton.disabled = !preferences.soundEnabled;
    elements.volumeInput.disabled = !preferences.soundEnabled;
    elements.restoreDefaultsButton.disabled = sessionLocked;
    elements.soundEnabledLabel.textContent = preferences.soundEnabled ? "On" : "Off";
    elements.secondaryEnabledLabel.textContent = preferences.secondaryEnabled ? "On" : "Off";
    elements.volumeValue.value = `${preferences.volume}%`;
    elements.volumeValue.textContent = `${preferences.volume}%`;
    elements.settingsHint.textContent = audioWarningShown
      ? "Sound could not start in this browser. Visual alerts will still work."
      : sessionLocked
        ? "Sound and alert presentation can still be changed. Reset to change session timing."
        : "Changes save automatically. Timing controls lock during a session.";
  }

  function observeAudioUnlock(unlockPromise) {
    Promise.resolve(unlockPromise).then((available) => {
      if (available) {
        if (audioWarningShown) {
          audioWarningShown = false;
          if (isSettingsOpen()) elements.settingsFeedback.textContent = "Sound is ready.";
          updateSettingsControls();
        }
        return;
      }

      reportAudioUnavailable();
    });
  }

  function reportAudioUnavailable() {
    if (!preferences.soundEnabled || preferences.volume === 0 || audioWarningShown) return;

    audioWarningShown = true;
    statusMessage = "Sound is unavailable. Visual alerts will still work.";
    if (isSettingsOpen()) {
      elements.settingsFeedback.textContent =
        "Sound could not start. Visual alerts will still work.";
    }
    announce("Sound is unavailable in this browser. Visual alerts will still work.");
    render();
  }

  async function previewSound(playSound, successMessage) {
    if (preferences.volume === 0) {
      elements.settingsFeedback.textContent = "Volume is 0%. Raise it to hear a preview.";
      return;
    }

    const available = await audio.unlock();
    if (!available) {
      reportAudioUnavailable();
      return;
    }

    const played = await playSound();
    if (played) elements.settingsFeedback.textContent = successMessage;
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

    const showSecondary =
      snapshot.phase === "running" &&
      snapshot.secondaryEnabled &&
      snapshot.secondaryRemainingMs !== null;
    elements.secondaryStatus.hidden = !showSecondary;
    if (showSecondary) {
      elements.secondaryTime.textContent = formatTime(snapshot.secondaryRemainingMs);
    }

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

  function presentEvents(events) {
    const freshEvents = events.filter((event) => {
      if (handledEventIds.has(event.id)) return false;
      handledEventIds.add(event.id);
      return true;
    });
    const statusParts = [];
    const announcementParts = [];

    freshEvents.forEach((event) => {
      if (event.type === "main-alert") {
        const durationMs = preferences.mainAlertDurationSeconds * 1000;
        if (isSettingsOpen()) closeSettings();
        visuals.show("main", durationMs, "Interval alert");
        // Main cues win over a secondary cue that began or was scheduled moments ago.
        audio.stopAll();
        lastMainAudioAt = now();
        audio.playMain(preferences.mainSound, soundOptions());
        statusParts.push(`Alert ${event.completedMain} of ${event.totalAlerts}.`);
        announcementParts.push(`Alert ${event.completedMain} of ${event.totalAlerts}.`);
        return;
      }

      if (event.type === "secondary-alert") {
        if (isSettingsOpen()) closeSettings();
        visuals.show("secondary", 1400, "Item reminder");
        const separationDelayMs = Math.max(0, 700 - (now() - lastMainAudioAt));
        audio.playSecondary(
          preferences.secondarySound,
          soundOptions(separationDelayMs / 1000)
        );
        statusParts.push("Item reminder.");
        announcementParts.push("Item reminder now.");
        return;
      }

      if (event.type === "completion") {
        stopScheduler();
        audio.stopAll();
        if (isSettingsOpen()) closeSettings();
        // Completion owns the screen and discards any simultaneous amber accent
        // from the now-finished session.
        visuals.clear();
        visuals.show("completion", 2600, "Session complete");
        audio.playCompletion(soundOptions());
        statusParts.splice(0, statusParts.length, "Session complete. Reset when you are ready.");
        announcementParts.splice(
          0,
          announcementParts.length,
          `Session complete. ${event.totalAlerts} alerts finished.`
        );
        releaseWakeLock();
      }
    });

    if (statusParts.length > 0) {
      statusMessage = statusParts.join(" ");
      announce(announcementParts.join(" "));
    }
  }

  function reconcileAndPresent() {
    const events = engine.reconcile(now());
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

    // Unlocking is intentionally initiated by this user gesture. The session does not
    // wait for audio or wake-lock support before its monotonic schedule begins.
    observeAudioUnlock(audio.unlock());
    handledEventIds = new Set();
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
    if (!fallbackDialogActive) return;

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

  elements.startButton.addEventListener("click", startTimer);
  elements.alertNowButton.addEventListener("click", alertNow);
  elements.resetButton.addEventListener("click", resetTimer);
  elements.settingsButton.addEventListener("click", openSettings);
  elements.closeSettingsButton.addEventListener("click", closeSettings);
  elements.doneSettingsButton.addEventListener("click", closeSettings);

  elements.settingsDialog.addEventListener("click", (event) => {
    if (event.target !== elements.settingsDialog) return;

    const bounds = elements.settingsDialog.getBoundingClientRect();
    const outside =
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom;
    if (outside) closeSettings();
  });

  [
    elements.mainIntervalInput,
    elements.totalAlertsInput,
    elements.mainAlertDurationInput,
    elements.secondaryIntervalInput
  ].forEach((input) => {
    input.addEventListener("change", () => persistFormPreferences(true));
  });

  [
    elements.mainSoundSelect,
    elements.soundEnabledInput,
    elements.secondaryEnabledInput,
    elements.secondarySoundSelect
  ].forEach((control) => {
    control.addEventListener("change", () => persistFormPreferences(false));
  });

  elements.volumeInput.addEventListener("input", () => persistFormPreferences(false));

  elements.restoreDefaultsButton.addEventListener("click", () => {
    if (engine.getSnapshot(now()).phase !== "idle") return;
    preferences = restoreDefaultPreferences();
    audio.setVolume(preferences.volume);
    observeAudioUnlock(audio.unlock());
    applyPreferencesToForm();
    statusMessage = "Default settings restored.";
    elements.settingsFeedback.textContent = statusMessage;
    render();
  });

  elements.previewMainSoundButton.addEventListener("click", () => {
    previewSound(
      () => audio.playMain(preferences.mainSound, soundOptions()),
      "Main sound preview played."
    );
  });

  elements.previewSecondarySoundButton.addEventListener("click", () => {
    previewSound(
      () => audio.playSecondary(preferences.secondarySound, soundOptions()),
      "Item reminder sound preview played."
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
