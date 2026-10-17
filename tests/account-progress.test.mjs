import assert from "node:assert/strict";
import test from "node:test";
import { applyProgressOperations, normalizeProgressAccount } from "../scripts/account-progress.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const pendingKey = "invidious-fe:account-pending";
const windowTarget = new EventTarget();
const documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" });
const timers = new Map();
let nextTimer = 0;
Object.assign(windowTarget, {
  setTimeout: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
  clearTimeout: (id) => timers.delete(id)
});
globalThis.window = windowTarget;
globalThis.document = documentTarget;
globalThis.CustomEvent ??= class extends Event {
  constructor(type, { detail } = {}) { super(type); this.detail = detail; }
};
const account = await import("../src/account.js");
const { installAccountProgress } = await import("../src/account-progress.js");

class Player extends EventTarget {
  _time = 0;
  duration = 3000;
  readyState = 1;
  paused = true;
  seeking = false;
  ended = false;
  isConnected = true;
  seekable = { length: 0 };
  get currentTime() { return this._time; }
  set currentTime(time) {
    this.seeking = true;
    this._time = time;
    this.dispatchEvent(new Event("seeking"));
    this.seeking = false;
    this.dispatchEvent(new Event("seeked"));
    this.dispatchEvent(new Event("timeupdate"));
  }
  advance(time) { this._time = time; this.dispatchEvent(new Event("timeupdate")); }
  pause() { const wasPlaying = !this.paused; this.paused = true; if (wasPlaying) this.dispatchEvent(new Event("pause")); }
  play() { this.paused = false; this.dispatchEvent(new Event("play")); this.dispatchEvent(new Event("playing")); }
}

async function fixture(t, { initialTime = 100, initialProgress = true, applyInitialSeek = true } = {}) {
  timers.clear();
  documentTarget.visibilityState = "visible";
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key)
  };
  const server = normalizeProgressAccount({ progress: initialProgress ? { a: { currentTime: initialTime, duration: 3000 } } : {} }, "Alice");
  const calls = [];
  let intercept = null;
  const respond = async (url, options = {}) => {
    if (intercept) {
      const override = await intercept(url, options);
      if (override) return override;
    }
    if (options.method === "POST") {
      const ops = JSON.parse(options.body).ops;
      calls.push(structuredClone(ops));
      const results = applyProgressOperations(server, ops);
      return Response.json({ account: structuredClone(server), results }, { status: results.some((r) => r.status === "conflict") ? 409 : 200 });
    }
    return Response.json(structuredClone(server));
  };
  globalThis.fetch = respond;
  await account.signIn("Alice");
  const player = new Player();
  const noteElement = { textContent: "" };
  const stop = installAccountProgress({ player, video: { videoId: "a", title: "Video", lengthSeconds: 3000 }, noteElement, initialTime, applyInitialSeek });
  t.after(async () => { stop(); await account.refreshAccountProgress(); account.signOut(); await tick(); });
  const remote = (time, type = "upsert") => applyProgressOperations(server, [{
    id: `remote-${Math.random()}`, type, videoId: "a", expectedRevision: server.revisions.a || 0,
    entry: { currentTime: time, duration: 3000 }
  }]);
  const queued = () => JSON.parse(storage.get(pendingKey) || "{}").alice || [];
  return { server, storage, player, noteElement, calls, remote, queued, stop, intercept: (fn) => { intercept = fn; } };
}

test("paused players do not write unchanged positions on pause/hide/close or programmatic resume", async (t) => {
  const f = await fixture(t);
  assert.equal(f.player.currentTime, 100);
  f.player.dispatchEvent(new Event("pause"));
  documentTarget.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  windowTarget.dispatchEvent(new Event("pagehide"));
  await account.refreshAccountProgress();
  assert.equal(f.calls.length, 0);
  assert.equal(f.server.revisions.a, 0);
});

test("returning to a tab loads the latest remote position without writing it back", async (t) => {
  const f = await fixture(t);
  f.remote(900);
  documentTarget.visibilityState = "visible";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await account.refreshAccountProgress();
  assert.equal(f.player.currentTime, 900);
  assert.equal(f.player.paused, true);
  assert.equal(f.calls.length, 0);
  assert.match(f.noteElement.textContent, /synced/);
  // A deliberate backwards seek after synchronization is allowed.
  f.player.currentTime = 500;
  await account.refreshAccountProgress();
  assert.equal(f.server.progress.a.currentTime, 500);
  assert.equal(f.server.revisions.a, 2);
});

test("stale playback writes conflict, pause and synchronize instead of retrying with a new revision", async (t) => {
  const f = await fixture(t);
  f.remote(900);
  f.player.play();
  f.player.advance(110);
  await account.refreshAccountProgress();
  assert.equal(f.server.progress.a.currentTime, 900);
  assert.equal(f.player.currentTime, 900);
  assert.equal(f.player.paused, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0].expectedRevision, 0);
  assert.equal(f.queued().length, 0);
});

test("remote completion resets an old player and blocks resurrection or stale completion", async (t) => {
  const f = await fixture(t);
  f.remote(3000, "remove");
  f.player.advance(120);
  await account.refreshAccountProgress();
  assert.equal(f.server.progress.a, undefined);
  assert.equal(f.player.currentTime, 0);
  assert.equal(f.server.revisions.a, 1);
  assert.equal(f.queued().length, 0);
  // New viewing after the completed state was actually loaded can create progress again.
  f.player.play(); f.player.advance(10);
  await account.refreshAccountProgress();
  assert.equal(f.server.progress.a.currentTime, 10);
  f.remote(500);
  f.player._time = 3000;
  f.player.ended = true;
  f.player.dispatchEvent(new Event("ended"));
  await account.refreshAccountProgress();
  assert.equal(f.server.progress.a.currentTime, 500);
});

test("a successful save advances this player's revision; small paused changes also persist", async (t) => {
  const f = await fixture(t);
  f.player.play(); f.player.advance(110);
  await account.refreshAccountProgress();
  assert.equal(f.server.revisions.a, 1);
  f.player.advance(112); f.player.pause();
  await account.refreshAccountProgress();
  assert.equal(f.server.progress.a.currentTime, 112);
  assert.equal(f.server.revisions.a, 2);
  assert.deepEqual(f.calls.map((ops) => ops[0].expectedRevision), [0, 1]);
});

test("changes made during an in-flight save use only its acknowledged revision", async (t) => {
  const f = await fixture(t);
  let release;
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let held = false;
  f.intercept(async (_url, options) => {
    if (options.method === "POST" && !held) { held = true; started(); await gate; }
  });
  f.player.play(); f.player.advance(110);
  windowTarget.dispatchEvent(new Event("pagehide"));
  await start;
  f.player.advance(120);
  assert.equal(f.queued().length, 2);
  release();
  await account.refreshAccountProgress();
  assert.equal(f.server.progress.a.currentTime, 120);
  assert.equal(f.server.revisions.a, 2);
  assert.deepEqual(f.calls.map((ops) => ops[0].expectedRevision), [0, 1]);
});

test("lost POST acknowledgement retains the operation ID and later local changes", async (t) => {
  const f = await fixture(t);
  const logged = t.mock.method(console, "error", () => {});
  let lose = true;
  f.intercept(async (_url, options) => {
    if (options.method === "POST" && lose) {
      lose = false;
      applyProgressOperations(f.server, JSON.parse(options.body).ops);
      throw new Error("simulated lost response");
    }
  });
  f.player.play(); f.player.advance(110);
  windowTarget.dispatchEvent(new Event("pagehide"));
  await tick();
  const attemptedId = f.queued()[0].id;
  f.player.advance(120);
  assert.equal(f.queued()[0].id, attemptedId);
  await account.refreshAccountProgress();
  assert.equal(f.server.progress.a.currentTime, 120);
  assert.equal(f.server.revisions.a, 2);
  assert.equal(f.calls[0][0].id, attemptedId);
  assert.equal(logged.mock.callCount(), 1);
});

test("a GET recovers a lost acknowledgement without discarding the next local change", async (t) => {
  const f = await fixture(t);
  t.mock.method(console, "error", () => {});
  let committed = false;
  let failPosts = true;
  f.intercept(async (_url, options) => {
    if (options.method !== "POST" || !failPosts) return;
    if (!committed) {
      committed = true;
      applyProgressOperations(f.server, JSON.parse(options.body).ops);
    }
    throw new Error("POST responses unavailable");
  });
  f.player.play(); f.player.advance(110);
  windowTarget.dispatchEvent(new Event("pagehide"));
  await tick();
  f.player.advance(120);
  await account.refreshAccountProgress();
  assert.equal(f.queued().length, 1);
  assert.equal(f.queued()[0].expectedRevision, 1);
  assert.equal(f.player.currentTime, 120);
  failPosts = false;
  await account.refreshAccountProgress();
  assert.equal(f.server.progress.a.currentTime, 120);
  assert.equal(f.server.revisions.a, 2);
});

test("position changes during a refresh wait for the snapshot before being saved", async (t) => {
  const f = await fixture(t);
  let release;
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let held = false;
  f.intercept(async (_url, options) => {
    if (options.method !== "POST" && !held) { held = true; started(); await gate; }
  });
  const refresh = account.refreshAccountProgress();
  await start;
  f.player.currentTime = 150;
  assert.equal(f.queued().length, 0);
  release();
  await refresh;
  await account.refreshAccountProgress();
  assert.equal(f.server.progress.a.currentTime, 150);
  assert.equal(f.server.revisions.a, 1);
});

test("a deliberate rewind to the beginning persists for an already saved video", async (t) => {
  const f = await fixture(t);
  f.player.currentTime = 0;
  await account.refreshAccountProgress();
  assert.equal(f.server.progress.a.currentTime, 0);
  assert.equal(f.server.revisions.a, 1);
});

test("a stream reload resetting an unloaded media element does not save zero", async (t) => {
  const f = await fixture(t);
  f.player.readyState = 0;
  f.player.advance(0);
  f.player.dispatchEvent(new Event("pause"));
  windowTarget.dispatchEvent(new Event("pagehide"));
  await account.refreshAccountProgress();
  assert.equal(f.calls.length, 0);
  assert.equal(f.server.progress.a.currentTime, 100);
});

test("clear history uses per-video revisions and cannot remove newer remote progress", async (t) => {
  const f = await fixture(t);
  f.remote(900);
  account.clearAccountProgress();
  await account.refreshAccountProgress();
  assert.equal(f.server.progress.a.currentTime, 900);
  assert.equal(account.getVideoProgress("a").currentTime, 900);
  account.clearAccountProgress();
  await account.refreshAccountProgress();
  assert.equal(f.server.progress.a, undefined);
  assert.equal(f.server.revisions.a, 2);
});

test("DASH's initial resume is not saved; a remote resume applies through the media element", async (t) => {
  const f = await fixture(t, { applyInitialSeek: false });
  f.player.dispatchEvent(new Event("pause"));
  assert.equal(f.queued().length, 0);
  f.player.currentTime = 100;
  await account.refreshAccountProgress();
  assert.equal(f.calls.length, 0);
  f.remote(600);
  windowTarget.dispatchEvent(new Event("focus"));
  await account.refreshAccountProgress();
  assert.equal(f.player.currentTime, 600);
  assert.equal(f.calls.length, 0);
});

test("detached players cannot save", async (t) => {
  const f = await fixture(t);
  f.player.isConnected = false;
  f.player.advance(200);
  f.player.dispatchEvent(new Event("pause"));
  await account.refreshAccountProgress();
  assert.equal(f.calls.length, 0);
});

test("players belonging to a signed-out account cannot save to another account", async (t) => {
  const f = await fixture(t);
  account.signOut();
  f.player.advance(200);
  f.player.dispatchEvent(new Event("pause"));
  assert.equal(f.queued().length, 0);
  assert.equal(f.calls.length, 0);
});
