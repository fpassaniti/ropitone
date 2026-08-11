import {
  AudioEngine,
  sensitivityToK,
  sensitivityToGain,
  REFRACTORY_MS,
  HYSTERESIS_FACTOR,
  FLUX_WINDOW_FRAMES,
  FLUX_FLOOR_DECAY_FACTOR,
  FLUX_ABS_FLOOR_STDDEV_MULT,
  FLUX_PEAK_MARGIN_FACTOR,
} from "./audio.js";
import { WakeLockController } from "./wakelock.js";
import * as ui from "./ui.js";
import * as storage from "./storage.js";

const CALIBRATION_MS = 2500;
const GET_READY_SECONDS = 3;

const wakeLock = new WakeLockController();
const debugEnabled = new URLSearchParams(location.search).has("debug");
const debugPanel = document.querySelector('[data-role="debug-panel"]');
const debugText = document.querySelector('[data-role="debug-text"]');
const debugRefractoryInput = document.querySelector('[data-role="debug-refractory-input"]');
const debugHysteresisInput = document.querySelector('[data-role="debug-hysteresis-input"]');
const debugModeSelect = document.querySelector('[data-role="debug-mode-select"]');
const debugFluxWindowInput = document.querySelector('[data-role="debug-flux-window-input"]');
const debugFluxDecayInput = document.querySelector('[data-role="debug-flux-decay-input"]');
const debugFluxFloorInput = document.querySelector('[data-role="debug-flux-floor-input"]');
const debugFluxMarginInput = document.querySelector('[data-role="debug-flux-margin-input"]');

let audioEngine = null;
let sessionStartTime = 0;
let timerIntervalId = null;
let hitCount = 0;
let currentSensitivity = 6;
let lastHitTimestamp = null;
let debugRefractoryMs = REFRACTORY_MS;
let debugHysteresisFactor = HYSTERESIS_FACTOR;
let debugDetectionMode = "legacy";
let debugFluxWindowFrames = FLUX_WINDOW_FRAMES;
let debugFluxDecayFactor = FLUX_FLOOR_DECAY_FACTOR;
let debugFluxAbsFloorMult = FLUX_ABS_FLOOR_STDDEV_MULT;
let debugFluxPeakMargin = FLUX_PEAK_MARGIN_FACTOR;

function init() {
  if (debugEnabled) {
    debugPanel.hidden = false;
    debugRefractoryInput.value = String(debugRefractoryMs);
    debugHysteresisInput.value = String(debugHysteresisFactor);
    debugRefractoryInput.addEventListener("input", () => {
      const value = Number(debugRefractoryInput.value);
      if (Number.isFinite(value) && value >= 0) {
        debugRefractoryMs = value;
        audioEngine?.setRefractoryMs(value);
      }
    });
    debugHysteresisInput.addEventListener("input", () => {
      const value = Number(debugHysteresisInput.value);
      if (Number.isFinite(value) && value >= 0) {
        debugHysteresisFactor = value;
        audioEngine?.setHysteresisFactor(value);
      }
    });

    debugModeSelect.value = debugDetectionMode;
    debugFluxWindowInput.value = String(debugFluxWindowFrames);
    debugFluxDecayInput.value = String(debugFluxDecayFactor);
    debugFluxFloorInput.value = String(debugFluxAbsFloorMult);
    debugFluxMarginInput.value = String(debugFluxPeakMargin);

    debugModeSelect.addEventListener("change", () => {
      debugDetectionMode = debugModeSelect.value;
      audioEngine?.setDetectionMode(debugDetectionMode);
    });
    debugFluxWindowInput.addEventListener("input", () => {
      const value = Number(debugFluxWindowInput.value);
      if (Number.isFinite(value) && value >= 1) {
        debugFluxWindowFrames = value;
        audioEngine?.setFluxWindowFrames(value);
      }
    });
    debugFluxDecayInput.addEventListener("input", () => {
      const value = Number(debugFluxDecayInput.value);
      if (Number.isFinite(value) && value >= 0 && value <= 1) {
        debugFluxDecayFactor = value;
        audioEngine?.setFluxFloorDecayFactor(value);
      }
    });
    debugFluxFloorInput.addEventListener("input", () => {
      const value = Number(debugFluxFloorInput.value);
      if (Number.isFinite(value) && value >= 0) {
        debugFluxAbsFloorMult = value;
        audioEngine?.setFluxAbsFloorMultiplier(value);
      }
    });
    debugFluxMarginInput.addEventListener("input", () => {
      const value = Number(debugFluxMarginInput.value);
      if (Number.isFinite(value) && value >= 0) {
        debugFluxPeakMargin = value;
        audioEngine?.setFluxPeakMarginFactor(value);
      }
    });
  }

  const settings = storage.loadSettings();
  currentSensitivity = settings.sensitivity;
  ui.setSensitivityValue(currentSensitivity);
  ui.setBestScore(storage.getBestScore());
  ui.init({
    onStart: handleStart,
    onStop: handleStop,
    onNewSession: handleNewSession,
    onShowHistory: handleShowHistory,
    onBackToIdle: handleBackToIdle,
    onClearHistory: handleClearHistory,
    onResetTrip: handleResetTrip,
    onSensitivityChange: handleSensitivityChange,
    onShareScore: handleShareScore,
    onShareBest: handleShareBest,
    onShareAlltime: handleShareAlltime,
    onShareTrip: handleShareTrip,
  });
  ui.setState("idle");
}

async function handleStart() {
  ui.setIdleError(null);
  audioEngine = new AudioEngine();
  audioEngine.setSensitivity(currentSensitivity);
  if (debugEnabled) {
    audioEngine.setRefractoryMs(debugRefractoryMs);
    audioEngine.setHysteresisFactor(debugHysteresisFactor);
    audioEngine.setFluxWindowFrames(debugFluxWindowFrames);
    audioEngine.setFluxFloorDecayFactor(debugFluxDecayFactor);
    audioEngine.setFluxAbsFloorMultiplier(debugFluxAbsFloorMult);
    audioEngine.setFluxPeakMarginFactor(debugFluxPeakMargin);
    audioEngine.setDetectionMode(debugDetectionMode);
  }

  try {
    await audioEngine.start();
  } catch (err) {
    ui.setIdleError(describeError(err));
    audioEngine = null;
    return;
  }

  await wakeLock.request();

  ui.setState("calibrating");
  ui.setCalibrationProgress(0);
  audioEngine.addEventListener("calibration-progress", (e) => ui.setCalibrationProgress(e.detail.progress));
  await audioEngine.calibrate(CALIBRATION_MS);

  await runGetReadyCountdown();

  startCountingSession();
}

function describeError(err) {
  if (err?.name === "NotAllowedError") {
    return "Permission micro refusée. Autorise l'accès au micro pour compter les sauts.";
  }
  if (err?.name === "NotFoundError") {
    return "Aucun micro détecté sur cet appareil.";
  }
  if (!window.isSecureContext) {
    return "Cette page doit être servie en HTTPS (ou localhost) pour accéder au micro.";
  }
  return "Impossible d'accéder au micro. Réessaie.";
}

function runGetReadyCountdown() {
  return new Promise((resolve) => {
    ui.setState("get-ready");
    let count = GET_READY_SECONDS;
    ui.setCountdown(count);
    const intervalId = setInterval(() => {
      count -= 1;
      if (count <= 0) {
        clearInterval(intervalId);
        resolve();
      } else {
        ui.setCountdown(count);
      }
    }, 1000);
  });
}

function startCountingSession() {
  hitCount = 0;
  lastHitTimestamp = null;
  ui.setCounter(0);
  ui.setTimer(0);
  ui.setPace(0);
  ui.setState("counting");

  sessionStartTime = performance.now();

  audioEngine.addEventListener("hit", onHit);
  audioEngine.addEventListener("level", onLevel);
  audioEngine.startCounting();

  timerIntervalId = setInterval(updateTimerAndPace, 200);
}

function onHit(e) {
  hitCount += 1;
  ui.setCounter(hitCount);
  ui.pulse();
  lastHitTimestamp = e.detail.timestamp;
}

function onLevel(e) {
  const ratio =
    e.detail.mode === "flux"
      ? e.detail.fluxThreshold > 0 ? e.detail.flux / e.detail.fluxThreshold : 0
      : e.detail.threshold > 0 ? e.detail.rms / e.detail.threshold : 0;
  ui.setMicLevel(ratio);
  if (debugEnabled) renderDebugPanel(e.detail);
}

function renderDebugPanel(d) {
  const interval = lastHitTimestamp != null ? Math.round(performance.now() - lastHitTimestamp) : "-";
  const header = `sensibilité: ${currentSensitivity} (k=${sensitivityToK(currentSensitivity).toFixed(2)}, gain=${sensitivityToGain(currentSensitivity).toFixed(2)}x)  algo: ${d.mode}\n`;

  if (d.mode === "flux") {
    debugText.textContent =
      header +
      `flux: ${d.flux.toFixed(2)}  seuil: ${d.fluxThreshold.toFixed(2)}  plancher: ${d.fluxFloor.toFixed(2)}  écart-type: ${d.windowStddev.toFixed(2)}\n` +
      `dernier hit il y a: ${interval}ms  total: ${hitCount}`;
    return;
  }

  debugText.textContent =
    header +
    `rms: ${d.rms.toFixed(4)}  seuil: ${d.threshold.toFixed(4)}  hystérésis: ${d.hysteresisThreshold.toFixed(4)}\n` +
    `état: ${d.state}  hfc: ${d.hfcRatio.toFixed(2)}  attaque: ${d.attackDelta.toFixed(4)}/${d.requiredDelta.toFixed(4)}\n` +
    `dernier hit il y a: ${interval}ms  total: ${hitCount}`;
}

function updateTimerAndPace() {
  const elapsedSeconds = (performance.now() - sessionStartTime) / 1000;
  ui.setTimer(elapsedSeconds);
  const jumpsPerMinute = elapsedSeconds > 0 ? Math.round((hitCount / elapsedSeconds) * 60) : 0;
  ui.setPace(jumpsPerMinute);
}

function handleStop() {
  clearInterval(timerIntervalId);
  timerIntervalId = null;

  const durationSeconds = (performance.now() - sessionStartTime) / 1000;

  audioEngine.stopCounting();
  audioEngine.stop();
  audioEngine = null;
  wakeLock.release();

  const previousBest = storage.getBestScore();
  const isNewBest = hitCount > previousBest && hitCount > 0;
  const session = storage.makeSession({ count: hitCount, durationSeconds, sensitivity: currentSensitivity });
  storage.saveSession(session);

  ui.setBestScore(storage.getBestScore());
  ui.setSummary({ count: hitCount, durationSeconds, jumpsPerMinute: session.jumpsPerMinute, isNewBest });
  ui.setState("summary");
}

async function shareText(message, button) {
  if ("share" in navigator) {
    try {
      await navigator.share({ text: message });
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
    return;
  }

  if ("clipboard" in navigator && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(message);
      ui.showCopiedFeedback(button);
    } catch {
      // écriture presse-papiers refusée/indisponible — rien à afficher
    }
  }
}

function handleShareScore(button) {
  shareText(`Aujourd'hui, j'ai fait ${hitCount} sauts à la corde, nouveau record ! 🏆`, button);
}

function handleShareBest(button) {
  shareText(`Mon record à la corde : ${storage.getBestScore()} sauts ! 🏆`, button);
}

function handleShareAlltime(button) {
  shareText(`J'ai fait ${storage.getStats().allTimeTotal} sauts à la corde au total ! 🏆`, button);
}

function handleShareTrip(button) {
  shareText(`${storage.getStats().tripTotal} sauts à la corde sur mon compteur en cours ! 🏆`, button);
}

function handleNewSession() {
  ui.setState("idle");
}

function handleShowHistory() {
  ui.renderHistory(storage.loadSessions());
  ui.setBestScore(storage.getBestScore());
  ui.setStats(storage.getStats());
  ui.setState("history");
}

function handleBackToIdle() {
  ui.setState("idle");
}

function handleClearHistory() {
  if (!window.confirm("Effacer tout l'historique des sessions ? Cette action est irréversible.")) return;
  storage.clearHistory();
  storage.resetStats();
  ui.renderHistory([]);
  ui.setBestScore(storage.getBestScore());
  ui.setStats(storage.getStats());
}

function handleResetTrip() {
  ui.setStats(storage.resetTrip());
}

function handleSensitivityChange(value) {
  currentSensitivity = value;
  storage.saveSettings({ sensitivity: value });
  audioEngine?.setSensitivity(value);
}

init();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
