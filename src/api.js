import { getConfig, normalizeOrigin } from "./config.js";
import { isExternalUrl } from "./utils.js";

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export function apiOrigin() {
  return normalizeOrigin(getConfig().apiOrigin);
}

export function assetUrl(url) {
  if (!url) return "";
  if (isExternalUrl(url) || url.startsWith("data:") || url.startsWith("blob:")) return url;
  return `${apiOrigin()}${url.startsWith("/") ? url : `/${url}`}`;
}

export function apiUrl(path, params = {}) {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, `${apiOrigin()}/`);
  const config = getConfig();

  if (config.region && !("region" in params)) {
    url.searchParams.set("region", config.region);
  }

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

export function backendUrl(path, params = {}) {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, `${apiOrigin()}/`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

export function mediaUrl(path, params = {}) {
  const url = backendUrl(path, params);

  if (["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) {
    return `/proxy?url=${encodeURIComponent(url)}`;
  }

  return url;
}

export function dashManifestUrl(id) {
  const url = backendUrl(`/api/manifest/dash/id/${encodeURIComponent(id)}`, {
    local: "true",
    unique_res: "1"
  });

  if (["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) {
    return `/dash-manifest?url=${encodeURIComponent(url)}`;
  }

  return url;
}

async function readResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  return response.text();
}

export async function request(path, params = {}, options = {}) {
  const response = await fetch(apiUrl(path, params), {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await readResponse(response);

  if (!response.ok) {
    const message = payload?.error || payload?.message || response.statusText || "Request failed";
    throw new ApiError(message, response.status, payload);
  }

  return payload;
}

export const api = {
  stats: () => request("/api/v1/stats"),
  search: (q, options = {}) => request("/api/v1/search", { q, ...options }),
  suggestions: (q) => request("/api/v1/search/suggestions", { q }),
  video: (id, options = {}) => request(`/api/v1/videos/${encodeURIComponent(id)}`, { local: "true" }, options),
  comments: (id, source = "youtube") => request(`/api/v1/comments/${encodeURIComponent(id)}`, { source }),
  channel: (ucid) => request(`/api/v1/channels/${encodeURIComponent(ucid)}`),
  channelTab: (ucid, tab, params = {}) => request(`/api/v1/channels/${encodeURIComponent(ucid)}/${tab}`, params),
  channelSearch: (ucid, q) => request(`/api/v1/channels/${encodeURIComponent(ucid)}/search`, { q }),
  playlist: (plid) => request(`/api/v1/playlists/${encodeURIComponent(plid)}`),
  mix: (rdid) => request(`/api/v1/mixes/${encodeURIComponent(rdid)}`),
  latestVersion: (id, itag) => mediaUrl("/latest_version", { id, itag, local: "true" }),
  dashManifest: (id) => dashManifestUrl(id),
  captions: (id, params = {}) => apiUrl(`/api/v1/captions/${encodeURIComponent(id)}`, params)
};
