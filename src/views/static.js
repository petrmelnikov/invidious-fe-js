import { pageHeader } from "../components.js";
import { setTitle } from "../utils.js";

const view = () => document.getElementById("view");

export function renderStaticPage(_ctx, page) {
  if (page === "licenses") {
    setTitle("Licenses");
    view().innerHTML = `
      ${pageHeader("JavaScript licenses", "Player libraries are loaded on demand from jsDelivr.")}
      <section class="section text-section">
        <p>The optional JS player uses <a href="https://github.com/muxinc/media-chrome/tree/v4.19.3" target="_blank" rel="noreferrer noopener">Media Chrome 4.19.3</a>, licensed under the <a href="https://github.com/muxinc/media-chrome/blob/v4.19.3/LICENSE" target="_blank" rel="noreferrer noopener">MIT license</a>.</p>
        <p>DASH playback uses <a href="https://github.com/Dash-Industry-Forum/dash.js/tree/v4.7.4" target="_blank" rel="noreferrer noopener">dash.js 4.7.4</a>. Video and media endpoints are provided by the configured Invidious backend.</p>
      </section>
    `;
    return;
  }

  setTitle("Privacy");
  view().innerHTML = `
    ${pageHeader("Privacy", "The frontend stores only local data in your browser.")}
    <section class="section text-section">
      <p>Searches, video requests, comments, and media requests are sent to the configured Invidious backend. Preferences such as backend URL, theme, region, and quality are saved in localStorage on this device. Local account names and watch progress are also stored only in this browser and are never sent to the backend.</p>
    </section>
  `;
}
