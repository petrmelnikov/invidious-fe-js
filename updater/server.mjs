import { createServer } from "node:http";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Repository } from "./repository.mjs";

const frontend = resolve(process.env.INVIDIOUS_FE_DIR);
const engine = resolve(frontend, process.env.INVIDIOUS_ENGINE_DIR || "../invidious");
if (frontend === engine) throw new Error("The two checkouts must have different paths.");
const options = { sshDir: join(frontend, ".git", "updater-ssh") };
const repos = { frontend: new Repository("frontend", frontend, options), engine: new Repository("engine", engine, options) };

const runDir = process.env.UPDATER_RUN_DIR || "/run/invidious-updates";
const socket = join(runDir, "control.sock");
const lastJob = join(runDir, "last-job.json");
const empty = () => ({ current: null, available: null, branch: null, canUpdate: false, error: null });
const state = { components: { frontend: empty(), engine: empty() }, checking: false, job: null };
try {
  state.job = JSON.parse(await readFile(lastJob, "utf8"));
  if (state.job?.state === "running") {
    state.job = { ...state.job, state: "failed", message: "The updater stopped during installation. Check versions before retrying." };
  }
} catch (error) {
  if (error.code !== "ENOENT") console.warn("Could not read the previous update result.");
}

async function saveJob(job) {
  await writeFile(lastJob + ".tmp", JSON.stringify(job), { mode: 0o600 });
  await rename(lastJob + ".tmp", lastJob);
}

let checkedAt = 0;
function busy() {
  return state.checking || state.job?.state === "running";
}

async function inspect(target, job) {
  const info = await repos[target].inspect();
  if (job?.state === "failed" && job.target === target && job.revision === info.available) {
    // A replacement can report the new SHA even if it failed its health check.
    info.canUpdate = true;
  }
  return info;
}

async function check() {
  state.checking = true;
  try {
    await Promise.all(Object.keys(repos).map(async target => {
      state.components[target] = await inspect(target, state.job);
    }));
  } finally {
    checkedAt = Date.now();
    state.checking = false;
  }
}

async function install(target, revision) {
  state.job = { target, revision, state: "running", message: "Fetching the confirmed revision…" };
  let succeeded = false;
  try {
    await saveJob(state.job);
    await repos[target].install(revision, message => { state.job.message = message; });
    succeeded = true;
  } catch (error) {
    state.job.message = error.message;
  }
  if (succeeded) state.job.message = "Updated to " + revision.slice(0, 10) + ".";
  // Keep the lock until the result is durable and ready for the next client.
  const result = { ...state.job, state: succeeded ? "succeeded" : "failed" };
  state.components[target] = await inspect(target, result);
  await saveJob(result);
  state.job = result;
  if (succeeded && target === "frontend") {
    // Compose restarts this process, loading the updater from the updated checkout.
    process.exit(0);
  }
}

const server = createServer((req, res) => {
  function send(status, body) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }
  if (req.method === "GET" && req.url === "/api/updates") {
    if (!busy() && Date.now() - checkedAt > 5 * 60_000) void check();
    return send(200, state);
  }
  const action = /^\/api\/updates\/(check|frontend|engine)$/.exec(req.url)?.[1];
  if (req.method !== "POST" || !action) return send(404, { error: "Unknown updater action." });
  if (busy()) return send(409, { error: "Another check or update is already running." });
  if (action === "check") {
    void check();
  } else {
    const info = state.components[action];
    if (!info.canUpdate || req.headers["if-match"] !== '"' + info.available + '"') {
      return send(409, { error: "Versions changed. Check for updates before installing." });
    }
    void install(action, info.available).catch(error => {
      console.error("Could not finish the update job:", error.message);
      state.job = { target: action, state: "failed", message: "Could not save the update result. Check updater storage." };
    });
  }
  send(202, state);
});

await unlink(socket).catch(error => { if (error.code !== "ENOENT") throw error; });
server.listen(socket, async () => {
  await chmod(socket, 0o666);
  console.log("Update service ready.");
});
