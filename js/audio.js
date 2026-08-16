// Jump detection engine: microphone capture + percussive onset detection.
// Emits DOM-style events: 'hit', 'level', 'calibration-progress', 'calibration-done', 'error'.

export const REFRACTORY_MS = 250; // hard floor on inter-hit spacing (~240 jumps/min ceiling)
export const HYSTERESIS_FACTOR = 0.65; // must fall below threshold*this before re-arming
const MIN_ABS_THRESHOLD = 0.004; // guards near-silent rooms where stddev ~= 0
const MAX_THRESHOLD = 0.9;
const ATTACK_WINDOW = 8; // frames of short-term average used for the attack/derivative guard
const ATTACK_DELTA_FACTOR = 0.25; // required jump above short-term average, as a fraction of (threshold - baseline)
export const HFC_MIN_RATIO = 0.15; // minimum high-frequency-content ratio for a hit to count as percussive
const BASELINE_EMA_TAU_MS = 3000; // slow drift tracking of the noise floor while quiet

// Analyser dynamic range. The AnalyserNode defaults (-100/-30 dBFS) pin every bin louder
// than -30 dBFS to byte 255; with the sensitivity gain applied that happens well inside a
// rope slap, so consecutive frames both read 255, their difference is 0, and the flux peak
// is flattened exactly when it matters. A wider window keeps the transient on scale.
const ANALYSER_MIN_DB = -90;
const ANALYSER_MAX_DB = 0;

// Spectral band the flux is summed over. A rope slap is a wideband transient, but the bins
// below ~500 Hz mostly carry footfalls, ventilation and handling noise — summing the whole
// 0-24 kHz range drowns the onset in them. The upper bound keeps the band inside what phone
// microphones actually capture.
export const FLUX_BAND_LOW_HZ = 500;
export const FLUX_BAND_HIGH_HZ = 8000;
export const HFC_SPLIT_HZ = 4000; // percussive/tonal split, kept inside the flux band

// Flux-based onset detection (default algorithm)
export const FLUX_SMOOTH_FRAMES = 3; // moving-average window applied to raw per-frame flux
export const FLUX_WINDOW_FRAMES = 30; // trailing window (~0.5s at 60fps) for adaptive mean/stddev
export const FLUX_ABS_FLOOR_STDDEV_MULT = 3; // absolute floor = calibration flux mean + this * calibration flux stddev
export const FLUX_FLOOR_DECAY_FACTOR = 0.999; // per-frame leaky-max decay of the adaptive floor (slow fall, instant rise)
export const FLUX_PEAK_MARGIN_FACTOR = 0.1; // required margin above threshold, as a fraction of threshold
export const FLUX_MAX_THRESHOLD_RATIO = 12; // ceiling on absFloor as a multiple of the live noise level
const K_AT_MIN_SENSITIVITY_FLUX = 4; // slider 1
const K_AT_MAX_SENSITIVITY_FLUX = 1.5; // slider 10

// Flux v2 (prominence + re-arm hysteresis on top of the flux algorithm)
export const FLUX_PROMINENCE_FACTOR = 0.4; // minimum prominence required, as a fraction of the current fluxThreshold
export const FLUX_REARM_FACTOR = 0.8; // must fall below fluxThreshold*this to re-arm
// Anti-livelock safety net: force re-arm if stuck longer than this. Kept just above
// REFRACTORY_MS so a stuck re-arm costs almost nothing — at 1200ms it silently capped
// the counter at ~50 jumps/min, well under a normal skipping cadence.
export const FLUX_REARM_TIMEOUT_MS = 300;

// Calibration robustness
const CALIBRATION_WARMUP_FRAMES = 3; // dropped: they compare against an unprimed spectrum
const CALIBRATION_KEEP_QUANTILE = 0.95; // top tail dropped before computing mean/stddev
const GAIN_RAMP_BLANKING_MS = 120; // detection blanked while a sensitivity change ramps the gain

function computeRms(timeDomainData) {
  let sumSquares = 0;
  for (let i = 0; i < timeDomainData.length; i++) {
    sumSquares += timeDomainData[i] * timeDomainData[i];
  }
  return Math.sqrt(sumSquares / timeDomainData.length);
}

function computeHfcRatio(freqData, lowBin, splitBin, highBin) {
  let total = 0;
  let high = 0;
  for (let i = lowBin; i < highBin; i++) {
    total += freqData[i];
    if (i >= splitBin) high += freqData[i];
  }
  return total > 0 ? high / total : 0;
}

function hzToBin(hz, sampleRate, fftSize) {
  return Math.round((hz * fftSize) / sampleRate);
}

// Mean/stddev with the top tail dropped. A single stray noise during calibration — a
// footstep, a door, or an unprimed first frame — would otherwise inflate stddev by an
// order of magnitude and lock absFloor above anything a real jump can reach.
function robustStats(samples) {
  if (samples.length === 0) return { mean: 0, stddev: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const keep = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * CALIBRATION_KEEP_QUANTILE)));
  const mean = keep.reduce((a, b) => a + b, 0) / keep.length;
  const variance = keep.reduce((a, b) => a + (b - mean) ** 2, 0) / keep.length;
  return { mean, stddev: Math.sqrt(variance) };
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
    this.hfcMinRatio = HFC_MIN_RATIO;
    this.state = "BELOW";
    this.lastHitTime = 0;
    this.blankUntil = 0; // detection suppressed until this timestamp (gain ramp transient)
    this.recentRms = [];
    this.detectionMode = "flux"; // "legacy" | "flux" | "flux-v2" — flux is the default
    this.prevFreqBuffer = null;
    this.fluxBaseline = null; // { mean, stddev }
    this.fluxHistory = [];
    this.fluxRecent = [];
    this.fluxFrames = [];
    this.fluxFloorSmoothed = 0;
    this.fluxSmoothFrames = FLUX_SMOOTH_FRAMES;
    this.fluxWindowFrames = FLUX_WINDOW_FRAMES;
    this.fluxFloorDecayFactor = FLUX_FLOOR_DECAY_FACTOR;
    this.fluxAbsFloorMultiplier = FLUX_ABS_FLOOR_STDDEV_MULT;
    this.fluxPeakMarginFactor = FLUX_PEAK_MARGIN_FACTOR;
    this.fluxMaxThresholdRatio = FLUX_MAX_THRESHOLD_RATIO;
    this.fluxProminenceFactor = FLUX_PROMINENCE_FACTOR;
    this.fluxRearmFactor = FLUX_REARM_FACTOR;
    this.fluxRearmTimeoutMs = FLUX_REARM_TIMEOUT_MS;
    this.fluxArmed = true;
    this.fluxValleySinceHit = Infinity; // min(smoothedFlux) observed since the last confirmed hit (flux-v2 only)
    // Bin range the flux and the HFC ratio are computed over; derived from the real
    // sample rate in start(), since 44.1 kHz and 48 kHz map these bands differently.
    this.fluxBinLow = 0;
    this.fluxBinHigh = 0;
    this.hfcSplitBin = 0;
    this.gateRejections = this._emptyGateRejections();
    this.clockNode = null;
    this.silentGain = null;
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
  }

  // Why a local maximum in the flux was not promoted to a hit, bucketed by the first
  // gate that rejected it. Without this a silent session gives no clue which criterion
  // is blocking, and every threshold has to be tuned blind.
  _emptyGateRejections() {
    return { threshold: 0, hfc: 0, refractory: 0, prominence: 0, armed: 0 };
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
    this.analyser.minDecibels = ANALYSER_MIN_DB;
    this.analyser.maxDecibels = ANALYSER_MAX_DB;

    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = sensitivityToGain(this.sensitivity);
    source.connect(this.gainNode);
    this.gainNode.connect(this.analyser);

    this.timeDomainBuffer = new Float32Array(this.analyser.fftSize);
    this.freqBuffer = new Uint8Array(this.analyser.frequencyBinCount);
    this.prevFreqBuffer = new Uint8Array(this.analyser.frequencyBinCount);

    this._computeBandBins();

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

  _computeBandBins() {
    const { sampleRate } = this.audioContext;
    const { fftSize, frequencyBinCount } = this.analyser;
    const low = hzToBin(FLUX_BAND_LOW_HZ, sampleRate, fftSize);
    const high = hzToBin(FLUX_BAND_HIGH_HZ, sampleRate, fftSize);
    const split = hzToBin(HFC_SPLIT_HZ, sampleRate, fftSize);

    this.fluxBinLow = Math.min(Math.max(1, low), frequencyBinCount - 2);
    this.fluxBinHigh = Math.min(Math.max(high, this.fluxBinLow + 2), frequencyBinCount);
    this.hfcSplitBin = Math.min(Math.max(split, this.fluxBinLow + 1), this.fluxBinHigh - 1);
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

  _readHfcRatio() {
    return computeHfcRatio(this.freqBuffer, this.fluxBinLow, this.hfcSplitBin, this.fluxBinHigh);
  }

  _computeFlux(freqData) {
    let flux = 0;
    for (let i = this.fluxBinLow; i < this.fluxBinHigh; i++) {
      const diff = freqData[i] - this.prevFreqBuffer[i];
      if (diff > 0) flux += diff;
    }
    this.prevFreqBuffer.set(freqData);
    return flux;
  }

  _absFloor() {
    return (
      (this.fluxBaseline?.mean ?? 0) + this.fluxAbsFloorMultiplier * (this.fluxBaseline?.stddev ?? 0)
    );
  }

  calibrate(durationMs = 2500) {
    return new Promise((resolve) => {
      const samples = [];
      const fluxSamples = [];
      const startTime = performance.now();
      let frameIndex = 0;

      const tick = () => {
        const rms = this._readRms();
        samples.push(rms);
        this.analyser.getByteFrequencyData(this.freqBuffer);
        const flux = this._computeFlux(this.freqBuffer);
        // The first frames are differenced against an unprimed prevFreqBuffer (and the
        // analyser may still be returning zeros), so they sum the whole spectrum instead
        // of a frame-to-frame delta — an outlier two orders of magnitude too large.
        if (frameIndex >= CALIBRATION_WARMUP_FRAMES) fluxSamples.push(flux);
        frameIndex += 1;

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

          this.fluxBaseline = robustStats(fluxSamples);
          this.fluxFloorSmoothed = this.fluxBaseline.mean;
          this.fluxHistory = fluxSamples.slice(-this.fluxWindowFrames);

          this.dispatchEvent(
            new CustomEvent("calibration-done", {
              detail: {
                ...this.baseline,
                flux: { ...this.fluxBaseline, absFloor: this._absFloor() },
              },
            })
          );
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

      // The byte spectrum is logarithmic, so a gain change is a constant dB offset that
      // cancels out of a frame-to-frame difference — the flux baselines need no rescaling.
      // The ramp itself, however, sweeps every bin over ~30-50ms and reads as a broadband
      // onset, so drop the in-flight frames and blank detection until it has settled.
      this.fluxRecent = [];
      this.fluxFrames = [];
      this.blankUntil = performance.now() + GAIN_RAMP_BLANKING_MS;
    }

    this._recomputeThreshold();
  }

  setRefractoryMs(ms) {
    this.refractoryMs = ms;
  }

  setHysteresisFactor(factor) {
    this.hysteresisFactor = factor;
  }

  setHfcMinRatio(ratio) {
    this.hfcMinRatio = ratio;
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
    this.gateRejections = this._emptyGateRejections();
  }

  setFluxSmoothFrames(n) {
    this.fluxSmoothFrames = n;
    this.fluxRecent = [];
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

  setFluxMaxThresholdRatio(r) {
    this.fluxMaxThresholdRatio = r;
  }

  setFluxProminenceFactor(f) {
    this.fluxProminenceFactor = f;
  }

  setFluxRearmFactor(f) {
    this.fluxRearmFactor = f;
  }

  setFluxRearmTimeoutMs(ms) {
    this.fluxRearmTimeoutMs = ms;
  }

  setFluxPeakMarginFactor(f) {
    this.fluxPeakMarginFactor = f;
  }

  // Shared by both flux algorithms: adaptive statistics and the resulting threshold.
  _computeFluxThreshold() {
    const historyOrBaseline = this.fluxHistory.length >= 2 ? this.fluxHistory : null;
    const windowMean = historyOrBaseline
      ? historyOrBaseline.reduce((a, b) => a + b, 0) / historyOrBaseline.length
      : this.fluxBaseline?.mean ?? 0;
    const windowVariance = historyOrBaseline
      ? historyOrBaseline.reduce((a, b) => a + (b - windowMean) ** 2, 0) / historyOrBaseline.length
      : (this.fluxBaseline?.stddev ?? 0) ** 2;
    const windowStddev = Math.sqrt(windowVariance);

    this.fluxFloorSmoothed = Math.max(this.fluxFloorSmoothed * this.fluxFloorDecayFactor, windowMean);

    const adaptive = this.fluxFloorSmoothed + sensitivityToFluxK(this.sensitivity) * windowStddev;
    const absFloor = this._absFloor();

    // Legacy has MIN/MAX_THRESHOLD; the flux path had no equivalent, so a calibration
    // taken in a noisy moment could pin absFloor above anything reachable for the whole
    // session. Cap it against the live noise level — but never below the adaptive term,
    // so a genuinely silent room can't collapse the threshold to zero.
    const cap = this.fluxMaxThresholdRatio * Math.max(windowMean, this.fluxBaseline?.mean ?? 0);
    const cappedAbsFloor = cap > 0 ? Math.min(absFloor, cap) : absFloor;

    return {
      fluxThreshold: Math.max(cappedAbsFloor, adaptive),
      windowMean,
      windowStddev,
      absFloor,
    };
  }

  _smoothFlux(rawFlux) {
    this.fluxRecent.push(rawFlux);
    if (this.fluxRecent.length > this.fluxSmoothFrames) this.fluxRecent.shift();
    return this.fluxRecent.reduce((a, b) => a + b, 0) / this.fluxRecent.length;
  }

  _tickLegacy(rms, now) {
    const hfcRatio = this._readHfcRatio();

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
      const isPercussive = hfcRatio >= this.hfcMinRatio;

      if (hasSharpAttack && isPercussive && now >= this.blankUntil) {
        this.lastHitTime = now;
        this.state = "ABOVE";
        this.dispatchEvent(new CustomEvent("hit", { detail: { timestamp: now, rms, hfcRatio } }));
      }
    } else if (this.state === "ABOVE" && belowRearm) {
      this.state = "BELOW";
    }

    // slow-following baseline drift, only while quiet, so it never absorbs jump peaks
    if (this.state === "BELOW" && this.baselineEma != null) {
      const dt = 16; // approx ms per tick, good enough for this slow EMA
      const alpha = dt / (BASELINE_EMA_TAU_MS + dt);
      this.baselineEma = this.baselineEma + alpha * (rms - this.baselineEma);
      this._recomputeThreshold();
    }

    this.recentRms.push(rms);
    if (this.recentRms.length > ATTACK_WINDOW) this.recentRms.shift();
  }

  _tickFlux(rms, now) {
    const hfcRatio = this._readHfcRatio();
    const smoothedFlux = this._smoothFlux(this._computeFlux(this.freqBuffer));
    const { fluxThreshold, windowMean, windowStddev, absFloor } = this._computeFluxThreshold();

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
          windowMean,
          windowStddev,
          absFloor,
          hfcRatio,
          gateRejections: this.gateRejections,
        },
      })
    );

    if (this.fluxFrames.length === 3) {
      const [prev2, prev1, current] = this.fluxFrames;
      const isLocalMax = prev2.flux <= prev1.flux && prev1.flux >= current.flux;
      if (!isLocalMax) return;

      const exceedsThreshold = prev1.flux > prev1.threshold * (1 + this.fluxPeakMarginFactor);
      const refractoryElapsed =
        prev1.timestamp - this.lastHitTime > this.refractoryMs && prev1.timestamp >= this.blankUntil;
      const isPercussive = prev1.hfcRatio >= this.hfcMinRatio;

      if (!exceedsThreshold) this.gateRejections.threshold += 1;
      else if (!isPercussive) this.gateRejections.hfc += 1;
      else if (!refractoryElapsed) this.gateRejections.refractory += 1;
      else {
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
  // (must fall back below a lower threshold before a new hit can be confirmed).
  _tickFluxV2(rms, now) {
    const hfcRatio = this._readHfcRatio();
    const smoothedFlux = this._smoothFlux(this._computeFlux(this.freqBuffer));

    if (smoothedFlux < this.fluxValleySinceHit) this.fluxValleySinceHit = smoothedFlux;

    const { fluxThreshold, windowMean, windowStddev, absFloor } = this._computeFluxThreshold();

    const fluxRearmThreshold = fluxThreshold * this.fluxRearmFactor;
    if (!this.fluxArmed) {
      if (smoothedFlux < fluxRearmThreshold || now - this.lastHitTime > this.fluxRearmTimeoutMs) {
        this.fluxArmed = true;
      }
    }

    // Only feed the adaptive window with frames that are both quiet AND re-armed, so a
    // jump's reverb tail (still under the current threshold but above the real noise
    // floor) can't ratchet the threshold up and suppress the next jump. The fluxArmed
    // term matters more than it looks: gating on the threshold alone truncates the noise
    // distribution from above and understates its stddev, which collapses the threshold
    // and lets stationary noise through.
    const isQuiet = smoothedFlux <= fluxThreshold && this.fluxArmed;
    if (isQuiet) {
      this.fluxHistory.push(smoothedFlux);
      if (this.fluxHistory.length > this.fluxWindowFrames) this.fluxHistory.shift();
    }

    this.fluxFrames.push({ flux: smoothedFlux, threshold: fluxThreshold, timestamp: now, hfcRatio });
    if (this.fluxFrames.length > 3) this.fluxFrames.shift();

    const prominenceNow =
      this.fluxValleySinceHit === Infinity ? 0 : smoothedFlux - this.fluxValleySinceHit;

    this.dispatchEvent(
      new CustomEvent("level", {
        detail: {
          mode: "flux-v2",
          rms,
          flux: smoothedFlux,
          fluxThreshold,
          fluxFloor: this.fluxFloorSmoothed,
          windowMean,
          windowStddev,
          absFloor,
          hfcRatio,
          fluxValleySinceHit: this.fluxValleySinceHit,
          fluxRearmThreshold,
          fluxArmed: this.fluxArmed,
          prominence: prominenceNow,
          gateRejections: this.gateRejections,
        },
      })
    );

    if (this.fluxFrames.length === 3) {
      const [prev2, prev1, current] = this.fluxFrames;
      const isLocalMax = prev2.flux <= prev1.flux && prev1.flux >= current.flux;
      if (!isLocalMax) return;

      const exceedsThreshold = prev1.flux > prev1.threshold * (1 + this.fluxPeakMarginFactor);
      const refractoryElapsed =
        prev1.timestamp - this.lastHitTime > this.refractoryMs && prev1.timestamp >= this.blankUntil;
      const isPercussive = prev1.hfcRatio >= this.hfcMinRatio;
      const prominence = prev1.flux - this.fluxValleySinceHit;
      const hasProminence = prominence >= prev1.threshold * this.fluxProminenceFactor;

      if (!exceedsThreshold) this.gateRejections.threshold += 1;
      else if (!isPercussive) this.gateRejections.hfc += 1;
      else if (!refractoryElapsed) this.gateRejections.refractory += 1;
      else if (!hasProminence) this.gateRejections.prominence += 1;
      else if (!this.fluxArmed) this.gateRejections.armed += 1;
      else {
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
    this.blankUntil = 0;
    this.recentRms = [];
    this.fluxRecent = [];
    this.fluxFrames = [];
    this.fluxArmed = true;
    this.fluxValleySinceHit = Infinity;
    this.gateRejections = this._emptyGateRejections();

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
