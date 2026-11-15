const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server/http');

const webDir = path.join(__dirname, '..', 'web');

async function start(dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-'))) {
  const server = createServer({ dataDir, webDir });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const close = () => new Promise(r => { server.closeAllConnections(); server.close(r); });
  return { server, base, api, close, dataDir };
}

// مشترك SSE بسيط: يجمع الأحداث ويتيح انتظار حدث معيّن
async function subscribe(base, token) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events?token=${token}`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  const events = [];
  const waiters = [];
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          if (ev && data) {
            events.push({ event: ev[1], data: JSON.parse(data[1]) });
            waiters.splice(0).forEach(w => w());
          }
        }
      }
    } catch {}
  })();
  const waitFor = async (name, ms = 1000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = events.find(e => e.event === name);
      if (hit) return hit.data;
      const left = end - Date.now();
      if (left <= 0) throw new Error(`no "${name}" event within ${ms}ms`);
      await Promise.race([new Promise(r => waiters.push(r)), new Promise(r => setTimeout(r, left))]);
    }
  };
  return { events, waitFor, close: () => ctrl.abort() };
}

async function seed(s) {
  const admin = (await s.api('POST', '/api/setup', { name: 'عمر', pin: 'omar1234' })).json;
  await s.api('POST', '/api/users', { name: 'حاسوب 1', pin: '1111', kind: 'computer' }, admin.token);
  const pc = (await s.api('POST', '/api/login', { name: 'حاسوب 1', pin: '1111' })).json;
  const conv = (await s.api('POST', '/api/direct', { userId: pc.user.id }, admin.token)).json.convId;
  return { admin, pc, conv };
}

test('setup, login, add user, send and fetch a message', async () => {
  const s = await start();
  try {
    assert.deepEqual((await s.api('GET', '/api/state')).json, { needsSetup: true, remote: false });
    const { admin, pc, conv } = await seed(s);
    assert.deepEqual((await s.api('GET', '/api/state')).json, { needsSetup: false, remote: false });
    assert.equal((await s.api('GET', '/api/users', undefined, pc.token)).json.length, 2);
    const sent = await s.api('POST', '/api/messages', { conv, body: 'اطبع 20 نسخة' }, admin.token);
    assert.equal(sent.status, 200);
    const got = (await s.api('GET', `/api/messages?conv=${conv}&after=0`, undefined, pc.token)).json;
    assert.deepEqual(got.messages.map(m => m.body), ['اطبع 20 نسخة']);
    assert.ok(Array.isArray(got.reads));
    const list = (await s.api('GET', '/api/conversations', undefined, pc.token)).json;
    assert.equal(list.find(c => c.id === conv).unread, 1);
  } finally { await s.close(); }
});

test('errors map to the right status codes', async () => {
  const s = await start();
  try {
    const { admin, pc, conv } = await seed(s);
    assert.equal((await s.api('GET', '/api/users')).status, 401);
    assert.equal((await s.api('GET', '/api/users', undefined, 'bogus')).status, 401);
    assert.equal((await s.api('POST', '/api/messages', '{broken', admin.token)).status, 400);
    assert.equal((await s.api('POST', '/api/messages', { conv, body: '   ' }, admin.token)).status, 400);
    assert.equal((await s.api('POST', '/api/messages', { conv: 999, body: 'x' }, admin.token)).status, 403);
    assert.equal((await s.api('POST', '/api/users', { name: 'x', pin: '111111', kind: 'person' }, pc.token)).status, 403);
    assert.equal((await s.api('POST', '/api/users', { name: 'عمر', pin: '111111', kind: 'person' }, admin.token)).status, 409);
    assert.equal((await s.api('POST', '/api/setup', { name: 'ثان', pin: 'omar1234' })).status, 409);
    const bad = await s.api('POST', '/api/login', { name: 'عمر', pin: '0000' });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error, 'bad_login');
    assert.equal((await s.api('GET', '/api/nothing', undefined, admin.token)).status, 404);
    assert.equal((await s.api('POST', '/api/messages', { conv, body: 'x'.repeat(70000) }, admin.token)).status, 413);
  } finally { await s.close(); }
});

test('repeated wrong pins answer 429 locked', async () => {
  const s = await start();
  try {
    await seed(s);
    for (let i = 0; i < 5; i++) await s.api('POST', '/api/login', { name: 'عمر', pin: '0000' });
    const r = await s.api('POST', '/api/login', { name: 'عمر', pin: 'omar1234' });
    assert.equal(r.status, 429);
    assert.equal(r.json.error, 'locked');
  } finally { await s.close(); }
});

test('the receiver gets the message live over SSE', async () => {
  const s = await start();
  try {
    const { admin, pc, conv } = await seed(s);
    const sub = await subscribe(s.base, pc.token);
    await s.api('POST', '/api/messages', { conv, body: 'تعال للمكتب' }, admin.token);
    const m = await sub.waitFor('message');
    assert.equal(m.body, 'تعال للمكتب');
    assert.equal(m.senderName, 'عمر');
    sub.close();
  } finally { await s.close(); }
});

test('same account on two devices: both get the message, reading on one clears the other', async () => {
  const s = await start();
  try {
    const { admin, pc, conv } = await seed(s);
    const d1 = await subscribe(s.base, pc.token);
    const pc2 = (await s.api('POST', '/api/login', { name: 'حاسوب 1', pin: '1111' })).json;
    const d2 = await subscribe(s.base, pc2.token);
    const sender = await subscribe(s.base, admin.token);
    const sent = (await s.api('POST', '/api/messages', { conv, body: 'مرحبا' }, admin.token)).json;
    assert.equal((await d1.waitFor('message')).id, sent.id);
    assert.equal((await d2.waitFor('message')).id, sent.id);
    await s.api('POST', '/api/read', { conv, upTo: sent.id }, pc.token);
    assert.deepEqual(await d2.waitFor('read'), { convId: conv, userId: pc.user.id, upToId: sent.id });
    assert.equal((await sender.waitFor('read')).userId, pc.user.id);
    d1.close(); d2.close(); sender.close();
  } finally { await s.close(); }
});

test('SSE without a valid token is refused', async () => {
  const s = await start();
  try {
    await seed(s);
    assert.equal((await fetch(`${s.base}/api/events?token=bogus`)).status, 401);
  } finally { await s.close(); }
});

test('after a restart only the missed messages are returned', async () => {
  let s = await start();
  const { admin, pc, conv } = await seed(s);
  const first = (await s.api('POST', '/api/messages', { conv, body: 'قبل' }, admin.token)).json;
  await s.close();
  s = await start(s.dataDir);
  try {
    await s.api('POST', '/api/messages', { conv, body: 'بعد' }, admin.token);
    const got = (await s.api('GET', `/api/messages?conv=${conv}&after=${first.id}`, undefined, pc.token)).json;
    assert.deepEqual(got.messages.map(m => m.body), ['بعد']);
  } finally { await s.close(); }
});

test('static files are served and path traversal is blocked', async () => {
  const s = await start();
  try {
    for (const p of ['/../server/db.js', '/..%2Fserver%2Fdb.js', '/%2e%2e/server/db.js']) {
      const res = await fetch(s.base + p);
      assert.equal(res.status, 404, p);
      assert.ok(!(await res.text()).includes('DatabaseSync'), p);
    }
  } finally { await s.close(); }
});
