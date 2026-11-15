const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server/http');

let chromium = null;
for (const from of [undefined, process.env.NODE_PATH, '/opt/node22/lib/node_modules', '/usr/lib/node_modules', '/usr/local/lib/node_modules']) {
  try {
    const p = from ? require.resolve('playwright', { paths: [from] }) : require.resolve('playwright');
    chromium = require(p).chromium;
    break;
  } catch {}
}
const skip = chromium ? false : 'playwright غير متوفر';

async function boot() {
  const server = createServer({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'msg-')),
    webDir: path.join(__dirname, '..', 'web'),
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const post = (url, body, token) => fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then(r => r.json());
  const close = async () => {
    await browser.close();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  };
  return { base, browser, post, close };
}

async function loginUi(browser, base, name, pin) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base);
  await page.fill('#login-name', name);
  await page.fill('#login-pin', pin);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#conv-list .conv');
  return { page, errors };
}

test('first run shows setup and creates the admin', { skip }, async () => {
  const s = await boot();
  try {
    const page = await s.browser.newPage();
    await page.goto(s.base);
    assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl');
    await page.fill('#setup-name', 'عمر');
    await page.fill('#setup-pin', 'omar1234');
    await page.click('#setup-form button[type=submit]');
    await page.waitForSelector('#conv-list .conv');
    assert.match(await page.textContent('#conv-list'), /المحل/);
    // المدير يضيف حسابًا من الواجهة
    await page.click('#add-user-btn');
    await page.fill('#add-name', 'حاسوب 1');
    await page.fill('#add-pin', '1111');
    await page.selectOption('#add-kind', 'computer');
    await page.click('#add-form button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#conv-list').textContent.includes('حاسوب 1'));
    // الجلسة تبقى بعد إعادة التحميل
    await page.reload();
    await page.waitForSelector('#conv-list .conv');
  } finally { await s.close(); }
});

test('wrong pin shows an Arabic error', { skip }, async () => {
  const s = await boot();
  try {
    await s.post('/api/setup', { name: 'عمر', pin: 'omar1234' });
    const page = await s.browser.newPage();
    await page.goto(s.base);
    await page.fill('#login-name', 'عمر');
    await page.fill('#login-pin', '0000');
    await page.click('#login-form button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#login-error').textContent.includes('غير صحيح'));
  } finally { await s.close(); }
});

test('live messaging: arrival, unread badge, read mark, quick reply, html safety', { skip }, async () => {
  const s = await boot();
  try {
    const admin = await s.post('/api/setup', { name: 'عمر', pin: 'omar1234' });
    await s.post('/api/users', { name: 'حاسوب 1', pin: '1111', kind: 'computer' }, admin.token);
    const a = await loginUi(s.browser, s.base, 'عمر', 'omar1234');
    const b = await loginUi(s.browser, s.base, 'حاسوب 1', '1111');
    // يسجّل ما يُبلَّغ به برنامج الحاسوب
    await b.page.evaluate(() => { window.__unread = []; window.desktop = { setUnread: v => window.__unread.push(v) }; });

    await a.page.click('#conv-list .conv:has-text("حاسوب 1")');
    await a.page.fill('#text', 'اطبع 20 نسخة');
    await a.page.press('#text', 'Enter');
    await a.page.waitForSelector('#messages .msg.mine:has-text("اطبع 20 نسخة")');
    assert.match(await a.page.textContent('#messages .read-mark'), /أُرسلت/);

    // تصل للطرف الآخر دون إعادة تحميل، مع عدّاد
    await b.page.waitForFunction(() => {
      const el = document.querySelector('#conv-list .conv.has-unread .badge');
      return el && el.textContent.trim() === '1';
    });
    await b.page.waitForFunction(() => window.__unread.some(v => v.count === 1 && v.from === 'عمر'));
    assert.match(await b.page.title(), /\(1\)/);

    // يفتحها فتُعلَّم مقروءة عند المرسل
    await b.page.click('#conv-list .conv:has-text("عمر")');
    await b.page.waitForSelector('#messages .msg:has-text("اطبع 20 نسخة")');
    await a.page.waitForFunction(() => /قُرئت/.test(document.querySelector('#messages .read-mark')?.textContent || ''));
    await b.page.waitForFunction(() => window.__unread.at(-1).count === 0);
    await b.page.waitForFunction(() => !document.querySelector('#conv-list .conv.has-unread'));

    // رد سريع بنقرة
    await b.page.click('.quick button:has-text("تم")');
    await a.page.waitForSelector('#messages .msg:not(.mine) .body:text-is("تم")');
    assert.deepEqual(await b.page.$$eval('.quick button', els => els.map(e => e.textContent.trim())), ['تم', 'حاضر', 'دقيقة']);

    // HTML يظهر كنص
    await a.page.fill('#text', '<img src=x onerror=alert(1)>');
    await a.page.click('#send');
    await b.page.waitForSelector('#messages .msg .body:text-is("<img src=x onerror=alert(1)>")');
    assert.equal(await b.page.$$eval('#messages img', els => els.length), 0);

    // Shift+Enter سطر جديد لا إرسال
    await a.page.fill('#text', 'سطر');
    await a.page.press('#text', 'Shift+Enter');
    assert.equal(await a.page.inputValue('#text'), 'سطر\n');

    assert.deepEqual(a.errors, []);
    assert.deepEqual(b.errors, []);
  } finally { await s.close(); }
});

test('#conv=<id> opens that conversation directly', { skip }, async () => {
  const s = await boot();
  try {
    const admin = await s.post('/api/setup', { name: 'عمر', pin: 'omar1234' });
    const pc = await s.post('/api/users', { name: 'حاسوب 1', pin: '1111', kind: 'computer' }, admin.token);
    const { convId } = await s.post('/api/direct', { userId: pc.id }, admin.token);
    await s.post('/api/messages', { conv: convId, body: 'من الرابط' }, admin.token);
    const a = await loginUi(s.browser, s.base, 'عمر', 'omar1234');
    await a.page.evaluate(id => { location.hash = `#conv=${id}`; }, convId);
    await a.page.waitForSelector('#messages .msg:has-text("من الرابط")');
  } finally { await s.close(); }
});

test('settings: I change my own secret; owner resets and removes accounts', { skip }, async () => {
  const s = await boot();
  try {
    const admin = await s.post('/api/setup', { name: 'عمر', pin: 'omar1234' });
    await s.post('/api/users', { name: 'سمير', pin: 'samir66', kind: 'person' }, admin.token);
    await s.post('/api/users', { name: 'حاسوب 1', pin: '1111', kind: 'computer' }, admin.token);

    // سمير يغيّر كلمة سره
    const w = await loginUi(s.browser, s.base, 'سمير', 'samir66');
    await w.page.click('#settings-btn');
    assert.equal(await w.page.isVisible('#accounts'), false);      // إدارة الحسابات لصاحب المحل فقط
    await w.page.fill('#mypin-old', 'wrong');
    await w.page.fill('#mypin-new', 'mine6666');
    await w.page.click('#mypin-form button[type=submit]');
    await w.page.waitForFunction(() => document.querySelector('#mypin-msg').textContent.includes('غير صحيحة'));
    await w.page.fill('#mypin-old', 'samir66');
    await w.page.click('#mypin-form button[type=submit]');
    await w.page.waitForFunction(() => document.querySelector('#mypin-msg').textContent.includes('تم'));
    assert.ok((await s.post('/api/login', { name: 'سمير', pin: 'mine6666' })).token);

    // صاحب المحل يعيد تعيين كلمة سر ثم يحذف حسابًا
    const a = await loginUi(s.browser, s.base, 'عمر', 'omar1234');
    await a.page.click('#settings-btn');
    const row = a.page.locator('#accounts .account', { hasText: 'سمير' });
    await row.locator('.reset').click();
    await row.locator('input').fill('reset666');
    await row.locator('.save').click();
    await a.page.waitForFunction(() => document.querySelector('#accounts-msg').textContent.includes('تم'));
    assert.ok((await s.post('/api/login', { name: 'سمير', pin: 'reset666' })).token);
    // حساب سمير المفتوح يُخرَج تلقائيًا
    await w.page.waitForSelector('#login-form', { state: 'visible' });

    await row.locator('.delete').click();
    assert.match(await row.locator('.delete').textContent(), /تأكيد/);   // نقرتان للحذف
    await row.locator('.delete').click();
    await a.page.waitForFunction(() => !document.querySelector('#accounts').textContent.includes('سمير'));
    await a.page.click('#settings-close');
    await a.page.waitForFunction(() => !document.querySelector('#conv-list').textContent.includes('سمير'));
    // لا يستطيع حذف نفسه
    assert.equal(await a.page.locator('#accounts .account', { hasText: 'عمر' }).locator('.delete').count(), 0);
    assert.deepEqual(a.errors, []);
  } finally { await s.close(); }
});

test('the app registers its notification worker and logout clears the session', { skip }, async () => {
  const s = await boot();
  try {
    await s.post('/api/setup', { name: 'عمر', pin: 'omar1234' });
    const a = await loginUi(s.browser, s.base, 'عمر', 'omar1234');
    await a.page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration()));
    const token = await a.page.evaluate(async () => (await (await caches.open('messenger-auth')).match('/__token')).text());
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(await a.page.getAttribute('link[rel=manifest]', 'href'), 'manifest.webmanifest');
    await a.page.click('#logout-btn');
    await a.page.waitForSelector('#login-form', { state: 'visible' });
    assert.equal(await a.page.evaluate(async () => !!(await (await caches.open('messenger-auth')).match('/__token'))), false);
    // إنهاء الجلسة على المركز يُرسل في الخلفية؛ ننتظره حتى ثانيتين
    let status = 0;
    for (let i = 0; i < 40 && status !== 401; i++) {
      status = (await fetch(s.base + '/api/me', { headers: { authorization: `Bearer ${token}` } })).status;
      if (status !== 401) await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(status, 401);
  } finally { await s.close(); }
});

test('a work computer joins with its name only; the owner accepts with one click', { skip }, async () => {
  const s = await boot();
  try {
    await s.post('/api/setup', { name: 'عمر', pin: 'omar1234' });
    const owner = await loginUi(s.browser, s.base, 'عمر', 'omar1234');
    assert.equal(await owner.page.isVisible('#join-banner'), false);

    // حاسوب عمل جديد: برنامج الحاسوب يعطي الصفحة اسم الجهاز
    const ctx = await s.browser.newContext();
    const pc = await ctx.newPage();
    const errors = [];
    pc.on('pageerror', e => errors.push(String(e)));
    await pc.addInitScript(() => { window.desktop = { setUnread() {}, getComputerName: async () => 'PRINT-PC' }; });
    await pc.goto(s.base);
    await pc.waitForSelector('#join-form', { state: 'visible' });
    await pc.waitForFunction(() => document.querySelector('#join-name').value === 'PRINT-PC');
    await pc.fill('#join-name', 'حاسوب الطباعة');
    await pc.click('#join-form button[type=submit]');
    await pc.waitForFunction(() => document.querySelector('#join-msg').textContent.includes('موافقة'));

    // صاحب المحل يرى الطلب فورًا ويقبله
    const req = owner.page.locator('#join-banner .join-req', { hasText: 'حاسوب الطباعة' });
    await req.waitFor({ state: 'visible' });
    await req.locator('.accept').click();
    await owner.page.waitForFunction(() => document.querySelector('#join-banner').hidden);

    // الحاسوب يدخل وحده
    await pc.waitForSelector('#conv-list .conv');
    assert.equal(await pc.textContent('#me-name'), 'حاسوب الطباعة');
    await owner.page.waitForFunction(() => document.querySelector('#conv-list').textContent.includes('حاسوب الطباعة'));
    // ويبقى داخلًا بعد إعادة التشغيل
    await pc.reload();
    await pc.waitForSelector('#conv-list .conv');
    assert.deepEqual(errors, []);
    assert.deepEqual(owner.errors, []);
  } finally { await s.close(); }
});

test('a rejected computer is told, and a browser (not the desktop program) still gets the login form', { skip }, async () => {
  const s = await boot();
  try {
    const admin = await s.post('/api/setup', { name: 'عمر', pin: 'omar1234' });
    const plain = await s.browser.newPage();
    await plain.goto(s.base);
    await plain.waitForSelector('#login-form', { state: 'visible' });
    assert.equal(await plain.isVisible('#join-form'), false);

    const pc = await (await s.browser.newContext()).newPage();
    await pc.addInitScript(() => { window.desktop = { setUnread() {}, getComputerName: async () => 'PC-2' }; });
    await pc.goto(s.base);
    await pc.waitForFunction(() => document.querySelector('#join-name').value === 'PC-2');
    await pc.click('#join-form button[type=submit]');
    await pc.waitForFunction(() => document.querySelector('#join-msg').textContent.includes('موافقة'));
    const list = await fetch(s.base + '/api/join/requests', { headers: { authorization: `Bearer ${admin.token}` } }).then(r => r.json());
    await s.post('/api/join/decide', { id: list[0].id, approve: false }, admin.token);
    await pc.waitForFunction(() => document.querySelector('#join-msg').textContent.includes('رُفض'));
    // يمكنه الانتقال للدخول بحساب موجود
    await pc.click('#join-to-login');
    await pc.waitForSelector('#login-form', { state: 'visible' });
  } finally { await s.close(); }
});
