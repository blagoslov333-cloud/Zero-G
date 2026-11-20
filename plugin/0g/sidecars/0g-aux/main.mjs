import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const realDir = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const candidateRoot = path.resolve(realDir, "../../../..");
const repoRoot =
  process.env.ZEROG_REPO_ROOT ||
  (fs.existsSync(path.join(candidateRoot, "server", "app.py"))
    ? candidateRoot
    : "C:/Users/blagoslov333/.gemini/antigravity/scratch/0G");
const DAEMON_HOST = "127.0.0.1";
const DAEMON_PORT = Number.parseInt(process.env.ZEROG_PORT || "8790", 10) || 8790;
const DAEMON_BASE = `http://${DAEMON_HOST}:${DAEMON_PORT}`;
const AUX_URL = `${DAEMON_BASE}/?view=auxpane`;
const PYTHON_EXE =
  process.env.ZEROG_PYTHON ||
  "C:/Users/blagoslov333/AppData/Local/Programs/Python/Python312/python.exe";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

function checkHealth(timeoutMs = 700) {
  return new Promise((resolve) => {
    const req = http.get(`${DAEMON_BASE}/api/health`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureDaemonRunning() {
  if (await checkHealth()) {
    return true;
  }

  const pyExe = fs.existsSync(PYTHON_EXE) ? PYTHON_EXE : "python";
  const child = spawn(pyExe, ["-m", "server.app"], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      ZEROG_HOST: DAEMON_HOST,
      ZEROG_PORT: String(DAEMON_PORT),
    },
  });
  child.unref();

  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    if (await checkHealth()) {
      return true;
    }
  }
  return false;
}

function buildAuxBridgeHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="0;url=${AUX_URL}" />
  <title>0G Aux Pane</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #09090B; color: #F4F4F5; font-family: system-ui, -apple-system, sans-serif; }
    .shell { display: flex; flex-direction: column; height: 100%; }
    iframe { border: 0; width: 100%; flex: 1; background: #09090B; }
    .bar { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; font-size: 12px; border-bottom: 1px solid #27272A; background: #121318; }
    a { color: #10B981; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="bar">
      <span>0G Aux Pane</span>
      <a href="${AUX_URL}">Open Direct</a>
    </div>
    <iframe src="${AUX_URL}" title="0G Aux Pane" allow="clipboard-read; clipboard-write"></iframe>
  </div>
  <script>
    if (window.top === window.self) {
      window.location.replace(${JSON.stringify(AUX_URL)});
    }
  </script>
</body>
</html>`;
}

await ensureDaemonRunning().catch((err) => {
  process.stderr.write(`[0g-aux] Daemon startup check warning: ${String(err)}\n`);
});

let SidecarApp = null;
let ResponseCtor = null;
try {
  ({ SidecarApp, Response: ResponseCtor } = await import("sidecar_sdk"));
} catch {
  // Running outside Antigravity sidecar_sdk host
}

if (SidecarApp && ResponseCtor) {
  const app = new SidecarApp();
  app.page("/", async () => {
    await ensureDaemonRunning().catch(() => false);
    return new ResponseCtor(buildAuxBridgeHtml(), {
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: NO_CACHE,
    });
  });
  app.api(
    "/api/status",
    async () => {
      try {
        const res = await fetch(`${DAEMON_BASE}/api/status`);
        return await res.json();
      } catch (err) {
        return { ok: false, error: String(err), auxUrl: AUX_URL };
      }
    },
    "GET"
  );
  app.run();
} else if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const webPort = Number.parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT, 10);
  if (Number.isFinite(webPort) && webPort > 0 && webPort !== DAEMON_PORT) {
    const server = http.createServer(async (req, res) => {
      await ensureDaemonRunning().catch(() => false);
      if (req.url === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json", ...NO_CACHE });
        res.end(JSON.stringify({ ok: true, target: AUX_URL }));
        return;
      }
      res.writeHead(302, { Location: AUX_URL, ...NO_CACHE });
      res.end();
    });
    server.listen(webPort, DAEMON_HOST);
  }
}
