# Invidious FE

Standalone frontend for an Invidious backend. It does not copy templates back into
the original Crystal project; it talks to the backend through `/api/v1/*`.

## Run

Start Invidious separately, usually on `http://localhost:3000`, then run:

```sh
npm run dev
```

Open `http://localhost:5173`.

The frontend backend URL is configurable in the Settings page. The default is
`http://localhost:3000`.

## Run With Docker Compose

Build and start the frontend container:

```sh
docker compose up -d --build
```

By default the app is published on `http://localhost:5173` and expects the
Invidious backend at `http://localhost:3000`. On a server, set the public backend
origin that browsers can reach:

```sh
INVIDIOUS_API_ORIGIN=https://invidious.example.com docker compose up -d --build
```

Supported compose environment variables:

- `INVIDIOUS_FE_PORT` - host port for the frontend, defaults to `5173`.
- `PORT` - internal container port, defaults to `5173`.
- `INVIDIOUS_API_ORIGIN` - default Invidious backend origin shown in Settings.
- `INVIDIOUS_REGION` - optional default region code.
- `SPONSORBLOCK_API_ORIGIN` - SponsorBlock API origin, defaults to
  `https://sponsor.ajay.app`.

Settings are still saved in each browser's localStorage. Resetting settings in
the app returns to the defaults provided by the container environment.

## Project Layout

- `src/api.js` - Invidious API client and URL helpers.
- `src/router.js` - client-side routing.
- `src/views/` - pages for home, search, watch, channel, playlist, and settings.
- `src/components.js` - shared cards, lists, loading and error states.
- `src/styles.css` - complete UI styling.
- `scripts/dev-server.mjs` - dependency-free static dev server with SPA fallback.

## Implemented Surface

- Search with filters through `/api/v1/search`.
- Signed-in homepage with saved videos and resume controls.
- A Similar videos page based on the 12 most recently saved videos, with duplicates and saved videos excluded.
- Watch page with proxied video streams via `/api/v1/videos/:id?local=true`.
- SponsorBlock integration on the watch player with per-category auto-skip or manual-skip behavior.
- Related videos, comments, captions, metadata, and channel links.
- Channel overview, latest videos, playlists, community, channels, and search.
- Public playlists.
- Maximum available video quality and original audio on every new video; Russian is preferred only among original tracks, not automatic translations. Quality and audio can still be changed for the current video.
- Backend origin, region, theme, and playback speed preferences.

## SponsorBlock

SponsorBlock is integrated in the same style as Piped: the frontend fetches skip
segments from the official SponsorBlock API and applies them on top of the native
HTML5 video element. The integration is isolated in `src/sponsorblock.js` so it
can evolve independently from the rest of the player code.

The Settings page lets you:

- enable or disable SponsorBlock;
- choose the SponsorBlock API origin;
- toggle timeline markers;
- set the minimum segment length;
- configure each category as `auto`, `button`, or `no`.

There is no browser-ready SponsorBlock package with a stable player API that fits
this app better than the direct API approach. The available packages are either
Node-only wrappers or userscript bundles, so this frontend talks directly to the
official API instead of vendoring a third-party runtime.

Account names and watch progress are synced through the frontend server. Saved
videos are the existing watch-progress list: videos appear after playback starts
and leave the list when finished or removed. Guests see search and sign-in entry
points. Similar videos are available after signing in; an unavailable seed does
not prevent recommendations from the other saved videos from being shown.

Run `npm run check` for JavaScript syntax checks and `npm test` for playback
selection and recommendation tests.
