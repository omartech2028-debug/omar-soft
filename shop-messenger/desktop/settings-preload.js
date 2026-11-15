const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('settings:get'),
  discover: () => ipcRenderer.invoke('settings:discover'),
  chooseCenter: () => ipcRenderer.invoke('settings:center'),
  chooseClient: server => ipcRenderer.invoke('settings:client', server),
});
