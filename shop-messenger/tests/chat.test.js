const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createChat } = require('../server/chat');

function fresh() {
  const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'msg-')));
  const auth = createAuth(db);
  const chat = createChat(db, { now: () => 5000 });
  const a = auth.setup('عمر', 'omar1234');
  const b = auth.addUser(a, { name: 'حاسوب 1', pin: '1111', kind: 'computer' });
  const c = auth.addUser(a, { name: 'سمير', pin: '222222', kind: 'person' });
  return { chat, a, b, c };
}
const conv = (list, id) => list.find(x => x.id === id);

test('one direct conversation per pair, in either order', () => {
  const { chat, a, b, c } = fresh();
  const ab = chat.directWith(a, b.id);
  assert.equal(chat.directWith(b, a.id), ab);
  assert.notEqual(chat.directWith(a, c.id), ab);
  assert.throws(() => chat.directWith(a, a.id), /bad_user/);
  assert.throws(() => chat.directWith(a, 999), /bad_user/);
});

test('sending makes it unread for the receiver only', () => {
  const { chat, a, b } = fresh();
  const id = chat.directWith(a, b.id);
  const m = chat.send(a, id, 'اطبع 20 نسخة');
  assert.deepEqual(
    { convId: m.convId, senderId: m.senderId, senderName: m.senderName, kind: m.kind, body: m.body, createdAt: m.createdAt },
    { convId: id, senderId: a.id, senderName: 'عمر', kind: 'text', body: 'اطبع 20 نسخة', createdAt: 5000 }
  );
  const forB = conv(chat.listConversations(b), id);
  assert.equal(forB.unread, 1);
  assert.equal(forB.last.body, 'اطبع 20 نسخة');
  assert.equal(forB.title, 'عمر');
  const forA = conv(chat.listConversations(a), id);
  assert.equal(forA.unread, 0);
  assert.equal(forA.title, 'حاسوب 1');
  assert.equal(forA.otherId, b.id);
  assert.equal(forB.otherId, a.id);
  assert.equal(conv(chat.listConversations(a), 1).otherId, null);
});

test('markRead clears unread and is visible to the sender', () => {
  const { chat, a, b } = fresh();
  const id = chat.directWith(a, b.id);
  const m = chat.send(a, id, 'مرحبا');
  assert.deepEqual(chat.markRead(b, id, m.id), { convId: id, userId: b.id, upToId: m.id });
  assert.equal(conv(chat.listConversations(b), id).unread, 0);
  assert.ok(chat.readState(a, id).some(r => r.userId === b.id && r.lastReadId === m.id));
});

test('markRead never moves backwards or past the last message', () => {
  const { chat, a, b } = fresh();
  const id = chat.directWith(a, b.id);
  const m1 = chat.send(a, id, '1');
  const m2 = chat.send(a, id, '2');
  chat.markRead(b, id, m2.id);
  assert.equal(chat.markRead(b, id, m1.id).upToId, m2.id);
  assert.equal(chat.markRead(b, id, 999999).upToId, m2.id);
});

test('invalid messages are rejected and not stored', () => {
  const { chat, a, b, c } = fresh();
  const id = chat.directWith(a, b.id);
  assert.throws(() => chat.send(a, id, '   \n '), /empty/);
  assert.throws(() => chat.send(a, id, 'x'.repeat(4001)), /too_long/);
  assert.throws(() => chat.send(c, id, 'تطفل'), /not_member/);
  assert.throws(() => chat.messagesAfter(c, id), /not_member/);
  assert.equal(chat.messagesAfter(a, id).length, 0);
  assert.equal(chat.send(a, id, 'x'.repeat(4000)).body.length, 4000);
});

test('messagesAfter returns only newer messages in order', () => {
  const { chat, a, b } = fresh();
  const id = chat.directWith(a, b.id);
  const m1 = chat.send(a, id, '1');
  chat.send(b, id, '2');
  chat.send(a, id, '3');
  assert.deepEqual(chat.messagesAfter(b, id, m1.id).map(m => m.body), ['2', '3']);
  assert.deepEqual(chat.messagesAfter(b, id).map(m => m.body), ['1', '2', '3']);
});

test('a message in the shop group reaches everyone', () => {
  const { chat, a, b, c } = fresh();
  chat.send(a, 1, 'اجتماع بعد 5 دقائق');
  assert.equal(conv(chat.listConversations(b), 1).unread, 1);
  assert.equal(conv(chat.listConversations(c), 1).unread, 1);
  assert.equal(conv(chat.listConversations(b), 1).title, 'المحل');
  assert.deepEqual(chat.membersOf(1).sort(), [a.id, b.id, c.id]);
});

test('body is stored verbatim, html included', () => {
  const { chat, a, b } = fresh();
  const id = chat.directWith(a, b.id);
  assert.equal(chat.send(a, id, '<b>مهم</b>').body, '<b>مهم</b>');
});
