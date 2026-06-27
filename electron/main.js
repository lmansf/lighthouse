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

async function addFilesDialog() {
  if (!win) return;
  const r = await dialog.showOpenDialog(win, {
    title: "Add files to your vault",
    properties: ["openFile", "multiSelections"],
  });
  if (r.canceled) return;
  const dir = vaultDir();
  for (const src of r.filePaths) {
    const ext = path.extname(src);
    const base = path.basename(src, ext);
    let dest = path.join(dir, path.basename(src));
    for (let i = 1; fs.existsSync(dest); i++) dest = path.join(dir, `${base} (${i})${ext}`);
    fs.copyFileSync(src, dest); // lands EXCLUDED by default (no state entry)
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
  tray = new Tray(nativeImage.createEmpty()); // replace with assets/tray.png for a real icon
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
