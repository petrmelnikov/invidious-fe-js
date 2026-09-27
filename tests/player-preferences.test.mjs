import assert from "node:assert/strict";
import test from "node:test";
import { chooseDashQuality, chooseInitialAudioTrack, compareVideoQuality } from "../src/player-preferences.js";

const audio = (lang, role, extra = {}) => ({ lang, roles: role ? [role] : [], type: "audio", ...extra });

test("Russian original wins over alternate translations regardless of track order", () => {
  const russian = audio("ru-RU", "main");
  assert.equal(chooseInitialAudioTrack([audio("en", "alternate"), russian]), russian);
});

test("Russian automatic translation never replaces a foreign original", () => {
  const english = audio("en", "main");
  assert.equal(chooseInitialAudioTrack([audio("ru", "alternate"), english]), english);
  assert.equal(chooseInitialAudioTrack([audio("ru", "main", { labels: [{ text: "Russian (auto-dubbed)" }] }), english]), english);
});

test("explicit original labels take precedence over a localized default role", () => {
  const original = audio("de", "alternate", { labels: [{ text: "German (original)" }] });
  assert.equal(chooseInitialAudioTrack([audio("ru", "main"), original]), original);
});

test("Russian is preferred among original languages, with the highest audio bitrate", () => {
  const russian = audio("ru", { value: "main" }, { bitrateList: [{ bandwidth: 128000 }] });
  assert.equal(chooseInitialAudioTrack([
    audio("en", "main"), audio("ru", "main", { bitrateList: [{ bandwidth: 64000 }] }), russian
  ]), russian);
});

test("missing metadata does not promote a Russian alternate; single legacy tracks work", () => {
  const legacy = audio("und");
  assert.equal(chooseInitialAudioTrack([audio("ru", "alternate"), legacy]), legacy);
  assert.equal(chooseInitialAudioTrack([legacy]), legacy);
  assert.equal(chooseInitialAudioTrack([]), undefined);
});

test("maximum DASH quality uses actual resolution before bitrate, without a 1080p cap", () => {
  const quality = chooseDashQuality([
    { height: 1080, bitrate: 20000000, qualityIndex: 8 },
    { height: 4320, bitrate: 18000000, qualityIndex: 2 },
    { height: 2160, bitrate: 25000000, qualityIndex: 5 }
  ]);
  assert.equal(quality.qualityIndex, 2);
});

test("fixed quality supports manual selection and falls back to a manifest representation", () => {
  const bitrates = [{ height: 720, bitrate: 100, qualityIndex: 4 }, { height: 1080, bitrate: 200, qualityIndex: 7 }];
  assert.equal(chooseDashQuality(bitrates, { mode: "dash-fixed", height: 720 }).qualityIndex, 4);
  assert.equal(chooseDashQuality(bitrates, { mode: "dash-fixed", height: 2160 }).qualityIndex, 7);
  assert.equal(chooseDashQuality([]), undefined);
});

test("progressive quality sorts qualityLabel, frame rate and bitrate", () => {
  const formats = [
    { quality: "medium", qualityLabel: "360p", fps: 30 },
    { quality: "hd720", qualityLabel: "720p", fps: 30 },
    { qualityLabel: "720p60", fps: 60 }
  ];
  assert.deepEqual(formats.sort(compareVideoQuality).map((format) => format.qualityLabel), ["720p60", "720p", "360p"]);
});

test("old saved quality preferences cannot lower the next video's default", async () => {
  globalThis.localStorage = { getItem: () => JSON.stringify({ quality: "360p", theme: "dark" }) };
  const { getConfig } = await import("../src/config.js");
  assert.equal(getConfig().quality, "best");
  assert.equal(getConfig().theme, "dark");
  delete globalThis.localStorage;
});
