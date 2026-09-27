function language(track) {
  return String(track.lang || track.language || "").toLowerCase().split(/[-_.]/)[0];
}

function labels(track) {
  return [track.label, ...(track.labels || []).map((label) => label.text || label)]
    .filter(Boolean).join(" ").toLowerCase();
}

function roles(track) {
  return (track.roles || []).map((role) => String(role.value || role).toLowerCase());
}

function isDubbed(track) {
  return track.isAutoDubbed === true || roles(track).includes("dub")
    || /auto[ -]?dub|auto[ -]?translat|автоперевод|автоматическ/.test(labels(track));
}

function isOriginal(track) {
  return track.isOriginal === true || /\boriginal\b|оригинал/.test(labels(track));
}

function audioBitrate(track) {
  return Math.max(0, ...(track.bitrateList || []).map((entry) => Number(entry.bandwidth || entry.bitrate) || 0));
}

// Invidious maps YouTube's original/default audio to the DASH "main" role.
// Prefer Russian only within the original tracks, never an alternate translation.
export function chooseInitialAudioTrack(tracks = []) {
  const undubbed = tracks.filter((track) => !isDubbed(track));
  const originals = undubbed.filter(isOriginal);
  const main = undubbed.filter((track) => roles(track).includes("main"));
  const candidates = originals.length ? originals : main;
  if (candidates.length) {
    return [...candidates].sort((a, b) =>
      Number(language(b) === "ru") - Number(language(a) === "ru")
      || audioBitrate(b) - audioBitrate(a))[0];
  }

  // With incomplete metadata, do not promote a Russian alternate over the
  // unlabelled/default track. A lone track also covers older manifests.
  return undubbed.find((track) => !roles(track).includes("alternate") && language(track) !== "ru")
    || undubbed.find((track) => !roles(track).includes("alternate"))
    || undubbed.find((track) => language(track) !== "ru")
    || undubbed[0] || tracks[0];
}

export function videoHeight(stream) {
  return Number(stream.height)
    || Number.parseInt(stream.qualityLabel || stream.resolution || stream.quality || "0", 10) || 0;
}

export function compareVideoQuality(a, b) {
  return videoHeight(b) - videoHeight(a)
    || Number(b.fps || 0) - Number(a.fps || 0)
    || Number(b.bitrate || b.bandwidth || 0) - Number(a.bitrate || a.bandwidth || 0);
}

export function chooseDashQuality(bitrates = [], requested = { mode: "dash-best" }) {
  const available = bitrates.map((entry, index) => ({ ...entry, index }));
  const matching = requested.mode === "dash-fixed"
    ? available.filter((entry) => videoHeight(entry) === requested.height)
    : available;
  // The actual manifest is authoritative; advertised formats can be absent.
  return (matching.length ? matching : available).sort(compareVideoQuality)[0];
}
