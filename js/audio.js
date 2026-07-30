// Jump detection engine: microphone capture + percussive onset detection.
// Emits DOM-style events: 'hit', 'level', 'calibration-progress', 'calibration-done', 'error'.

const REFRACTORY_MS = 250; // hard floor on inter-hit spacing (~240 jumps/min ceiling)
const HYSTERESIS_FACTOR = 0.65; // must fall below threshold*this before re-arming
const MIN_ABS_THRESHOLD = 0.02; // guards near-silent rooms where stddev ~= 0
const MAX_THRESHOLD = 0.9;
const ATTACK_WINDOW = 8; // frames of short-term average used for the attack/derivative guard
const ATTACK_DELTA_FACTOR = 0.4; // required jump above short-term average, as a fraction of (threshold - baseline)
const HFC_MIN_RATIO = 0.22; // minimum high-frequency-content ratio for a hit to count as percussive
const BASELINE_EMA_TAU_MS = 3000; // slow drift tracking of the noise floor while quiet

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

export function sensitivityToK(sensitivity) {
  // slider 1 (least sensitive) -> k=12, slider 10 (most sensitive) -> k=3
  return 13 - sensitivity;
}

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.stream = null;
    this.audioContext = null;
    this.analyser = null;
    this.timeDomainBuffer = null;
    this.freqBuffer = null;
    this.rafId = null;
    this.baseline = null; // { mean, stddev }
    this.baselineEma = null;
    this.threshold = MIN_ABS_THRESHOLD;
    this.sensitivity = 6;
    this.state = "BELOW";
    this.lastHitTime = 0;
    this.recentRms = [];
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
    source.connect(this.analyser);

    this.timeDomainBuffer = new Float32Array(this.analyser.fftSize);
    this.freqBuffer = new Uint8Array(this.analyser.frequencyBinCount);

    document.addEventListener("visibilitychange", this._onVisibilityChange);
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

  calibrate(durationMs = 2500) {
    return new Promise((resolve) => {
      const samples = [];
      const startTime = performance.now();

      const tick = () => {
        const rms = this._readRms();
        samples.push(rms);
        const elapsed = performance.now() - startTime;
        const progress = Math.min(1, elapsed / durationMs);
        this.dispatchEvent(new CustomEvent("calibration-progress", { detail: { progress } }));

        if (elapsed < durationMs) {
          this.rafId = requestAnimationFrame(tick);
        } else {
          const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
          const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
          const stddev = Math.sqrt(variance);
          const max = Math.max(...samples);
          this.baseline = { mean, stddev, max };
          this.baselineEma = mean;
          this._recomputeThreshold();
          this.dispatchEvent(new CustomEvent("calibration-done", { detail: { ...this.baseline } }));
          resolve(this.baseline);
        }
      };

      this.rafId = requestAnimationFrame(tick);
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
    this.sensitivity = sensitivity;
    this._recomputeThreshold();
  }

  startCounting() {
    this.state = "BELOW";
    this.lastHitTime = 0;
    this.recentRms = [];

    const tick = () => {
      const rms = this._readRms();
      this.dispatchEvent(new CustomEvent("level", { detail: { rms, threshold: this.threshold } }));

      const shortTermAvg =
        this.recentRms.length > 0
          ? this.recentRms.reduce((a, b) => a + b, 0) / this.recentRms.length
          : rms;

      const now = performance.now();
      const aboveThreshold = rms > this.threshold;
      const belowRearm = rms < this.threshold * HYSTERESIS_FACTOR;

      if (this.state === "BELOW" && aboveThreshold && now - this.lastHitTime > REFRACTORY_MS) {
        const attackDelta = rms - shortTermAvg;
        const requiredDelta =
          (this.threshold - (this.baselineEma ?? this.baseline?.mean ?? 0)) * ATTACK_DELTA_FACTOR;
        const hasSharpAttack = attackDelta >= requiredDelta;

        this.analyser.getByteFrequencyData(this.freqBuffer);
        const hfcRatio = computeHfcRatio(this.freqBuffer);
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

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  stopCounting() {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  stop() {
    this.stopCounting();
    document.removeEventListener("visibilitychange", this._onVisibilityChange);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.audioContext?.close();
    this.stream = null;
    this.audioContext = null;
    this.analyser = null;
  }
}
