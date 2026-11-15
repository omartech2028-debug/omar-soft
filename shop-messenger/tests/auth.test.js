const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-'));
  const db = openDb(dir);
  const clock = { t: 1_000_000 };
  const auth = createAuth(db, { now: () => clock.t });
  return { db, auth, clock };
}

test('setup creates the first admin once only', () => {
  const { auth } = fresh();
  assert.equal(auth.needsSetup(), true);
  const admin = auth.setup('عمر', 'omar1234');
  assert.equal(admin.isAdmin, true);
  assert.equal(auth.needsSetup(), false);
  assert.throws(() => auth.setup('آخر', 'omar1234'), /already_setup/);
});

test('login returns a token that resolves to the user', () => {
  const { auth } = fresh();
  auth.setup('عمر', 'omar1234');
  const { token, user } = auth.login('عمر', 'omar1234');
  assert.equal(user.name, 'عمر');
  assert.equal(auth.userFromToken(token).name, 'عمر');
  assert.equal(auth.userFromToken('nope'), null);
});

test('wrong pin is rejected', () => {
  const { auth } = fresh();
  auth.setup('عمر', 'omar1234');
  assert.throws(() => auth.login('عمر', '0000'), /bad_login/);
  assert.throws(() => auth.login('مجهول', 'omar1234'), /bad_login/);
});

test('five wrong pins lock the name for one minute', () => {
  const { auth, clock } = fresh();
  auth.setup('عمر', 'omar1234');
  for (let i = 0; i < 5; i++) assert.throws(() => auth.login('عمر', '0000'), /bad_login/);
  assert.throws(() => auth.login('عمر', 'omar1234'), /locked/);
  clock.t += 60_001;
  assert.equal(auth.login('عمر', 'omar1234').user.name, 'عمر');
});

test('only the admin adds accounts, with validation', () => {
  const { auth } = fresh();
  const admin = auth.setup('عمر', 'omar1234');
  const pc = auth.addUser(admin, { name: 'حاسوب 1', pin: '1111', kind: 'computer' });
  assert.equal(pc.kind, 'computer');
  assert.equal(pc.isAdmin, false);
  assert.throws(() => auth.addUser(pc, { name: 'x', pin: '111111', kind: 'person' }), /forbidden/);
  assert.throws(() => auth.addUser(admin, { name: 'حاسوب 1', pin: '1111', kind: 'computer' }), /name_taken/);
  assert.throws(() => auth.addUser(admin, { name: 'سمير', pin: '12345', kind: 'person' }), /bad_pin/);
  assert.throws(() => auth.addUser(admin, { name: '   ', pin: '111111', kind: 'person' }), /bad_name/);
  assert.throws(() => auth.addUser(admin, { name: 'سمير', pin: '1111', kind: 'robot' }), /bad_kind/);
});

test('every account joins the shop group (conversation 1)', () => {
  const { auth, db } = fresh();
  const admin = auth.setup('عمر', 'omar1234');
  const w = auth.addUser(admin, { name: 'سمير', pin: '111111', kind: 'person' });
  const ids = db.prepare('SELECT user_id FROM members WHERE conv_id = 1 ORDER BY user_id').all().map(r => r.user_id);
  assert.deepEqual(ids, [admin.id, w.id]);
  const g = db.prepare('SELECT kind, title FROM conversations WHERE id = 1').get();
  assert.equal(g.kind, 'group');
  assert.equal(g.title, 'المحل');
});

test('listUsers never exposes pin fields', () => {
  const { auth } = fresh();
  auth.setup('عمر', 'omar1234');
  const u = auth.listUsers()[0];
  assert.deepEqual(Object.keys(u).sort(), ['id', 'isAdmin', 'kind', 'name']);
});
