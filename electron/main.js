// Lighthouse desktop shell (Electron).
//
// Wraps the existing Next.js + Node backend: starts the production server on a
// local port, shows it in a window, keeps files in a real local directory,
// launches at login, lives in the tray, and adds native Add files / Choose
// vault folder dialogs. Run after `npm run build` via `npm run electron`.
const { app, BrowserWindow, Menu, Tray, dialog, shell, nativeImage } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const PORT = Number(process.env.LIGHTHOUSE_PORT || 3777);
const APP_ROOT = path.join(__dirname, "..");
const WINDOW_ICON = path.join(APP_ROOT, "assets", "icon.png");
const TRAY_ICON = path.join(APP_ROOT, "assets", "tray.png");

let serverProc = null;
let win = null;
let tray = null;

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

function startServer() {
  const nextBin = path.join(APP_ROOT, "node_modules", "next", "dist", "bin", "next");
  serverProc = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1", // run the Next CLI on Electron's bundled Node
      VAULT_DIR: vaultDir(),
      PORT: String(PORT),
    },
    stdio: "inherit",
  });
}

function waitForServer(cb, tries = 0) {
  http
    .get(`http://localhost:${PORT}/api/rag`, (res) => {
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
  win.loadURL(`http://localhost:${PORT}`);
  win.once("ready-to-show", () => win.show());
  // Closing hides to tray instead of quitting (persistent app).
  win.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

/** POST to the running local server's /api/rag (no Origin ⇒ same-origin OK). */
function postRag(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "localhost", port: PORT, path: "/api/rag", method: "POST",
        headers: { "content-type": "application/json", "content-length": data.length },
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
    app.setLoginItemSettings({ openAtLogin: true }); // persistent: launch at login
    startServer();
    buildMenu();
    createTray();
    waitForServer((err) => {
      if (err) {
        dialog.showErrorBox(
          "Lighthouse",
          "The local server did not start. Make sure you ran `npm run build` first.",
        );
        return;
      }
      createWindow();
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
  });
}
