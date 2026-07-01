// Lighthouse desktop shell (Electron).
//
// Wraps the existing Next.js + Node backend: starts the production server on a
// local port, shows it in a window, keeps files in a real local directory,
// launches at login, lives in the tray, and adds native Add files / Choose
// vault folder dialogs. Run after `npm run build` via `npm run electron`.
const { app, BrowserWindow, Menu, Tray, dialog, shell, nativeImage, session } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.env.LIGHTHOUSE_PORT || 3777);
// Per-launch shared secret. The renderer authenticates to the local API via its
// same-origin Origin header; header-less callers (this main process) must present
// this token instead. It lets the server reject any other local process/user that
// hits the port without an Origin, closing the old "no Origin ⇒ trusted" hole.
const API_TOKEN = crypto.randomBytes(32).toString("hex");
// Everything addresses the server as 127.0.0.1 (never "localhost", which can
// resolve to IPv6 ::1 and miss our IPv4-only bind).
const SERVER_ORIGIN = `http://127.0.0.1:${PORT}`;
const APP_ROOT = path.join(__dirname, "..");
const WINDOW_ICON = path.join(APP_ROOT, "assets", "icon.png");
const TRAY_ICON = path.join(APP_ROOT, "assets", "tray.png");

let serverProc = null;
let llmProc = null;
let win = null;
let tray = null;

/**
 * Open (append) a log file in the per-user data dir for a child process's
 * output, returning its fd — or "ignore" if it can't be opened. Used so child
 * processes write to a log file instead of a console window (paired with
 * `windowsHide: true`), keeping the desktop app windowless on Windows while
 * preserving logs for troubleshooting. Call only after `app` is ready.
 */
function logFd(name) {
  try {
    return fs.openSync(path.join(app.getPath("userData"), name), "a");
  } catch {
    return "ignore";
  }
}

/** Close a log fd from `logFd` (a numeric fd; "ignore" is a no-op). */
function closeFd(fd) {
  if (typeof fd === "number") {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

// Content-Security-Policy for the renderer. The app loads its own local Next
// server (http://localhost:PORT) and only talks to that same origin from the
// page (API routes proxy out to Anthropic/Supabase server-side). Notably this
// omits 'unsafe-eval' — production Next doesn't need it — which clears
// Electron's insecure-CSP warning and removes that attack surface.
// 'unsafe-inline' stays because Next's bootstrap inline script and Fluent UI's
// (Griffel) runtime <style> injection rely on it. localhost/127.0.0.1 are
// allowed in connect-src for the local-model server.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  // Read-aloud plays a synthesized WAV via an object URL (blob:).
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

function settingsFile() {
  return path.join(app.getPath("userData"), "lighthouse-settings.json");
}
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}
function saveSettings(s) {
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

/** The local vault directory (persisted; defaults under the user's Documents). */
function vaultDir() {
  const dir = loadSettings().vaultDir || path.join(app.getPath("documents"), "Lighthouse Vault");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The bundled `llama-server` binaries + libraries (small; shipped in the installer). */
function llmRoot() {
  return process.resourcesPath
    ? path.join(process.resourcesPath, "llm")
    : path.join(APP_ROOT, "resources", "llm");
}

/**
 * Where the (optional, large) private model lives. It's NOT bundled — the
 * installer would blow past NSIS's 2 GB limit — so the user opts in from the
 * model picker and the Next server downloads it here, into a writable per-user
 * dir that survives app updates.
 */
function modelsDir() {
  const dir = path.join(app.getPath("userData"), "models");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** First installed `.gguf` — the downloaded model, or a dev-bundled one in resources/llm. */
function findModel() {
  for (const dir of [modelsDir(), llmRoot()]) {
    try {
      const f = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith(".gguf"));
      if (f) return path.join(dir, f);
    } catch {
      /* dir may not exist yet */
    }
  }
  return null;
}

/**
 * Launch the bundled local inference server (issue #24, "Local model") against
 * the installed model, if there is one. The `.gguf` is fetched on demand (see
 * app/api/model), so at first launch there may be nothing to run — `reconcileModel`
 * starts the server the moment the download lands. When no binary is bundled at
 * all this is a no-op, and the "Local model" provider instead targets any
 * OpenAI-compatible server the user runs themselves (Ollama, LM Studio) via the
 * LIGHTHOUSE_LOCAL_LLM_URL the Next server reads.
 */
function startLocalLlm() {
  if (llmProc) return; // already running
  const bin = path.join(llmRoot(), process.platform === "win32" ? "llama-server.exe" : "llama-server");
  const model = findModel();
  if (!model || !fs.existsSync(bin)) return; // model not installed yet — nothing to run
  const out = logFd("local-model.log");
  llmProc = spawn(bin, ["-m", model, "--host", "127.0.0.1", "--port", "8080"], {
    cwd: llmRoot(),
    // Log to a file and hide the console window — no terminal pops up for the user.
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  llmProc.on("error", (e) => console.error("local model failed to start", e));
  llmProc.on("exit", (code, signal) => {
    llmProc = null;
    closeFd(out);
    if (code) console.error(`local model exited with code ${code}${signal ? ` (${signal})` : ""}`);
    // If this exit was to release the memory-mapped weights for an uninstall,
    // finish deleting them now that the file is unlocked.
    if (uninstalling) finishUninstall();
  });
}

// Uninstall coordination: the Next server (app/api/model DELETE) drops a marker
// file, since only main owns the llama-server whose mmap locks the .gguf on
// Windows. We stop the server, then delete the weights, then clear the marker.
const UNINSTALL_MARKER = ".uninstall";
let uninstalling = false;

/** All bundled/downloaded `.gguf` files across the search dirs. */
function modelGgufFiles() {
  const files = [];
  for (const dir of [modelsDir(), llmRoot()]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.toLowerCase().endsWith(".gguf")) files.push(path.join(dir, f));
      }
    } catch {
      /* dir may not exist */
    }
  }
  return files;
}

/**
 * Delete the model weights (the server is already stopped). Only clear the marker
 * once the weights are actually gone, so a rare still-locked file retries on the
 * next reconcile tick rather than silently leaving the model in place.
 */
function finishUninstall() {
  let remaining = false;
  for (const f of modelGgufFiles()) {
    try {
      fs.rmSync(f, { force: true });
    } catch (e) {
      console.error("uninstall: could not remove", f, e);
      remaining = true;
    }
  }
  if (!remaining) {
    try {
      fs.rmSync(path.join(modelsDir(), UNINSTALL_MARKER), { force: true });
    } catch {
      /* best-effort */
    }
  }
  uninstalling = false;
}

/**
 * Keep the local model server in sync with what's on disk, on a poll (fs.watch
 * is unreliable on Windows). Start llama-server when a model appears (e.g. a
 * download just finished), and honor an uninstall request: drop the running
 * server first so its memory-mapped `.gguf` unlocks, then delete the weights
 * (finishUninstall runs from the server's exit handler). Unref'd so it never
 * keeps the app alive on its own.
 */
function reconcileModel() {
  if (fs.existsSync(path.join(modelsDir(), UNINSTALL_MARKER))) {
    if (llmProc) {
      if (!uninstalling) {
        uninstalling = true;
        llmProc.kill(); // weights are deleted from the exit handler once released
      }
      return; // wait for the server to exit before deleting
    }
    finishUninstall(); // nothing holding the file — delete immediately
    return;
  }
  if (!llmProc && findModel()) startLocalLlm();
}

function startServer() {
  const nextBin = path.join(APP_ROOT, "node_modules", "next", "dist", "bin", "next");
  const out = logFd("server.log");
  // Bind to loopback ONLY. `next start` defaults its host to 0.0.0.0, which would
  // expose the local API (and every unauthenticated file/link/open route) to any
  // device on the same network. The renderer always talks to 127.0.0.1, so this
  // is transparent to the app while removing the entire LAN attack surface. Both
  // the `-H` flag and HOSTNAME are set so neither Next default can re-widen it.
  serverProc = spawn(process.execPath, [nextBin, "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1", // belt-and-suspenders: never bind beyond loopback
      LIGHTHOUSE_API_TOKEN: API_TOKEN, // header-less callers must present this
      ELECTRON_RUN_AS_NODE: "1", // run the Next CLI on Electron's bundled Node
      LIGHTHOUSE_DESKTOP: "1", // gates desktop-only endpoints (e.g. link in place)
      // Where the bundled offline assets (local model, TTS voice) live, so the
      // Next API routes can find them. Packaged: Electron's resourcesPath; dev:
      // the repo's resources/ folder.
      LIGHTHOUSE_RESOURCES_PATH: app.isPackaged
        ? process.resourcesPath
        : path.join(APP_ROOT, "resources"),
      // Where the Next server downloads (and reads) the optional private model,
      // matching what findModel() watches so llama-server picks it up.
      LIGHTHOUSE_MODELS_DIR: modelsDir(),
      // Keep OAuth connector tokens in the app's private data dir, NOT inside the
      // vault (which defaults to the cloud-synced Documents folder).
      LIGHTHOUSE_CONNECTORS_DIR: path.join(app.getPath("userData"), "connectors"),
      VAULT_DIR: vaultDir(),
      // Let the in-app UI read/change desktop settings (e.g. launch-at-login);
      // the main process re-reads this file on its next launch.
      LIGHTHOUSE_SETTINGS_FILE: settingsFile(),
      PORT: String(PORT),
    },
    // Log to a file and hide the console window — no terminal pops up for the user.
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  // Close this fd when the process exits so restarting the server (e.g. on a
  // vault change) doesn't leak a descriptor / duplicate writer on server.log.
  serverProc.on("exit", () => closeFd(out));
}

function waitForServer(cb, tries = 0) {
  http
    .get(`${SERVER_ORIGIN}/api/rag`, (res) => {
      res.resume();
      cb(null);
    })
    .on("error", () => {
      if (tries > 80) return cb(new Error("server did not start"));
      setTimeout(() => waitForServer(cb, tries + 1), 500);
    });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    backgroundColor: "#FBF5E9", // sandy cream — matches the theme, no flash
    title: "Lighthouse",
    icon: WINDOW_ICON,
    webPreferences: { contextIsolation: true },
  });
  // Show a branded splash immediately (a local file, so it paints in well under a
  // second) while the local engine boots; `showApp()` swaps to the live app once
  // the server answers. This keeps the user from staring at an empty screen.
  win.loadFile(path.join(__dirname, "splash.html"));
  // Open external links (e.g. the Microsoft device-login page) in the system
  // browser rather than a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(SERVER_ORIGIN)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  // Keep the top frame pinned to the app origin. Without this a malicious link or
  // redirect could navigate the whole window to a remote/file URL inside the
  // Electron context; instead we block it and hand external URLs to the OS browser.
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(SERVER_ORIGIN)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.once("ready-to-show", () => win.show());
  // Closing hides to tray instead of quitting (persistent app).
  win.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

/** Swap the splash for the live app once the local server is answering. */
function showApp() {
  if (win && !win.isDestroyed()) win.loadURL(SERVER_ORIGIN);
}

/** Replace the loading splash with a static error state when startup fails. */
function showError() {
  if (win && !win.isDestroyed()) win.loadFile(path.join(__dirname, "error.html"));
}

/** POST to the running local server's /api/rag. This caller sends no Origin, so
 *  it authenticates with the per-launch API token instead. */
function postRag(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1", port: PORT, path: "/api/rag", method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": data.length,
          "x-lighthouse-token": API_TOKEN,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(buf || "{}")); } catch { resolve({}); }
          } else {
            reject(new Error(`rag ${res.statusCode}: ${buf}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

/** Unique destination under the vault, suffixing " (n)" on collisions. */
function uniqueDest(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let dest = path.join(dir, name);
  for (let i = 1; fs.existsSync(dest); i++) dest = path.join(dir, `${base} (${i})${ext}`);
  return dest;
}

function copyDirInto(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue; // skip dotfiles / .rag-vault
    const s = path.join(srcDir, e.name);
    const d = path.join(destDir, e.name);
    if (e.isDirectory()) copyDirInto(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

async function addFilesDialog() {
  if (!win) return;
  const r = await dialog.showOpenDialog(win, {
    title: "Add files to your vault",
    properties: ["openFile", "multiSelections"],
  });
  if (r.canceled) return;
  const dir = vaultDir();
  for (const src of r.filePaths) {
    fs.copyFileSync(src, uniqueDest(dir, path.basename(src))); // EXCLUDED by default
  }
  win.webContents.reload();
}

async function addFolderDialog() {
  if (!win) return;
  const r = await dialog.showOpenDialog(win, {
    title: "Add a folder to your vault (copies it in)",
    properties: ["openDirectory"],
  });
  if (r.canceled) return;
  const src = r.filePaths[0];
  const name = path.basename(src);
  const dir = vaultDir();
  let dest = path.join(dir, name);
  for (let i = 1; fs.existsSync(dest); i++) dest = path.join(dir, `${name} (${i})`);
  copyDirInto(src, dest);
  win.webContents.reload();
}

/** Link files or a folder in place (added by reference — no copy is made). */
async function linkDialog(directory) {
  if (!win) return;
  const r = await dialog.showOpenDialog(win, {
    title: directory
      ? "Link a folder in place (not copied)"
      : "Link files in place (not copied)",
    properties: directory ? ["openDirectory"] : ["openFile", "multiSelections"],
  });
  if (r.canceled) return;
  for (const p of r.filePaths) {
    try {
      await postRag({ op: "addReference", path: p });
    } catch (err) {
      dialog.showErrorBox("Lighthouse", `Could not link:\n${p}\n\n${err.message}`);
    }
  }
  win.webContents.reload();
}

async function chooseVaultDialog() {
  if (!win) return;
  const r = await dialog.showOpenDialog(win, {
    title: "Choose your vault folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled) return;
  const s = loadSettings();
  s.vaultDir = r.filePaths[0];
  saveSettings(s);
  if (serverProc) serverProc.kill();
  startServer();
  waitForServer(() => win && win.webContents.reload());
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          { label: "Add files…", accelerator: "CmdOrCtrl+O", click: addFilesDialog },
          { label: "Add folder…", click: addFolderDialog },
          { type: "separator" },
          { label: "Link files… (no copy)", click: () => linkDialog(false) },
          { label: "Link folder… (no copy)", click: () => linkDialog(true) },
          { type: "separator" },
          { label: "Choose vault folder…", click: chooseVaultDialog },
          { label: "Open vault folder", click: () => shell.openPath(vaultDir()) },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

function createTray() {
  // A real branded tray icon, falling back to empty if the asset is missing.
  let trayImg = nativeImage.createFromPath(TRAY_ICON);
  trayImg = trayImg.isEmpty() ? nativeImage.createEmpty() : trayImg.resize({ width: 16, height: 16 });
  tray = new Tray(trayImg);
  tray.setToolTip("Lighthouse");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Lighthouse", click: () => win && win.show() },
      { label: "Add files…", click: addFilesDialog },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => win && win.show());
}

// Single-instance: focus the existing window instead of starting a second copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // Apply a Content-Security-Policy to every response the renderer loads. Set
    // before the window is created so the first document is covered too.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [CONTENT_SECURITY_POLICY],
        },
      });
    });
    // Launch at login unless the user turned it off (default on). The in-app
    // prompt writes runOnStartup to the settings file; we honor it each launch.
    app.setLoginItemSettings({ openAtLogin: loadSettings().runOnStartup !== false });
    startLocalLlm(); // bring up the local model if one is already installed…
    // …and keep reconciling: start it when a download lands, and handle uninstalls.
    const modelTimer = setInterval(reconcileModel, 3000);
    if (typeof modelTimer.unref === "function") modelTimer.unref();
    startServer();
    buildMenu();
    createTray();
    createWindow(); // show the splash right away; swap to the app when ready
    waitForServer((err) => {
      if (err) {
        dialog.showErrorBox(
          "Lighthouse",
          app.isPackaged
            ? "Lighthouse couldn't start its local engine. Please try reinstalling; if it keeps happening, contact support."
            : "The local server did not start. Run `npm run build` first, then `npm run electron`.",
        );
        showError();
        return;
      }
      showApp();
    });
  });

  app.on("activate", () => {
    if (win) win.show();
  });
  app.on("window-all-closed", () => {
    /* stay alive in the tray */
  });
  app.on("before-quit", () => {
    app.isQuitting = true;
    if (serverProc) serverProc.kill();
    if (llmProc) llmProc.kill();
  });
}
