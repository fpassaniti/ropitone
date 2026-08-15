const SESSIONS_KEY = "ropitone:v1:sessions";
const SETTINGS_KEY = "ropitone:v1:settings";
const STATS_KEY = "ropitone:v1:stats";
const MAX_SESSIONS = 200;
const DEFAULT_SETTINGS = { sensitivity: 6, algoMode: "flux" };
const DEFAULT_STATS = { allTimeTotal: 0, tripTotal: 0, tripStartDate: null };

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

  const stats = getStats();
  stats.allTimeTotal += session.count;
  stats.tripTotal += session.count;
  if (!stats.tripStartDate) stats.tripStartDate = new Date().toISOString();
  writeJson(STATS_KEY, stats);

  return sessions;
}

export function getBestScore() {
  const sessions = loadSessions();
  return sessions.reduce((best, s) => Math.max(best, s.count), 0);
}

export function clearHistory() {
  writeJson(SESSIONS_KEY, []);
}

export function resetStats() {
  writeJson(STATS_KEY, { ...DEFAULT_STATS });
  return { ...DEFAULT_STATS };
}

export function getStats() {
  return { ...DEFAULT_STATS, ...readJson(STATS_KEY, {}) };
}

export function resetTrip() {
  const stats = getStats();
  stats.tripTotal = 0;
  stats.tripStartDate = new Date().toISOString();
  writeJson(STATS_KEY, stats);
  return stats;
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
