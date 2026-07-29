import { defaults, getConfig, normalizeOrigin } from "./config.js";

export const sponsorBlockCategoryOptions = [
  { id: "sponsor", label: "Sponsor", defaultMode: "auto", color: "#35c26b" },
  { id: "selfpromo", label: "Self-promo", defaultMode: "auto", color: "#4f8cff" },
  { id: "interaction", label: "Interaction", defaultMode: "button", color: "#f2b640" },
  { id: "intro", label: "Intro", defaultMode: "button", color: "#8f75ff" },
  { id: "outro", label: "Outro", defaultMode: "button", color: "#ff7b72" },
  { id: "preview", label: "Preview", defaultMode: "button", color: "#4cc9c0" },
  { id: "hook", label: "Hook", defaultMode: "no", color: "#ff9f43" },
  { id: "filler", label: "Filler", defaultMode: "no", color: "#8892a0" }
];

const VALID_MODES = new Set(["no", "button", "auto"]);
const ACTIVE_SEGMENT_EPSILON = 0.05;

export function getSponsorBlockSettings(config = getConfig()) {
  const saved = config.sponsorBlock || {};

  return {
    enabled: Boolean(saved.enabled),
    apiOrigin: normalizeOrigin(saved.apiOrigin || defaults.sponsorBlock.apiOrigin),
    showMarkers: saved.showMarkers !== false,
    minSegmentLength: normalizeMinLength(saved.minSegmentLength),
    categories: Object.fromEntries(sponsorBlockCategoryOptions.map((option) => [
      option.id,
      VALID_MODES.has(saved.categories?.[option.id]) ? saved.categories[option.id] : option.defaultMode
    ]))
  };
}

export function installSponsorBlock({ player, videoId, noteElement, skipButton, timeline }) {
  setNote(noteElement, "");
  timeline?.setSegments([]);
  updateSkipButton(skipButton, null);

  if (!player || !videoId || !timeline) return () => {};

  const settings = getSponsorBlockSettings();
  const categoryModes = settings.categories;
  const requestedCategories = sponsorBlockCategoryOptions
    .map((option) => option.id)
    .filter((category) => categoryModes[category] !== "no");

  if (!settings.enabled || !requestedCategories.length) return () => {};

  let destroyed = false;
  let segments = [];

  const handlePlaybackState = (currentTime) => {
    if (destroyed || !player.isConnected) return;

    clearSkipGuards(segments, currentTime);

    const segment = findCurrentSegment(segments, currentTime, (entry) => !entry.autoSkip);
    updateSkipButton(skipButton, segment);

    skipCurrentAutoSegment(currentTime);
  };

  const skipCurrentSegment = () => {
    if (destroyed || !player.isConnected) return;
    const segment = findCurrentSegment(segments, Number(player.currentTime || 0), (entry) => !entry.autoSkip);

    if (!segment) return;

    skipSegments(player, noteElement, [segment], segment.end);
    updateSkipButton(skipButton, null);
  };

  const skipCurrentAutoSegment = (currentTime) => {
    const segment = findCurrentSegment(segments, currentTime, (entry) => entry.autoSkip && !entry.skipped);
    if (!segment) return false;

    const skippedSegments = contiguousAutoSegments(segments, segment);
    skipSegments(player, noteElement, skippedSegments, skippedSegments[skippedSegments.length - 1].end);
    return true;
  };

  const unsubscribe = timeline.onTick(handlePlaybackState);
  skipButton?.addEventListener("click", skipCurrentSegment);

  void loadSponsorSegments(videoId, settings, requestedCategories)
    .then((loadedSegments) => {
      if (destroyed || !player.isConnected) return;

      segments = loadedSegments;
      timeline.setSegments(timelineSegments(segments), settings.showMarkers);
      handlePlaybackState(Number(player.currentTime || 0));

      if (!segments.length) return;

      const autoCount = segments.filter((segment) => segment.autoSkip).length;
      const manualCount = segments.length - autoCount;
      const suffix = [
        autoCount ? `${autoCount} auto` : "",
        manualCount ? `${manualCount} manual` : ""
      ].filter(Boolean).join(", ");

      setNote(noteElement, `SponsorBlock loaded ${segments.length} segment${segments.length === 1 ? "" : "s"}${suffix ? ` (${suffix}).` : "."}`);
    })
    .catch((error) => {
      if (destroyed || !player.isConnected) return;
      setNote(noteElement, `SponsorBlock unavailable: ${error.message}.`);
    });

  return () => {
    destroyed = true;
    unsubscribe();
    timeline.setSegments([]);
    skipButton?.removeEventListener("click", skipCurrentSegment);
  };
}

function timelineSegments(segments) {
  return segments.map((segment) => ({
    start: segment.start,
    end: segment.end,
    color: colorForCategory(segment.category),
    label: labelForCategory(segment.category)
  }));
}

async function loadSponsorSegments(videoId, settings, categories) {
  const url = new URL("/api/skipSegments", `${settings.apiOrigin || defaults.sponsorBlock.apiOrigin}/`);
  url.searchParams.set("videoID", videoId);
  url.searchParams.set("categories", JSON.stringify(categories));
  url.searchParams.set("actionTypes", JSON.stringify(["skip"]));
  url.searchParams.set("service", "YouTube");

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" }
  });

  if (response.status === 404) return [];

  const payload = await readPayload(response);
  if (!response.ok) {
    const message = typeof payload === "string"
      ? payload
      : payload?.message || payload?.error || "Could not load SponsorBlock segments";
    throw new Error(message);
  }

  return normalizeSegments(Array.isArray(payload) ? payload : [], settings.categories, settings.minSegmentLength);
}

async function readPayload(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  return response.text();
}

function normalizeSegments(payload, categoryModes, minSegmentLength) {
  return payload
    .filter((entry) => Array.isArray(entry.segment) && entry.segment.length >= 2)
    .map((entry) => {
      const start = Number(entry.segment[0]);
      const end = Number(entry.segment[1]);

      return {
        ...entry,
        start,
        end,
        autoSkip: categoryModes[entry.category] === "auto",
        skipped: false
      };
    })
    .filter((entry) => Number.isFinite(entry.start) && Number.isFinite(entry.end))
    .filter((entry) => entry.end - entry.start >= minSegmentLength)
    .filter((entry) => entry.end > entry.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function normalizeMinLength(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaults.sponsorBlock.minSegmentLength;
}

function findCurrentSegment(segments, currentTime, predicate = () => true) {
  return segments.find((segment) => (
    predicate(segment)
      && currentTime >= segment.start
      && currentTime + ACTIVE_SEGMENT_EPSILON < segment.end
  )) || null;
}

function contiguousAutoSegments(segments, firstSegment) {
  const skippedSegments = [firstSegment];
  let targetEnd = firstSegment.end;

  for (const segment of segments) {
    if (!segment.autoSkip || segment.skipped || skippedSegments.includes(segment)) continue;
    if (segment.start > targetEnd + ACTIVE_SEGMENT_EPSILON) continue;
    if (segment.end <= firstSegment.start + ACTIVE_SEGMENT_EPSILON) continue;

    skippedSegments.push(segment);
    targetEnd = Math.max(targetEnd, segment.end);
  }

  return skippedSegments.sort((a, b) => a.start - b.start || a.end - b.end);
}

function skipSegments(player, noteElement, segments, targetTime) {
  for (const segment of segments) {
    segment.skipped = true;
  }

  if (!player) return;

  player.currentTime = targetTime;
  const label = segments.length === 1
    ? labelForCategory(segments[0].category).toLowerCase()
    : `${segments.length} segments`;
  setNote(noteElement, `Skipped ${label}.`);
}

function clearSkipGuards(segments, currentTime) {
  for (const segment of segments) {
    if (currentTime < segment.start - ACTIVE_SEGMENT_EPSILON || currentTime > segment.end + ACTIVE_SEGMENT_EPSILON) {
      segment.skipped = false;
    }
  }
}

function updateSkipButton(button, segment) {
  if (!button) return;
  button.hidden = !segment;
  button.disabled = !segment;
  button.textContent = segment ? `Skip ${labelForCategory(segment.category).toLowerCase()}` : "Skip segment";
}

function setNote(element, text) {
  if (element) element.textContent = text;
}

function colorForCategory(category) {
  return sponsorBlockCategoryOptions.find((option) => option.id === category)?.color || "#35c26b";
}

function labelForCategory(category) {
  return sponsorBlockCategoryOptions.find((option) => option.id === category)?.label || "segment";
}
