// Bridge for the splash/loading screen (and, in Phase B, the app) to reflect
// update status and act on it. Read-only state + two fixed-channel, arg-less
// actions, so there's no IPC injection surface. The privileged action
// (restartToUpdate) is additionally gated in the main process to the boot window,
// so live web content can't trigger an install even though it shares this bridge.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lighthouseUpdate", {
  onState: (cb) => ipcRenderer.on("update:state", (_e, s) => cb(s)),
  openRelease: () => ipcRenderer.send("update:open"),
  restartToUpdate: () => ipcRenderer.send("update:restart"), // Phase B only
});
