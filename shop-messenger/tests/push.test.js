const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createPush } = require('../server/push');

const b64u = s => Buffer.from(s, 'base64url');
function fresh(respond = () => ({ status: 201 })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-'));
  const db = openDb(dir);
  const auth = createAuth(db);
  const admin = auth.setup('عمر', 'omar1234');
  const w = auth.addUser(admin, { name: 'سمير', pin: 'samir66', kind: 'person' });
  const calls = [];
  const push = createPush(db, {
    now: () => 1_700_000_000_000,
    fetch: async (url, init) => { calls.push({ url, init }); return respond(url); },
  });
  return { dir, db, push, calls, admin, w };
}
const EP = 'https://fcm.googleapis.com/fcm/send/abc123';

test('the public key is a stable uncompressed P-256 point', () => {
  const a = fresh();
  const key = b64u(a.push.publicKey());
  assert.equal(key.length, 65);
  assert.equal(key[0], 4);
  assert.equal(createPush(openDb(a.dir), {}).publicKey(), a.push.publicKey());
});

test('only https endpoints of known push services are accepted', () => {
  const { push, w } = fresh();
  push.subscribe(w.id, EP);
  push.subscribe(w.id, 'https://web.push.apple.com/QOxyz');
  push.subscribe(w.id, 'https://updates.push.services.mozilla.com/wpush/v2/x');
  for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://192.168.1.1/x',
    'https://fcm.googleapis.com.evil.example/x', 'not a url', '', null, 'https://localhost/x']) {
    assert.throws(() => push.subscribe(w.id, bad), /bad_endpoint/, String(bad));
  }
});

test('notify sends an empty, VAPID-signed push to each device of the user', async () => {
  const { push, calls, w, admin } = fresh();
  push.subscribe(w.id, EP);
  push.subscribe(admin.id, 'https://web.push.apple.com/other');
  await push.notify([w.id]);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, EP);
  assert.equal(init.method, 'POST');
  assert.equal(init.body, undefined);
  assert.equal(init.headers.TTL, '300');
  assert.equal(init.headers.Urgency, 'high');
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(init.headers.Authorization);
  assert.ok(m);
  assert.equal(m[2], push.publicKey());
  const [h, c, sig] = m[1].split('.');
  assert.deepEqual(JSON.parse(b64u(h)), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(b64u(c));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.exp, 1_700_000_000 + 12 * 3600);
  assert.match(claims.sub, /^(mailto:|https:)/);
  // التوقيع يتحقق بالمفتاح العام المعلن
  const pub = b64u(m[2]);
  const key = crypto.createPublicKey({ format: 'jwk', key: {
    kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, b64u(sig)), true);
});

test('a subscription the push service reports gone is forgotten', async () => {
  const { push, calls, db, w } = fresh(() => ({ status: 410 }));
  push.subscribe(w.id, EP);
  await push.notify([w.id]);
  await push.notify([w.id]);
  assert.equal(calls.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 0);
});

test('a failing push service never throws and keeps the subscription', async () => {
  const { push, db, w } = fresh(() => { throw new Error('offline'); });
  push.subscribe(w.id, EP);
  await push.notify([w.id]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 1);
});

test('a device re-subscribing under another account moves, and unsubscribe removes it', async () => {
  const { push, calls, w, admin } = fresh();
  push.subscribe(w.id, EP);
  push.subscribe(admin.id, EP);
  await push.notify([w.id]);
  assert.equal(calls.length, 0);
  push.unsubscribe(admin.id, EP);
  await push.notify([admin.id]);
  assert.equal(calls.length, 0);
});
