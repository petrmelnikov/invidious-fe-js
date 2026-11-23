import { escapeHtml } from "../utils.js";

const components = { engine: "Invidious engine", frontend: "Invidious FE" };

export function updatesSectionMarkup() {
  return `<section class="section" aria-labelledby="updates-heading">
    <div class="section-heading"><h2 id="updates-heading">Software updates</h2></div>
    <div class="settings-form" id="updates-body"><p role="status">Checking versions…</p></div>
  </section>`;
}

function revision(sha) {
  return sha ? `<code title="${escapeHtml(sha)}">${escapeHtml(sha.slice(0, 10))}</code>` : "Unknown";
}

function componentRow(target, info, busy) {
  const { current, available, branch, error, canUpdate } = info;
  const isCurrent = current && current === available && !error && !canUpdate;
  return `<fieldset class="settings-fieldset">
    <legend>${components[target]}</legend>
    <p class="form-hint">Running ${revision(current)} · Available ${revision(available)}
      ${branch ? `on <code>${escapeHtml(branch)}</code>` : ""}</p>
    ${error ? `<p class="form-hint" role="alert">${escapeHtml(error)}</p>` : ""}
    ${isCurrent ? '<p class="form-hint">Up to date</p>' : ""}
    ${canUpdate ? `<button type="button" class="button" data-action="${target}" ${busy ? "disabled" : ""}>Update ${components[target]}</button>` : ""}
  </fieldset>`;
}

export function mountUpdates() {
  const body = document.getElementById("updates-body");
  let state;
  let pending = false;
  let timer;
  let message = "";

  function working() {
    return state?.checking || state?.job?.state === "running";
  }

  function render() {
    const busy = pending || working();
    const rows = state ? Object.keys(components).map(target =>
      componentRow(target, state.components[target], busy)).join("") : "";
    const job = state?.job;
    body.innerHTML = `${rows}
      ${job ? `<p class="form-hint" role="status">${components[job.target]} · ${escapeHtml(job.message)}</p>` : ""}
      ${message ? `<p class="form-hint" role="status">${escapeHtml(message)}</p>` : ""}
      <div class="form-actions">
        <button type="button" class="button button-ghost" data-action="check" ${busy ? "disabled" : ""}>
          ${state?.checking || (pending && !state) ? "Checking versions…" : "Check for updates"}
        </button>
      </div>`;
  }

  async function refresh(action = "") {
    if (!body.isConnected || pending) return;
    clearTimeout(timer);
    pending = true;
    message = "";
    render();
    let reconnect = false;
    try {
      const options = { cache: "no-store" };
      if (action) {
        options.method = "POST";
        options.headers = { "Content-Type": "application/json" };
        if (Object.hasOwn(components, action)) {
          options.headers["If-Match"] = `"${state.components[action].available}"`;
        }
      }
      const response = await fetch("/api/updates" + (action ? "/" + action : ""), options);
      const payload = await response.json();
      if (!response.ok) {
        reconnect = response.status === 409 || (response.status >= 500 && working());
        throw new Error(payload.error || `Update request failed (HTTP ${response.status}).`);
      }
      state = payload;
    } catch (error) {
      reconnect ||= working() || (action === "frontend" && error instanceof TypeError);
      message = error instanceof TypeError ? "Cannot reach the server." : error.message;
      if (reconnect) message += " Checking status again…";
    } finally {
      pending = false;
    }
    if (!body.isConnected) return;
    render();
    if (working() || reconnect) timer = setTimeout(refresh, 2000);
  }

  body.addEventListener("click", event => {
    const action = event.target.closest("button[data-action]")?.dataset.action;
    if (!action || pending || working()) return;
    if (action !== "check") {
      const info = state?.components[action];
      if (!info?.canUpdate || !window.confirm(`Update ${components[action]} to ${info.available.slice(0, 10)}?`)) return;
    }
    void refresh(action);
  });
  void refresh();
}
