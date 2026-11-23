import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleUpdatesRequest } from "../scripts/update-api.mjs";

test("update API passes only a checked revision and fixed action to the local updater", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iv-up-"));
  const socket = join(dir, "u.sock");
  const previous = process.env.INVIDIOUS_UPDATE_SOCKET;
  process.env.INVIDIOUS_UPDATE_SOCKET = socket;
  t.after(async () => {
    if (previous === undefined) delete process.env.INVIDIOUS_UPDATE_SOCKET;
    else process.env.INVIDIOUS_UPDATE_SOCKET = previous;
    await rm(dir, { force: true, recursive: true });
  });

  const received = [];
  const helper = createServer((req, res) => {
    received.push({ path: req.url, method: req.method, headers: req.headers });
    res.writeHead(req.method === "POST" ? 202 : 200);
    res.end(JSON.stringify({ checking: false }));
  });
  const api = createServer((req, res) => handleUpdatesRequest(req, res, new URL(req.url, "http://" + req.headers.host)));
  function listen(server, ...args) {
    return new Promise((resolve, reject) => server.once("error", reject).listen(...args, resolve));
  }
  await listen(helper, socket);
  t.after(() => helper.close());
  await listen(api, 0, "127.0.0.1");
  t.after(() => api.close());
  const url = "http://127.0.0.1:" + api.address().port + "/api/updates";
  const revision = '"' + "a".repeat(40) + '"';
  const headers = { "Content-Type": "application/json", "If-Match": revision };
  const post = (path, extra) => fetch(url + path, { method: "POST", headers: { ...headers, ...extra } });

  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url + "/engine")).status, 405);
  assert.equal((await post("/custom")).status, 404);
  assert.equal((await post("/engine", { Origin: "https://other.example" })).status, 403);
  assert.equal((await post("/engine", { "Content-Type": "text/plain; application/json" })).status, 415);
  assert.equal((await post("/engine", { "If-Match": "master" })).status, 400);
  const result = await post("/engine?path=/wrong", { Authorization: "test" });
  assert.equal(result.status, 202);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), { checking: false });
  assert.deepEqual(received.map(r => r.path), ["/api/updates", "/api/updates/engine"]);
  assert.equal(received[1].headers.authorization, undefined);
  assert.equal(received[1].headers["if-match"], revision);
  process.env.INVIDIOUS_UPDATE_SOCKET = join(dir, "missing.sock");
  assert.equal((await fetch(url)).status, 503);
});
