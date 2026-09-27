import { renderAccount } from "./views/account.js";
import { applyTheme } from "./config.js";
import { installRouter, navigate, notFound, renderRoute, route } from "./router.js";
import { renderChannel } from "./views/channel.js";
import { renderHome } from "./views/home.js";
import { renderRecommendations } from "./views/recommendations.js";
import { renderPlaylist } from "./views/playlist.js";
import { renderSearch } from "./views/search.js";
import { renderSettings } from "./views/settings.js";
import { renderStaticPage } from "./views/static.js";
import { renderWatch } from "./views/watch.js";
import { initAccount, getCurrentAccount, getCurrentAccountKey } from "./account.js";

(async () => {
  applyTheme();

  const activeKey = getCurrentAccountKey();
  if (activeKey) {
    await initAccount(activeKey);
  }

  route("/", renderHome);
  route("/recommendations", renderRecommendations);
  route("/search", renderSearch);
  route("/watch", renderWatch);
  route("/account", renderAccount);
  route("/channel/:ucid", renderChannel);
  route("/playlist", renderPlaylist);
  route("/settings", renderSettings);
  route("/privacy", (ctx) => renderStaticPage(ctx, "privacy"));
  route("/licenses", (ctx) => renderStaticPage(ctx, "licenses"));
  notFound(renderHome);

  installRouter();

  document.getElementById("global-search").addEventListener("submit", (event) => {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get("q")?.toString().trim();
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
  });

  window.addEventListener("configchange", () => renderRoute());

  const refreshAccountPages = () => {
    document.getElementById("recommendations-link").hidden = !getCurrentAccount();
    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    if (path === "/" || path === "/recommendations") renderRoute();
  };
  window.addEventListener("accountchange", refreshAccountPages);
  window.addEventListener("accountprogresschange", refreshAccountPages);
  document.getElementById("recommendations-link").hidden = !getCurrentAccount();

  renderRoute();
})();
