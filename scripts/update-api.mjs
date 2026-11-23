import { request } from "node:http";

const base = "/api/updates";
const methods = new Map([
  [base, "GET"],
  [base + "/check", "POST"],
  [base + "/frontend", "POST"],
  [base + "/engine", "POST"]
]);

export function isUpdatesPath(path) {
  return path === base || path.startsWith(base + "/");
}

function send(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function relay(path, method, revision) {
  return new Promise((resolve, reject) => {
    const headers = revision ? { "If-Match": revision } : {};
    const upstream = request({
      socketPath: process.env.INVIDIOUS_UPDATE_SOCKET || "/run/invidious-updates/control.sock",
      path, method, headers, timeout: 5000
    }, async (response) => {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of response) {
          size += chunk.length;
          if (size > 64 * 1024) throw new Error("Oversized updater response");
          chunks.push(chunk);
        }
        resolve({ status: response.statusCode, payload: JSON.parse(Buffer.concat(chunks).toString()) });
      } catch (error) {
        reject(error);
      }
    });
    upstream.on("error", reject);
    upstream.on("timeout", () => upstream.destroy(new Error("Updater timed out")));
    upstream.end();
  });
}

function sameSite(req, url) {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  if (req.headers.origin === undefined) return true;
  try {
    const origin = new URL(req.headers.origin);
    return ["https:", "http:"].includes(origin.protocol) && origin.host === url.host;
  } catch {
    return false;
  }
}

export async function handleUpdatesRequest(req, res, url) {
  const method = methods.get(url.pathname);
  if (!method) return send(res, 404, { error: "Unknown update endpoint." });
  if (req.method !== method) return send(res, 405, { error: "Method not allowed." });
  const revision = req.headers["if-match"];
  if (method === "POST") {
    if (!sameSite(req, url)) return send(res, 403, { error: "Cross-site update request." });
    const type = req.headers["content-type"]?.split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return send(res, 415, { error: "Expected application/json." });
    if (!url.pathname.endsWith("/check") && !/^"(?:[a-f0-9]{40}|[a-f0-9]{64})"$/.test(revision || "")) {
      return send(res, 400, { error: "Select a checked revision to install." });
    }
  }
  req.resume();
  try {
    const result = await relay(url.pathname, method, method === "POST" && !url.pathname.endsWith("/check") ? revision : null);
    send(res, result.status, result.payload);
  } catch {
    send(res, 503, { error: "Cannot reach the update service. Check that the updater is running." });
  }
}
