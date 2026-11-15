const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createChat } = require('../server/chat');

const DAY = 86_400_000;
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-'));
  const db = openDb(dir);
  const clock = { t: 1_000_000 };
  const auth = createAuth(db, { now: () => clock.t });
  const admin = auth.setup('عمر', 'omar1234');
  const pc = auth.addUser(admin, { name: 'حاسوب 1', pin: '1111', kind: 'computer' });
  const w = auth.addUser(admin, { name: 'سمير', pin: 'samir66', kind: 'person' });
  return { dir, db, auth, clock, admin, pc, w };
}

test('secret length policy: owner 8, person 6, computer 4', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-'));
  const auth = createAuth(openDb(dir));
  assert.throws(() => auth.setup('عمر', '1234567'), /bad_pin/);
  const admin = auth.setup('عمر', '12345678');
  assert.throws(() => auth.addUser(admin, { name: 'a', pin: '12345', kind: 'person' }), /bad_pin/);
  assert.throws(() => auth.addUser(admin, { name: 'b', pin: '123', kind: 'computer' }), /bad_pin/);
  assert.throws(() => auth.addUser(admin, { name: 'c', pin: 'x'.repeat(65), kind: 'person' }), /bad_pin/);
  auth.addUser(admin, { name: 'a', pin: 'كلمة سر', kind: 'person' });
  auth.addUser(admin, { name: 'b', pin: '1234', kind: 'computer' });
});

test('computer accounts cannot log in from the internet', () => {
  const { auth } = fresh();
  assert.throws(() => auth.login('حاسوب 1', '1111', { remote: true }), /lan_only/);
  assert.throws(() => auth.login('حاسوب 1', '0000', { remote: true }), /bad_login/);
  assert.equal(auth.login('حاسوب 1', '1111').user.name, 'حاسوب 1');
  assert.equal(auth.login('سمير', 'samir66', { remote: true }).user.name, 'سمير');
});

test('an old short secret is refused from the internet but works in the shop', () => {
  const { auth, db, admin } = fresh();
  // حساب أُنشئ بالقواعد القديمة (4 أرقام لشخص)
  const row = db.prepare('SELECT pin_hash, pin_salt FROM users WHERE name = ?').get('حاسوب 1');
  db.prepare('UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?').run(row.pin_hash, row.pin_salt, admin.id);
  assert.throws(() => auth.login('عمر', '1111', { remote: true }), /weak_secret/);
  assert.equal(auth.login('عمر', '1111').user.name, 'عمر');
});

test('internet lockouts do not lock logins inside the shop, and they escalate', () => {
  const { auth, clock } = fresh();
  for (let i = 0; i < 5; i++) assert.throws(() => auth.login('سمير', 'wrong!', { remote: true }), /bad_login/);
  assert.throws(() => auth.login('سمير', 'samir66', { remote: true }), /locked/);
  assert.equal(auth.login('سمير', 'samir66').user.name, 'سمير');
  clock.t += 60_001;
  for (let i = 0; i < 5; i++) assert.throws(() => auth.login('سمير', 'wrong!', { remote: true }), /bad_login/);
  clock.t += 60_001;                      // القفل الثاني أطول من دقيقة
  assert.throws(() => auth.login('سمير', 'samir66', { remote: true }), /locked/);
  clock.t += 60_001;
  assert.equal(auth.login('سمير', 'samir66', { remote: true }).user.name, 'سمير');
});

test('sessions expire after 30 idle days and logout ends one', () => {
  const { auth, clock } = fresh();
  const a = auth.login('سمير', 'samir66').token;
  const b = auth.login('سمير', 'samir66').token;
  clock.t += 29 * DAY;
  assert.ok(auth.userFromToken(a));          // الاستعمال يجدّد المهلة
  clock.t += 2 * DAY;
  assert.ok(auth.userFromToken(a));
  assert.equal(auth.userFromToken(b), null); // لم تُستعمل 31 يومًا
  auth.logout(a);
  assert.equal(auth.userFromToken(a), null);
});

test('owner changes any secret; it signs that account out everywhere', () => {
  const { auth, admin, w, pc } = fresh();
  const t = auth.login('سمير', 'samir66').token;
  assert.throws(() => auth.setPin(w, pc.id, '9999'), /forbidden/);
  assert.throws(() => auth.setPin(admin, w.id, '123'), /bad_pin/);
  assert.throws(() => auth.setPin(admin, 999, 'whatever1'), /bad_user/);
  auth.setPin(admin, w.id, 'newpass');
  assert.equal(auth.userFromToken(t), null);
  assert.throws(() => auth.login('سمير', 'samir66'), /bad_login/);
  assert.ok(auth.login('سمير', 'newpass').token);
});

test('anyone changes their own secret with the old one, keeping this device signed in', () => {
  const { auth, w } = fresh();
  const here = auth.login('سمير', 'samir66').token;
  const other = auth.login('سمير', 'samir66').token;
  assert.throws(() => auth.changeOwnPin(w, here, 'wrong', 'newpass'), /bad_old/);
  auth.changeOwnPin(w, here, 'samir66', 'newpass');
  assert.ok(auth.userFromToken(here));
  assert.equal(auth.userFromToken(other), null);
  assert.ok(auth.login('سمير', 'newpass').token);
});

test('owner removes an account: gone from lists, signed out, name reusable, messages kept', () => {
  const { auth, db, admin, w, pc } = fresh();
  const chat = createChat(db);
  const conv = chat.directWith(admin, w.id);
  chat.send(w, conv, 'رسالة قديمة');
  const t = auth.login('سمير', 'samir66').token;
  assert.throws(() => auth.removeUser(w, pc.id), /forbidden/);
  assert.throws(() => auth.removeUser(admin, admin.id), /bad_user/);
  auth.removeUser(admin, w.id);
  assert.equal(auth.userFromToken(t), null);
  assert.throws(() => auth.login('سمير', 'samir66'), /bad_login/);
  assert.deepEqual(auth.listUsers().map(u => u.name), ['عمر', 'حاسوب 1']);
  // لا تبقى محادثته ولا عدّادها عند الآخرين
  assert.equal(chat.listConversations(admin).some(c => c.id === conv), false);
  assert.deepEqual(chat.membersOf(1).sort(), [admin.id, pc.id]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  auth.addUser(admin, { name: 'سمير', pin: 'again66', kind: 'person' });
});

test('owner recovery from the shop computer resets the secret', () => {
  const { auth } = fresh();
  assert.deepEqual(auth.adminNames(), ['عمر']);
  assert.throws(() => auth.recoverAdmin('عمر', 'short'), /bad_pin/);
  assert.throws(() => auth.recoverAdmin('سمير', 'longenough'), /bad_user/);
  auth.recoverAdmin('عمر', 'brandnew1');
  assert.ok(auth.login('عمر', 'brandnew1', { remote: true }).token);
});

test('a database from stage 1 is upgraded in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-'));
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(path.join(dir, 'messenger.db'));
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0, pin_hash TEXT NOT NULL, pin_salt TEXT NOT NULL);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));
    INSERT INTO users (name, kind, is_admin, pin_hash, pin_salt) VALUES ('قديم', 'person', 1, 'aa', 'bb');
    INSERT INTO sessions VALUES ('tok', 1);`);
  old.close();
  const auth = createAuth(openDb(dir));
  assert.equal(auth.userFromToken('tok').name, 'قديم');
  assert.deepEqual(auth.listUsers().map(u => u.name), ['قديم']);
});
