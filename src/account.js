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
  return String(name || "").trim().replace(/\s+/g, " ");
}

function accountKey(name) {
  return normalizeName(name).toLowerCase();
}

function normalizeProgressEntry(videoId, entry = {}) {
  return {
    videoId,
    title: String(entry.title || ""),
    author: String(entry.author || ""),
    thumbnail: String(entry.thumbnail || ""),
    currentTime: Math.max(0, Number(entry.currentTime || 0)),
    duration: Math.max(0, Number(entry.duration || 0)),
    updatedAt: Number(entry.updatedAt || 0)
  };
}

function normalizeAccount(account = {}, fallbackName = "") {
  return {
    name: normalizeName(account.name || fallbackName),
    progress: Object.fromEntries(Object.entries(account.progress || {})
      .map(([videoId, entry]) => [videoId, normalizeProgressEntry(videoId, entry)])),
    revisions: { ...account.revisions },
    lastOperations: { ...account.lastOperations }
  };
}

function videoRevision(account, videoId) {
  const value = account?.revisions?.[videoId];
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function newId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const uiWriter = newId();
let cachedAccount = null;
let flushChain = Promise.resolve();
let refreshPromise = null;
const flushTimers = new Map();
const retryTimers = new Map();

function readPendingOps(key) {
  const queue = readJson(PENDING_OPS_KEY, {});
  const ops = Array.isArray(queue[key]) ? queue[key] : [];
  // Unversioned writes from an older client cannot safely be replayed after an upgrade.
  return ops.filter((op) => op && (op.type === "upsert" || op.type === "remove")
    && typeof op.id === "string" && typeof op.videoId === "string"
    && Number.isSafeInteger(op.expectedRevision) && op.expectedRevision >= 0);
}

function writePendingOps(key, ops) {
  const queue = readJson(PENDING_OPS_KEY, {});
  if (ops.length) queue[key] = ops;
  else delete queue[key];
  writeJson(PENDING_OPS_KEY, queue);
}

function queueOp(key, op) {
  const pending = readPendingOps(key);
  const previous = pending.findLast((queued) => queued.videoId === op.videoId);
  // Keep attempted operations until acknowledged, including after a network failure.
  // Otherwise a lost response would also lose the ID needed for an idempotent retry.
  const next = pending.filter((queued) => queued.videoId !== op.videoId || queued.attempted);
  const canDepend = previous && (previous.writerId === op.writerId || op.writerId === uiWriter);
  const dependsOn = canDepend ? (previous.attempted ? previous.id : previous.dependsOn) : undefined;
  next.push({ ...op, dependsOn, id: newId() });
  writePendingOps(key, next);
  scheduleFlush(key);
}

function applyPending(account, ops) {
  const progress = { ...account.progress };
  for (const op of ops) {
    if (op.expectedRevision !== videoRevision(account, op.videoId)) continue;
    if (op.type === "remove") delete progress[op.videoId];
    else progress[op.videoId] = normalizeProgressEntry(op.videoId, op.entry);
  }
  return { ...account, progress };
}

function accountNameFor(key) {
  if (cachedAccount && accountKey(cachedAccount.name) === key) return cachedAccount.name;
  return normalizeName(readJson(ACCOUNTS_KEY, {})[key]?.name) || key;
}

function scheduleFlush(key, delay = FLUSH_DELAY, timers = flushTimers) {
  if (timers.has(key)) return;
  timers.set(key, window.setTimeout(() => {
    timers.delete(key);
    flushPendingOps(key);
  }, delay));
}

function flushPendingOps(key, { keepalive = false } = {}) {
  flushChain = flushChain.then(() => sendPendingOps(key, keepalive)).catch((err) => {
    console.error("Failed to save progress to backend, keeping it queued:", err);
    scheduleFlush(key, FLUSH_RETRY_DELAY, retryTimers);
  });
  return flushChain;
}

function settlePending(key, account, ops, results) {
  const byId = new Map(results.map((result) => [result.id, result]));
  let pending = readPendingOps(key);
  for (const op of ops) {
    const result = byId.get(op.id);
    if (!result) continue;
    pending = pending.filter((queued) => queued.id !== op.id).flatMap((queued) => {
      if (queued.videoId !== op.videoId || queued.expectedRevision !== op.expectedRevision) return [queued];
      // Only acknowledge this writer's subsequent changes. A conflict never authorizes
      // replaying an old position with the server's new revision.
      if (result.status === "conflict") return [];
      if (queued.writerId === op.writerId || queued.dependsOn === op.id) {
        return [{ ...queued, expectedRevision: result.revision, dependsOn: undefined }];
      }
      return [queued];
    });
  }
  writePendingOps(key, pending);
  publishAccount(key, account, { ops, results });
}

function publishAccount(key, account, detail = {}) {
  const normalized = normalizeAccount(account, accountNameFor(key));
  commitLocalAccount(key, applyPending(normalized, readPendingOps(key)));
  if (getCurrentAccountKey() !== key) return;
  window.dispatchEvent(new CustomEvent("accountprogresssync", { detail: { key, account: normalized, ...detail } }));
  dispatchProgressChange({ account: normalized.name, videoId: null });
}

async function sendPendingOps(key, keepalive) {
  while (true) {
    const pending = readPendingOps(key);
    // One outstanding operation per video; later writes depend on its acknowledgement.
    const seen = new Set();
    const ops = pending.filter((op) => {
      if (seen.has(op.videoId)) return false;
      seen.add(op.videoId);
      return true;
    });
    if (!ops.length) return;
    const sending = new Set(ops.map((op) => op.id));
    writePendingOps(key, pending.map((op) => sending.has(op.id) ? { ...op, attempted: true } : op));
    const response = await fetch(`/api/custom-accounts?name=${encodeURIComponent(accountNameFor(key))}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ops }),
      keepalive
    });
    if (!response.ok && response.status !== 409) throw new Error(`Backend refused the update (HTTP ${response.status})`);
    const data = await response.json();
    if (!data.account || !Array.isArray(data.results)
      || ops.some((op) => !data.results.some((result) => result.id === op.id))) {
      throw new Error("Backend did not acknowledge progress revisions");
    }
    settlePending(key, data.account, ops, data.results);
  }
}

function flushOnHide() {
  const key = getCurrentAccountKey();
  if (!key || !readPendingOps(key).length) return;
  window.clearTimeout(flushTimers.get(key));
  flushTimers.delete(key);
  flushPendingOps(key, { keepalive: true });
}

async function fetchAccount(key, name) {
  const response = await fetch(`/api/custom-accounts?name=${encodeURIComponent(name)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Backend returned HTTP ${response.status} for the account`);
  const account = normalizeAccount(await response.json(), name);
  // A GET can also recover an acknowledgement whose POST response was lost.
  const seen = new Set();
  const ops = readPendingOps(key).filter((op) => {
    if (seen.has(op.videoId)) return false;
    seen.add(op.videoId);
    return true;
  });
  const results = ops.flatMap((op) => {
    const revision = videoRevision(account, op.videoId);
    if (account.lastOperations[op.videoId] === op.id) return [{ id: op.id, videoId: op.videoId, revision, status: "duplicate" }];
    return op.expectedRevision !== revision ? [{ id: op.id, videoId: op.videoId, revision, status: "conflict" }] : [];
  });
  settlePending(key, account, ops, results);
  return loadAccount(key);
}

export function refreshAccountProgress() {
  const key = getCurrentAccountKey();
  if (!key) return Promise.resolve(null);
  if (refreshPromise) return refreshPromise;
  const name = accountNameFor(key);
  window.dispatchEvent(new CustomEvent("accountprogresssyncstart", { detail: { key } }));
  // Read after outstanding local writes, so a response cannot move the cache backwards.
  flushPendingOps(key);
  const refreshing = flushChain.then(() => fetchAccount(key, name)).catch((err) => {
    console.warn("Failed to refresh account progress:", err);
    return null;
  });
  flushChain = refreshing.then(() => {});
  refreshPromise = refreshing.finally(() => {
    refreshPromise = null;
    window.dispatchEvent(new CustomEvent("accountprogresssyncend", { detail: { key } }));
  });
  return refreshPromise;
}

window.addEventListener("pagehide", flushOnHide);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushOnHide();
  else refreshAccountProgress();
});
window.addEventListener("focus", () => {
  if (document.visibilityState !== "hidden") refreshAccountProgress();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) refreshAccountProgress();
});

export async function initAccount(name) {
  const normalized = normalizeName(name);
  const key = accountKey(normalized);
  if (!key) {
    cachedAccount = null;
    return null;
  }
  try {
    await flushChain;
    await fetchAccount(key, normalized);
  } catch (err) {
    console.warn("Failed to fetch account from backend, using local backup:", err);
    cachedAccount = normalizeAccount(readJson(ACCOUNTS_KEY, {})[key], normalized);
  }
  scheduleFlush(key);
  return loadAccount(key);
}

function loadAccount(key) {
  if (cachedAccount && accountKey(cachedAccount.name) === key) return cachedAccount;
  const backup = readJson(ACCOUNTS_KEY, {});
  if (!backup[key]) return null;
  cachedAccount = applyPending(normalizeAccount(backup[key], key), readPendingOps(key));
  return cachedAccount;
}

function commitLocalAccount(key, account) {
  if (getCurrentAccountKey() === key) cachedAccount = account;
  writeJson(ACCOUNTS_KEY, { ...readJson(ACCOUNTS_KEY, {}), [key]: account });
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
  return { id: key, ...account, progressCount: Object.keys(account.progress).length };
}

export async function signIn(name) {
  const normalized = normalizeName(name);
  const key = accountKey(normalized);
  if (!key) return null;
  localStorage.setItem(CURRENT_ACCOUNT_KEY, key);
  cachedAccount = null;
  await initAccount(normalized);
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
  return getCurrentAccount()?.progress[videoId] || null;
}

export function getVideoProgressRevision(videoId) {
  return videoRevision(getCurrentAccount(), videoId);
}

export function listVideoProgress() {
  return Object.values(getCurrentAccount()?.progress || {}).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveVideoProgress(entry = {}, { expectedRevision, writerId = uiWriter } = {}) {
  const key = getCurrentAccountKey();
  const videoId = String(entry.videoId || "");
  if (!key || !videoId || !Number.isFinite(entry.currentTime)) return false;
  const account = normalizeAccount(loadAccount(key) || { name: key }, key);
  expectedRevision ??= videoRevision(account, videoId);
  if (expectedRevision !== videoRevision(account, videoId)) return false;
  const progressEntry = normalizeProgressEntry(videoId, { ...entry, updatedAt: Date.now() });
  const finished = progressEntry.duration > 0
    && progressEntry.currentTime >= Math.max(progressEntry.duration - PROGRESS_COMPLETE_THRESHOLD, PROGRESS_SAVE_THRESHOLD);
  if (finished) return clearVideoProgress(videoId, { expectedRevision, writerId, force: true });
  if (progressEntry.currentTime < PROGRESS_SAVE_THRESHOLD && !account.progress[videoId]) return false;
  if (account.progress[videoId]?.currentTime === progressEntry.currentTime) return false;
  account.progress[videoId] = progressEntry;
  commitLocalAccount(key, account);
  queueOp(key, { type: "upsert", videoId, entry: progressEntry, expectedRevision, writerId });
  dispatchProgressChange({ account: account.name, videoId, progress: progressEntry });
  return true;
}

export function clearVideoProgress(videoId, { expectedRevision, writerId = uiWriter, force = false } = {}) {
  const key = getCurrentAccountKey();
  if (!key || !videoId) return false;
  const account = normalizeAccount(loadAccount(key) || { name: key }, key);
  expectedRevision ??= videoRevision(account, videoId);
  if (expectedRevision !== videoRevision(account, videoId) || (!force && !account.progress[videoId])) return false;
  delete account.progress[videoId];
  commitLocalAccount(key, account);
  queueOp(key, { type: "remove", videoId, expectedRevision, writerId });
  dispatchProgressChange({ account: account.name, videoId, progress: null });
  return true;
}

export function clearAccountProgress() {
  const account = getCurrentAccount();
  if (!account) return false;
  // Each removal checks its own revision. A stale clear cannot erase newer viewing.
  for (const videoId of Object.keys(account.progress)) clearVideoProgress(videoId);
  return true;
}
