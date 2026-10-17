import assert from "node:assert/strict";
import test from "node:test";
import { installPlayerMode, installSeekGestures, seekBy } from "../src/js-player.js";
import { getConfig } from "../src/config.js";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const timeRanges = (...ranges) => ({ length: ranges.length, start: (i) => ranges[i][0], end: (i) => ranges[i][1] });

function fixture(config = {}) {
  const storage = new Map([["invidious-fe:config", JSON.stringify(config)]]);
  globalThis.localStorage = { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  globalThis.document = { documentElement: { dataset: {} } };
  const feedback = { hidden: true, dataset: {} };
  const controls = [{ hidden: true }, { hidden: true }];
  const attributes = new Set(["nohotkeys", "noautohide", "gesturesdisabled"]);
  const classes = new Set();
  const controller = Object.assign(new EventTarget(), {
    querySelectorAll: () => controls,
    querySelector: () => feedback,
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
    setAttribute: (name) => attributes.add(name),
    removeAttribute: (name) => attributes.delete(name)
  });
  const player = {
    currentTime: 40, duration: 120, seekable: timeRanges(), controls: true, paused: true,
    playbackRate: 1.5, volume: 0.4, muted: true, src: "blob:dash-source", isConnected: true,
    getBoundingClientRect: () => ({ left: 0, width: 900 }),
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; }
  };
  const selector = Object.assign(new EventTarget(), { value: config.playerMode || "native" });
  const note = { hidden: true, textContent: "" };
  const click = (x, time, target = player, type = "click", extra = {}) => {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries({ target, clientX: x, clientY: 100, timeStamp: time, button: 0, ...extra })) {
      Object.defineProperty(event, key, { value });
    }
    controller.dispatchEvent(event);
  };
  const select = (mode) => { selector.value = mode; selector.dispatchEvent(new Event("change")); };
  return { player, controller, selector, note, feedback, controls, attributes, classes, click, select };
}

test.after(() => {
  delete globalThis.localStorage;
  delete globalThis.document;
});

test("native is the default, with invalid saved player modes normalized", () => {
  fixture();
  assert.equal(getConfig().playerMode, "native");
  fixture({ playerMode: "unexpected" });
  assert.equal(getConfig().playerMode, "native");
});

test("switching controls preserves the media source and playback state, and saves the mode", async () => {
  const f = fixture();
  let loads = 0;
  installPlayerMode({ ...f, loadLibrary: async () => { loads += 1; } });
  assert.equal(loads, 0);
  const state = { ...f.player };
  f.select("js");
  await wait();
  assert.equal(f.player.controls, false);
  assert.ok(f.classes.has("js-player"));
  assert.equal(getConfig().playerMode, "js");
  assert.ok(f.controls.every((control) => !control.hidden));
  f.select("native");
  assert.deepEqual(f.player, state);
  assert.ok(f.controls.every((control) => control.hidden));
  assert.ok(f.attributes.has("nohotkeys"));
  assert.equal(getConfig().playerMode, "native");
});

test("a pending JS load cannot override a newer native selection or a removed video", async () => {
  const f = fixture({ playerMode: "js" });
  let finish;
  installPlayerMode({ ...f, loadLibrary: () => new Promise((resolve) => { finish = resolve; }) });
  f.select("native");
  finish();
  await wait();
  assert.equal(f.player.controls, true);
  assert.ok(!f.classes.has("js-player"));
  f.select("js");
  f.player.isConnected = false;
  finish();
  await wait();
  assert.equal(f.player.controls, true);
});

test("failed JS loads leave native controls usable and allow retry", async () => {
  const f = fixture();
  let fails = true;
  installPlayerMode({ ...f, loadLibrary: async () => { if (fails) throw new Error("Load failed; retry"); } });
  f.select("js");
  await wait();
  assert.equal(f.player.controls, true);
  assert.equal(f.selector.value, "native");
  assert.match(f.note.textContent, /Load failed/);
  fails = false;
  f.select("js");
  await wait();
  assert.equal(f.player.controls, false);
  f.select("native");
});

test("double taps seek by ten seconds without pausing; repeated taps keep seeking", async () => {
  const f = fixture();
  const stop = installSeekGestures(f);
  f.player.paused = false;
  f.click(850, 100);
  f.click(850, 180);
  assert.equal(f.player.currentTime, 50);
  assert.equal(f.player.paused, false);
  f.click(850, 260);
  assert.equal(f.player.currentTime, 60);
  f.click(50, 340);
  f.click(50, 420);
  assert.equal(f.player.currentTime, 50);
  assert.equal(f.feedback.dataset.direction, "backward");
  await wait(330);
  assert.equal(f.player.paused, false);
  stop();
  f.click(50, 500);
  f.click(50, 580);
  assert.equal(f.player.currentTime, 50);
});

test("single taps toggle playback while controls, cancelled pointers and drags do not seek", async () => {
  const f = fixture();
  const stop = installSeekGestures(f);
  f.click(450, 100);
  assert.equal(f.player.paused, false);
  f.click(50, 200);
  await wait(330);
  assert.equal(f.player.paused, true);
  f.click(50, 600, f.controls[0]);
  f.click(50, 700, f.controls[0]);
  f.click(50, 800, f.player, "pointerdown");
  f.click(200, 900, f.player, "pointerup");
  f.click(200, 900);
  f.click(50, 1000, f.player, "pointercancel");
  f.click(50, 1100);
  f.click(50, 1200);
  assert.equal(f.player.currentTime, 40);
  assert.equal(f.player.paused, true);
  stop();
});

test("seeks clamp to duration, live seekable bounds and gaps; unloaded media is ignored", () => {
  const { player } = fixture();
  player.currentTime = 3;
  seekBy(player, -10);
  assert.equal(player.currentTime, 0);
  player.currentTime = 117;
  seekBy(player, 10);
  assert.equal(player.currentTime, 120);
  player.duration = Infinity;
  player.seekable = timeRanges([100, 150], [170, 200]);
  player.currentTime = 145;
  seekBy(player, 10);
  assert.equal(player.currentTime, 170);
  seekBy(player, -10);
  assert.equal(player.currentTime, 150);
  player.currentTime = 105;
  seekBy(player, -10);
  assert.equal(player.currentTime, 100);
  player.currentTime = 198;
  seekBy(player, 10);
  assert.equal(player.currentTime, 200);
  player.seekable = timeRanges();
  player.duration = NaN;
  assert.equal(seekBy(player, 10), false);
});
