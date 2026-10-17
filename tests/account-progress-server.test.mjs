import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { applyProgressOperations, normalizeProgressAccount } from "../scripts/account-progress.mjs";

const upsert = (id, videoId, expectedRevision, currentTime) => ({
  id, videoId, expectedRevision, type: "upsert", entry: { currentTime, duration: 3000, updatedAt: 9999999999999 }
});

test("per-video revisions allow rewinds, reject stale writes/deletes and retain tombstones", () => {
  const account = normalizeProgressAccount({ progress: { a: { currentTime: 100 } } }, "alice");
  const apply = (op) => applyProgressOperations(account, [op])[0];
  assert.equal(apply(upsert("b1", "a", 0, 500)).revision, 1);
  assert.equal(apply(upsert("late", "a", 0, 110)).status, "conflict");
  assert.equal(apply({ id: "late-end", videoId: "a", type: "remove", expectedRevision: 0 }).status, "conflict");
  assert.equal(account.progress.a.currentTime, 500);
  assert.equal(apply(upsert("rewind", "a", 1, 30)).status, "applied");
  assert.equal(account.progress.a.currentTime, 30);
  assert.equal(apply({ id: "end", videoId: "a", type: "remove", expectedRevision: 2 }).revision, 3);
  assert.equal(account.progress.a, undefined);
  assert.equal(apply(upsert("resurrect", "a", 2, 50)).status, "conflict");
  assert.equal(apply(upsert("different-video", "b", 0, 70)).status, "applied");
  assert.equal(apply({ type: "clear", id: "legacy-clear" }).status, "conflict");
  assert.equal(apply({ ...upsert("legacy", "a", 0, 100), expectedRevision: undefined }).status, "conflict");
});

test("retrying a committed operation is idempotent, including removals", () => {
  const account = normalizeProgressAccount({}, "alice");
  const op = upsert("saved", "a", 0, 10);
  applyProgressOperations(account, [op]);
  assert.equal(applyProgressOperations(account, [op])[0].status, "duplicate");
  assert.equal(account.revisions.a, 1);
  const remove = { id: "removed", videoId: "a", expectedRevision: 1, type: "remove" };
  applyProgressOperations(account, [remove]);
  assert.equal(applyProgressOperations(account, [remove])[0].status, "duplicate");
  assert.equal(account.revisions.a, 2);
});

test("HTTP storage migrates existing progress and atomically rejects concurrent/legacy writes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "invidious-progress-"));
  const accountsPath = join(dir, "accounts.json");
  await writeFile(accountsPath, JSON.stringify({ alice: { name: "Alice", progress: { a: { currentTime: 100, duration: 3000 } } } }));
  const child = spawn(process.execPath, ["scripts/dev-server.mjs", "--port", "0"], {
    cwd: new URL("..", import.meta.url), env: { ...process.env, ACCOUNTS_FILE: accountsPath }, stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
    await rm(dir, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Server exited: ${code}`)));
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/http:\/\/localhost:(\d+)/);
      if (match) resolve(`http://127.0.0.1:${match[1]}/api/custom-accounts?name=Alice`);
    });
    child.stderr.on("data", (chunk) => reject(new Error(String(chunk))));
  });
  const post = (payload) => fetch(base, { method: "POST", body: JSON.stringify(payload) });
  const initial = await (await fetch(base)).json();
  assert.equal(initial.revisions.a, 0);
  const responses = await Promise.all([post({ ops: [upsert("one", "a", 0, 500)] }), post({ ops: [upsert("two", "a", 0, 700)] })]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const current = await (await fetch(base)).json();
  assert.equal(current.revisions.a, 1);
  assert.ok([500, 700].includes(current.progress.a.currentTime));
  assert.equal((await post({ progress: { a: { currentTime: 10, updatedAt: 9999999999999 } } })).status, 409);
  assert.equal((await post({ ops: [{ type: "remove", videoId: "a" }] })).status, 409);
  const removed = await post({ ops: [{ id: "end", type: "remove", videoId: "a", expectedRevision: 1 }] });
  assert.equal(removed.status, 200);
  const persisted = JSON.parse(await readFile(accountsPath, "utf8"));
  assert.equal(persisted.alice.revisions.a, 2);
  assert.deepEqual(persisted.alice.progress, {});
  assert.equal((await post({ ops: [upsert("late", "a", 1, 300)] })).status, 409);
});
