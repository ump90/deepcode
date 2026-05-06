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
  newThread: (payload) => ipcRenderer.invoke('agent:new-thread', payload),
  listThreads: (payload) => ipcRenderer.invoke('agent:list-threads', payload),
  resumeThread: (payload) => ipcRenderer.invoke('agent:resume-thread', payload),
  readThread: (payload) => ipcRenderer.invoke('agent:read-thread', payload),
  unsubscribeThread: (payload) => ipcRenderer.invoke('agent:unsubscribe-thread', payload),
  interruptTurn: (payload) => ipcRenderer.invoke('agent:interrupt-turn', payload),
  steerTurn: (payload) => ipcRenderer.invoke('agent:steer-turn', payload),
  resolveApproval: (payload) => ipcRenderer.invoke('agent:resolve-approval', payload),
  getGitStatus: (payload) => ipcRenderer.invoke('git:status', payload),
  savePlan: (payload) => ipcRenderer.invoke('plan:save', payload),
  testConnection: (settings) => ipcRenderer.invoke('agent:test-connection', settings),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:maximize-toggle'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onAgentEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },
});
