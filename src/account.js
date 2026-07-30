const ACCOUNTS_KEY = "invidious-fe:accounts";
const CURRENT_ACCOUNT_KEY = "invidious-fe:account";
const PENDING_OPS_KEY = "invidious-fe:account-pending";
const PROGRESS_SAVE_THRESHOLD = 3;
const PROGRESS_COMPLETE_THRESHOLD = 5;
const FLUSH_DELAY = 400;
const FLUSH_RETRY_DELAY = 5000;

function readJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function normalizeName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ");
}

function accountKey(name) {
  return normalizeName(name).toLowerCase();
}

function normalizeProgressEntry(videoId, entry = {}) {
  const currentTime = Math.max(0, Number(entry.currentTime || 0));
  const duration = Math.max(0, Number(entry.duration || 0));
  const updatedAt = Number(entry.updatedAt || 0) || Date.now();

  return {
    videoId,
    title: String(entry.title || ""),
    author: String(entry.author || ""),
    thumbnail: String(entry.thumbnail || ""),
    currentTime,
    duration,
    updatedAt
  };
}

function normalizeAccount(account = {}, fallbackName = "") {
  const name = normalizeName(account.name || fallbackName);
  const progress = Object.fromEntries(
    Object.entries(account.progress || {})
      .filter(([videoId]) => typeof videoId === "string" && videoId)
      .map(([videoId, entry]) => [videoId, normalizeProgressEntry(videoId, entry)])
  );

  return { name, progress };
}

let cachedAccount = null;
let flushChain = Promise.resolve();
let flushTimer = 0;
let retryTimer = 0;
let opCounter = 0;

// Every change is queued as a single operation (upsert / remove / clear) and merged by the
// backend, instead of uploading the whole progress map. Uploading the map made two requests
// race: whichever one happened to arrive last won, so a slightly older map silently rolled
// the history back, and a request lost on page navigation dropped the video for good.

function readPendingOps(key) {
  const queue = readJson(PENDING_OPS_KEY, {});
  const ops = Array.isArray(queue[key]) ? queue[key] : [];
  return ops.filter((op) => op && typeof op === "object" && typeof op.type === "string");
}

function writePendingOps(key, ops) {
  const queue = readJson(PENDING_OPS_KEY, {});
  if (ops.length) queue[key] = ops;
  else delete queue[key];
  writeJson(PENDING_OPS_KEY, queue);
}

function queueOp(key, op) {
  // A clear supersedes everything queued before it, and a newer change for one video
  // supersedes the pending change for that same video.
  const pending = op.type === "clear"
    ? []
    : readPendingOps(key).filter((queued) => queued.videoId !== op.videoId);

  pending.push({ ...op, id: `${Date.now()}-${++opCounter}` });
  writePendingOps(key, pending);
  scheduleFlush(key);
}

function applyOps(progress, ops) {
  let merged = { ...progress };

  for (const op of ops) {
    if (op.type === "clear") {
      merged = {};
    } else if (op.type === "remove" && op.videoId) {
      delete merged[op.videoId];
    } else if (op.type === "upsert" && op.entry?.videoId) {
      const entry = normalizeProgressEntry(op.entry.videoId, op.entry);
      const existing = merged[entry.videoId];
      if (!existing || Number(existing.updatedAt || 0) <= entry.updatedAt) {
        merged[entry.videoId] = entry;
      }
    }
  }

  return merged;
}

function accountNameFor(key) {
  if (cachedAccount && accountKey(cachedAccount.name) === key) return cachedAccount.name;
  const backup = readJson(ACCOUNTS_KEY, {});
  return normalizeName(backup[key]?.name) || key;
}

function scheduleFlush(key, delay = FLUSH_DELAY) {
  if (flushTimer) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = 0;
    flushPendingOps(key);
  }, delay);
}

function scheduleRetry(key) {
  if (retryTimer) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = 0;
    flushPendingOps(key);
  }, FLUSH_RETRY_DELAY);
}

// Requests are chained so only one is ever in flight: the backend applies operations in the
// order they were made, and nothing can arrive out of order.
function flushPendingOps(key, { keepalive = false } = {}) {
  flushChain = flushChain
    .then(() => sendPendingOps(key, keepalive))
    .catch((err) => {
      console.error("Failed to save progress to backend, keeping it queued:", err);
      scheduleRetry(key);
    });
  return flushChain;
}

async function sendPendingOps(key, keepalive) {
  const ops = readPendingOps(key);
  if (!ops.length) return;

  const response = await fetch(`/api/custom-accounts?name=${encodeURIComponent(accountNameFor(key))}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ops }),
    keepalive
  });

  if (!response.ok) {
    throw new Error(`Backend refused the update (HTTP ${response.status})`);
  }

  // Drop only what this request carried: more changes may have queued up while it was in flight.
  const sent = new Set(ops.map((op) => op.id));
  writePendingOps(key, readPendingOps(key).filter((op) => !sent.has(op.id)));
}

function flushOnHide() {
  const key = getCurrentAccountKey();
  if (!key || !readPendingOps(key).length) return;

  if (flushTimer) {
    window.clearTimeout(flushTimer);
    flushTimer = 0;
  }
  flushPendingOps(key, { keepalive: true });
}

window.addEventListener("pagehide", flushOnHide);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushOnHide();
});

export async function initAccount(name) {
  const normalized = normalizeName(name);
  const key = accountKey(normalized);
  if (!key) {
    cachedAccount = null;
    return null;
  }

  let account = null;

  try {
    const response = await fetch(`/api/custom-accounts?name=${encodeURIComponent(normalized)}`);
    if (response.ok) {
      const data = await response.json();
      if (data && typeof data === "object") account = normalizeAccount(data, normalized);
    } else {
      console.warn(`Backend returned HTTP ${response.status} for the account, using local backup.`);
    }
  } catch (err) {
    console.warn("Failed to fetch account from backend, using local backup:", err);
  }

  if (!account) {
    const backup = readJson(ACCOUNTS_KEY, {});
    account = backup[key] ? normalizeAccount(backup[key], normalized) : { name: normalized, progress: {} };
  }

  // Changes that never reached the backend are still queued, so replay them on top of the
  // server state instead of letting the download discard them.
  account.progress = applyOps(account.progress, readPendingOps(key));
  cachedAccount = account;
  writeJson(ACCOUNTS_KEY, { [key]: cachedAccount });
  scheduleFlush(key);
  return cachedAccount;
}

function loadAccount(key) {
  if (cachedAccount && accountKey(cachedAccount.name) === key) return cachedAccount;

  const backup = readJson(ACCOUNTS_KEY, {});
  if (backup[key]) {
    cachedAccount = normalizeAccount(backup[key], key);
    cachedAccount.progress = applyOps(cachedAccount.progress, readPendingOps(key));
    return cachedAccount;
  }

  return null;
}

function commitLocalAccount(key, account) {
  cachedAccount = account;
  writeJson(ACCOUNTS_KEY, { [key]: account });
}

export function getCurrentAccountKey() {
  return accountKey(localStorage.getItem(CURRENT_ACCOUNT_KEY) || "");
}

function dispatchAccountChange() {
  const detail = getCurrentAccount();
  window.dispatchEvent(new CustomEvent("accountchange", { detail }));
  return detail;
}

function dispatchProgressChange(detail) {
  window.dispatchEvent(new CustomEvent("accountprogresschange", { detail }));
}

export function getCurrentAccount() {
  const key = getCurrentAccountKey();
  if (!key) return null;

  const account = loadAccount(key);
  if (!account?.name) return null;

  return {
    id: key,
    name: account.name,
    progress: account.progress,
    progressCount: Object.keys(account.progress).length
  };
}

export async function signIn(name) {
  const normalizedName = normalizeName(name);
  const key = accountKey(normalizedName);
  if (!key) return null;

  localStorage.setItem(CURRENT_ACCOUNT_KEY, key);
  await initAccount(normalizedName);
  return dispatchAccountChange();
}

export function signOut() {
  const key = getCurrentAccountKey();
  if (key) flushPendingOps(key);

  localStorage.removeItem(CURRENT_ACCOUNT_KEY);
  cachedAccount = null;
  return dispatchAccountChange();
}

export function getVideoProgress(videoId) {
  const account = getCurrentAccount();
  if (!account || !videoId) return null;
  return account.progress[videoId] || null;
}

export function listVideoProgress() {
  const account = getCurrentAccount();
  if (!account) return [];

  return Object.values(account.progress)
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
}

export function saveVideoProgress(entry = {}) {
  const key = getCurrentAccountKey();
  const videoId = String(entry.videoId || "");
  if (!key || !videoId) return false;

  const account = normalizeAccount(loadAccount(key) || { name: key }, key);
  const progressEntry = normalizeProgressEntry(videoId, { ...entry, updatedAt: Date.now() });
  const finished = progressEntry.duration > 0
    && progressEntry.currentTime >= Math.max(progressEntry.duration - PROGRESS_COMPLETE_THRESHOLD, PROGRESS_SAVE_THRESHOLD);

  if (finished) {
    if (account.progress[videoId]) {
      delete account.progress[videoId];
      commitLocalAccount(key, account);
      queueOp(key, { type: "remove", videoId });
    }
  } else if (progressEntry.currentTime >= PROGRESS_SAVE_THRESHOLD) {
    account.progress[videoId] = progressEntry;
    commitLocalAccount(key, account);
    queueOp(key, { type: "upsert", videoId, entry: progressEntry });
  }

  dispatchProgressChange({ account: account.name, videoId, progress: account.progress[videoId] || null });
  return true;
}

export function clearVideoProgress(videoId) {
  const key = getCurrentAccountKey();
  if (!key || !videoId) return false;

  const account = normalizeAccount(loadAccount(key) || { name: key }, key);
  if (!account.progress[videoId]) return false;

  delete account.progress[videoId];
  commitLocalAccount(key, account);
  queueOp(key, { type: "remove", videoId });
  dispatchProgressChange({ account: account.name, videoId, progress: null });
  return true;
}

export function clearAccountProgress() {
  const key = getCurrentAccountKey();
  if (!key) return false;

  const account = normalizeAccount(loadAccount(key) || { name: key }, key);
  account.progress = {};
  commitLocalAccount(key, account);
  queueOp(key, { type: "clear" });
  dispatchProgressChange({ account: account.name, videoId: null, progress: null });
  return true;
}
