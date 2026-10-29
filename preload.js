// The only bridge between the page and the main process.
// It exposes a few named operations - the page can never read the saved API key, and the
// encryption/decryption stays in the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tcgen', {
  gemini: {
    status: () => ipcRenderer.invoke('gemini:status'),
    save: key => ipcRenderer.invoke('gemini:save', typeof key === 'string' ? key : ''),
    clear: () => ipcRenderer.invoke('gemini:clear'),
    test: key => ipcRenderer.invoke('gemini:test', typeof key === 'string' ? key : '')
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    state: () => ipcRenderer.invoke('updater:state'),
    onEvent: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('updater:event', listener);
      return () => ipcRenderer.removeListener('updater:event', listener);
    }
  },
  onOpenSettings: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('open-settings', listener);
    return () => ipcRenderer.removeListener('open-settings', listener);
  }
});
