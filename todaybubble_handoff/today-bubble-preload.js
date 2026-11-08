const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('todayBubbleDesktop', {
  getState: () => ipcRenderer.invoke('todaybubble:get-state'),
  saveState: (nextState) => ipcRenderer.invoke('todaybubble:save-state', nextState),
  setWidgetMode: (mode) => ipcRenderer.invoke('todaybubble:set-widget-mode', mode),
  restoreMain: () => ipcRenderer.invoke('todaybubble:restore-main'),
  quitApp: () => ipcRenderer.invoke('todaybubble:quit-app'),
  archiveCurrentList: (nextState) => ipcRenderer.invoke('todaybubble:archive-current-list', nextState)
});
