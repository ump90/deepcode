const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deepcode', {
  versions: {
    chrome: process.versions.chrome,
    node: process.versions.node,
    electron: process.versions.electron,
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  sendMessage: (payload) => ipcRenderer.invoke('agent:send-message', payload),
  savePlan: (payload) => ipcRenderer.invoke('plan:save', payload),
  testConnection: (settings) => ipcRenderer.invoke('agent:test-connection', settings),
  onAgentEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },
});
