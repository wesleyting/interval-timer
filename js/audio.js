(function attachAudio(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.IntervalTimer = Object.assign(root.IntervalTimer || {}, api);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createAudioApi() {
  "use strict";

  const DEFAULT_OWNER = Symbol("default-audio-owner");

  class AudioManager {
    constructor(options = {}) {
      this.context = null;
      this.masterGain = null;
      this.compressor = null;
      this.activeSources = new Set();
      this.activeSourcesByOwner = new Map();
      this.ownerGenerations = new Map();
      this.generation = 0;
      this.currentVolume = 100;
      this.onUnavailable =
        typeof options.onUnavailable === "function" ? options.onUnavailable : null;
    }

    async unlock() {
      try {
        const context = await this._ensureContext();
        if (context.state === "suspended") {
          await context.resume();
        }
        return context.state === "running";
      } catch (error) {
        console.warn("Audio is unavailable:", error);
        this._notifyUnavailable(error);
        return false;
      }
    }

    async playMain(style, options = {}) {
      return this._play(options, (context, start, ownerKey) => {
        if (style === "crystal-chirp") {
          // Two quick upward chirps cut through background audio without the
          // long metallic tail of Glass Ping.
          this._sweep(context, 987.77, 1567.98, start, 0.09, 0.62, 0.12, "sine", ownerKey);
          this._sweep(
            context,
            1318.51,
            2093,
            start + 0.13,
            0.085,
            0.5,
            0.13,
            "sine",
            ownerKey
          );
          return;
        }

        if (style === "triple-spark") {
          // A short three-note rhythm remains recognizable when a game or
          // music masks one of the individual notes.
          [1318.51, 1760, 2093].forEach((frequency, index) => {
            this._tone(
              context,
              frequency,
              start + index * 0.105,
              0.045,
              index === 2 ? 0.62 : 0.5,
              0.13,
              "triangle",
              ownerKey
            );
          });
          return;
        }

        if (style === "high-beacon") {
          // Alternating pitches make this cue more urgent and easier to pick
          // out than a single bell, while keeping each note brief.
          [1174.66, 1567.98, 1174.66, 1975.53].forEach((frequency, index) => {
            this._tone(
              context,
              frequency,
              start + index * 0.095,
              0.035,
              index === 3 ? 0.62 : 0.46,
              0.11,
              index % 2 === 0 ? "triangle" : "sine",
              ownerKey
            );
          });
          return;
        }

        if (style === "bright-bell") {
          this._tone(context, 659.25, start, 0.1, 0.72, 0.38, "triangle", ownerKey);
          this._tone(context, 987.77, start + 0.015, 0.07, 0.4, 0.42, "sine", ownerKey);
          this._tone(
            context,
            1318.51,
            start + 0.025,
            0.055,
            0.2,
            0.34,
            "sine",
            ownerKey
          );
          return;
        }

        if (style === "soft-chime") {
          this._tone(context, 523.25, start, 0.12, 0.42, 0.3, "sine", ownerKey);
          this._tone(context, 659.25, start + 0.1, 0.11, 0.34, 0.31, "sine", ownerKey);
          this._tone(context, 783.99, start + 0.2, 0.09, 0.26, 0.3, "sine", ownerKey);
          return;
        }

        // Glass Ping: a strong, bright transient with several quickly decaying partials.
        this._tone(context, 783.99, start, 0.055, 0.28, 0.38, "triangle", ownerKey);
        this._tone(context, 1046.5, start, 0.07, 0.78, 0.52, "sine", ownerKey);
        this._tone(
          context,
          1567.98,
          start + 0.006,
          0.045,
          0.4,
          0.42,
          "sine",
          ownerKey
        );
        this._tone(context, 2093, start + 0.01, 0.035, 0.18, 0.31, "sine", ownerKey);
      });
    }

    async playSecondary(style, options = {}) {
      return this._play(options, (context, start, ownerKey) => {
        if (style === "signal-drop") {
          this._sweep(context, 740, 430, start, 0.19, 0.58, 0.16, "triangle", ownerKey);
          this._sweep(
            context,
            620,
            350,
            start + 0.25,
            0.17,
            0.5,
            0.14,
            "triangle",
            ownerKey
          );
          return;
        }

        if (style === "wood-block") {
          this._tone(context, 470, start, 0.035, 0.76, 0.07, "square", ownerKey);
          this._tone(context, 335, start + 0.12, 0.04, 0.68, 0.08, "square", ownerKey);
          this._tone(
            context,
            235,
            start + 0.13,
            0.045,
            0.34,
            0.08,
            "triangle",
            ownerKey
          );
          return;
        }

        // Low Double Tap stays well below the bright main ping so it is easy to identify.
        this._tone(context, 293.66, start, 0.08, 0.72, 0.13, "triangle", ownerKey);
        this._tone(context, 220, start, 0.065, 0.34, 0.12, "sine", ownerKey);
        this._tone(
          context,
          329.63,
          start + 0.21,
          0.085,
          0.78,
          0.14,
          "triangle",
          ownerKey
        );
        this._tone(
          context,
          246.94,
          start + 0.21,
          0.07,
          0.36,
          0.13,
          "sine",
          ownerKey
        );
      });
    }

    async playCompletion(options = {}) {
      return this._play(options, (context, start, ownerKey) => {
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((frequency, index) => {
          const noteStart = start + index * 0.14;
          this._tone(
            context,
            frequency,
            noteStart,
            index === notes.length - 1 ? 0.16 : 0.1,
            index === notes.length - 1 ? 0.66 : 0.46,
            index === notes.length - 1 ? 0.5 : 0.24,
            index < 2 ? "triangle" : "sine",
            ownerKey
          );
          this._tone(
            context,
            frequency * 2,
            noteStart + 0.01,
            0.04,
            0.12,
            0.2,
            "sine",
            ownerKey
          );
        });
      });
    }

    setVolume(volume) {
      const normalized = Math.max(0, Math.min(100, Number(volume) || 0));
      this.currentVolume = normalized;
      if (!this.context || !this.masterGain) return;

      const level = Math.pow(normalized / 100, 1.55) * 0.9;
      this.masterGain.gain.setTargetAtTime(level, this.context.currentTime, 0.012);
    }

    stop(ownerId) {
      const ownerKey = this._ownerKey(ownerId);
      this.ownerGenerations.set(ownerKey, this._ownerGeneration(ownerKey) + 1);

      const ownerSources = this.activeSourcesByOwner.get(ownerKey);
      if (!ownerSources) return;

      this.activeSourcesByOwner.delete(ownerKey);
      [...ownerSources].forEach((source) => {
        this.activeSources.delete(source);
        try {
          source.stop(0);
        } catch (error) {
          // A source that already ended is safe to ignore.
        }
      });
    }

    stopAll() {
      this.generation += 1;
      this.ownerGenerations.clear();

      [...this.activeSources].forEach((source) => {
        try {
          source.stop(0);
        } catch (error) {
          // A source that already ended is safe to ignore.
        }
      });

      this.activeSources.clear();
      this.activeSourcesByOwner.clear();
    }

    async _play(options, buildSound) {
      const enabled = options.enabled !== false;
      const volume = Math.max(0, Math.min(100, Number(options.volume) || 0));
      const ownerKey = this._ownerKey(options.ownerId);

      if (!enabled || volume === 0) {
        return false;
      }

      this.setVolume(volume);
      const requestedGeneration = this.generation;
      const requestedOwnerGeneration = this._ownerGeneration(ownerKey);

      try {
        const context = await this._ensureContext();
        if (context.state === "suspended") {
          await context.resume();
        }

        if (
          requestedGeneration !== this.generation ||
          requestedOwnerGeneration !== this._ownerGeneration(ownerKey)
        ) {
          return false;
        }

        if (context.state !== "running") {
          this._notifyUnavailable(new Error("The audio context could not start."));
          return false;
        }

        // A slider move while AudioContext.resume() was pending wins over the
        // request's earlier value; never restore stale volume after the await.
        if (this.currentVolume === 0) return false;
        this.setVolume(this.currentVolume);
        const delaySeconds = Math.max(0, Number(options.delaySeconds) || 0);
        buildSound(context, context.currentTime + 0.025 + delaySeconds, ownerKey);
        return true;
      } catch (error) {
        console.warn("Sound could not be played:", error);
        this._notifyUnavailable(error);
        return false;
      }
    }

    _ownerKey(ownerId) {
      return ownerId === undefined ? DEFAULT_OWNER : ownerId;
    }

    _ownerGeneration(ownerKey) {
      return this.ownerGenerations.get(ownerKey) || 0;
    }

    _notifyUnavailable(error) {
      if (!this.onUnavailable) return;

      try {
        this.onUnavailable(error);
      } catch (callbackError) {
        console.warn("The audio availability warning failed:", callbackError);
      }
    }

    async _ensureContext() {
      if (this.context) {
        return this.context;
      }

      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error("Web Audio is not supported by this browser.");
      }

      const context = new AudioContextClass();
      const masterGain = context.createGain();
      const compressor = context.createDynamicsCompressor();

      masterGain.gain.value = 0.9;
      compressor.threshold.value = -12;
      compressor.knee.value = 10;
      compressor.ratio.value = 8;
      compressor.attack.value = 0.002;
      compressor.release.value = 0.18;

      masterGain.connect(compressor);
      compressor.connect(context.destination);

      this.context = context;
      this.masterGain = masterGain;
      this.compressor = compressor;
      return context;
    }

    _tone(context, frequency, start, sustain, peak, release, type, ownerKey) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const end = start + sustain + release;

      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), start + 0.008);
      gain.gain.setValueAtTime(Math.max(0.0001, peak * 0.82), start + sustain);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);

      oscillator.connect(gain);
      gain.connect(this.masterGain);
      this._trackSource(oscillator, gain, ownerKey);
      oscillator.start(start);
      oscillator.stop(end + 0.035);
    }

    _sweep(
      context,
      fromFrequency,
      toFrequency,
      start,
      duration,
      peak,
      release,
      type,
      ownerKey
    ) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const end = start + duration + release;

      oscillator.type = type;
      oscillator.frequency.setValueAtTime(fromFrequency, start);
      oscillator.frequency.exponentialRampToValueAtTime(toFrequency, start + duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);

      oscillator.connect(gain);
      gain.connect(this.masterGain);
      this._trackSource(oscillator, gain, ownerKey);
      oscillator.start(start);
      oscillator.stop(end + 0.035);
    }

    _trackSource(source, gain, ownerKey = DEFAULT_OWNER) {
      this.activeSources.add(source);
      let ownerSources = this.activeSourcesByOwner.get(ownerKey);
      if (!ownerSources) {
        ownerSources = new Set();
        this.activeSourcesByOwner.set(ownerKey, ownerSources);
      }
      ownerSources.add(source);

      source.addEventListener(
        "ended",
        () => {
          this.activeSources.delete(source);
          const currentOwnerSources = this.activeSourcesByOwner.get(ownerKey);
          if (currentOwnerSources) {
            currentOwnerSources.delete(source);
            if (currentOwnerSources.size === 0) {
              this.activeSourcesByOwner.delete(ownerKey);
            }
          }
          try {
            source.disconnect();
            gain.disconnect();
          } catch (error) {
            // The nodes may already be disconnected during reset.
          }
        },
        { once: true }
      );
    }
  }

  return { AudioManager };
});
