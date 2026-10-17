import { clearVideoProgress, getCurrentAccount, getCurrentAccountKey, getVideoProgressRevision, saveVideoProgress } from "./account.js";
import { assetUrl } from "./api.js";
import { pickThumbnail, secondsToDuration } from "./utils.js";

const resumeTargets = new WeakMap();

// Stream initialization can finish after a remote sync. Its delayed seeks must use
// the new target, and already scheduled seeks to an older target must stop.
export function getProgressResumeTarget(player) {
  return resumeTargets.get(player);
}

// A writer keeps the revision of the position it actually loaded. Refreshing the account
// cache alone must never authorize this player's old position to overwrite newer viewing.
export function installAccountProgress({ player, video, noteElement, initialTime = 0, applyInitialSeek = true }) {
  const account = getCurrentAccount();
  if (!player || !account) {
    if (noteElement) noteElement.textContent = "";
    return () => {};
  }
  const key = account.id;
  const writerId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const thumbnail = assetUrl(pickThumbnail(video.videoThumbnails, 1280));
  let revision = getVideoProgressRevision(video.videoId);
  let targetTime = Math.max(0, Number(initialTime) || 0);
  let lastSavedTime = targetTime;
  let resumeApplied = targetTime === 0;
  let seekEnabled = applyInitialSeek;
  let resumeAttempts = 0;
  let resumeTimer = 0;
  let internalSeek = false;
  let syncing = false;
  let completed = false;
  let stopped = false;
  const listeners = [];
  const listen = (target, name, handler) => {
    target.addEventListener(name, handler);
    listeners.push(() => target.removeEventListener(name, handler));
  };
  const note = (text) => { if (noteElement) noteElement.textContent = text; };
  note(targetTime > 0 ? `Resuming for ${account.name} at ${secondsToDuration(targetTime)}.` : `Saving progress for ${account.name}.`);

  const stopResumeLoop = () => {
    window.clearTimeout(resumeTimer);
    resumeTimer = 0;
  };
  const stop = () => {
    stopped = true;
    stopResumeLoop();
    listeners.splice(0).forEach((remove) => remove());
  };
  const active = () => {
    if (stopped) return false;
    if (!player.isConnected || getCurrentAccountKey() !== key) {
      stop();
      return false;
    }
    return true;
  };
  const applyResume = () => {
    if (!active() || resumeApplied || internalSeek) return;
    const duration = Number(player.duration || 0);
    const safeTime = duration > 0 ? Math.min(targetTime, Math.max(duration - 1, 0)) : targetTime;
    const seekableEnd = player.seekable?.length ? Number(player.seekable.end(player.seekable.length - 1) || 0) : 0;
    if (seekEnabled && (player.readyState >= 1 || duration > 0 || seekableEnd > 0)) {
      internalSeek = true;
      try { player.currentTime = safeTime; } catch { /* Retry when the media is ready. */ }
      finally { internalSeek = false; }
    }
    if (Math.abs(Number(player.currentTime) - safeTime) < 1) {
      resumeApplied = true;
      lastSavedTime = Number(player.currentTime);
      stopResumeLoop();
    } else if (seekEnabled && !resumeTimer && resumeAttempts < 40) {
      resumeTimer = window.setTimeout(() => {
        resumeTimer = 0;
        resumeAttempts += 1;
        applyResume();
      }, 250);
    }
  };

  const persistProgress = (force = false) => {
    if (!active() || syncing || internalSeek || !resumeApplied || player.seeking || player.readyState < 1) return;
    const currentTime = Number(player.currentTime);
    if (!Number.isFinite(currentTime) || Math.abs(currentTime - lastSavedTime) < 0.01) return;
    if (!force && (currentTime < 3 || Math.abs(currentTime - lastSavedTime) < 5)) return;
    const duration = Number(player.duration || video.lengthSeconds || 0);
    const finished = player.ended || (duration > 0 && currentTime >= Math.max(duration - 5, 3));
    if (completed && finished) return;
    const options = { expectedRevision: revision, writerId };
    const saved = player.ended
      ? clearVideoProgress(video.videoId, { ...options, force: true })
      : saveVideoProgress({ videoId: video.videoId, title: video.title, author: video.author, thumbnail, currentTime, duration }, options);
    if (saved) {
      lastSavedTime = currentTime;
      completed = finished;
      if (finished) note(`Finished for ${account.name}.`);
    }
  };

  const handleSync = ({ detail }) => {
    if (!active() || detail.key !== key) return;
    for (const op of detail.ops || []) {
      if (op.videoId !== video.videoId || op.writerId !== writerId || op.expectedRevision !== revision) continue;
      const result = detail.results?.find((item) => item.id === op.id);
      if (result && result.status !== "conflict") revision = result.revision;
    }
    const serverRevision = detail.account.revisions[video.videoId] || 0;
    if (serverRevision === revision) return;
    revision = serverRevision;
    const progress = detail.account.progress[video.videoId];
    targetTime = progress?.currentTime || 0;
    resumeTargets.set(player, { time: targetTime });
    lastSavedTime = targetTime;
    completed = false;
    resumeApplied = false;
    seekEnabled = true;
    resumeAttempts = 0;
    stopResumeLoop();
    // Pause before applying a remote position, including completion/deletion. The pause
    // and programmatic seek must not themselves create a new progress operation.
    internalSeek = true;
    try { player.pause(); } finally { internalSeek = false; }
    applyResume();
    note(progress
      ? `Progress synced for ${account.name} at ${secondsToDuration(targetTime)}.`
      : `This video was finished or removed on another device.`);
  };

  for (const name of ["loadedmetadata", "loadeddata", "canplay", "play", "playing", "seeked", "timeupdate"]) {
    listen(player, name, applyResume);
  }
  listen(player, "timeupdate", () => persistProgress());
  listen(player, "pause", () => persistProgress(true));
  listen(player, "seeked", () => persistProgress(true));
  listen(player, "ended", () => persistProgress(true));
  listen(window, "accountprogresssync", handleSync);
  listen(window, "accountprogresssyncstart", ({ detail }) => {
    if (detail.key !== key || !active()) return;
    persistProgress(true);
    syncing = true;
  });
  listen(window, "accountprogresssyncend", ({ detail }) => {
    if (detail.key !== key || !active()) return;
    syncing = false;
    persistProgress(true);
  });
  listen(window, "accountchange", active);
  listen(window, "pagehide", () => persistProgress(true));
  listen(document, "visibilitychange", () => {
    if (document.visibilityState === "hidden") persistProgress(true);
  });
  applyResume();
  return stop;
}
