import { AudioEngine } from "./audio.js";
import { WakeLockController } from "./wakelock.js";
import * as ui from "./ui.js";
import * as storage from "./storage.js";

const CALIBRATION_MS = 2500;
const GET_READY_SECONDS = 3;

const wakeLock = new WakeLockController();

let audioEngine = null;
let sessionStartTime = 0;
let timerIntervalId = null;
let hitCount = 0;
let currentSensitivity = 6;

function init() {
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
    onSensitivityChange: handleSensitivityChange,
  });
  ui.setState("idle");
}

async function handleStart() {
  ui.setIdleError(null);
  audioEngine = new AudioEngine();
  audioEngine.setSensitivity(currentSensitivity);

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

function onHit() {
  hitCount += 1;
  ui.setCounter(hitCount);
  ui.pulse();
}

function onLevel(e) {
  const ratio = e.detail.threshold > 0 ? e.detail.rms / e.detail.threshold : 0;
  ui.setMicLevel(ratio);
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

function handleNewSession() {
  ui.setState("idle");
}

function handleShowHistory() {
  ui.renderHistory(storage.loadSessions());
  ui.setBestScore(storage.getBestScore());
  ui.setState("history");
}

function handleBackToIdle() {
  ui.setState("idle");
}

function handleClearHistory() {
  storage.clearHistory();
  ui.renderHistory([]);
  ui.setBestScore(storage.getBestScore());
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
