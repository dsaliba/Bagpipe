/**
 * electron/main.js
 * Electron main process — creates window, handles IPC for bag operations
 */

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const { loadBagMeta } = require("../src/bagReader");
const { exportBags } = require("../src/exporter");

// ── Global crash guards ────────────────────────────────────────────────────────
// These prevent silent process termination from unhandled async errors.
process.on("unhandledRejection", (reason, promise) => {
  console.error("[unhandledRejection]", reason);
  // Do NOT rethrow — let Electron keep running and report via IPC
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  // Log but don't exit — Electron will handle window lifecycle
});

let mainWindow;

// Resolve icon path — works both in dev (project root) and packaged (resources)
function getIconPath() {
  const iconFile = process.platform === "win32" ? "bagpipe.ico"
                 : process.platform === "darwin" ? "bagpipe.icns"
                 : "bagpipe.png";
  // In packaged app, __dirname is inside the asar; use process.resourcesPath
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "assets", iconFile);
  }
  return path.join(__dirname, "..", "assets", iconFile);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#111213",
    icon: getIconPath(),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  if (process.env.NODE_ENV === "development") {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC Handlers ──────────────────────────────────────────────────────────────

/** Open file dialog to pick bag files */
ipcMain.handle("dialog:openBags", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select ROS Bag Files",
    filters: [
      { name: "ROS Bags", extensions: ["bag", "db3", "mcap"] },
      { name: "All Files", extensions: ["*"] },
    ],
    properties: ["openFile", "multiSelections"],
  });
  return result.canceled ? [] : result.filePaths;
});

/** Open directory dialog for output */
ipcMain.handle("dialog:openOutputDir", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Output Directory",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

/** Load bag metadata */
ipcMain.handle("bag:loadMeta", async (event, filePath) => {
  try {
    const meta = await loadBagMeta(filePath);
    // Strip the live bag object — only return serializable data
    return {
      success: true,
      name: meta.name,
      filePath: meta.filePath,
      format: meta.format,
      startTimeSec: meta.startTime
        ? meta.startTime.sec + meta.startTime.nsec / 1e9
        : null,
      endTimeSec: meta.endTime
        ? meta.endTime.sec + meta.endTime.nsec / 1e9
        : null,
      topics: meta.topics,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/** Run export — streams progress back via webContents.send */
ipcMain.handle("bag:export", async (event, exportOptions) => {
  const { bagPaths, outputDir, topicSelection, generateSync } = exportOptions;

  try {
    const result = await exportBags({
      bagPaths,
      outputDir,
      topicSelection,
      generateSync,
      onProgress: (info) => {
        mainWindow.webContents.send("export:progress", info);
      },
    });

    mainWindow.webContents.send("export:progress", {
      stage: "complete",
      result,
    });

    return { success: true, result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});