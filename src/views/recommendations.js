import { getCurrentAccount, listVideoProgress } from "../account.js";
import { api } from "../api.js";
import { emptyState, errorState, grid, loading, pageHeader } from "../components.js";
import { loadRecommendations, MAX_SEEDS } from "../recommendations.js";
import { setTitle } from "../utils.js";

export async function renderRecommendations() {
  setTitle("Similar videos");
  const view = document.getElementById("view");
  const account = getCurrentAccount();
  if (!account) {
    view.innerHTML = `${pageHeader("Similar videos")}
      ${emptyState("Sign in to see similar videos", "Recommendations are based on your saved videos.")}
      <div class="form-actions"><a class="button" href="/account" data-link>Sign in</a></div>`;
    return;
  }
  const saved = listVideoProgress();
  const header = pageHeader("Similar videos", `Based on your ${Math.min(saved.length, MAX_SEEDS)} most recently saved videos.`);
  if (!saved.length) {
    view.innerHTML = `${pageHeader("Similar videos")}${emptyState("No saved videos yet", "Start watching a video while signed in to get recommendations.")}`;
    return;
  }

  view.innerHTML = `${header}<div id="recommendation-results">${loading("Finding similar videos")}</div>`;
  const results = document.getElementById("recommendation-results");
  const isCurrent = () => results.isConnected && getCurrentAccount()?.id === account.id
    && window.location.pathname.replace(/\/+$/, "") === "/recommendations";
  const { items, failed, total } = await loadRecommendations(saved,
    (id) => api.video(id, { signal: AbortSignal.timeout(15000) }), isCurrent);
  if (!isCurrent()) return;

  if (total > 0 && failed === total) {
    results.innerHTML = errorState(new Error("Could not load similar videos. Check the backend connection and try again."));
  } else {
    results.innerHTML = `
      ${failed ? '<p class="form-hint">Some saved videos could not be loaded. Showing available recommendations.</p><button class="button button-ghost" data-action="retry">Try again</button>' : ""}
      ${items.length ? grid(items) : emptyState("No new recommendations yet", "No similar videos were found outside your saved list. Try another saved video.")}
    `;
  }
  results.querySelector("[data-action='retry']")?.addEventListener("click", renderRecommendations);
}
