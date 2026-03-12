/**
 * electron/preload.js
 * Exposes a safe IPC bridge to the renderer
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rosApi", {
  openBags: () => ipcRenderer.invoke("dialog:openBags"),
  openOutputDir: () => ipcRenderer.invoke("dialog:openOutputDir"),
  loadBagMeta: (filePath) => ipcRenderer.invoke("bag:loadMeta", filePath),
  exportBags: (opts) => ipcRenderer.invoke("bag:export", opts),
  onProgress: (cb) => ipcRenderer.on("export:progress", (_e, data) => cb(data)),
  offProgress: () => ipcRenderer.removeAllListeners("export:progress"),
});
