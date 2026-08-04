const appEl = document.getElementById("app");

const el = {
  bestScore: document.querySelector('[data-role="best-score"]'),
  sensitivitySlider: document.querySelector('[data-role="sensitivity-slider"]'),
  sensitivitySliderLive: document.querySelector('[data-role="sensitivity-slider-live"]'),
  idleError: document.querySelector('[data-role="idle-error"]'),
  calibrationProgress: document.querySelector('[data-role="calibration-progress"]'),
  countdown: document.querySelector('[data-role="countdown"]'),
  pulse: document.querySelector('[data-role="pulse"]'),
  counter: document.querySelector('[data-role="counter"]'),
  timer: document.querySelector('[data-role="timer"]'),
  pace: document.querySelector('[data-role="pace"]'),
  micLevel: document.querySelector('[data-role="mic-level"]'),
  summaryCount: document.querySelector('[data-role="summary-count"]'),
  summaryDetails: document.querySelector('[data-role="summary-details"]'),
  newBestRow: document.querySelector('[data-role="new-best-row"]'),
  historyBestScore: document.querySelector('[data-role="history-best-score"]'),
  historyList: document.querySelector('[data-role="history-list"]'),
  historyEmpty: document.querySelector('[data-role="history-empty"]'),
  alltimeTotal: document.querySelector('[data-role="alltime-total"]'),
  tripTotal: document.querySelector('[data-role="trip-total"]'),
  tripMeta: document.querySelector('[data-role="trip-meta"]'),
};

let pulseTimeoutId = null;

export function init(actions) {
  document.querySelectorAll("[data-action]").forEach((button) => {
    const action = button.dataset.action;
    button.addEventListener("click", () => actions[toCamelCase("on-" + action)]?.(button));
  });

  el.sensitivitySlider.addEventListener("input", (e) => {
    const value = Number(e.target.value);
    el.sensitivitySliderLive.value = value;
    actions.onSensitivityChange?.(value);
  });
  el.sensitivitySliderLive.addEventListener("input", (e) => {
    const value = Number(e.target.value);
    el.sensitivitySlider.value = value;
    actions.onSensitivityChange?.(value);
  });
}

function toCamelCase(str) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function setState(state) {
  appEl.dataset.state = state;
}

export function setSensitivityValue(value) {
  el.sensitivitySlider.value = value;
  el.sensitivitySliderLive.value = value;
}

export function setBestScore(count) {
  const text = count > 0 ? `${count} sauts` : "—";
  el.bestScore.textContent = text;
  el.historyBestScore.textContent = text;
}

export function setIdleError(message) {
  el.idleError.hidden = !message;
  el.idleError.textContent = message || "";
}

export function setCalibrationProgress(progress) {
  const degrees = Math.round(progress * 360);
  el.calibrationProgress.style.background = `conic-gradient(var(--accent) ${degrees}deg, var(--panel) ${degrees}deg)`;
}

export function setCountdown(value) {
  el.countdown.textContent = String(value);
}

export function setCounter(count) {
  el.counter.textContent = String(count);
}

export function setTimer(seconds) {
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(Math.floor(seconds % 60)).padStart(2, "0");
  el.timer.textContent = `${mm}:${ss}`;
}

export function setPace(jumpsPerMinute) {
  el.pace.textContent = `${jumpsPerMinute} sauts/min`;
}

export function setMicLevel(ratio) {
  el.micLevel.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
}

export function pulse() {
  el.pulse.classList.remove("active");
  // force reflow so the animation restarts even on rapid consecutive hits
  void el.pulse.offsetWidth;
  el.pulse.classList.add("active");
  clearTimeout(pulseTimeoutId);
  pulseTimeoutId = setTimeout(() => el.pulse.classList.remove("active"), 180);
}

export function setSummary({ count, durationSeconds, jumpsPerMinute, isNewBest }) {
  el.summaryCount.textContent = String(count);
  const mm = String(Math.floor(durationSeconds / 60)).padStart(2, "0");
  const ss = String(Math.floor(durationSeconds % 60)).padStart(2, "0");
  el.summaryDetails.textContent = `${mm}:${ss} · ${jumpsPerMinute} sauts/min`;
  el.newBestRow.hidden = !isNewBest;
}

export function showCopiedFeedback(button) {
  button.dataset.copied = "true";
  setTimeout(() => {
    delete button.dataset.copied;
  }, 1500);
}

export function setStats({ allTimeTotal, tripTotal, tripStartDate }) {
  el.alltimeTotal.textContent = `${allTimeTotal} sauts`;
  el.tripTotal.textContent = `${tripTotal} sauts`;
  el.tripMeta.textContent = tripStartDate ? `depuis le ${new Date(tripStartDate).toLocaleDateString()}` : "";
}

export function renderHistory(sessions) {
  el.historyList.innerHTML = "";
  el.historyEmpty.hidden = sessions.length > 0;

  for (const session of sessions) {
    const li = document.createElement("li");
    li.className = "history-item";
    const date = new Date(session.date);
    const dateLabel = date.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });
    const timeLabel = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    li.innerHTML = `
      <span class="history-item-count">${session.count} sauts</span>
      <span class="history-item-meta">${dateLabel} ${timeLabel} · ${session.jumpsPerMinute}/min</span>
    `;
    el.historyList.appendChild(li);
  }
}
