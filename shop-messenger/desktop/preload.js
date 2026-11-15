// الجسر الوحيد بين صفحة المحادثة وبرنامج الحاسوب: إبلاغ عدد الرسائل غير المقروءة
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  getComputerName: () => ipcRenderer.invoke('computer-name'),
  setUnread: info => ipcRenderer.send('unread', {
    count: Number(info && info.count) || 0,
    from: info && info.from ? String(info.from) : null,
    conv: info && Number.isInteger(info.conv) ? info.conv : null,
  }),
});
