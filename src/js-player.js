import { getConfig, saveConfig } from "./config.js";

const MEDIA_CHROME_URL = "https://cdn.jsdelivr.net/npm/media-chrome@4.19.3/+esm";
const DOUBLE_TAP_MS = 300;
let libraryPromise;

export function jsPlayerControls() {
  return `
    <media-loading-indicator slot="centered-chrome" data-js-player-control hidden></media-loading-indicator>
    <div class="player-seek-feedback" slot="middle-chrome" role="status" noautohide hidden></div>
    <media-control-bar class="js-player-timeline" data-js-player-control hidden>
      <media-time-range></media-time-range>
    </media-control-bar>
    <media-control-bar data-js-player-control hidden>
      <media-play-button></media-play-button>
      <media-seek-backward-button seekoffset="10"></media-seek-backward-button>
      <media-seek-forward-button seekoffset="10"></media-seek-forward-button>
      <media-time-display showduration></media-time-display>
      <span class="js-player-spacer"></span>
      <media-mute-button></media-mute-button>
      <media-volume-range></media-volume-range>
      <media-captions-button></media-captions-button>
      <media-pip-button></media-pip-button>
      <media-fullscreen-button></media-fullscreen-button>
    </media-control-bar>
  `;
}

function loadMediaChrome() {
  if (customElements.get("media-controller")) return Promise.resolve();
  if (libraryPromise) return libraryPromise;

  libraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.onload = script.onerror = null;
      script.remove();
      libraryPromise = null;
      reject(new Error("Could not load the JS player. Native controls are available; select JS to retry."));
    };
    const timer = setTimeout(fail, 15000);
    script.type = "module";
    script.src = MEDIA_CHROME_URL;
    script.onload = () => {
      if (!customElements.get("media-controller")) return fail();
      settled = true;
      clearTimeout(timer);
      script.onload = script.onerror = null;
      resolve();
    };
    script.onerror = fail;
    document.head.append(script);
  });

  return libraryPromise;
}

// Keep the same video in both modes: DASH, captions, progress and playback state
// remain attached to it. Media Chrome supplies controls without owning the source.
export function installPlayerMode({ player, controller, selector, note, loadLibrary = loadMediaChrome }) {
  let request = 0;
  let stopGestures = () => {};
  const controls = controller.querySelectorAll("[data-js-player-control]");
  const feedback = controller.querySelector(".player-seek-feedback");

  const showNative = () => {
    stopGestures();
    stopGestures = () => {};
    controller.classList.remove("js-player");
    controller.setAttribute("nohotkeys", "");
    controller.setAttribute("noautohide", "");
    controls.forEach((control) => { control.hidden = true; });
    feedback.hidden = true;
    player.controls = true;
  };

  const setMode = async (mode, persist = false) => {
    const currentRequest = ++request;
    showNative();
    note.hidden = mode !== "js";
    if (persist) saveConfig({ playerMode: mode }, { silent: true });
    if (mode !== "js") return;

    note.textContent = "Loading JS player…";
    try {
      await loadLibrary();
      if (currentRequest !== request || !player.isConnected) return;
      controller.classList.add("js-player");
      controller.removeAttribute("nohotkeys");
      controller.removeAttribute("noautohide");
      controls.forEach((control) => { control.hidden = false; });
      player.controls = false;
      stopGestures = installSeekGestures({ player, controller, feedback });
      note.textContent = "Double-tap the left or right third of the video to seek −10 / +10 seconds.";
    } catch (error) {
      if (currentRequest !== request || !player.isConnected) return;
      showNative();
      selector.value = "native";
      note.textContent = error.message;
    }
  };

  selector.addEventListener("change", () => setMode(selector.value, true));
  setMode(getConfig().playerMode);
}

export function seekBy(player, offset) {
  const ranges = player.seekable;
  let target = player.currentTime + offset;
  if (ranges?.length) {
    target = Math.max(ranges.start(0), Math.min(ranges.end(ranges.length - 1), target));
    for (let index = 0; index < ranges.length - 1; index += 1) {
      if (target > ranges.end(index) && target < ranges.start(index + 1)) {
        target = offset > 0 ? ranges.start(index + 1) : ranges.end(index);
        break;
      }
    }
  } else if (Number.isFinite(player.duration) && player.duration > 0) {
    target = Math.max(0, Math.min(player.duration, target));
  } else {
    return false;
  }
  try {
    player.currentTime = target;
    return true;
  } catch {
    return false;
  }
}

export function installSeekGestures({ player, controller, feedback }) {
  let pointer;
  let lastTap;
  let singleTapTimer;
  let feedbackTimer;
  const events = new AbortController();
  const options = { signal: events.signal, capture: true };
  const clearTap = () => {
    clearTimeout(singleTapTimer);
    lastTap = null;
  };
  const togglePlay = () => {
    if (!player.isConnected) return;
    if (player.paused) player.play()?.catch(() => {});
    else player.pause();
  };

  controller.addEventListener("pointerdown", (event) => {
    pointer = { x: event.clientX, y: event.clientY, time: event.timeStamp, cancelled: event.isPrimary === false };
  }, options);
  controller.addEventListener("pointerup", (event) => {
    if (pointer && (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 12
      || event.timeStamp - pointer.time > 500)) pointer.cancelled = true;
  }, options);
  controller.addEventListener("pointercancel", () => {
    pointer = { cancelled: true };
    clearTap();
  }, options);
  controller.addEventListener("click", (event) => {
    // Controls (including their shadow DOM), menus and the timeline handle their
    // own input. Only clicks on the video surface participate in edge seeking.
    if (event.target !== player || event.button !== 0) {
      clearTap();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (pointer?.cancelled) return;
    const rect = player.getBoundingClientRect();
    if (!rect.width) return;
    const x = (event.clientX - rect.left) / rect.width;
    const side = x < 1 / 3 ? -1 : x > 2 / 3 ? 1 : 0;
    if (!side) {
      clearTap();
      togglePlay();
      return;
    }
    const repeated = lastTap?.side === side && event.timeStamp - lastTap.time <= DOUBLE_TAP_MS;
    clearTimeout(singleTapTimer);
    lastTap = { side, time: event.timeStamp };
    if (!repeated) {
      singleTapTimer = setTimeout(() => { lastTap = null; togglePlay(); }, DOUBLE_TAP_MS);
      return;
    }
    if (!seekBy(player, side * 10)) return;
    feedback.textContent = side < 0 ? "⏪ −10 s" : "+10 s ⏩";
    feedback.dataset.direction = side < 0 ? "backward" : "forward";
    feedback.hidden = false;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => { feedback.hidden = true; }, 700);
  }, options);
  controller.addEventListener("dblclick", (event) => {
    if (event.target === player) event.preventDefault();
  }, options);

  return () => {
    events.abort();
    clearTap();
    clearTimeout(feedbackTimer);
    feedback.hidden = true;
  };
}
