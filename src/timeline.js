import { secondsToDuration } from "./utils.js";

const KEYBOARD_SEEK_STEP = 5;

// Owns the seek bar under the player: playback progress, YouTube chapter markers and the
// SponsorBlock segment overlay. SponsorBlock subscribes to onTick for its skip logic so a
// single playback loop drives everything.
export function installTimeline({ player, element, tooltipElement, labelElement }) {
  const tickHandlers = new Set();
  let destroyed = false;
  let chapters = [];
  let segments = [];
  let segmentsVisible = true;
  let animationFrame = 0;

  const playerDuration = () => {
    const duration = Number(player?.duration || 0);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  };

  const chapterAt = (currentTime) => {
    let active = null;
    for (const chapter of chapters) {
      if (chapter.start > currentTime + 0.001) break;
      active = chapter;
    }
    return active;
  };

  const render = () => {
    if (!element) return;

    const duration = playerDuration();
    element.replaceChildren();
    if (!duration) return;

    if (segmentsVisible) {
      for (const segment of segments) {
        const left = clamp((segment.start / duration) * 100, 0, 100);
        const right = clamp((segment.end / duration) * 100, left, 100);
        const marker = document.createElement("span");
        marker.className = "timeline-segment";
        marker.style.left = `${left}%`;
        marker.style.width = `${Math.max(right - left, 0.2)}%`;
        marker.style.backgroundColor = segment.color;
        marker.title = segment.label;
        element.append(marker);
      }
    }

    for (const chapter of chapters) {
      if (chapter.start <= 0 || chapter.start >= duration) continue;
      const divider = document.createElement("span");
      divider.className = "timeline-divider";
      divider.style.left = `${clamp((chapter.start / duration) * 100, 0, 100)}%`;
      divider.title = chapter.title;
      element.append(divider);
    }
  };

  const updateProgress = (currentTime, duration) => {
    const chapter = chapterAt(currentTime);

    if (element) {
      const progress = duration > 0 ? clamp((currentTime / duration) * 100, 0, 100) : 0;
      element.style.setProperty("--playback-progress", `${progress.toFixed(4)}%`);
      element.setAttribute("aria-valuemax", String(Math.floor(duration)));
      element.setAttribute("aria-valuenow", String(Math.floor(clamp(currentTime, 0, duration || currentTime))));
      element.setAttribute("aria-valuetext", describeTime(currentTime, chapter));
    }

    if (labelElement) {
      labelElement.textContent = chapter?.title || "";
      labelElement.hidden = !chapter;
    }
  };

  const sync = () => {
    if (destroyed || !player?.isConnected) return;

    const currentTime = Number(player.currentTime || 0);
    const duration = playerDuration();
    updateProgress(currentTime, duration);

    for (const handler of [...tickHandlers]) {
      handler(currentTime, duration);
    }
  };

  const startLoop = () => {
    if (animationFrame || destroyed) return;

    const tick = () => {
      animationFrame = 0;
      sync();

      if (!destroyed && player.isConnected && !player.paused && !player.ended) {
        animationFrame = requestAnimationFrame(tick);
      }
    };

    animationFrame = requestAnimationFrame(tick);
  };

  const stopLoop = () => {
    if (!animationFrame) return;
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  };

  const refresh = () => {
    render();
    sync();
  };

  const seekTo = (time) => {
    const duration = playerDuration();
    if (!duration) return;
    player.currentTime = clamp(time, 0, duration);
    sync();
  };

  const ratioFromEvent = (event) => {
    const rect = element.getBoundingClientRect();
    if (!rect.width) return null;
    return clamp((event.clientX - rect.left) / rect.width, 0, 1);
  };

  const hideTooltip = () => {
    if (tooltipElement) tooltipElement.hidden = true;
  };

  const handleClick = (event) => {
    if (event.detail === 0) return;
    const ratio = ratioFromEvent(event);
    if (ratio === null) return;
    seekTo(ratio * playerDuration());
  };

  const handleKeydown = (event) => {
    const step = event.key === "ArrowRight" ? KEYBOARD_SEEK_STEP : event.key === "ArrowLeft" ? -KEYBOARD_SEEK_STEP : 0;
    if (!step) return;
    event.preventDefault();
    seekTo(Number(player.currentTime || 0) + step);
  };

  const handlePointerMove = (event) => {
    if (!tooltipElement) return;

    const duration = playerDuration();
    const rect = element.getBoundingClientRect();
    if (!duration || !rect.width) {
      hideTooltip();
      return;
    }

    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const time = ratio * duration;

    tooltipElement.hidden = false;
    tooltipElement.textContent = describeTime(time, chapterAt(time));

    const half = tooltipElement.offsetWidth / 2;
    const center = rect.width / 2;
    tooltipElement.style.left = `${clamp(ratio * rect.width, Math.min(half, center), Math.max(rect.width - half, center))}px`;
  };

  player?.addEventListener("timeupdate", sync);
  player?.addEventListener("seeked", sync);
  player?.addEventListener("playing", startLoop);
  player?.addEventListener("pause", stopLoop);
  player?.addEventListener("ended", stopLoop);
  player?.addEventListener("loadedmetadata", refresh);
  player?.addEventListener("durationchange", refresh);
  element?.addEventListener("click", handleClick);
  element?.addEventListener("keydown", handleKeydown);
  element?.addEventListener("pointermove", handlePointerMove);
  element?.addEventListener("pointerleave", hideTooltip);
  element?.addEventListener("blur", hideTooltip);

  refresh();
  if (player && !player.paused) startLoop();

  return {
    setChapters(nextChapters) {
      chapters = Array.isArray(nextChapters) ? [...nextChapters].sort((a, b) => a.start - b.start) : [];
      refresh();
    },
    setSegments(nextSegments, visible = true) {
      segments = Array.isArray(nextSegments) ? nextSegments : [];
      segmentsVisible = visible;
      refresh();
    },
    onTick(handler) {
      tickHandlers.add(handler);
      return () => tickHandlers.delete(handler);
    },
    refresh,
    destroy() {
      destroyed = true;
      stopLoop();
      tickHandlers.clear();
      hideTooltip();
      element?.replaceChildren();
      player?.removeEventListener("timeupdate", sync);
      player?.removeEventListener("seeked", sync);
      player?.removeEventListener("playing", startLoop);
      player?.removeEventListener("pause", stopLoop);
      player?.removeEventListener("ended", stopLoop);
      player?.removeEventListener("loadedmetadata", refresh);
      player?.removeEventListener("durationchange", refresh);
      element?.removeEventListener("click", handleClick);
      element?.removeEventListener("keydown", handleKeydown);
      element?.removeEventListener("pointermove", handlePointerMove);
      element?.removeEventListener("pointerleave", hideTooltip);
      element?.removeEventListener("blur", hideTooltip);
    }
  };
}

function describeTime(time, chapter) {
  return [secondsToDuration(time) || "0:00", chapter?.title].filter(Boolean).join(" · ");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
