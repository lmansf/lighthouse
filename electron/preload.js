// Bridge for the splash/loading screen (and, in Phase B, the app) to reflect
// update status and act on it. Read-only state + two fixed-channel, arg-less
// actions, so there's no IPC injection surface. The privileged action
// (restartToUpdate) is additionally gated in the main process to the boot window,
// so live web content can't trigger an install even though it shares this bridge.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("lighthouseUpdate", {
  onState: (cb) => ipcRenderer.on("update:state", (_e, s) => cb(s)),
  openRelease: () => ipcRenderer.send("update:open"),
  restartToUpdate: () => ipcRenderer.send("update:restart"), // Phase B only
});

// Desktop file bridge: lets the app link dropped/picked files IN PLACE instead
// of copying their bytes in. pathForFile only resolves a File object the page
// already holds (a real OS drop) to its path - it cannot browse the disk; the
// link dialog returns only paths the user explicitly picked. The server's
// addReference is additionally gated to the desktop build.
contextBridge.exposeInMainWorld("lighthouseDesktop", {
  /** Absolute path of an OS-dropped File, or "" when unavailable. */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  /** Native picker for linking files (or a folder) in place; resolves to paths. */
  linkDialog: (directory) => ipcRenderer.invoke("vault:link-dialog", Boolean(directory)),
});
