const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createServer } = require('../server/http');

function fresh() {
  const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'msg-')));
  const clock = { t: 1_000_000 };
  const auth = createAuth(db, { now: () => clock.t });
  const admin = auth.setup('عمر', 'omar1234');
  const w = auth.addUser(admin, { name: 'سمير', pin: 'samir66', kind: 'person' });
  return { db, auth, clock, admin, w };
}

test('a new computer asks to join with just its name and waits for the owner', () => {
  const { auth, admin, w } = fresh();
  const r = auth.requestJoin('حاسوب الطباعة');
  assert.match(r.pollToken, /^[0-9a-f]{48}$/);
  assert.deepEqual(auth.joinStatus(r.pollToken), { status: 'pending' });
  assert.throws(() => auth.listJoinRequests(w), /forbidden/);
  assert.deepEqual(auth.listJoinRequests(admin).map(x => x.name), ['حاسوب الطباعة']);
  assert.deepEqual(auth.joinStatus('nope'), { status: 'unknown' });
});

test('approval creates a computer account and hands the waiting computer its session', () => {
  const { auth, admin, w } = fresh();
  const r = auth.requestJoin('حاسوب الطباعة');
  const id = auth.listJoinRequests(admin)[0].id;
  assert.throws(() => auth.decideJoin(w, id, true), /forbidden/);
  auth.decideJoin(admin, id, true);
  const s = auth.joinStatus(r.pollToken);
  assert.equal(s.status, 'approved');
  assert.deepEqual({ name: s.user.name, kind: s.user.kind, isAdmin: s.user.isAdmin }, { name: 'حاسوب الطباعة', kind: 'computer', isAdmin: false });
  assert.equal(auth.userFromToken(s.token).name, 'حاسوب الطباعة');
  assert.deepEqual(auth.listJoinRequests(admin), []);
  assert.ok(auth.listUsers().some(u => u.name === 'حاسوب الطباعة'));
});

test('rejection gives nothing and creates no account', () => {
  const { auth, admin } = fresh();
  const r = auth.requestJoin('غريب');
  auth.decideJoin(admin, auth.listJoinRequests(admin)[0].id, false);
  assert.deepEqual(auth.joinStatus(r.pollToken), { status: 'rejected' });
  assert.equal(auth.listUsers().some(u => u.name === 'غريب'), false);
});

test('a reinstalled computer rejoins its own account; a person name cannot be taken over', () => {
  const { auth, admin } = fresh();
  const first = auth.requestJoin('حاسوب 1');
  auth.decideJoin(admin, auth.listJoinRequests(admin)[0].id, true);
  const id1 = auth.joinStatus(first.pollToken).user.id;
  const again = auth.requestJoin('حاسوب 1');
  auth.decideJoin(admin, auth.listJoinRequests(admin)[0].id, true);
  assert.equal(auth.joinStatus(again.pollToken).user.id, id1);
  assert.throws(() => auth.requestJoin('سمير'), /name_taken/);
  assert.throws(() => auth.requestJoin('عمر'), /name_taken/);
  assert.throws(() => auth.requestJoin('   '), /bad_name/);
});

test('join requests are bounded, replaced per name, and expire', () => {
  const { auth, admin, clock } = fresh();
  const a = auth.requestJoin('حاسوب 1');
  const b = auth.requestJoin('حاسوب 1');             // نفس الاسم: يحلّ محل الطلب السابق
  assert.equal(auth.listJoinRequests(admin).length, 1);
  assert.deepEqual(auth.joinStatus(a.pollToken), { status: 'unknown' });
  assert.deepEqual(auth.joinStatus(b.pollToken), { status: 'pending' });
  for (let i = 2; i <= 10; i++) auth.requestJoin(`حاسوب ${i}`);
  assert.throws(() => auth.requestJoin('حاسوب 11'), /too_many/);
  clock.t += 24 * 3600_000 + 1;
  assert.deepEqual(auth.listJoinRequests(admin), []);
  assert.deepEqual(auth.joinStatus(b.pollToken), { status: 'unknown' });
  auth.requestJoin('حاسوب 11');
});

test('an approved session can be collected for ten minutes only', () => {
  const { auth, admin, clock } = fresh();
  const r = auth.requestJoin('حاسوب 1');
  auth.decideJoin(admin, auth.listJoinRequests(admin)[0].id, true);
  clock.t += 10 * 60_000 + 1;
  assert.deepEqual(auth.joinStatus(r.pollToken), { status: 'unknown' });
});

// ---------- عبر HTTP ----------
async function start() {
  const server = createServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'msg-')), webDir: path.join(__dirname, '..', 'web'), pushFetch: async () => ({ status: 201 }) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, url, body, token, extra = {}) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const close = () => new Promise(r => { server.closeAllConnections(); server.close(r); });
  const admin = (await api('POST', '/api/setup', { name: 'عمر', pin: 'omar1234' })).json;
  return { base, api, close, admin };
}

test('join over the API: request, owner is told live, approve, computer signs in', async () => {
  const s = await start();
  try {
    const res = await fetch(`${s.base}/api/events?token=${s.admin.token}`);
    let seen = '';
    (async () => { const d = new TextDecoder(); try { for await (const c of res.body) seen += d.decode(c); } catch {} })();
    const req = await s.api('POST', '/api/join', { name: 'حاسوب الطباعة' });
    assert.equal(req.status, 200);
    await new Promise(r => setTimeout(r, 100));
    assert.match(seen, /event: join/);
    assert.equal((await s.api('GET', `/api/join/status?token=${req.json.pollToken}`)).json.status, 'pending');
    const list = await s.api('GET', '/api/join/requests', undefined, s.admin.token);
    assert.equal(list.json[0].name, 'حاسوب الطباعة');
    assert.equal((await s.api('GET', '/api/join/requests')).status, 401);
    assert.equal((await s.api('POST', '/api/join/decide', { id: list.json[0].id, approve: true }, s.admin.token)).status, 200);
    const done = (await s.api('GET', `/api/join/status?token=${req.json.pollToken}`)).json;
    assert.equal(done.status, 'approved');
    assert.equal((await s.api('GET', '/api/me', undefined, done.token)).json.name, 'حاسوب الطباعة');
  } finally { await s.close(); }
});

test('joining is refused from the internet and before the owner exists', async () => {
  const s = await start();
  try {
    const r = await s.api('POST', '/api/join', { name: 'متطفل' }, null, { 'x-forwarded-for': '203.0.113.9' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'lan_only');
    assert.equal((await s.api('POST', '/api/join', { name: 'عمر' })).status, 409);
  } finally { await s.close(); }
  const empty = createServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'msg-')), webDir: path.join(__dirname, '..', 'web') });
  await new Promise(r => empty.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${empty.address().port}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'حاسوب 1' }) });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'not_ready');
  } finally { empty.closeAllConnections(); await new Promise(r => empty.close(r)); }
});
