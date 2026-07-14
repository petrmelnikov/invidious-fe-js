import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const portArgIndex = process.argv.findIndex((arg) => arg === "--port" || arg === "-p");
const port = Number(portArgIndex >= 0 ? process.argv[portArgIndex + 1] : process.env.PORT || 5173);

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".ico", "image/x-icon"],
  [".webmanifest", "application/manifest+json"]
]);

function resolvePath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath.split("?")[0]);
  const normalized = normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  const target = resolve(join(root, normalized));

  if (!target.startsWith(root)) return null;
  if (existsSync(target) && statSync(target).isFile()) return target;
  return join(root, "index.html");
}

const server = createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/runtime-config.js") {
    runtimeConfigRequest(res);
    return;
  }

  if (requestUrl.pathname === "/proxy") {
    proxyRequest(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname === "/dash-manifest") {
    dashManifestRequest(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname === "/api/custom-accounts") {
    customAccountsRequest(req, res, requestUrl);
    return;
  }

  const filePath = resolvePath(req.url || "/");

  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const contentType = mime.get(extname(filePath)) || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  createReadStream(filePath).pipe(res);
});

function envValue(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function runtimeConfigRequest(res) {
  const config = {};
  const apiOrigin = envValue("INVIDIOUS_API_ORIGIN");
  const region = envValue("INVIDIOUS_REGION");
  const sponsorBlockApiOrigin = envValue("SPONSORBLOCK_API_ORIGIN");

  if (apiOrigin) config.apiOrigin = apiOrigin;
  if (region) config.region = region;
  if (sponsorBlockApiOrigin) {
    config.sponsorBlock = { apiOrigin: sponsorBlockApiOrigin };
  }

  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(`window.__INVIDIOUS_FE_CONFIG__ = ${JSON.stringify(config)};\n`);
}

async function proxyRequest(req, res, requestUrl) {
  const target = requestUrl.searchParams.get("url");

  if (!target || !/^https?:\/\//i.test(target)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Missing proxy url");
    return;
  }

  try {
    const headers = {};
    for (const name of ["range", "accept", "accept-language", "user-agent"]) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      redirect: "follow"
    });

    const responseHeaders = {};
    const blockedHeaders = new Set([
      "connection",
      // fetch() decompresses the body, so the upstream content-encoding and
      // content-length no longer match what we send downstream.
      "content-encoding",
      "content-length",
      "content-security-policy",
      "permissions-policy",
      "referrer-policy",
      "transfer-encoding",
      "x-content-type-options",
      "x-frame-options",
      "x-xss-protection"
    ]);

    for (const [key, value] of upstream.headers) {
      if (!blockedHeaders.has(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    }
    responseHeaders["Access-Control-Allow-Origin"] = "*";

    res.writeHead(upstream.status, responseHeaders);
    if (req.method === "HEAD" || !upstream.body) {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(error?.message || "Proxy request failed");
  }
}

async function dashManifestRequest(_req, res, requestUrl) {
  const target = requestUrl.searchParams.get("url");

  if (!target || !/^https?:\/\//i.test(target)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Missing manifest url");
    return;
  }

  try {
    const upstream = await fetch(target, { redirect: "follow" });
    if (!upstream.ok) {
      res.writeHead(upstream.status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(await upstream.text());
      return;
    }

    const upstreamUrl = new URL(upstream.url);
    const manifest = await upstream.text();
    const rewritten = manifest.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (_match, rawUrl) => {
      const decoded = rawUrl.replaceAll("&amp;", "&");
      const absolute = new URL(decoded, upstreamUrl.origin).toString();
      const proxied = `/proxy?url=${encodeURIComponent(absolute)}`;
      return `<BaseURL>${proxied.replaceAll("&", "&amp;")}</BaseURL>`;
    });

    res.writeHead(200, {
      "Content-Type": "application/dash+xml; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    });
    res.end(rewritten);
  } catch (error) {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(error?.message || "DASH manifest request failed");
  }
}

const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || join(root, "accounts.json");

function normalizeName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ");
}

function accountKey(name) {
  return normalizeName(name).toLowerCase();
}

function readAccountsDb() {
  try {
    if (existsSync(ACCOUNTS_FILE)) {
      const content = readFileSync(ACCOUNTS_FILE, "utf8");
      return JSON.parse(content || "{}");
    }
  } catch (err) {
    console.error("Error reading accounts file:", err);
  }
  return {};
}

function writeAccountsDb(db) {
  try {
    writeFileSync(ACCOUNTS_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (err) {
    console.error("Error writing accounts file:", err);
  }
}

async function customAccountsRequest(req, res, requestUrl) {
  const name = requestUrl.searchParams.get("name");
  if (!name) {
    res.writeHead(400, {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    });
    res.end("Missing 'name' query parameter");
    return;
  }

  const normalized = normalizeName(name);
  const key = accountKey(normalized);

  if (!key) {
    res.writeHead(400, {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    });
    res.end("Invalid 'name' query parameter");
    return;
  }

  if (req.method === "GET") {
    const db = readAccountsDb();
    const account = db[key] || { name: normalized, progress: {} };
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify(account));
  } else if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const db = readAccountsDb();
        db[key] = {
          name: normalized,
          progress: payload.progress || {}
        };
        writeAccountsDb(db);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        });
        res.end("Invalid JSON body");
      }
    });
  } else if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
  } else {
    res.writeHead(405, {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    });
    res.end("Method Not Allowed");
  }
}

server.listen(port, () => {
  console.log(`Invidious FE running at http://localhost:${port}`);
  console.log(`Serving ${root}`);
});
