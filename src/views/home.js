import { clearVideoProgress, getCurrentAccount, listVideoProgress } from "../account.js";
import { emptyState, pageHeader } from "../components.js";
import { progressCard } from "../saved-videos.js";
import { setTitle } from "../utils.js";

export function renderHome() {
  setTitle("Home");
  const view = document.getElementById("view");
  const account = getCurrentAccount();
  if (!account) {
    view.innerHTML = `
      ${pageHeader("Find something to watch", "Search for videos, channels and playlists using the search bar above.")}
      ${emptyState("Your videos, saved here", "Sign in to continue watching your saved videos and discover similar ones.")}
      <div class="form-actions"><a class="button" href="/account" data-link>Sign in</a></div>
    `;
    return;
  }

  const saved = listVideoProgress();
  view.innerHTML = `
    ${pageHeader("Saved videos", `Continue watching as ${account.name}.`, '<a class="button button-ghost" href="/recommendations" data-link>Similar videos</a>')}
    ${saved.length
      ? `<section class="list">${saved.map(progressCard).join("")}</section>`
      : emptyState("No saved videos yet", "Start watching a video while signed in. Your progress will appear here.")}
  `;
  view.querySelectorAll("[data-remove-progress]").forEach((button) => {
    button.addEventListener("click", () => {
      if (window.confirm(`Remove "${button.dataset.removeTitle}" from saved progress?`)) {
        clearVideoProgress(button.dataset.removeProgress);
      }
    });
  });
}
