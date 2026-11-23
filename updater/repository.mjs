import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const services = {
  frontend: { file: "compose.yaml", service: "invidious-fe" },
  engine: { file: "docker-compose.yml", service: "invidious" }
};

async function dockerCommand(args, options) {
  if (!options.stream) return (await execute("docker", args, options)).stdout.trim();
  await new Promise((resolve, reject) => {
    const child = spawn("docker", args, { ...options, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error("Compose failed")));
  });
}

export class Repository {
  constructor(target, dir, { docker = dockerCommand, sshDir } = {}) {
    this.target = target;
    this.dir = dir;
    this.docker = docker;
    this.sshDir = sshDir;
    this.service = services[target].service;
  }

  async git(args, message) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
    const config = [];
    if (this.sshDir && existsSync(join(this.sshDir, "id_ed25519"))) {
      env.UPDATER_SSH_DIR = this.sshDir;
      env.GIT_SSH_COMMAND = 'ssh -F /dev/null -oBatchMode=yes -oIdentitiesOnly=yes -oStrictHostKeyChecking=yes -o "UserKnownHostsFile=$UPDATER_SSH_DIR/known_hosts" -i "$UPDATER_SSH_DIR/id_ed25519"';
    } else {
      // Public GitHub checkouts often have an SSH push URL. Read them over HTTPS.
      config.push("-c", "url.https://github.com/.insteadOf=git@github.com:",
        "-c", "url.https://github.com/.insteadOf=ssh://git@github.com/");
      env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes";
    }
    try {
      const result = await execute("git", [...config, ...args], { cwd: this.dir, env, timeout: 60000 });
      return result.stdout.trim();
    } catch {
      throw new Error(message);
    }
  }

  async tracking() {
    const root = await this.git(["rev-parse", "--show-toplevel"], "Cannot open the configured Git checkout. Check the path and its ownership.");
    if (await realpath(this.dir) !== root) throw new Error("The configured path must be the repository root.");
    const ref = await this.git(["symbolic-ref", "--quiet", "HEAD"], "The checkout is in detached HEAD state.");
    const upstream = await this.git(["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", ref],
      "Cannot read the tracked branch.");
    const [remote, branch] = upstream.split("\0");
    if (!remote || !branch?.startsWith("refs/heads/")) throw new Error("Configure an upstream branch for this checkout.");
    return { ref, remote, branch };
  }

  compose(args, { revision, stream = false } = {}) {
    const env = { ...process.env, PWD: this.dir };
    if (revision) env.INVIDIOUS_FE_REVISION = revision;
    const composeArgs = ["compose", "-f", services[this.target].file];
    if (this.target === "frontend" && env.UPDATER_FRONTEND_PROJECT) composeArgs.push("-p", env.UPDATER_FRONTEND_PROJECT);
    return this.docker([...composeArgs, ...args], { cwd: this.dir, env, stream, timeout: stream ? 60 * 60 * 1000 : 20000 });
  }

  async running() {
    if (this.target === "frontend") {
      const sha = (await this.compose(["exec", "-T", this.service, "printenv", "INVIDIOUS_FE_REVISION"])).trim();
      return revisionPattern.test(sha) ? sha : null;
    }
    const output = await this.compose(["exec", "-T", this.service, "/invidious/invidious", "--version"]);
    const version = JSON.parse(output).version;
    const sha = /-([a-f0-9]{4,64})$/i.exec(version)?.[1];
    if (!sha) return null;
    // Invidious embeds an abbreviated SHA in the binary.
    return await this.git(["rev-parse", "--verify", sha + "^{commit}"], "Unknown local commit.").catch(() => sha);
  }

  async inspect() {
    const status = { current: null, available: null, branch: null, canUpdate: false, error: null };
    status.current = await this.running().catch(() => null);
    try {
      const { remote, branch } = await this.tracking();
      status.branch = remote + "/" + branch.slice("refs/heads/".length);
      const line = await this.git(["ls-remote", "--exit-code", "--refs", "--", remote, branch],
        "Cannot read the tracked branch from Git. Check network access and repository credentials.");
      const [sha, ref] = line.split("\t");
      if (!revisionPattern.test(sha) || ref !== branch) throw new Error("Git returned an unexpected branch revision.");
      status.available = sha;
      status.canUpdate = status.current !== sha;
      if (!status.current) status.error = "The running container did not report a revision.";
    } catch (error) {
      status.error = error.message;
    }
    return status;
  }

  async install(expected, progress) {
    if (!revisionPattern.test(expected)) throw new Error("Invalid revision.");
    const { remote, branch, ref } = await this.tracking();
    await this.git(["fetch", "--no-tags", "--no-recurse-submodules", "--", remote, branch],
      "Git fetch failed. Check network access and repository credentials.");
    const fetched = await this.git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], "Cannot resolve the fetched revision.");
    if (fetched !== expected || ref !== (await this.tracking()).ref) {
      throw new Error("The branch changed. Check for updates and confirm the new revision.");
    }
    await this.git(["merge-base", "--is-ancestor", "HEAD", expected], "The local branch is ahead or has diverged. Resolve it on the server.");
    await this.git(["merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", expected],
      "Git could not fast-forward. Check for conflicting local changes in the server checkout.");
    progress("Building the image…");
    try {
      await this.compose(["build", this.service], { revision: expected, stream: true });
    } catch {
      throw new Error("Image build failed. See the updater container logs, then retry.");
    }
    progress("Starting the service and waiting for its health check…");
    try {
      await this.compose(["up", "-d", "--wait", "--wait-timeout", "180", "--no-build", "--no-deps", this.service],
        { revision: expected, stream: true });
    } catch {
      throw new Error("Compose could not start a healthy service. See the updater container logs, then retry.");
    }
    if (await this.running().catch(() => null) !== expected) {
      throw new Error("The service did not report the selected revision after restart.");
    }
  }
}
