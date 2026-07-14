const CONFIG_KEY = "invidious-fe:config";

const baseDefaults = {
  apiOrigin: "http://localhost:3000",
  region: "",
  theme: "system",
  quality: "auto",
  playbackSpeed: 1,
  fullPagePlayer: false,
  comments: "youtube",
  sponsorBlock: {
    enabled: false,
    apiOrigin: "https://sponsor.ajay.app",
    showMarkers: true,
    minSegmentLength: 1,
    categories: {
      sponsor: "auto",
      selfpromo: "auto",
      interaction: "button",
      intro: "button",
      outro: "button",
      preview: "button",
      hook: "no",
      filler: "no"
    }
  }
};

const runtimeDefaults =
  typeof globalThis !== "undefined" &&
  globalThis.__INVIDIOUS_FE_CONFIG__ &&
  typeof globalThis.__INVIDIOUS_FE_CONFIG__ === "object"
    ? globalThis.__INVIDIOUS_FE_CONFIG__
    : {};

const defaults = mergeDefaultConfig(runtimeDefaults);

function mergeDefaultConfig(saved = {}) {
  return {
    ...baseDefaults,
    ...saved,
    sponsorBlock: {
      ...baseDefaults.sponsorBlock,
      ...(saved.sponsorBlock || {}),
      categories: {
        ...baseDefaults.sponsorBlock.categories,
        ...(saved.sponsorBlock?.categories || {})
      }
    }
  };
}

function mergeSponsorBlock(saved = {}) {
  return {
    ...defaults.sponsorBlock,
    ...saved,
    categories: {
      ...defaults.sponsorBlock.categories,
      ...(saved.categories || {})
    }
  };
}

function mergeConfig(saved = {}) {
  return {
    ...defaults,
    ...saved,
    sponsorBlock: mergeSponsorBlock(saved.sponsorBlock)
  };
}

export function getConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
    return mergeConfig(saved);
  } catch {
    return mergeConfig();
  }
}

export function saveConfig(nextConfig, options = {}) {
  const { silent = false } = options;
  const current = getConfig();
  const config = mergeConfig({
    ...current,
    ...nextConfig,
    sponsorBlock: nextConfig.sponsorBlock
      ? {
          ...current.sponsorBlock,
          ...nextConfig.sponsorBlock,
          categories: {
            ...current.sponsorBlock.categories,
            ...(nextConfig.sponsorBlock.categories || {})
          }
        }
      : current.sponsorBlock
  });
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  applyTheme(config.theme);
  if (!silent) {
    window.dispatchEvent(new CustomEvent("configchange", { detail: config }));
  }
  return config;
}

export function resetConfig() {
  localStorage.removeItem(CONFIG_KEY);
  applyTheme(defaults.theme);
  window.dispatchEvent(new CustomEvent("configchange", { detail: getConfig() }));
}

export function applyTheme(theme = getConfig().theme) {
  document.documentElement.dataset.theme = theme;
}

export function normalizeOrigin(origin) {
  return String(origin || "")
    .trim()
    .replace(/\/+$/, "");
}

export { defaults };
