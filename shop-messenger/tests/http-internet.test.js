const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server/http');

const REMOTE = { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' };

async function start() {
  const pushed = [];
  const server = createServer({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'msg-')),
    webDir: path.join(__dirname, '..', 'web'),
    pushFetch: async url => { pushed.push(url); return { status: 201 }; },
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, url, body, token, extra = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  };
  const close = () => new Promise(r => { server.closeAllConnections(); server.close(r); });
  const admin = (await api('POST', '/api/setup', { name: 'عمر', pin: 'omar1234' })).json;
  const pcUser = (await api('POST', '/api/users', { name: 'حاسوب 1', pin: '1111', kind: 'computer' }, admin.token)).json;
  const wUser = (await api('POST', '/api/users', { name: 'سمير', pin: 'samir66', kind: 'person' }, admin.token)).json;
  const w = (await api('POST', '/api/login', { name: 'سمير', pin: 'samir66' })).json;
  return { base, api, close, pushed, admin, pcUser, wUser, w };
}

test('requests arriving through the internet gateway follow the remote rules', async () => {
  const s = await start();
  try {
    const pc = await s.api('POST', '/api/login', { name: 'حاسوب 1', pin: '1111' }, null, REMOTE);
    assert.equal(pc.status, 403);
    assert.equal(pc.json.error, 'lan_only');
    assert.equal((await s.api('POST', '/api/login', { name: 'حاسوب 1', pin: '1111' })).status, 200);
    assert.equal((await s.api('POST', '/api/login', { name: 'سمير', pin: 'samir66' }, null, REMOTE)).status, 200);
    // إعداد أول مرة لا يُسمح به من الإنترنت أبدًا
    assert.deepEqual((await s.api('GET', '/api/state', undefined, null, REMOTE)).json, { needsSetup: false, remote: true });
    assert.deepEqual((await s.api('GET', '/api/state')).json, { needsSetup: false, remote: false });
  } finally { await s.close(); }
});

test('first-time setup is refused from the internet', async () => {
  const server = createServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'msg-')), webDir: path.join(__dirname, '..', 'web') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...REMOTE }, body: JSON.stringify({ name: 'لص', pin: 'takeover1' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'lan_only');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('logout ends the session on the server', async () => {
  const s = await start();
  try {
    // الخروج يوقف أيضًا إشعارات هذا الجهاز بطلب واحد
    const ep = 'https://fcm.googleapis.com/fcm/send/w-phone';
    await s.api('POST', '/api/push/subscribe', { endpoint: ep }, s.w.token);
    assert.equal((await s.api('POST', '/api/logout', { endpoint: ep }, s.w.token)).status, 200);
    assert.equal((await s.api('GET', '/api/me', undefined, s.w.token)).status, 401);
    await s.api('POST', '/api/messages', { conv: 1, body: 'للجميع' }, s.admin.token);
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(s.pushed, []);
  } finally { await s.close(); }
});

test('owner changes a secret and removes an account over the API', async () => {
  const s = await start();
  try {
    assert.equal((await s.api('POST', '/api/users/pin', { userId: s.pcUser.id, pin: '9999' }, s.w.token)).status, 403);
    assert.equal((await s.api('POST', '/api/users/pin', { userId: s.wUser.id, pin: 'changed1' }, s.admin.token)).status, 200);
    assert.equal((await s.api('GET', '/api/me', undefined, s.w.token)).status, 401);
    assert.equal((await s.api('POST', '/api/login', { name: 'سمير', pin: 'changed1' })).status, 200);
    assert.equal((await s.api('POST', '/api/users/delete', { userId: s.wUser.id }, s.admin.token)).status, 200);
    assert.deepEqual((await s.api('GET', '/api/users', undefined, s.admin.token)).json.map(u => u.name), ['عمر', 'حاسوب 1']);
    assert.equal((await s.api('POST', '/api/users/delete', { userId: s.admin.user.id }, s.admin.token)).status, 400);
  } finally { await s.close(); }
});

test('changing my own secret needs the old one', async () => {
  const s = await start();
  try {
    assert.equal((await s.api('POST', '/api/me/pin', { old: 'nope', pin: 'mine6666' }, s.w.token)).status, 400);
    assert.equal((await s.api('POST', '/api/me/pin', { old: 'samir66', pin: 'mine6666' }, s.w.token)).status, 200);
    assert.equal((await s.api('GET', '/api/me', undefined, s.w.token)).status, 200);
    assert.equal((await s.api('POST', '/api/login', { name: 'سمير', pin: 'mine6666' })).status, 200);
  } finally { await s.close(); }
});

test('removing an account cuts its live connection', async () => {
  const s = await start();
  try {
    const res = await fetch(`${s.base}/api/events?token=${s.w.token}`);
    const ended = (async () => { for await (const _ of res.body) { /* drain */ } return true; })();
    await s.api('POST', '/api/users/delete', { userId: s.wUser.id }, s.admin.token);
    const r = await Promise.race([ended, new Promise(r => setTimeout(() => r(false), 1000))]);
    assert.equal(r, true);
  } finally { await s.close(); }
});

test('a new message pushes to the receivers phones, not the sender', async () => {
  const s = await start();
  try {
    const key = await s.api('GET', '/api/push/key', undefined, s.w.token);
    assert.equal(Buffer.from(key.json.key, 'base64url').length, 65);
    assert.equal((await s.api('GET', '/api/push/key')).status, 401);
    assert.equal((await s.api('POST', '/api/push/subscribe', { endpoint: 'https://evil.example/x' }, s.w.token)).status, 400);
    await s.api('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/w' }, s.w.token);
    await s.api('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/admin' }, s.admin.token);
    const { convId } = (await s.api('POST', '/api/direct', { userId: s.wUser.id }, s.admin.token)).json;
    await s.api('POST', '/api/messages', { conv: convId, body: 'تعال' }, s.admin.token);
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(s.pushed, ['https://fcm.googleapis.com/fcm/send/w']);
    await s.api('POST', '/api/push/unsubscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/w' }, s.w.token);
    await s.api('POST', '/api/messages', { conv: convId, body: 'ثانية' }, s.admin.token);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(s.pushed.length, 1);
  } finally { await s.close(); }
});

test('pages carry security headers; the app manifest and worker are served', async () => {
  const s = await start();
  try {
    const page = await fetch(s.base + '/');
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    const man = await fetch(s.base + '/manifest.webmanifest');
    assert.equal(man.status, 200);
    assert.match(man.headers.get('content-type'), /manifest\+json/);
    const m = await man.json();
    assert.equal(m.display, 'standalone');
    assert.equal(m.dir, 'rtl');
    for (const icon of m.icons) assert.equal((await fetch(s.base + '/' + icon.src.replace(/^\//, ''))).status, 200, icon.src);
    const sw = await fetch(s.base + '/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('content-type'), /javascript/);
  } finally { await s.close(); }
});
