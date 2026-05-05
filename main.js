const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { sendMessage, testConnection } = require('./src/main/codexClient');
const { savePlan } = require('./src/main/planWriter');
const { createSettingsStore } = require('./src/main/settings');

let settingsStore;

function emitAgentEvent(webContents, event) {
  if (!webContents.isDestroyed()) {
    webContents.send('agent:event', event);
  }
}

function registerIpcHandlers() {
  ipcMain.handle('settings:get', () => settingsStore.readSettings());
  ipcMain.handle('settings:save', (_event, settings) => settingsStore.writeSettings(settings));
  ipcMain.handle('agent:send-message', async (event, payload) => {
    const settings = await settingsStore.readSettings();
    return sendMessage(payload, settings, (agentEvent) => emitAgentEvent(event.sender, agentEvent));
  });
  ipcMain.handle('agent:test-connection', async (_event, partialSettings) => {
    const currentSettings = await settingsStore.readSettings();
    const settings = settingsStore.normalizeSettings({ ...currentSettings, ...partialSettings });
    return testConnection(settings);
  });
  ipcMain.handle('plan:save', async (_event, payload) => {
    const settings = await settingsStore.readSettings();
    return savePlan(payload, settings);
  });
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    title: 'DeepCode',
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  settingsStore = createSettingsStore({
    app,
    defaultWorkspacePath: __dirname,
  });

  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
