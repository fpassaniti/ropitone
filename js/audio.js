// Jump detection engine: microphone capture + percussive onset detection.
// Emits DOM-style events: 'hit', 'level', 'calibration-progress', 'calibration-done', 'error'.

export const REFRACTORY_MS = 250; // hard floor on inter-hit spacing (~240 jumps/min ceiling)
export const HYSTERESIS_FACTOR = 0.65; // must fall below threshold*this before re-arming
const MIN_ABS_THRESHOLD = 0.004; // guards near-silent rooms where stddev ~= 0
const MAX_THRESHOLD = 0.9;
const ATTACK_WINDOW = 8; // frames of short-term average used for the attack/derivative guard
const ATTACK_DELTA_FACTOR = 0.25; // required jump above short-term average, as a fraction of (threshold - baseline)
const HFC_MIN_RATIO = 0.15; // minimum high-frequency-content ratio for a hit to count as percussive
const BASELINE_EMA_TAU_MS = 3000; // slow drift tracking of the noise floor while quiet

// Flux-based onset detection (alternative algorithm, toggled via the debug panel)
export const FLUX_SMOOTH_FRAMES = 3; // moving-average window applied to raw per-frame flux
export const FLUX_WINDOW_FRAMES = 30; // trailing window (~0.5s at 60fps) for adaptive mean/stddev
export const FLUX_ABS_FLOOR_STDDEV_MULT = 3; // absolute floor = calibration flux mean + this * calibration flux stddev
export const FLUX_FLOOR_DECAY_FACTOR = 0.999; // per-frame leaky-max decay of the adaptive floor (slow fall, instant rise)
export const FLUX_PEAK_MARGIN_FACTOR = 0.1; // required margin above threshold, as a fraction of threshold
const K_AT_MIN_SENSITIVITY_FLUX = 4; // slider 1
const K_AT_MAX_SENSITIVITY_FLUX = 1.5; // slider 10

// Flux v2 (prominence + re-arm hysteresis on top of the flux algorithm, toggled via the debug panel)
export const FLUX_PROMINENCE_FACTOR = 0.6; // minimum prominence required, as a fraction of the current fluxThreshold
export const FLUX_REARM_FACTOR = 0.55; // must fall below fluxThreshold*this to re-arm
const FLUX_REARM_TIMEOUT_MS = 1200; // anti-livelock safety net: force re-arm if stuck longer than this

function computeRms(timeDomainData) {
  let sumSquares = 0;
  for (let i = 0; i < timeDomainData.length; i++) {
    sumSquares += timeDomainData[i] * timeDomainData[i];
  }
  return Math.sqrt(sumSquares / timeDomainData.length);
}

function computeHfcRatio(freqData) {
  const mid = freqData.length >> 1;
  let total = 0;
  let high = 0;
  for (let i = 0; i < freqData.length; i++) {
    total += freqData[i];
    if (i >= mid) high += freqData[i];
  }
  return total > 0 ? high / total : 0;
}

const K_AT_MIN_SENSITIVITY = 10; // slider 1
const K_AT_MAX_SENSITIVITY = 1.1; // slider 10

export function sensitivityToK(sensitivity) {
  const t = (sensitivity - 1) / 9; // 0 at slider=1, 1 at slider=10
  return K_AT_MIN_SENSITIVITY - t * (K_AT_MIN_SENSITIVITY - K_AT_MAX_SENSITIVITY);
}

const GAIN_AT_MIN_SENSITIVITY = 1; // slider 1 — no boost
const GAIN_AT_MAX_SENSITIVITY = 8; // slider 10 — starting point, tune on real device

export function sensitivityToGain(sensitivity) {
  const t = (sensitivity - 1) / 9; // 0 at slider=1, 1 at slider=10
  return GAIN_AT_MIN_SENSITIVITY + t * (GAIN_AT_MAX_SENSITIVITY - GAIN_AT_MIN_SENSITIVITY);
}

export function sensitivityToFluxK(sensitivity) {
  const t = (sensitivity - 1) / 9; // 0 at slider=1, 1 at slider=10
  return K_AT_MIN_SENSITIVITY_FLUX - t * (K_AT_MIN_SENSITIVITY_FLUX - K_AT_MAX_SENSITIVITY_FLUX);
}

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.stream = null;
    this.audioContext = null;
    this.analyser = null;
    this.gainNode = null;
    this.timeDomainBuffer = null;
    this.freqBuffer = null;
    this.rafId = null;
    this.baseline = null; // { mean, stddev }
    this.baselineEma = null;
    this.threshold = MIN_ABS_THRESHOLD;
    this.sensitivity = 6;
    this.refractoryMs = REFRACTORY_MS;
    this.hysteresisFactor = HYSTERESIS_FACTOR;
    this.state = "BELOW";
    this.lastHitTime = 0;
    this.recentRms = [];
    this.detectionMode = "flux"; // "legacy" | "flux" | "flux-v2" — flux is the default
    this.prevFreqBuffer = null;
    this.fluxBaseline = null; // { mean, stddev }
    this.fluxHistory = [];
    this.fluxRecent = [];
    this.fluxFrames = [];
    this.fluxFloorSmoothed = 0;
    this.fluxWindowFrames = FLUX_WINDOW_FRAMES;
    this.fluxFloorDecayFactor = FLUX_FLOOR_DECAY_FACTOR;
    this.fluxAbsFloorMultiplier = FLUX_ABS_FLOOR_STDDEV_MULT;
    this.fluxPeakMarginFactor = FLUX_PEAK_MARGIN_FACTOR;
    this.fluxProminenceFactor = FLUX_PROMINENCE_FACTOR;
    this.fluxRearmFactor = FLUX_REARM_FACTOR;
    this.fluxArmed = true;
    this.fluxValleySinceHit = Infinity; // min(smoothedFlux) observed since the last confirmed hit (flux-v2 only)
    this.clockNode = null;
    this.silentGain = null;
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
  }

  async start() {
    // Create the AudioContext synchronously, before any await, so it's created
    // within the user-gesture call stack (required by Safari to start unsuspended).
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;

    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = sensitivityToGain(this.sensitivity);
    source.connect(this.gainNode);
    this.gainNode.connect(this.analyser);

    this.timeDomainBuffer = new Float32Array(this.analyser.fftSize);
    this.freqBuffer = new Uint8Array(this.analyser.frequencyBinCount);
    this.prevFreqBuffer = new Uint8Array(this.analyser.frequencyBinCount);

    // Drive frame timing off the audio render thread rather than requestAnimationFrame,
    // which browsers throttle/pause in background tabs or under rendering jank —
    // exactly when a transient jump peak is most likely to be silently dropped.
    if (this.audioContext.audioWorklet) {
      try {
        // Worklet.addModule() resolves relative URLs against the document's base URI,
        // not this module's URL, so the path must be given relative to index.html.
        await this.audioContext.audioWorklet.addModule("./js/audio-clock-processor.js");
        this.clockNode = new AudioWorkletNode(this.audioContext, "audio-clock-processor");
        this.gainNode.connect(this.clockNode);
        this.silentGain = this.audioContext.createGain();
        this.silentGain.gain.value = 0;
        this.clockNode.connect(this.silentGain);
        this.silentGain.connect(this.audioContext.destination);
      } catch {
        this.clockNode = null;
        this.silentGain = null;
      }
    }

    document.addEventListener("visibilitychange", this._onVisibilityChange);
  }

  _startClock(onTick) {
    if (this.clockNode) {
      this.clockNode.port.onmessage = () => onTick(performance.now());
    } else {
      const loop = () => {
        onTick(performance.now());
        this.rafId = requestAnimationFrame(loop);
      };
      this.rafId = requestAnimationFrame(loop);
    }
  }

  _stopClock() {
    if (this.clockNode) this.clockNode.port.onmessage = null;
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  async _onVisibilityChange() {
    if (document.visibilityState === "visible" && this.audioContext?.state === "suspended") {
      try {
        await this.audioContext.resume();
      } catch {
        this.dispatchEvent(new CustomEvent("error", { detail: { message: "resume-failed" } }));
      }
    }
  }

  _readRms() {
    this.analyser.getFloatTimeDomainData(this.timeDomainBuffer);
    return computeRms(this.timeDomainBuffer);
  }

  _computeFlux(freqData) {
    let flux = 0;
    for (let i = 0; i < freqData.length; i++) {
      const diff = freqData[i] - this.prevFreqBuffer[i];
      if (diff > 0) flux += diff;
      this.prevFreqBuffer[i] = freqData[i];
    }
    return flux;
  }

  calibrate(durationMs = 2500) {
    return new Promise((resolve) => {
      const samples = [];
      const fluxSamples = [];
      const startTime = performance.now();

      const tick = () => {
        const rms = this._readRms();
        samples.push(rms);
        this.analyser.getByteFrequencyData(this.freqBuffer);
        fluxSamples.push(this._computeFlux(this.freqBuffer));
        const elapsed = performance.now() - startTime;
        const progress = Math.min(1, elapsed / durationMs);
        this.dispatchEvent(new CustomEvent("calibration-progress", { detail: { progress } }));

        if (elapsed >= durationMs) {
          this._stopClock();

          const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
          const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
          const stddev = Math.sqrt(variance);
          const max = Math.max(...samples);
          this.baseline = { mean, stddev, max };
          this.baselineEma = mean;
          this._recomputeThreshold();

          const fluxMean = fluxSamples.reduce((a, b) => a + b, 0) / fluxSamples.length;
          const fluxVariance =
            fluxSamples.reduce((a, b) => a + (b - fluxMean) ** 2, 0) / fluxSamples.length;
          this.fluxBaseline = { mean: fluxMean, stddev: Math.sqrt(fluxVariance) };
          this.fluxFloorSmoothed = fluxMean;
          this.fluxHistory = fluxSamples.slice(-this.fluxWindowFrames);

          this.dispatchEvent(new CustomEvent("calibration-done", { detail: { ...this.baseline } }));
          resolve(this.baseline);
        }
      };

      this._startClock(tick);
    });
  }

  _recomputeThreshold() {
    if (!this.baseline) return;
    const k = sensitivityToK(this.sensitivity);
    const base = this.baselineEma ?? this.baseline.mean;
    const raw = base + k * this.baseline.stddev;
    this.threshold = Math.min(MAX_THRESHOLD, Math.max(MIN_ABS_THRESHOLD, raw));
  }

  setSensitivity(sensitivity) {
    const oldGain = this.gainNode ? sensitivityToGain(this.sensitivity) : null;
    this.sensitivity = sensitivity;

    if (this.gainNode) {
      const newGain = sensitivityToGain(this.sensitivity);
      const ratio = newGain / oldGain;

      this.gainNode.gain.setTargetAtTime(newGain, this.audioContext.currentTime, 0.01);

      // RMS scales linearly with gain, so existing calibration data must be
      // rescaled to stay consistent with now-differently-scaled live readings.
      if (this.baseline) {
        this.baseline = {
          mean: this.baseline.mean * ratio,
          stddev: this.baseline.stddev * ratio,
          max: this.baseline.max * ratio,
        };
      }
      if (this.baselineEma != null) this.baselineEma *= ratio;
      if (this.recentRms.length > 0) this.recentRms = this.recentRms.map((v) => v * ratio);
    }

    this._recomputeThreshold();
  }

  setRefractoryMs(ms) {
    this.refractoryMs = ms;
  }

  setHysteresisFactor(factor) {
    this.hysteresisFactor = factor;
  }

  setDetectionMode(mode) {
    this.detectionMode = mode;
    this.state = "BELOW";
    this.lastHitTime = 0;
    this.recentRms = [];
    this.fluxRecent = [];
    this.fluxFrames = [];
    this.fluxHistory = [];
    this.fluxFloorSmoothed = this.fluxBaseline?.mean ?? 0;
    this.fluxArmed = true;
    this.fluxValleySinceHit = Infinity;
  }

  setFluxWindowFrames(n) {
    this.fluxWindowFrames = n;
  }

  setFluxFloorDecayFactor(f) {
    this.fluxFloorDecayFactor = f;
  }

  setFluxAbsFloorMultiplier(m) {
    this.fluxAbsFloorMultiplier = m;
  }

  setFluxProminenceFactor(f) {
    this.fluxProminenceFactor = f;
  }

  setFluxRearmFactor(f) {
    this.fluxRearmFactor = f;
  }

  setFluxPeakMarginFactor(f) {
    this.fluxPeakMarginFactor = f;
  }

  _tickLegacy(rms, now) {
    const hfcRatio = computeHfcRatio(this.freqBuffer);

    const shortTermAvg =
      this.recentRms.length > 0
        ? this.recentRms.reduce((a, b) => a + b, 0) / this.recentRms.length
        : rms;

    const aboveThreshold = rms > this.threshold;
    const belowRearm = rms < this.threshold * this.hysteresisFactor;

    const attackDelta = rms - shortTermAvg;
    const requiredDelta =
      (this.threshold - (this.baselineEma ?? this.baseline?.mean ?? 0)) * ATTACK_DELTA_FACTOR;

    this.dispatchEvent(
      new CustomEvent("level", {
        detail: {
          mode: "legacy",
          rms,
          threshold: this.threshold,
          hysteresisThreshold: this.threshold * this.hysteresisFactor,
          hfcRatio,
          attackDelta,
          requiredDelta,
          state: this.state,
        },
      })
    );

    if (this.state === "BELOW" && aboveThreshold && now - this.lastHitTime > this.refractoryMs) {
      const hasSharpAttack = attackDelta >= requiredDelta;
      const isPercussive = hfcRatio >= HFC_MIN_RATIO;

      if (hasSharpAttack && isPercussive) {
        this.lastHitTime = now;
        this.state = "ABOVE";
        this.dispatchEvent(new CustomEvent("hit", { detail: { timestamp: now, rms, hfcRatio } }));
      }
    } else if (this.state === "ABOVE" && belowRearm) {
      this.state = "BELOW";
    }

    // slow-following baseline drift, only while quiet, so it never absorbs jump peaks
    if (this.state === "BELOW" && this.baselineEma != null) {
      const dt = 16; // approx ms per rAF tick, good enough for this slow EMA
      const alpha = dt / (BASELINE_EMA_TAU_MS + dt);
      this.baselineEma = this.baselineEma + alpha * (rms - this.baselineEma);
      this._recomputeThreshold();
    }

    this.recentRms.push(rms);
    if (this.recentRms.length > ATTACK_WINDOW) this.recentRms.shift();
  }

  _tickFlux(rms, now) {
    const hfcRatio = computeHfcRatio(this.freqBuffer);
    const rawFlux = this._computeFlux(this.freqBuffer);

    this.fluxRecent.push(rawFlux);
    if (this.fluxRecent.length > FLUX_SMOOTH_FRAMES) this.fluxRecent.shift();
    const smoothedFlux = this.fluxRecent.reduce((a, b) => a + b, 0) / this.fluxRecent.length;

    const historyOrBaseline = this.fluxHistory.length >= 2 ? this.fluxHistory : null;
    const windowMean = historyOrBaseline
      ? historyOrBaseline.reduce((a, b) => a + b, 0) / historyOrBaseline.length
      : this.fluxBaseline?.mean ?? 0;
    const windowVariance = historyOrBaseline
      ? historyOrBaseline.reduce((a, b) => a + (b - windowMean) ** 2, 0) / historyOrBaseline.length
      : (this.fluxBaseline?.stddev ?? 0) ** 2;
    const windowStddev = Math.sqrt(windowVariance);

    this.fluxFloorSmoothed = Math.max(this.fluxFloorSmoothed * this.fluxFloorDecayFactor, windowMean);
    const absFloor =
      (this.fluxBaseline?.mean ?? 0) + this.fluxAbsFloorMultiplier * (this.fluxBaseline?.stddev ?? 0);
    const fluxThreshold = Math.max(
      absFloor,
      this.fluxFloorSmoothed + sensitivityToFluxK(this.sensitivity) * windowStddev
    );

    // Only feed the adaptive window with quiet frames, mirroring legacy's
    // baselineEma-while-BELOW rule — otherwise a jump's own flux spike gets
    // folded into the "noise floor" and the threshold ratchets up during
    // continuous jumping.
    const isQuiet = smoothedFlux <= fluxThreshold;
    if (isQuiet) {
      this.fluxHistory.push(smoothedFlux);
      if (this.fluxHistory.length > this.fluxWindowFrames) this.fluxHistory.shift();
    }

    this.fluxFrames.push({ flux: smoothedFlux, threshold: fluxThreshold, timestamp: now, hfcRatio });
    if (this.fluxFrames.length > 3) this.fluxFrames.shift();

    this.dispatchEvent(
      new CustomEvent("level", {
        detail: {
          mode: "flux",
          rms,
          flux: smoothedFlux,
          fluxThreshold,
          fluxFloor: this.fluxFloorSmoothed,
          windowStddev,
        },
      })
    );

    if (this.fluxFrames.length === 3) {
      const [prev2, prev1, current] = this.fluxFrames;
      const isLocalMax = prev2.flux <= prev1.flux && prev1.flux >= current.flux;
      const exceedsThreshold = prev1.flux > prev1.threshold * (1 + this.fluxPeakMarginFactor);
      const refractoryElapsed = prev1.timestamp - this.lastHitTime > this.refractoryMs;
      const isPercussive = prev1.hfcRatio >= HFC_MIN_RATIO;

      if (isLocalMax && exceedsThreshold && refractoryElapsed && isPercussive) {
        this.lastHitTime = prev1.timestamp;
        this.dispatchEvent(
          new CustomEvent("hit", { detail: { timestamp: prev1.timestamp, rms, flux: prev1.flux } })
        );
      }
    }
  }

  // Same onset detection as _tickFlux, plus two additive shape-based checks:
  // a minimum prominence (how sharply the flux rose out of the preceding valley,
  // rather than just crossing an absolute threshold) and a low re-arm hysteresis
  // (must fall back below a lower threshold before a new hit can be confirmed,
  // which also stops reverb tails from leaking into the adaptive noise floor).
  _tickFluxV2(rms, now) {
    const hfcRatio = computeHfcRatio(this.freqBuffer);
    const rawFlux = this._computeFlux(this.freqBuffer);

    this.fluxRecent.push(rawFlux);
    if (this.fluxRecent.length > FLUX_SMOOTH_FRAMES) this.fluxRecent.shift();
    const smoothedFlux = this.fluxRecent.reduce((a, b) => a + b, 0) / this.fluxRecent.length;

    if (smoothedFlux < this.fluxValleySinceHit) this.fluxValleySinceHit = smoothedFlux;

    const historyOrBaseline = this.fluxHistory.length >= 2 ? this.fluxHistory : null;
    const windowMean = historyOrBaseline
      ? historyOrBaseline.reduce((a, b) => a + b, 0) / historyOrBaseline.length
      : this.fluxBaseline?.mean ?? 0;
    const windowVariance = historyOrBaseline
      ? historyOrBaseline.reduce((a, b) => a + (b - windowMean) ** 2, 0) / historyOrBaseline.length
      : (this.fluxBaseline?.stddev ?? 0) ** 2;
    const windowStddev = Math.sqrt(windowVariance);

    this.fluxFloorSmoothed = Math.max(this.fluxFloorSmoothed * this.fluxFloorDecayFactor, windowMean);
    const absFloor =
      (this.fluxBaseline?.mean ?? 0) + this.fluxAbsFloorMultiplier * (this.fluxBaseline?.stddev ?? 0);
    const fluxThreshold = Math.max(
      absFloor,
      this.fluxFloorSmoothed + sensitivityToFluxK(this.sensitivity) * windowStddev
    );

    const fluxRearmThreshold = fluxThreshold * this.fluxRearmFactor;
    if (!this.fluxArmed) {
      if (smoothedFlux < fluxRearmThreshold || now - this.lastHitTime > FLUX_REARM_TIMEOUT_MS) {
        this.fluxArmed = true;
      }
    }

    // Only feed the adaptive window with frames that are both quiet AND re-armed,
    // so a jump's reverb tail (still under the current threshold but above the
    // real noise floor) can't ratchet the threshold up and suppress the next jump.
    const isQuiet = smoothedFlux <= fluxThreshold && this.fluxArmed;
    if (isQuiet) {
      this.fluxHistory.push(smoothedFlux);
      if (this.fluxHistory.length > this.fluxWindowFrames) this.fluxHistory.shift();
    }

    this.fluxFrames.push({ flux: smoothedFlux, threshold: fluxThreshold, timestamp: now, hfcRatio });
    if (this.fluxFrames.length > 3) this.fluxFrames.shift();

    this.dispatchEvent(
      new CustomEvent("level", {
        detail: {
          mode: "flux-v2",
          rms,
          flux: smoothedFlux,
          fluxThreshold,
          fluxFloor: this.fluxFloorSmoothed,
          windowStddev,
          fluxValleySinceHit: this.fluxValleySinceHit,
          fluxRearmThreshold,
          fluxArmed: this.fluxArmed,
        },
      })
    );

    if (this.fluxFrames.length === 3) {
      const [prev2, prev1, current] = this.fluxFrames;
      const isLocalMax = prev2.flux <= prev1.flux && prev1.flux >= current.flux;
      const exceedsThreshold = prev1.flux > prev1.threshold * (1 + this.fluxPeakMarginFactor);
      const refractoryElapsed = prev1.timestamp - this.lastHitTime > this.refractoryMs;
      const isPercussive = prev1.hfcRatio >= HFC_MIN_RATIO;
      const prominence = prev1.flux - this.fluxValleySinceHit;
      const hasProminence = prominence >= prev1.threshold * this.fluxProminenceFactor;

      if (
        isLocalMax &&
        exceedsThreshold &&
        refractoryElapsed &&
        isPercussive &&
        hasProminence &&
        this.fluxArmed
      ) {
        this.lastHitTime = prev1.timestamp;
        this.fluxValleySinceHit = Infinity;
        this.fluxArmed = false;
        this.dispatchEvent(
          new CustomEvent("hit", {
            detail: { timestamp: prev1.timestamp, rms, flux: prev1.flux, prominence },
          })
        );
      }
    }
  }

  startCounting() {
    this.state = "BELOW";
    this.lastHitTime = 0;
    this.recentRms = [];

    const tick = (now) => {
      const rms = this._readRms();
      this.analyser.getByteFrequencyData(this.freqBuffer);

      if (this.detectionMode === "flux-v2") {
        this._tickFluxV2(rms, now);
      } else if (this.detectionMode === "flux") {
        this._tickFlux(rms, now);
      } else {
        this._tickLegacy(rms, now);
      }
    };

    this._startClock(tick);
  }

  stopCounting() {
    this._stopClock();
  }

  stop() {
    this.stopCounting();
    document.removeEventListener("visibilitychange", this._onVisibilityChange);
    this.clockNode?.disconnect();
    this.silentGain?.disconnect();
    this.clockNode = null;
    this.silentGain = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.audioContext?.close();
    this.stream = null;
    this.audioContext = null;
    this.analyser = null;
    this.gainNode = null;
  }
}
