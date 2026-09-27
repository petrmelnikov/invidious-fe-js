import assert from "node:assert/strict";
import test from "node:test";
import { loadRecommendations, mixRecommendations } from "../src/recommendations.js";

const item = (n) => ({ videoId: `video${String(n).padStart(6, "0")}`, title: `Video ${n}` });

test("recommendations mix seeds fairly and exclude duplicates, all saved IDs and non-videos", () => {
  const saved = Array.from({ length: 15 }, (_, n) => item(n));
  const mixed = mixRecommendations([
    [item(20), item(21), item(14), { videoId: "bad" }, { ...item(25), type: "playlist" }],
    [item(22), item(20), item(23)],
    [item(24), item(24)]
  ], saved);
  assert.deepEqual(mixed.map((entry) => entry.videoId), [20, 22, 24, 21, 23].map((n) => item(n).videoId));
  assert.equal(mixRecommendations([[item(20), item(21)]], [], 1).length, 1);
  assert.deepEqual(mixRecommendations([[item(20)]], [], 0), []);
});

test("fetching uses at most 12 recent seeds and at most 3 concurrent requests", async () => {
  const saved = Array.from({ length: 20 }, (_, n) => item(n));
  let active = 0;
  let maximum = 0;
  const calls = [];
  const result = await loadRecommendations(saved, async (id) => {
    calls.push(id);
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return { recommendedVideos: [item(30), item(19)] };
  });
  assert.equal(maximum, 3);
  assert.deepEqual(calls, saved.slice(0, 12).map((entry) => entry.videoId));
  assert.deepEqual(result.items.map((entry) => entry.videoId), [item(30).videoId]);
  assert.equal(result.total, 12);
});

test("partial failures preserve results and fall back to relatedVideos", async () => {
  const result = await loadRecommendations([item(1), item(2)], async (id) => {
    if (id === item(1).videoId) throw new Error("Unavailable");
    return { recommendedVideos: [], relatedVideos: [item(3)] };
  });
  assert.equal(result.failed, 1);
  assert.equal(result.total, 2);
  assert.equal(result.items[0].videoId, item(3).videoId);
});

test("all failures and empty accounts are distinguishable", async () => {
  const fail = async () => { throw new Error("Offline"); };
  assert.deepEqual(await loadRecommendations([item(1)], fail), { items: [], failed: 1, total: 1 });
  assert.deepEqual(await loadRecommendations([], fail), { items: [], failed: 0, total: 0 });
});

test("leaving a page stops queued recommendation requests", async () => {
  let current = true;
  let calls = 0;
  await loadRecommendations(Array.from({ length: 12 }, (_, n) => item(n)), async () => {
    calls += 1;
    current = false;
    return { recommendedVideos: [] };
  }, () => current);
  assert.equal(calls, 1);
});
