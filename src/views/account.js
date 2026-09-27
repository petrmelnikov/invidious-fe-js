import { clearAccountProgress, clearVideoProgress, getCurrentAccount, listVideoProgress, signIn, signOut } from "../account.js";
import { emptyState, pageHeader } from "../components.js";
import { escapeHtml, setTitle } from "../utils.js";

import { progressCard } from "../saved-videos.js";
import { navigate } from "../router.js";

const view = () => document.getElementById("view");

export function renderAccount() {
  setTitle("Account");

  const account = getCurrentAccount();
  const progress = listVideoProgress();
  const subtitle = account
    ? `Signed in as ${account.name}. Only watch progress is saved for this local account.`
    : "Enter a name to sign in or create a local account.";

  view().innerHTML = `
    ${pageHeader("Account", subtitle)}

    <form class="settings-form" id="account-form">
      <fieldset class="settings-fieldset">
        <legend>Login / register</legend>

        <label>
          Name
          <input name="name" required autocomplete="nickname" placeholder="alice">
        </label>

        <p class="form-hint">
          ${account
            ? `Current account: <strong>${escapeHtml(account.name)}</strong>. Enter another name to switch accounts or create a new one.`
            : "Your account name and watch progress are synced with this frontend server."}
        </p>
      </fieldset>

      <div class="form-actions">
        <button class="button" type="submit">Continue</button>
        ${account ? '<button class="button button-ghost" type="button" id="account-signout">Sign out</button>' : ""}
      </div>
    </form>

    ${account ? `
      <section class="section text-section">
        <div class="section-heading">
          <h2>Saved progress</h2>
          <span class="pill">${escapeHtml(String(progress.length))} videos</span>
        </div>
        <p>Only watch progress is stored in the account. Settings such as backend URL, region, theme, and playback preferences still stay outside the account on this device.</p>
        ${progress.length ? '<div class="form-actions"><button class="button button-ghost" type="button" id="clear-account-progress">Clear saved progress</button></div>' : ""}
      </section>

      ${progress.length ? `
        <section class="list">
          ${progress.map(progressCard).join("")}
        </section>
      ` : emptyState("No saved progress yet", "Start a video while signed in and it will appear here.")}
    ` : ""}
  `;

  document.getElementById("account-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name");
    if (!(await signIn(name))) return;
    navigate("/");
  });

  document.getElementById("account-signout")?.addEventListener("click", () => {
    signOut();
    renderAccount();
  });

  document.getElementById("clear-account-progress")?.addEventListener("click", () => {
    clearAccountProgress();
    renderAccount();
  });

  view().querySelectorAll("[data-remove-progress]").forEach((button) => {
    button.addEventListener("click", () => {
      const title = button.dataset.removeTitle || "this video";
      if (!window.confirm(`Remove "${title}" from saved progress?`)) return;
      clearVideoProgress(button.dataset.removeProgress);
      renderAccount();
    });
  });
}
