// برنامج مراسلة المحل للحاسوب.
// على الحاسوب الرئيسي يشغّل المركز المضمَّن أيضًا؛ على حواسيب العمل يجد المركز وحده على الشبكة.
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, net, nativeImage, dialog, clipboard } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAlertState } = require('./lib/alert-state');
const { createCenter } = require('./lib/center');
const { discover } = require('./lib/discover');

const BUBBLE = { width: 150, height: 130 };
const RETRY_MS = 5000;
const PORT = 4800;
const LOCAL = `http://localhost:${PORT}`;
const startHidden = process.argv.includes('--hidden');

// السماح بتشغيل صوت التنبيه دون نقرة من المستخدم
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let config = {};
  let chatWin = null;
  let bubbleWin = null;
  let setupWin = null;
  let tray = null;
  let center = null;
  let quitting = false;
  let retryTimer = null;
  let pendingConv = null;

  const configFile = () => path.join(app.getPath('userData'), 'config.json');
  function loadConfig() {
    try { config = JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {}; } catch { config = {}; }
    // إعدادات النسخة السابقة: كان فيها عنوان فقط، أي حاسوب عمل
    if (!config.role && config.server) config.role = 'client';
  }
  function saveConfig() {
    try {
      fs.mkdirSync(path.dirname(configFile()), { recursive: true });
      fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
    } catch (e) { console.error(e); }
  }

  function normalizeServer(input) {
    let s = String(input || '').trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      if (!u.port && u.protocol === 'http:') u.port = String(PORT);
      return u.origin;
    } catch { return null; }
  }

  async function isCenter(server) {
    try {
      const res = await net.fetch(`${server}/api/state`, { signal: AbortSignal.timeout(4000) });
      const json = await res.json();
      return res.ok && typeof json.needsSetup === 'boolean';
    } catch { return false; }
  }

  // ---------- المركز المضمَّن (الحاسوب الرئيسي فقط) ----------
  // في النسخة المثبَّتة: resources/center فيه node.exe و server و web. في التطوير: مجلد المشروع و node من النظام.
  function centerPaths() {
    if (app.isPackaged) {
      const dir = path.join(process.resourcesPath, 'center');
      return { node: path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node'), script: path.join(dir, 'server', 'main.js'), dataDir: path.join(app.getPath('userData'), 'data') };
    }
    const root = path.join(__dirname, '..');
    return { node: 'node', script: path.join(root, 'server', 'main.js'), dataDir: path.join(root, 'data') };
  }

  function startCenter() {
    if (center) return;
    const p = centerPaths();
    center = createCenter({
      spawn,
      command: p.node,
      args: ['--disable-warning=ExperimentalWarning', p.script],
      env: { ...process.env, PORT: String(PORT), DATA_DIR: p.dataDir },
    });
    center.start();
  }

  function lanAddresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) out.push(`${ni.address}:${PORT}`);
    }
    return out;
  }

  // رابط الهاتف من Tailscale إن كان مفعَّلًا على هذا الحاسوب
  function phoneLink() {
    return new Promise(resolve => {
      execFile('tailscale', ['funnel', 'status'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
        const m = !err && /https:\/\/[a-z0-9.-]+\.ts\.net/i.exec(String(stdout));
        resolve(m ? m[0] : null);
      });
    });
  }

  async function showCenterInfo() {
    const link = await phoneLink();
    const lan = lanAddresses();
    const lines = [
      'هذا الحاسوب هو المركز.',
      '',
      'حواسيب العمل تجد المركز وحدها. إن طُلب العنوان يدويًا:',
      ...(lan.length ? lan.map(a => `    ${a}`) : ['    (لا توجد شبكة متصلة)']),
      '',
      link ? `رابط الهاتف:\n    ${link}` : 'رابط الهاتف: غير مفعَّل (يحتاج Tailscale Funnel على هذا الحاسوب).',
      '',
      `مجلد البيانات:\n    ${centerPaths().dataDir}`,
    ];
    const buttons = link ? ['إغلاق', 'نسخ رابط الهاتف'] : ['إغلاق'];
    const r = await dialog.showMessageBox({ type: 'info', title: 'معلومات المركز', message: 'مراسلة المحل', detail: lines.join('\n'), buttons, defaultId: 0 });
    if (link && r.response === 1) clipboard.writeText(link);
  }

  // استعادة كلمة سر صاحب المحل: تُنشأ كلمة جديدة عشوائية وتُعرض هنا على الحاسوب الرئيسي فقط
  async function recoverOwner() {
    const ask = await dialog.showMessageBox({
      type: 'question', title: 'استعادة كلمة سر صاحب المحل',
      message: 'ستُنشأ كلمة سر جديدة لحساب صاحب المحل ويُخرَج من كل أجهزته.',
      buttons: ['إلغاء', 'إنشاء كلمة سر جديدة'], defaultId: 0, cancelId: 0,
    });
    if (ask.response !== 1) return;
    const p = centerPaths();
    const secret = require('node:crypto').randomBytes(8).toString('base64url').slice(0, 10);
    execFile(p.node, ['--disable-warning=ExperimentalWarning', path.join(path.dirname(p.script), 'reset-owner.js'), secret],
      { env: { ...process.env, DATA_DIR: p.dataDir }, timeout: 15000, windowsHide: true }, async (err, _out, stderr) => {
        if (err) return dialog.showErrorBox('تعذّرت الاستعادة', String(stderr || err.message));
        const r = await dialog.showMessageBox({
          type: 'info', title: 'كلمة السر الجديدة', message: secret,
          detail: 'ادخل بها الآن بحساب صاحب المحل، ثم غيّرها من ⚙ ← «كلمة سري».',
          buttons: ['إغلاق', 'نسخ'], defaultId: 1,
        });
        if (r.response === 1) clipboard.writeText(secret);
      });
  }

  // استيراد بيانات من نسخة سابقة (ملف messenger.db من مجلد data القديم)
  async function importOldData() {
    const pick = await dialog.showOpenDialog({
      title: 'اختر ملف messenger.db من مجلد data القديم',
      filters: [{ name: 'قاعدة البيانات', extensions: ['db'] }], properties: ['openFile'],
    });
    if (pick.canceled || !pick.filePaths[0]) return;
    const ok = await dialog.showMessageBox({
      type: 'warning', title: 'استيراد بيانات قديمة',
      message: 'سيُستبدل كل ما في هذا البرنامج من حسابات ورسائل بمحتوى الملف المختار.',
      buttons: ['إلغاء', 'استيراد'], defaultId: 0, cancelId: 0,
    });
    if (ok.response !== 1) return;
    const { dataDir } = centerPaths();
    const target = path.join(dataDir, 'messenger.db');
    try {
      if (center) { center.stop(); center = null; }
      await new Promise(r => setTimeout(r, 800));
      fs.mkdirSync(dataDir, { recursive: true });
      for (const ext of ['', '-wal', '-shm']) fs.rmSync(target + ext, { force: true });
      fs.copyFileSync(pick.filePaths[0], target);
      for (const ext of ['-wal', '-shm']) {
        if (fs.existsSync(pick.filePaths[0] + ext)) fs.copyFileSync(pick.filePaths[0] + ext, target + ext);
      }
    } catch (e) {
      dialog.showErrorBox('تعذّر الاستيراد', String(e && e.message));
    }
    startCenter();
    setTimeout(loadServer, 1500);
  }

  // ---------- نافذة المحادثة ----------
  function createChatWindow() {
    chatWin = new BrowserWindow({
      width: 980, height: 680, minWidth: 360, minHeight: 480,
      show: false,
      title: 'مراسلة المحل',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    chatWin.on('close', ev => {
      if (quitting) return;
      ev.preventDefault();       // الإغلاق يخفي النافذة فقط؛ البرنامج يبقى يعمل
      chatWin.hide();
    });
    chatWin.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;   // -3: تحميل أُلغي
      showConnecting();
    });
    chatWin.webContents.on('did-finish-load', () => {
      if (!isServerPage()) return;
      clearTimeout(retryTimer);
      if (pendingConv !== null) { openConversation(pendingConv); }
    });
    // لا نفتح روابط خارجية داخل البرنامج
    chatWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    chatWin.webContents.on('will-navigate', (ev, url) => {
      if (config.server && !url.startsWith(config.server)) ev.preventDefault();
    });
    loadServer();
  }

  function isServerPage() {
    return !!config.server && chatWin && chatWin.webContents.getURL().startsWith(config.server);
  }

  function loadServer() {
    clearTimeout(retryTimer);
    if (!chatWin || !config.server) return;
    chatWin.loadURL(config.server).catch(() => {});
  }

  function showConnecting() {
    alertState.update({ count: 0 });
    chatWin.loadFile(path.join(__dirname, 'connecting.html'), { query: { server: config.server || '', center: config.role === 'center' ? '1' : '' } }).catch(() => {});
    clearTimeout(retryTimer);
    retryTimer = setTimeout(async () => {
      // حاسوب عمل: ربما تغيّر عنوان المركز (بعد إعادة تشغيل المودم مثلًا)، فنبحث عنه من جديد
      if (config.role === 'client') {
        const found = await discover().catch(() => null);
        if (found && found !== config.server && await isCenter(found)) { config.server = found; saveConfig(); }
      }
      loadServer();
    }, RETRY_MS);
  }

  function showChat() {
    if (!config.role) return openSetup();
    if (!chatWin) createChatWindow();
    if (chatWin.isMinimized()) chatWin.restore();
    chatWin.show();
    chatWin.focus();
  }

  function openConversation(convId) {
    pendingConv = null;
    const id = Number(convId);
    if (!Number.isInteger(id) || id <= 0 || !isServerPage()) return;
    chatWin.webContents.executeJavaScript(`location.hash = '#conv=${id}'`).catch(() => {});
  }

  // ---------- الدائرة العائمة ----------
  function bubblePosition() {
    const area = screen.getPrimaryDisplay().workArea;
    const fallback = { x: area.x + area.width - BUBBLE.width - 24, y: area.y + 90 };
    const p = config.bubble;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return fallback;
    // إن صار الموضع المحفوظ خارج كل الشاشات (شاشة فُصلت مثلًا) نعود للموضع الافتراضي
    const visible = screen.getAllDisplays().some(d =>
      p.x + BUBBLE.width > d.workArea.x && p.x < d.workArea.x + d.workArea.width &&
      p.y + BUBBLE.height > d.workArea.y && p.y < d.workArea.y + d.workArea.height);
    return visible ? { x: Math.round(p.x), y: Math.round(p.y) } : fallback;
  }

  function createBubbleWindow() {
    const pos = bubblePosition();
    bubbleWin = new BrowserWindow({
      ...BUBBLE, ...pos,
      show: false, frame: false, transparent: true, resizable: false,
      skipTaskbar: true, focusable: false, hasShadow: false,
      alwaysOnTop: true, fullscreenable: false, minimizable: false, maximizable: false,
      webPreferences: { preload: path.join(__dirname, 'bubble-preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    bubbleWin.setAlwaysOnTop(true, 'screen-saver');
    bubbleWin.setVisibleOnAllWorkspaces(true);
    bubbleWin.loadFile(path.join(__dirname, 'bubble.html'));
  }

  const toBubble = (channel, data) => {
    if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.webContents.send(channel, data);
  };

  let lastConv = null;
  const alertState = createAlertState({
    onShow: info => {
      toBubble('bubble:update', info);
      if (!bubbleWin || bubbleWin.isDestroyed()) return;
      const pos = bubblePosition();
      bubbleWin.setPosition(pos.x, pos.y);
      bubbleWin.showInactive();                  // تظهر دون سحب التركيز من عمل العامل
      bubbleWin.setAlwaysOnTop(true, 'screen-saver');
      bubbleWin.moveTop();
    },
    onHide: () => { if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.hide(); },
    onSound: () => toBubble('bubble:sound'),
  });

  function setTrayState(count) {
    if (!tray) return;
    tray.setToolTip(count ? `مراسلة المحل — ${count} رسالة جديدة` : 'مراسلة المحل');
  }

  ipcMain.on('unread', (ev, info) => {
    if (!chatWin || ev.sender !== chatWin.webContents || !isServerPage()) return;
    const count = Math.max(0, Math.floor(Number(info && info.count)) || 0);
    const from = info && typeof info.from === 'string' ? info.from.slice(0, 60) : null;
    lastConv = info && Number.isInteger(info.conv) ? info.conv : null;
    alertState.update({ count, from });
    setTrayState(count);
    chatWin.flashFrame(count > 0 && !chatWin.isFocused());
  });

  ipcMain.handle('computer-name', () => os.hostname());

  ipcMain.on('bubble:open', ev => {
    if (!bubbleWin || ev.sender !== bubbleWin.webContents) return;
    pendingConv = lastConv;
    showChat();
    if (pendingConv !== null && isServerPage()) openConversation(pendingConv);
  });

  ipcMain.on('bubble:move', (ev, d) => {
    if (!bubbleWin || ev.sender !== bubbleWin.webContents || !d) return;
    const dx = Number(d.dx), dy = Number(d.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const [x, y] = bubbleWin.getPosition();
    bubbleWin.setPosition(Math.round(x + dx), Math.round(y + dy));
  });

  ipcMain.on('bubble:moved', ev => {
    if (!bubbleWin || ev.sender !== bubbleWin.webContents) return;
    const [x, y] = bubbleWin.getPosition();
    config.bubble = { x, y };
    saveConfig();
  });

  // ---------- الإعداد الأول: هل هذا الحاسوب الرئيسي أم حاسوب عمل؟ ----------
  function openSetup() {
    if (setupWin) { setupWin.show(); setupWin.focus(); return; }
    setupWin = new BrowserWindow({
      width: 520, height: 560, resizable: false, title: 'إعداد مراسلة المحل',
      icon: path.join(__dirname, 'assets', 'icon.png'), autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    setupWin.on('closed', () => { setupWin = null; });
    setupWin.loadFile(path.join(__dirname, 'settings.html'));
  }

  // أول تشغيل: إن وُجد مركز على الشبكة فهذا حاسوب عمل ولا نسأل شيئًا؛ وإلا نسأل عن الدور
  async function firstRun() {
    const found = await discover({ timeoutMs: 3000 }).catch(() => null);
    if (found && await isCenter(found)) {
      config.role = 'client';
      config.server = found;
      saveConfig();
      buildTrayMenu();
      createChatWindow();
      chatWin.once('ready-to-show', () => chatWin.show());
      return;
    }
    openSetup();
  }

  const fromSetup = ev => setupWin && ev.sender === setupWin.webContents;

  function applyRole() {
    saveConfig();
    if (config.role === 'center') startCenter(); else if (center) { center.stop(); center = null; }
    buildTrayMenu();
    if (!chatWin) createChatWindow(); else loadServer();
    setTimeout(() => { if (setupWin) setupWin.close(); showChat(); }, 300);
  }

  ipcMain.handle('settings:get', () => ({ role: config.role || null, server: config.role === 'client' ? (config.server || '') : '' }));

  ipcMain.handle('settings:discover', async ev => {
    if (!fromSetup(ev)) return null;
    const found = await discover({ timeoutMs: 2500 }).catch(() => null);
    return found && await isCenter(found) ? found : null;
  });

  ipcMain.handle('settings:center', async ev => {
    if (!fromSetup(ev)) return { ok: false, error: 'غير مسموح' };
    // مركز آخر يعمل على الشبكة؟ ننبّه حتى لا يصير في المحل مركزان
    const other = await discover({ timeoutMs: 1500 }).catch(() => null);
    if (other && !/\/\/(127\.0\.0\.1|localhost)[:/]/.test(other) && !lanAddresses().some(a => other.endsWith(a))) {
      return { ok: false, error: `يوجد مركز يعمل على حاسوب آخر (${other.replace('http://', '')}). اختر «حاسوب عمل» هنا، أو أوقف المركز الآخر أولًا.` };
    }
    config.role = 'center';
    config.server = LOCAL;
    applyRole();
    return { ok: true };
  });

  ipcMain.handle('settings:client', async (ev, input) => {
    if (!fromSetup(ev)) return { ok: false, error: 'غير مسموح' };
    const server = normalizeServer(input);
    if (!server) return { ok: false, error: 'العنوان غير صالح. مثال: 192.168.1.10:4800' };
    if (!await isCenter(server)) return { ok: false, error: 'لم أجد المركز على هذا العنوان. تأكد أن الحاسوب الرئيسي مشتغل.' };
    config.role = 'client';
    config.server = server;
    applyRole();
    return { ok: true };
  });

  // ---------- أيقونة قرب الساعة ----------
  function buildTrayMenu() {
    if (!tray) return;
    const items = [{ label: 'فتح', click: showChat }];
    if (config.role === 'center') {
      items.push({ label: 'معلومات المركز ورابط الهاتف', click: showCenterInfo });
      items.push({ label: 'استيراد بيانات قديمة…', click: importOldData });
      items.push({ label: 'نسيت كلمة سر صاحب المحل…', click: recoverOwner });
    }
    items.push({ label: 'تغيير دور هذا الحاسوب…', click: openSetup });
    items.push({ type: 'separator' });
    items.push({ label: 'خروج', click: () => { quitting = true; app.quit(); } });
    tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  function createTray() {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
    tray.setToolTip('مراسلة المحل');
    tray.on('click', showChat);
    buildTrayMenu();
  }

  app.on('second-instance', showChat);
  app.on('before-quit', () => { quitting = true; if (center) center.stop(); });
  app.on('window-all-closed', () => { /* نبقى في الخلفية */ });

  app.whenReady().then(() => {
    loadConfig();
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
    createTray();
    createBubbleWindow();
    if (!config.role) return firstRun();
    if (config.role === 'center') { config.server = LOCAL; startCenter(); }
    createChatWindow();
    if (!startHidden) chatWin.once('ready-to-show', () => chatWin.show());
  });
}
