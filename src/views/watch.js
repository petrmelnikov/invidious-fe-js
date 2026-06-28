import { clearVideoProgress, getCurrentAccount, getVideoProgress, saveVideoProgress } from "../account.js";
import { api, assetUrl } from "../api.js";
import { errorState, list, loading } from "../components.js";
import { getConfig, saveConfig } from "../config.js";
import { installSponsorBlock } from "../sponsorblock.js";
import { compactNumber, escapeHtml, fullNumber, parseYoutubeTime, pickThumbnail, relativeTime, secondsToDuration, setTitle } from "../utils.js";

const view = () => document.getElementById("view");
const DASH_JS_URL = "https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js";
const PLAYBACK_SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
let dashScriptPromise;
let dashPlayer;
let dashManifestUrl;

export async function renderWatch({ search }) {
  destroyDash();
  const id = search.get("v") || search.get("id");
  if (!id) {
    view().innerHTML = errorState(new Error("Missing video id"));
    return;
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
    view().innerHTML = errorState(new Error(`Invalid YouTube video id: ${id}`));
    return;
  }

  view().innerHTML = loading("Loading video");

  try {
    const video = await api.video(id);
    setTitle(video.title);
    view().innerHTML = watchMarkup(video, id);
    installWatchInteractions(video, search);
    loadComments(id);
  } catch (error) {
    view().innerHTML = errorState(error);
  }
}

function chooseStreams(video) {
  const streams = Array.isArray(video.formatStreams)
    ? video.formatStreams.filter((stream) => String(stream.itag) !== "17")
    : [];
  const sorted = streams.sort((a, b) => Number.parseInt(b.resolution || b.quality || 0, 10) - Number.parseInt(a.resolution || a.quality || 0, 10));
  const preferred = getConfig().quality;

  if (!preferred || preferred === "auto") return sorted;

  const match = sorted.find((stream) => [stream.qualityLabel, stream.resolution, stream.quality].some((value) => String(value || "").includes(preferred)));
  return match ? [match, ...sorted.filter((stream) => stream !== match)] : sorted;
}

function hasDashStreams(video) {
  const formats = Array.isArray(video.adaptiveFormats) ? video.adaptiveFormats : [];
  return formats.some((stream) => String(stream.type || "").startsWith("video/"))
    && formats.some((stream) => String(stream.type || "").startsWith("audio/"));
}

function dashQualityOptions(video) {
  const formats = Array.isArray(video.adaptiveFormats) ? video.adaptiveFormats : [];
  const seen = new Set();

  return formats
    .filter((stream) => String(stream.type || "").startsWith("video/mp4"))
    .filter((stream) => stream.qualityLabel || stream.resolution)
    .map((stream) => ({
      label: stream.qualityLabel || stream.resolution,
      height: Number.parseInt(stream.resolution || stream.qualityLabel || "0", 10),
      fps: Number.parseInt(String(stream.qualityLabel || "").replace(/^\d+p/, ""), 10) || Number(stream.fps || 0) || 30
    }))
    .filter((stream) => {
      const key = `${stream.height}:${stream.fps}`;
      if (!stream.height || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.height - a.height || b.fps - a.fps);
}

function watchMarkup(video, videoId) {
  const streams = chooseStreams(video);
  const selected = streams[0];
  const dashAvailable = hasDashStreams(video);
  const playerAvailable = dashAvailable || selected || video.hlsUrl;
  const poster = assetUrl(pickThumbnail(video.videoThumbnails, 1280));
  const published = video.publishedText || relativeTime(video.published);
  const related = video.recommendedVideos || video.relatedVideos || [];
  const youtubeUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

  return `
    <section class="watch-layout">
      <article class="watch-main">
        <div class="player-frame">
          ${dashAvailable || selected ? `
            <video id="video-player" controls playsinline preload="metadata" poster="${escapeHtml(poster)}">
              ${dashAvailable ? "" : sourceTags(video, streams).join("")}
              ${captionTracks(video).join("")}
            </video>
          ` : video.hlsUrl ? `
            <video id="video-player" controls playsinline preload="metadata" poster="${escapeHtml(poster)}">
              <source src="${escapeHtml(assetUrl(video.hlsUrl))}" type="application/x-mpegURL">
              ${captionTracks(video).join("")}
            </video>
          ` : `
            <img src="${escapeHtml(poster)}" alt="">
            <div class="player-message">No browser-playable stream was returned by the backend.</div>
          `}
        </div>

        ${playerAvailable ? playerEnhancements() : ""}

        ${playerAvailable ? playbackControls(video, streams, selected, dashAvailable) : ""}
    <p class="player-note" id="account-progress-note"></p>
        <p class="player-note" id="player-note"></p>
        <p class="player-note" id="sponsorblock-note"></p>

        <header class="watch-header">
          <div class="watch-header-copy">
            <h1>${escapeHtml(video.title)}</h1>
            <p class="meta">
              ${video.viewCount ? `${escapeHtml(fullNumber(video.viewCount))} views` : ""}
              ${video.viewCount && published ? " · " : ""}
              ${published ? escapeHtml(published) : ""}
            </p>
          </div>
          <div class="watch-header-actions">
            <a class="button button-ghost" href="${escapeHtml(youtubeUrl)}" target="_blank" rel="noreferrer noopener">Open on YouTube</a>
          </div>
        </header>

        <section class="author-strip">
          <a class="avatar" href="/channel/${encodeURIComponent(video.authorId || "")}" data-link>
            ${authorAvatar(video)}
          </a>
          <div>
            <h2><a href="/channel/${encodeURIComponent(video.authorId || "")}" data-link>${escapeHtml(video.author || "Channel")}</a></h2>
            <p class="meta">${escapeHtml(video.subCountText || "")}</p>
          </div>
          ${video.likeCount ? `<div class="like-pill">${escapeHtml(compactNumber(video.likeCount))} likes</div>` : ""}
        </section>

        ${video.descriptionHtml || video.description ? `
          <details class="description" open>
            <summary>Description</summary>
            <div>${video.descriptionHtml || escapeHtml(video.description).replaceAll("\n", "<br>")}</div>
          </details>
        ` : ""}

        <section class="comments" id="comments">${loading("Loading comments")}</section>
      </article>

      <aside class="watch-side">
        <h2>Related</h2>
        ${list(related, { compact: true })}
      </aside>
    </section>
  `;
}

function playerEnhancements() {
  return `
    <div class="player-enhancements">
      <button class="sponsorblock-timeline" id="sponsorblock-timeline" type="button" aria-label="Seek video timeline" hidden></button>
      <button class="button sponsorblock-skip" type="button" id="sponsorblock-skip" hidden>Skip segment</button>
    </div>
  `;
}

function authorAvatar(video) {
  const thumb = assetUrl(pickThumbnail(video.authorThumbnails, 100));
  if (thumb) return `<img src="${escapeHtml(thumb)}" alt="" loading="lazy">`;
  return escapeHtml((video.author || "I").slice(0, 1).toUpperCase());
}

function playbackControls(video, streams, selected, dashAvailable) {
  return `
    <div class="player-controls">
      ${dashAvailable || streams.length ? streamSelector(video, streams, selected, dashAvailable) : ""}
      <label class="player-select" id="audio-select-container" style="display: none;">
        Audio
        <select id="audio-select" class="select"></select>
      </label>
      ${speedSelector(getConfig().playbackSpeed)}
    </div>
  `;
}

function streamSelector(video, streams, selected, dashAvailable) {
  const dashOptions = dashAvailable ? dashQualityOptions(video) : [];

  return `
    <label class="player-select">
      Quality
      <select id="stream-select" class="select">
        ${dashAvailable ? `<option value="${escapeHtml(api.dashManifest(video.videoId))}" data-mode="dash" selected>Auto DASH</option>` : ""}
        ${dashOptions.map((stream) => `
          <option value="${escapeHtml(api.dashManifest(video.videoId))}" data-mode="dash-fixed" data-height="${escapeHtml(stream.height)}" data-label="${escapeHtml(stream.label)}">
            ${escapeHtml(stream.label)} DASH
          </option>
        `).join("")}
        ${streams.map((stream) => `
          <option value="${escapeHtml(api.latestVersion(video.videoId, stream.itag))}" data-mode="progressive" data-type="${escapeHtml(stream.type || "")}" ${!dashAvailable && stream.itag === selected?.itag ? "selected" : ""}>
            ${escapeHtml(stream.qualityLabel || stream.resolution || stream.quality || stream.itag)} MP4
          </option>
        `).join("")}
      </select>
    </label>
  `;
}

function speedSelector(selectedSpeed) {
  const rate = normalizePlaybackRate(selectedSpeed);
  return `
    <label class="player-select">
      Speed
      <select id="speed-select" class="select">
        ${PLAYBACK_SPEED_OPTIONS.map((option) => `
          <option value="${option}" ${option === rate ? "selected" : ""}>${escapeHtml(formatPlaybackRate(option))}</option>
        `).join("")}
      </select>
    </label>
  `;
}

function sourceTags(video, streams) {
  return streams.map((stream) => `
    <source src="${escapeHtml(api.latestVersion(video.videoId, stream.itag))}" type="${escapeHtml(stream.type || "")}" data-itag="${escapeHtml(stream.itag)}">
  `);
}

function getLanguageName(langCode) {
  try {
    const displayNames = new Intl.DisplayNames([navigator.language || "en"], { type: "language" });
    return displayNames.of(langCode) || langCode;
  } catch {
    return langCode;
  }
}

function formatAudioTrack(track) {
  let label = getLanguageName(track.lang);
  if (track.roles && track.roles.length > 0 && !track.roles.includes("main")) {
    label += ` (${track.roles.join(", ")})`;
  }
  return label;
}

function populateAudioTracks() {
  if (!dashPlayer) return;
  const audioTracks = dashPlayer.getTracksFor("audio") || [];
  const container = document.getElementById("audio-select-container");
  const selector = document.getElementById("audio-select");
  if (!container || !selector) return;

  if (audioTracks.length > 1) {
    const currentTrack = dashPlayer.getCurrentTrackFor("audio");
    selector.innerHTML = audioTracks.map((track, index) => {
      const isSelected = currentTrack && (track.id === currentTrack.id || track.index === currentTrack.index);
      return `<option value="${index}" ${isSelected ? "selected" : ""}>${escapeHtml(formatAudioTrack(track))}</option>`;
    }).join("");
    container.style.display = "inline-flex";
  } else {
    container.style.display = "none";
    selector.innerHTML = "";
  }
}

function captionTracks(video) {
  if (!Array.isArray(video.captions)) return [];
  return video.captions.map((caption, index) => {
    const label = caption.label || caption.language_code || caption.languageCode;
    const lang = caption.language_code || caption.languageCode || "";
    const src = caption.url ? assetUrl(caption.url) : api.captions(video.videoId, { label });
    return `<track kind="subtitles" src="${escapeHtml(src)}" srclang="${escapeHtml(lang)}" label="${escapeHtml(label)}" ${index === 0 ? "default" : ""}>`;
  });
}

function installWatchInteractions(video, search) {
  const player = document.getElementById("video-player");
  const selector = document.getElementById("stream-select");
  const speedControl = document.getElementById("speed-select");
  const initialPlaybackRate = normalizePlaybackRate(speedControl?.value || getConfig().playbackSpeed);
  const savedProgress = getVideoProgress(video.videoId);

  let resumeTime = normalizeResumeTime(savedProgress?.currentTime);
  const tParam = search.get("t") || new URLSearchParams(window.location.hash.replace(/^#/, "")).get("t");
  if (tParam) {
    const parsedTime = parseYoutubeTime(tParam);
    resumeTime = parsedTime;

    // Remove the 't' parameter from URL query and hash
    const url = new URL(window.location.href);
    let urlChanged = false;
    if (url.searchParams.has("t")) {
      url.searchParams.delete("t");
      urlChanged = true;
    }
    if (url.hash) {
      const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
      if (hashParams.has("t")) {
        hashParams.delete("t");
        const newHash = hashParams.toString();
        url.hash = newHash ? `#${newHash}` : "";
        urlChanged = true;
      }
    }
    if (urlChanged) {
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    }
  }

  const selectedOption = selector?.selectedOptions[0];
  const usingDash = Boolean(selectedOption?.dataset.mode?.startsWith("dash"));

  if (player) {
    setPlayerPlaybackRate(player, initialPlaybackRate, speedControl);
    installAccountProgress({
      player,
      video,
      noteElement: document.getElementById("account-progress-note"),
      initialTime: resumeTime,
      applyInitialSeek: !usingDash
    });
  }

  if (player && usingDash) {
    initializeDash(player, selectedOption, resumeTime, true, initialPlaybackRate);
  }

  if (player) {
    installSponsorBlock({
      player,
      videoId: video.videoId,
      noteElement: document.getElementById("sponsorblock-note"),
      markerElement: document.getElementById("sponsorblock-timeline"),
      skipButton: document.getElementById("sponsorblock-skip")
    });
  }

  speedControl?.addEventListener("change", (event) => {
    if (!player) return;
    const nextRate = setPlayerPlaybackRate(player, event.target.value, event.target);
    saveConfig({ playbackSpeed: nextRate }, { silent: true });
  });

  document.getElementById("audio-select")?.addEventListener("change", (event) => {
    if (!dashPlayer) return;
    const index = Number(event.target.value);
    const audioTracks = dashPlayer.getTracksFor("audio") || [];
    const track = audioTracks[index];
    if (track) {
      dashPlayer.setCurrentTrack(track);
    }
  });

  document.getElementById("stream-select")?.addEventListener("change", (event) => {
    if (!player) return;
    const currentTime = player.currentTime;
    const paused = player.paused;
    const playbackRate = normalizePlaybackRate(player.playbackRate || speedControl?.value || getConfig().playbackSpeed);

    const option = event.target.selectedOptions[0];

    if (option?.dataset.mode?.startsWith("dash")) {
      initializeDash(player, option, currentTime, paused, playbackRate);
      return;
    }

    destroyDash();
    player.src = event.target.value;
    player.currentTime = currentTime;
    player.load();
    setPlayerPlaybackRate(player, playbackRate, speedControl);
    if (!paused) player.play().catch(() => {});
  });

  player?.addEventListener("error", () => {
    const sources = [...player.querySelectorAll("source")];
    const current = player.currentSrc || player.src;
    const next = sources.find((source) => source.src && source.src !== current && player.canPlayType(source.type) !== "");

    if (!next) return;

    const currentTime = player.currentTime || 0;
    const playbackRate = normalizePlaybackRate(player.playbackRate || speedControl?.value || getConfig().playbackSpeed);
    player.src = next.src;
    player.currentTime = currentTime;
    player.load();
    setPlayerPlaybackRate(player, playbackRate, speedControl);
  }, { once: true });
}

function loadDashScript() {
  if (window.dashjs) return Promise.resolve(window.dashjs);
  if (dashScriptPromise) return dashScriptPromise;

  dashScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = DASH_JS_URL;
    script.async = true;
    script.onload = () => resolve(window.dashjs);
    script.onerror = () => reject(new Error("Could not load dash.js"));
    document.head.append(script);
  });

  return dashScriptPromise;
}

async function initializeDash(player, option, currentTime = 0, paused = true, playbackRate = 1) {
  const note = document.getElementById("player-note");
  const normalizedPlaybackRate = normalizePlaybackRate(playbackRate);
  try {
    const dashjs = await loadDashScript();
    const manifest = option.value;
    const requestedQuality = {
      mode: option.dataset.mode,
      height: Number(option.dataset.height || 0),
      label: option.dataset.label || ""
    };
    const applyResume = createDashResumeHandler(player, currentTime);

    if (!dashPlayer || dashManifestUrl !== manifest) {
      destroyDash();
      dashManifestUrl = manifest;
      dashPlayer = dashjs.MediaPlayer().create();
      dashPlayer.updateSettings({
        streaming: {
          abr: { autoSwitchBitrate: { audio: true, video: true } },
          buffer: { stableBufferTime: 30 }
        }
      });
      dashPlayer.initialize(player, manifest, !paused);
      dashPlayer.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
        setPlayerPlaybackRate(player, normalizedPlaybackRate);
        applyDashQuality(requestedQuality);
        applyResume();
        populateAudioTracks();
      });

      if (currentTime > 0) {
        [
          dashjs.MediaPlayer.events.PLAYBACK_METADATA_LOADED,
          dashjs.MediaPlayer.events.CAN_PLAY,
          dashjs.MediaPlayer.events.PLAYBACK_PLAYING
        ].forEach((eventName) => {
          dashPlayer.on(eventName, applyResume);
        });
      }
    } else {
      setPlayerPlaybackRate(player, normalizedPlaybackRate);
      applyDashQuality(requestedQuality);
      applyResume();
      populateAudioTracks();
      if (!paused) player.play().catch(() => {});
    }

    if (note) {
      note.textContent = requestedQuality.mode === "dash-fixed"
        ? `DASH fixed at ${requestedQuality.label}.`
        : "DASH adaptive playback enabled.";
    }
  } catch (error) {
    if (note) note.textContent = `${error.message}. Falling back to progressive playback.`;
    document.querySelector("#stream-select option[data-mode='progressive']")?.setAttribute("selected", "selected");
    const fallback = document.querySelector("#stream-select option[data-mode='progressive']")?.value;
    if (fallback) {
      player.src = fallback;
      player.load();
      setPlayerPlaybackRate(player, normalizedPlaybackRate);
    }
  }
}

function createDashResumeHandler(player, currentTime) {
  const resumeTime = normalizeResumeTime(currentTime);
  if (!player || resumeTime <= 0) return () => {};

  let resumeApplied = false;
  let resumeAttempts = 0;
  let resumeTimer = 0;

  const stopResumeLoop = () => {
    if (!resumeTimer) return;
    window.clearTimeout(resumeTimer);
    resumeTimer = 0;
  };

  const queueResumeAttempt = () => {
    if (resumeApplied || resumeTimer || resumeAttempts >= 30 || !player.isConnected) return;
    resumeTimer = window.setTimeout(() => {
      resumeTimer = 0;
      resumeAttempts += 1;
      applyResume();
    }, 250);
  };

  const applyResume = () => {
    if (resumeApplied || !player.isConnected) {
      stopResumeLoop();
      return;
    }

    const duration = Number(player.duration || 0);
    const safeTime = duration > 0 ? Math.min(resumeTime, Math.max(duration - 1, 0)) : resumeTime;
    if (safeTime <= 0) {
      resumeApplied = true;
      stopResumeLoop();
      return;
    }

    const beforeSeek = Number(player.currentTime || 0);

    try {
      dashPlayer?.seek(safeTime);
    } catch {
      // dash.js can reject seeks until the manifest and media timeline are ready.
    }

    try {
      player.currentTime = safeTime;
    } catch {
      // Some browsers also reject the first media-element seek until metadata settles.
    }

    const afterSeek = Number(player.currentTime || 0);
    resumeApplied = Math.abs(afterSeek - safeTime) < 1 || afterSeek >= Math.max(safeTime - 1, 1) || afterSeek > beforeSeek + 0.5;

    if (resumeApplied) {
      stopResumeLoop();
      return;
    }

    queueResumeAttempt();
  };

  return applyResume;
}

function destroyDash() {
  if (!dashPlayer) return;
  dashPlayer.reset();
  dashPlayer = null;
  dashManifestUrl = "";

  const container = document.getElementById("audio-select-container");
  if (container) {
    container.style.display = "none";
  }
  const selector = document.getElementById("audio-select");
  if (selector) {
    selector.innerHTML = "";
  }
}

function applyDashQuality(requestedQuality) {
  if (!dashPlayer) return;

  const auto = requestedQuality.mode !== "dash-fixed";
  dashPlayer.updateSettings({
    streaming: {
      abr: { autoSwitchBitrate: { video: auto } }
    }
  });

  if (auto) return;

  const bitrates = dashPlayer.getBitrateInfoListFor("video") || [];
  const quality = bitrates
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => Number(entry.height) === requestedQuality.height)
    .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0))[0];

  if (quality) {
    dashPlayer.setQualityFor("video", quality.qualityIndex ?? quality.index, true);
  }
}

function normalizePlaybackRate(value) {
  const rate = Number(value);
  return PLAYBACK_SPEED_OPTIONS.includes(rate) ? rate : 1;
}

function formatPlaybackRate(rate) {
  return `${String(rate).replace(/\.0$/, "")}x`;
}

function setPlayerPlaybackRate(player, rate, control = document.getElementById("speed-select")) {
  const normalizedRate = normalizePlaybackRate(rate);
  if (!player) return normalizedRate;

  player.defaultPlaybackRate = normalizedRate;
  player.playbackRate = normalizedRate;

  if (control) {
    control.value = String(normalizedRate);
  }

  return normalizedRate;
}

function normalizeResumeTime(value) {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? time : 0;
}

function installAccountProgress({ player, video, noteElement, initialTime = 0, applyInitialSeek = true }) {
  const account = getCurrentAccount();
  if (!player || !account) {
    if (noteElement) noteElement.textContent = "";
    return;
  }

  const resumeTime = normalizeResumeTime(initialTime);
  const thumbnail = assetUrl(pickThumbnail(video.videoThumbnails, 1280));
  let lastSavedTime = resumeTime || Number.NEGATIVE_INFINITY;
  let resumeApplied = resumeTime <= 0;
  let resumeAttempts = 0;
  let resumeTimer = 0;

  if (noteElement) {
    noteElement.textContent = resumeTime > 0
      ? `Resuming for ${account.name} at ${secondsToDuration(resumeTime)}.`
      : `Saving progress for ${account.name}.`;
  }

  const stopResumeLoop = () => {
    if (!resumeTimer) return;
    window.clearTimeout(resumeTimer);
    resumeTimer = 0;
  };

  const queueResumeAttempt = () => {
    if (resumeApplied || resumeTimer || resumeAttempts >= 40 || !player.isConnected) return;
    resumeTimer = window.setTimeout(() => {
      resumeTimer = 0;
      applyResume();
    }, 250);
  };

  const applyResume = () => {
    if (!applyInitialSeek || resumeApplied || !player.isConnected) {
      stopResumeLoop();
      return;
    }

    const duration = Number(player.duration || 0);
    const safeTime = duration > 0 ? Math.min(resumeTime, Math.max(duration - 1, 0)) : resumeTime;
    if (safeTime <= 0) {
      resumeApplied = true;
      stopResumeLoop();
      return;
    }

    const seekableEnd = player.seekable?.length ? Number(player.seekable.end(player.seekable.length - 1) || 0) : 0;
    const beforeSeek = Number(player.currentTime || 0);
    const canSeek = player.readyState >= 1 || duration > 0 || seekableEnd > 0;

    if (canSeek) {
      try {
        player.currentTime = safeTime;
      } catch {
        // Some browsers reject the first seek until media metadata settles.
      }
    }

    const afterSeek = Number(player.currentTime || 0);
    resumeApplied = Math.abs(afterSeek - safeTime) < 1 || afterSeek >= Math.max(safeTime - 1, 1) || afterSeek > beforeSeek + 0.5;

    if (resumeApplied) {
      stopResumeLoop();
      return;
    }

    resumeAttempts += 1;
    queueResumeAttempt();
  };

  if (applyInitialSeek && resumeTime > 0) {
    ["loadedmetadata", "loadeddata", "canplay", "play", "playing", "seeked"].forEach((eventName) => {
      player.addEventListener(eventName, applyResume);
    });
    applyResume();
    queueResumeAttempt();
  }

  const persistProgress = (force = false) => {
    const currentTime = Number(player.currentTime || 0);
    if (!Number.isFinite(currentTime)) return;
    if (!force && currentTime < 3) return;
    if (!force && Math.abs(currentTime - lastSavedTime) < 5) return;

    lastSavedTime = currentTime;
    saveVideoProgress({
      videoId: video.videoId,
      title: video.title,
      author: video.author,
      thumbnail,
      currentTime,
      duration: Number(player.duration || video.lengthSeconds || 0)
    });
  };

  player.addEventListener("timeupdate", () => persistProgress(false));
  player.addEventListener("pause", () => persistProgress(true));
  player.addEventListener("ended", () => {
    clearVideoProgress(video.videoId);
    if (noteElement) noteElement.textContent = `Finished for ${account.name}.`;
  });
}

async function loadComments(id) {
  const comments = document.getElementById("comments");
  if (!comments) return;

  try {
    const payload = await api.comments(id, getConfig().comments);
    const entries = payload.comments || [];
    comments.innerHTML = `
      <h2>Comments</h2>
      ${entries.length ? `<div class="comment-list">${entries.slice(0, 40).map(commentMarkup).join("")}</div>` : "<p class='meta'>No comments returned.</p>"}
    `;
  } catch (error) {
    comments.innerHTML = `<h2>Comments</h2><p class="meta">${escapeHtml(error.message || "Could not load comments")}</p>`;
  }
}

function commentMarkup(comment) {
  const author = comment.author || "User";
  const content = comment.contentHtml || escapeHtml(comment.content || "");
  return `
    <article class="comment">
      <div class="comment-header">
        <strong>${escapeHtml(author)}</strong>
        <span>${escapeHtml(comment.publishedText || "")}</span>
      </div>
      <div>${content}</div>
    </article>
  `;
}
