const SESSIONS_KEY = "ropitone:v1:sessions";
const SETTINGS_KEY = "ropitone:v1:settings";
const MAX_SESSIONS = 200;
const DEFAULT_SETTINGS = { sensitivity: 6 };

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // quota exceeded or storage unavailable (e.g. private mode) — fail silently, data just won't persist
  }
}

export function loadSessions() {
  return readJson(SESSIONS_KEY, []);
}

export function saveSession(session) {
  const sessions = loadSessions();
  sessions.unshift(session);
  if (sessions.length > MAX_SESSIONS) sessions.length = MAX_SESSIONS;
  writeJson(SESSIONS_KEY, sessions);
  return sessions;
}

export function getBestScore() {
  const sessions = loadSessions();
  return sessions.reduce((best, s) => Math.max(best, s.count), 0);
}

export function clearHistory() {
  writeJson(SESSIONS_KEY, []);
}

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_KEY, {}) };
}

export function saveSettings(settings) {
  writeJson(SETTINGS_KEY, { ...loadSettings(), ...settings });
}

export function makeSession({ count, durationSeconds, sensitivity }) {
  return {
    id: crypto.randomUUID(),
    date: new Date().toISOString(),
    count,
    durationSeconds,
    jumpsPerMinute: durationSeconds > 0 ? Math.round((count / durationSeconds) * 60) : 0,
    sensitivity,
  };
}
