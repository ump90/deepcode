const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const { testConnection } = require('./src/main/codexClient');
const { CodexSessionManager } = require('./src/main/codexSessionManager');
const { readGitStatus } = require('./src/main/gitStatus');
const { savePlan } = require('./src/main/planWriter');
const { createSettingsStore } = require('./src/main/settings');

let settingsStore;
let sessionManager;

function emitAgentEvent(webContents, event) {
  if (!webContents.isDestroyed()) {
    webContents.send('agent:event', event);
  }
}

function registerIpcHandlers() {
  ipcMain.handle('settings:get', () => settingsStore.readSettings());
  ipcMain.handle('settings:save', (_event, settings) => settingsStore.writeSettings(settings));
  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle('window:maximize-toggle', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle('agent:send-message', async (event, payload) => {
    const settings = await settingsStore.readSettings();
    return sessionManager.sendMessage(payload, settings, (agentEvent) => emitAgentEvent(event.sender, agentEvent));
  });
  ipcMain.handle('agent:new-thread', async (_event, payload = {}) => {
    const settings = await settingsStore.readSettings();
    return sessionManager.startThread(settings, payload);
  });
  ipcMain.handle('agent:list-threads', async (_event, payload = {}) => {
    const settings = await settingsStore.readSettings();
    return sessionManager.listThreads(settings, payload);
  });
  ipcMain.handle('agent:resume-thread', async (_event, payload = {}) => {
    const settings = await settingsStore.readSettings();
    return sessionManager.resumeThread(settings, payload);
  });
  ipcMain.handle('agent:read-thread', async (_event, payload = {}) => {
    const settings = await settingsStore.readSettings();
    return sessionManager.readThread(settings, payload);
  });
  ipcMain.handle('agent:unsubscribe-thread', async (_event, payload = {}) => {
    const settings = await settingsStore.readSettings();
    return sessionManager.unsubscribeThread(settings, payload);
  });
  ipcMain.handle('agent:interrupt-turn', async (_event, payload = {}) => {
    const settings = await settingsStore.readSettings();
    return sessionManager.interruptTurn(settings, payload);
  });
  ipcMain.handle('agent:steer-turn', async (_event, payload = {}) => {
    const settings = await settingsStore.readSettings();
    return sessionManager.steerTurn(settings, payload);
  });
  ipcMain.handle('agent:resolve-approval', async (_event, payload = {}) => {
    const settings = await settingsStore.readSettings();
    return sessionManager.resolveApproval(settings, payload);
  });
  ipcMain.handle('git:status', async (_event, payload = {}) => {
    const settings = await settingsStore.readSettings();
    return readGitStatus(payload.workspacePath || settings.workspacePath);
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
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  settingsStore = createSettingsStore({
    app,
    defaultWorkspacePath: __dirname,
  });

  registerIpcHandlers();
  sessionManager = new CodexSessionManager();
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

app.on('before-quit', () => {
  sessionManager?.close();
});
