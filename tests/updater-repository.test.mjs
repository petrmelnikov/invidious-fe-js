import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Repository } from "../updater/repository.mjs";

const execFileAsync = promisify(execFile);

const git = (args, cwd) => execFileAsync("git", args, { cwd });
const headSha = async (cwd) => (await git(["rev-parse", "HEAD"], cwd)).stdout.trim();
const shortSha = (sha) => sha.slice(0, 7);

async function configureAuthor(cwd) {
  await git(["config", "user.email", "test@example.com"], cwd);
  await git(["config", "user.name", "Test"], cwd);
}

async function commitFile(cwd, name, content, message) {
  await writeFile(join(cwd, name), content);
  await git(["add", name], cwd);
  await git(["commit", "-m", message], cwd);
  await git(["push", "origin", "HEAD"], cwd);
  return headSha(cwd);
}

async function fixture(t, target = "engine") {
  const base = await mkdtemp(join(tmpdir(), "updater-repo-"));
  t.after(async () => {
    await rm(base, { force: true, recursive: true });
  });
  const remote = join(base, "remote.git");
  assert.ok(isAbsolute(remote));
  await execFileAsync("git", ["init", "--bare", remote]);
  const work = join(base, "work");
  await execFileAsync("git", ["clone", remote, work]);
  await configureAuthor(work);
  const initialSha = await commitFile(work, "app.txt", "v1\n", "initial");
  const local = join(base, "local");
  await execFileAsync("git", ["clone", remote, local]);
  await configureAuthor(local);
  assert.equal(await headSha(local), initialSha);

  const state = { deployed: initialSha, failBuild: false, upCalls: 0 };
  const calls = [];
  const docker = async (args, options = {}) => {
    calls.push({ args: [...args], options: { ...options } });
    if (args.includes("exec")) {
      if (target === "frontend") return state.deployed;
      return JSON.stringify({ version: `2026.11.01-${shortSha(state.deployed)}` });
    }
    if (args.includes("build")) {
      if (state.failBuild) throw new Error("mock build failure");
      return "";
    }
    if (args.includes("up")) {
      state.deployed = await headSha(local);
      state.upCalls += 1;
      return "";
    }
    return "";
  };
  const repository = new Repository(target, local, { docker });
  const progress = [];
  const progressFn = async (message) => {
    progress.push(String(message));
  };
  return { base, remote, work, local, initialSha, repository, docker, calls, state, progress, progressFn };
}

function assertDockerContract(calls, dir) {
  assert.ok(calls.length > 0, "expected docker to be called");
  const composed = calls.filter((call) => call.args.includes("compose"));
  assert.ok(composed.length > 0, "expected a compose call");
  assert.ok(
    composed.some((call) => call.args.includes("-f")),
    "expected compose -f <file> argv",
  );
  for (const call of calls) {
    assert.equal(call.options.cwd, dir);
    if (call.options.env !== undefined) assert.equal(typeof call.options.env, "object");
  }
}

test("inspect reports branch with no update when remote is unchanged", async (t) => {
  const f = await fixture(t);
  const status = await f.repository.inspect();
  assert.ok(typeof status.branch === "string" && status.branch.length > 0);
  assert.ok(String(status.current).includes(shortSha(f.initialSha)));
  assert.ok(String(status.available).includes(shortSha(f.initialSha)));
  assert.equal(status.canUpdate, false);
  assert.ok(!status.error);
  assertDockerContract(f.calls, f.local);
});

test("unchanged tracked local modifications survive fast-forward update", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.local, "app.txt"), "local edit\n");
  const next = await commitFile(f.work, "notes.txt", "shared\n", "notes");
  const status = await f.repository.inspect();
  assert.equal(status.canUpdate, true);
  assert.ok(String(status.available).includes(shortSha(next)));
  await f.repository.install(next, f.progressFn);
  assert.equal(await headSha(f.local), next);
  assert.equal(await readFile(join(f.local, "app.txt"), "utf8"), "local edit\n");
  assert.equal(await readFile(join(f.local, "notes.txt"), "utf8"), "shared\n");
  const after = await f.repository.inspect();
  assert.ok(String(after.current).includes(shortSha(next)));
  assert.equal(after.canUpdate, false);
  assert.equal(f.state.upCalls, 1);
  const up = f.calls.find(call => call.args.includes("up"));
  assert.ok(up.args.includes("--no-deps") && up.args.includes("--wait"));
  assert.equal(up.args.at(-1), "invidious");
});

test("an overlapping tracked modification remains intact on failed install", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.local, "app.txt"), "local change\n");
  const next = await commitFile(f.work, "app.txt", "remote change\n", "remote");
  await assert.rejects(() => f.repository.install(next, f.progressFn));
  assert.equal(await readFile(join(f.local, "app.txt"), "utf8"), "local change\n");
  const status = await f.repository.inspect();
  assert.ok(String(status.current).includes(shortSha(f.initialSha)));
});

test("changed upstream tip after the check refuses a stale install", async (t) => {
  const f = await fixture(t);
  const first = await commitFile(f.work, "app.txt", "v2\n", "second");
  const checked = await f.repository.inspect();
  assert.equal(checked.canUpdate, true);
  assert.ok(String(checked.available).includes(shortSha(first)));
  const second = await commitFile(f.work, "app.txt", "v3\n", "third");
  assert.notEqual(first, second);
  await assert.rejects(() => f.repository.install(first, f.progressFn));
  assert.notEqual(await headSha(f.local), second);
  assert.equal(f.state.deployed, f.initialSha);
});

test("failed build after git advance leaves old current and offers retry", async (t) => {
  const f = await fixture(t);
  const next = await commitFile(f.work, "app.txt", "v2\n", "second");
  f.state.failBuild = true;
  await assert.rejects(() => f.repository.install(next, f.progressFn));
  const failed = await f.repository.inspect();
  assert.ok(String(failed.current).includes(shortSha(f.initialSha)));
  assert.equal(failed.canUpdate, true);
  assert.ok(!String(failed.current).includes(shortSha(next)));
  f.state.failBuild = false;
  await f.repository.install(next, f.progressFn);
  const retried = await f.repository.inspect();
  assert.ok(String(retried.current).includes(shortSha(next)));
  assert.equal(retried.canUpdate, false);
});

test("inspect never throws on operational failures and install rejects on errors", async (t) => {
  const f = await fixture(t);
  const brokenDocker = async () => {
    throw new Error("docker unavailable");
  };
  const broken = new Repository("engine", f.local, { docker: brokenDocker });
  const status = await broken.inspect();
  assert.ok(status && typeof status === "object");
  assert.ok(status.error, "expected inspect to report an error");
  await assert.rejects(() => broken.install("0".repeat(40), async () => {}));
  const missing = new Repository("engine", join(f.base, "missing"), { docker: f.docker });
  const missingStatus = await missing.inspect();
  assert.ok(missingStatus.error, "expected missing directory to report an error");
});

test("frontend builds with the confirmed SHA and reports it from the running container", async t => {
  const f = await fixture(t, "frontend");
  const next = await commitFile(f.work, "app.txt", "new frontend\n", "frontend");
  await f.repository.install(next, f.progressFn);
  const build = f.calls.find(call => call.args.includes("build"));
  assert.equal(build.args.at(-1), "invidious-fe");
  assert.equal(build.options.env.INVIDIOUS_FE_REVISION, next);
  assert.equal((await f.repository.inspect()).current, next);
});
