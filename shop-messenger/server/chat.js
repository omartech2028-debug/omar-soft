// المحادثات والرسائل وحالة القراءة
const MAX_LEN = 4000;

function createChat(db, { now = Date.now } = {}) {
  const toMessage = r => ({
    id: r.id, convId: r.conv_id, senderId: r.sender_id, senderName: r.sender_name,
    kind: r.kind, body: r.body, createdAt: r.created_at,
  });
  const MSG_SELECT = `SELECT m.*, u.name AS sender_name FROM messages m JOIN users u ON u.id = m.sender_id`;

  function requireMember(user, convId) {
    const row = db.prepare('SELECT last_read_id FROM members WHERE conv_id = ? AND user_id = ?').get(convId, user.id);
    if (!row) throw new Error('not_member');
    return row;
  }

  function directWith(user, otherId) {
    otherId = Number(otherId);
    if (!Number.isInteger(otherId) || otherId === user.id) throw new Error('bad_user');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(otherId)) throw new Error('bad_user');
    const found = db.prepare(`
      SELECT c.id FROM conversations c
      JOIN members a ON a.conv_id = c.id AND a.user_id = ?
      JOIN members b ON b.conv_id = c.id AND b.user_id = ?
      WHERE c.kind = 'direct'`).get(user.id, otherId);
    if (found) return found.id;
    const id = Number(db.prepare("INSERT INTO conversations (kind) VALUES ('direct')").run().lastInsertRowid);
    const add = db.prepare('INSERT INTO members (conv_id, user_id) VALUES (?, ?)');
    add.run(id, user.id);
    add.run(id, otherId);
    return id;
  }

  function listConversations(user) {
    const rows = db.prepare(`
      SELECT c.id, c.kind, c.title, me.last_read_id,
        (SELECT u.name FROM members o JOIN users u ON u.id = o.user_id
          WHERE o.conv_id = c.id AND o.user_id != ? LIMIT 1) AS other_name,
        (SELECT o.user_id FROM members o
          WHERE o.conv_id = c.id AND o.user_id != ? LIMIT 1) AS other_id,
        (SELECT COUNT(*) FROM messages m
          WHERE m.conv_id = c.id AND m.id > me.last_read_id AND m.sender_id != ?) AS unread,
        (SELECT MAX(id) FROM messages m WHERE m.conv_id = c.id) AS last_id
      FROM conversations c JOIN members me ON me.conv_id = c.id AND me.user_id = ?
      WHERE c.kind != 'direct' OR EXISTS (
        SELECT 1 FROM members o JOIN users u ON u.id = o.user_id
        WHERE o.conv_id = c.id AND o.user_id != me.user_id AND u.active = 1)
      ORDER BY c.id`).all(user.id, user.id, user.id, user.id);
    const one = db.prepare(`${MSG_SELECT} WHERE m.id = ?`);
    return rows.map(r => ({
      id: r.id,
      kind: r.kind,
      title: r.kind === 'direct' ? r.other_name : r.title,
      otherId: r.kind === 'direct' ? r.other_id : null,
      unread: r.unread,
      last: r.last_id ? toMessage(one.get(r.last_id)) : null,
    }));
  }

  function send(user, convId, body) {
    convId = Number(convId);
    requireMember(user, convId);
    if (typeof body !== 'string' || !body.trim()) throw new Error('empty');
    if (body.length > MAX_LEN) throw new Error('too_long');
    const createdAt = now();
    const id = Number(db
      .prepare("INSERT INTO messages (conv_id, sender_id, kind, body, created_at) VALUES (?, ?, 'text', ?, ?)")
      .run(convId, user.id, body, createdAt).lastInsertRowid);
    db.prepare('UPDATE members SET last_read_id = ? WHERE conv_id = ? AND user_id = ?').run(id, convId, user.id);
    return { id, convId, senderId: user.id, senderName: user.name, kind: 'text', body, createdAt };
  }

  function messagesAfter(user, convId, afterId = 0) {
    convId = Number(convId);
    requireMember(user, convId);
    return db.prepare(`${MSG_SELECT} WHERE m.conv_id = ? AND m.id > ? ORDER BY m.id`)
      .all(convId, Number(afterId) || 0).map(toMessage);
  }

  function markRead(user, convId, upToId) {
    convId = Number(convId);
    const me = requireMember(user, convId);
    const max = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE conv_id = ?').get(convId).m;
    const next = Math.max(me.last_read_id, Math.min(Number(upToId) || 0, max));
    db.prepare('UPDATE members SET last_read_id = ? WHERE conv_id = ? AND user_id = ?').run(next, convId, user.id);
    return { convId, userId: user.id, upToId: next };
  }

  function readState(user, convId) {
    convId = Number(convId);
    requireMember(user, convId);
    return db.prepare('SELECT user_id, last_read_id FROM members WHERE conv_id = ?').all(convId)
      .map(r => ({ userId: r.user_id, lastReadId: r.last_read_id }));
  }

  function membersOf(convId) {
    return db.prepare('SELECT user_id FROM members WHERE conv_id = ?').all(Number(convId)).map(r => r.user_id);
  }

  return { directWith, listConversations, send, messagesAfter, markRead, readState, membersOf };
}

module.exports = { createChat };
