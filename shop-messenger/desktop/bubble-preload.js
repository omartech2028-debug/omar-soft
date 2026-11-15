const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bubble', {
  onUpdate: fn => ipcRenderer.on('bubble:update', (_e, info) => fn(info)),
  onSound: fn => ipcRenderer.on('bubble:sound', () => fn()),
  open: () => ipcRenderer.send('bubble:open'),
  move: (dx, dy) => ipcRenderer.send('bubble:move', { dx, dy }),
  moved: () => ipcRenderer.send('bubble:moved'),
});
