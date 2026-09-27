import { apiOrigin } from "../api.js";
import { defaults, getConfig, resetConfig, saveConfig } from "../config.js";
import { getSponsorBlockSettings, sponsorBlockCategoryOptions } from "../sponsorblock.js";
import { pageHeader } from "../components.js";
import { escapeHtml, setTitle } from "../utils.js";

const view = () => document.getElementById("view");

export function renderSettings() {
  setTitle("Settings");
  const config = getConfig();
  const sponsorBlock = getSponsorBlockSettings(config);
  view().innerHTML = `
    ${pageHeader("Settings", "This frontend stores preferences locally in your browser.")}
    <form class="settings-form" id="settings-form">
      <label>
        Backend URL
        <input name="apiOrigin" type="url" required value="${escapeHtml(config.apiOrigin)}" placeholder="http://localhost:3000">
      </label>

      <label>
        Region
        <input name="region" value="${escapeHtml(config.region)}" placeholder="US, DE, IL...">
      </label>

      <label>
        Theme
        <select name="theme" class="select">
          ${option("system", "System", config.theme)}
          ${option("dark", "Dark", config.theme)}
          ${option("light", "Light", config.theme)}
        </select>
      </label>

      <p class="form-hint">Videos start at the maximum available quality with original audio. Russian is selected when it is an original language, not an automatic translation. You can change quality and audio in the player for the current video.</p>

      <label>
        Comments source
        <select name="comments" class="select">
          ${option("youtube", "YouTube", config.comments)}
          ${option("reddit", "Reddit", config.comments)}
        </select>
      </label>

      <fieldset class="settings-fieldset">
        <legend>SponsorBlock</legend>

        <label class="checkbox-row">
          <input name="sponsorBlockEnabled" type="checkbox" ${sponsorBlock.enabled ? "checked" : ""}>
          <span>Enable SponsorBlock for the watch player</span>
        </label>

        <label>
          SponsorBlock API
          <input name="sponsorBlockApi" type="url" required value="${escapeHtml(sponsorBlock.apiOrigin)}" placeholder="https://sponsor.ajay.app">
        </label>

        <label class="checkbox-row">
          <input name="sponsorBlockShowMarkers" type="checkbox" ${sponsorBlock.showMarkers ? "checked" : ""}>
          <span>Show SponsorBlock markers under the player</span>
        </label>

        <label>
          Minimum segment length (seconds)
          <input name="sponsorBlockMinSegmentLength" type="number" min="0" step="0.1" value="${escapeHtml(String(sponsorBlock.minSegmentLength))}">
        </label>

        <p class="form-hint">Per-category behavior matches the Piped pattern: <strong>Auto</strong>, <strong>Button</strong>, or <strong>Off</strong>. <strong>Filler</strong> stays disabled by default because it is intentionally aggressive.</p>

        <div class="settings-grid sponsorblock-grid">
          ${sponsorBlockCategoryOptions.map((category) => `
            <label>
              ${escapeHtml(category.label)}
              <select name="sponsorBlockCategory:${escapeHtml(category.id)}" class="select">
                ${option("auto", "Auto skip", sponsorBlock.categories[category.id])}
                ${option("button", "Show skip button", sponsorBlock.categories[category.id])}
                ${option("no", "Off", sponsorBlock.categories[category.id])}
              </select>
            </label>
          `).join("")}
        </div>
      </fieldset>

      <div class="form-actions">
        <button class="button" type="submit">Save</button>
        <button class="button button-ghost" type="button" id="reset-settings">Reset</button>
      </div>
    </form>

    <section class="section">
      <div class="section-heading"><h2>Current API</h2></div>
      <code class="code-block">${escapeHtml(apiOrigin())}/api/v1</code>
    </section>
  `;

  document.getElementById("settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const sponsorBlockCategories = Object.fromEntries(sponsorBlockCategoryOptions.map((category) => [
      category.id,
      ["auto", "button", "no"].includes(form[`sponsorBlockCategory:${category.id}`])
        ? form[`sponsorBlockCategory:${category.id}`]
        : category.defaultMode
    ]));

    saveConfig({
      apiOrigin: form.apiOrigin || defaults.apiOrigin,
      region: form.region,
      theme: form.theme,
      comments: form.comments,
      sponsorBlock: {
        enabled: form.sponsorBlockEnabled === "on",
        apiOrigin: form.sponsorBlockApi || defaults.sponsorBlock.apiOrigin,
        showMarkers: form.sponsorBlockShowMarkers === "on",
        minSegmentLength: Math.max(0, Number(form.sponsorBlockMinSegmentLength || defaults.sponsorBlock.minSegmentLength)),
        categories: sponsorBlockCategories
      }
    });
    renderSettings();
  });

  document.getElementById("reset-settings").addEventListener("click", () => {
    resetConfig();
    renderSettings();
  });
}

function option(value, label, selected) {
  return `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`;
}
