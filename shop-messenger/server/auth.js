// الحسابات وكلمات السر والجلسات
const crypto = require('node:crypto');
const { SHOP_GROUP_ID } = require('./db');

const MAX_FAILS = 5;
const LOCK_MS = 60_000;          // أول قفل دقيقة، ويتضاعف حتى ساعة
const MAX_LOCK_MS = 3_600_000;
const SESSION_IDLE_MS = 30 * 86_400_000;
const TOUCH_MS = 3_600_000;
const KINDS = ['person', 'computer'];
const MAX_SECRET = 64;

function toUser(row) {
  return { id: row.id, name: row.name, kind: row.kind, isAdmin: !!row.is_admin };
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

// صاحب المحل 8 أحرف، الأشخاص 6، الحواسيب 4 (الحواسيب لا تدخل من الإنترنت أصلًا)
function minSecret({ kind, isAdmin }) {
  return isAdmin ? 8 : kind === 'computer' ? 4 : 6;
}

function createAuth(db, { now = Date.now } = {}) {
  const fails = new Map(); // "zone:name" -> { count, until, locks }

  function checkSecret(pin, who) {
    pin = String(pin ?? '');
    if (pin.length < minSecret(who) || pin.length > MAX_SECRET) throw new Error('bad_pin');
    return pin;
  }

  function storeSecret(userId, pin) {
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?').run(hashPin(pin, salt), salt, userId);
  }

  function matches(row, pin) {
    const a = Buffer.from(hashPin(pin ?? '', row.pin_salt), 'hex');
    const b = Buffer.from(row.pin_hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function insertUser({ name, pin, kind, isAdmin }) {
    name = String(name ?? '').trim();
    if (!name || name.length > 40) throw new Error('bad_name');
    if (!KINDS.includes(kind)) throw new Error('bad_kind');
    pin = checkSecret(pin, { kind, isAdmin });
    if (db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) throw new Error('name_taken');
    const id = Number(db
      .prepare("INSERT INTO users (name, kind, is_admin, pin_hash, pin_salt) VALUES (?, ?, ?, '', '')")
      .run(name, kind, isAdmin ? 1 : 0).lastInsertRowid);
    storeSecret(id, pin);
    db.prepare('INSERT INTO members (conv_id, user_id) VALUES (?, ?)').run(SHOP_GROUP_ID, id);
    return { id, name, kind, isAdmin: !!isAdmin };
  }

  function needsSetup() {
    return !db.prepare('SELECT 1 FROM users LIMIT 1').get();
  }

  function setup(name, pin) {
    if (!needsSetup()) throw new Error('already_setup');
    return insertUser({ name, pin, kind: 'person', isAdmin: true });
  }

  function addUser(actor, { name, pin, kind } = {}) {
    if (!actor || !actor.isAdmin) throw new Error('forbidden');
    return insertUser({ name, pin, kind, isAdmin: false });
  }

  function login(name, pin, { remote = false } = {}) {
    name = String(name ?? '').trim();
    // قفل الإنترنت منفصل عن قفل المحل: من يخمّن من الخارج لا يقفل الدخول من داخل المحل
    const key = `${remote ? 'net' : 'lan'}:${name}`;
    const f = fails.get(key) || { count: 0, until: 0, locks: 0 };
    if (f.until > now()) throw new Error('locked');
    const row = db.prepare('SELECT * FROM users WHERE name = ? AND active = 1').get(name);
    if (!row || !matches(row, pin)) {
      f.count += 1;
      if (f.count >= MAX_FAILS) {
        f.until = now() + Math.min(LOCK_MS * 2 ** f.locks, MAX_LOCK_MS);
        f.locks += 1;
        f.count = 0;
      }
      if (fails.size > 5000) fails.clear();   // حدّ للذاكرة أمام سيل من الأسماء العشوائية
      fails.set(key, f);
      throw new Error('bad_login');
    }
    const user = toUser(row);
    if (remote) {
      if (user.kind === 'computer') throw new Error('lan_only');
      if (String(pin).length < minSecret(user)) throw new Error('weak_secret');
    }
    fails.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, last_used) VALUES (?, ?, ?)').run(token, row.id, now());
    return { token, user };
  }

  function userFromToken(token) {
    if (!token) return null;
    token = String(token);
    const row = db.prepare(`
      SELECT u.*, s.last_used FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND u.active = 1`).get(token);
    if (!row) return null;
    const t = now();
    // last_used = 0 جلسة من المرحلة 1: نبدأ عدّ مهلتها من الآن
    if (row.last_used && t - row.last_used > SESSION_IDLE_MS) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    if (t - row.last_used > TOUCH_MS) db.prepare('UPDATE sessions SET last_used = ? WHERE token = ?').run(t, token);
    return toUser(row);
  }

  function logout(token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token ?? ''));
  }

  function activeRow(userId) {
    const row = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(Number(userId) || 0);
    if (!row) throw new Error('bad_user');
    return row;
  }

  // صاحب المحل يغيّر كلمة سر أي حساب؛ الحساب يخرج من كل أجهزته
  function setPin(actor, userId, pin) {
    if (!actor || !actor.isAdmin) throw new Error('forbidden');
    const row = activeRow(userId);
    storeSecret(row.id, checkSecret(pin, toUser(row)));
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    return toUser(row);
  }

  // كل واحد يغيّر كلمة سره بنفسه؛ يبقى داخلًا على هذا الجهاز فقط
  function changeOwnPin(user, currentToken, oldPin, newPin) {
    const row = activeRow(user.id);
    if (!matches(row, oldPin)) throw new Error('bad_old');
    storeSecret(row.id, checkSecret(newPin, toUser(row)));
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(row.id, String(currentToken ?? ''));
  }

  // الحذف يُبقي الرسائل القديمة ويحرّر الاسم
  function removeUser(actor, userId) {
    if (!actor || !actor.isAdmin) throw new Error('forbidden');
    const row = activeRow(userId);
    if (row.id === actor.id) throw new Error('bad_user');
    db.prepare('UPDATE users SET active = 0, name = ? WHERE id = ?').run(`${row.name} (محذوف ${row.id})`, row.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    db.prepare('DELETE FROM push_subs WHERE user_id = ?').run(row.id);
    db.prepare('DELETE FROM members WHERE user_id = ? AND conv_id = ?').run(row.id, SHOP_GROUP_ID);
    return toUser(row);
  }

  // للاستعادة من الحاسوب الرئيسي فقط (server/reset-owner.js)
  function adminNames() {
    return db.prepare('SELECT name FROM users WHERE is_admin = 1 AND active = 1 ORDER BY id').all().map(r => r.name);
  }
  function recoverAdmin(name, pin) {
    const row = db.prepare('SELECT * FROM users WHERE name = ? AND is_admin = 1 AND active = 1').get(String(name ?? '').trim());
    if (!row) throw new Error('bad_user');
    storeSecret(row.id, checkSecret(pin, toUser(row)));
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
  }

  // ---------- انضمام حاسوب جديد باسمه فقط، بموافقة صاحب المحل ----------
  const JOIN_PENDING_MS = 24 * 3_600_000;   // الطلب المعلّق يسقط بعد يوم
  const JOIN_COLLECT_MS = 10 * 60_000;      // الجلسة الموافَق عليها تُستلم خلال 10 دقائق
  const JOIN_MAX_PENDING = 10;

  function sweepJoins() {
    const t = now();
    db.prepare("DELETE FROM join_requests WHERE (status = 'pending' AND created_at < ?) OR (status != 'pending' AND decided_at < ?)")
      .run(t - JOIN_PENDING_MS, t - JOIN_COLLECT_MS);
  }

  function requestJoin(name) {
    name = String(name ?? '').trim();
    if (!name || name.length > 40) throw new Error('bad_name');
    if (needsSetup()) throw new Error('not_ready');
    sweepJoins();
    const existing = db.prepare('SELECT kind, is_admin FROM users WHERE name = ? AND active = 1').get(name);
    if (existing && (existing.kind !== 'computer' || existing.is_admin)) throw new Error('name_taken');
    db.prepare("DELETE FROM join_requests WHERE name = ? AND status = 'pending'").run(name);
    if (db.prepare("SELECT COUNT(*) AS n FROM join_requests WHERE status = 'pending'").get().n >= JOIN_MAX_PENDING) throw new Error('too_many');
    const pollToken = crypto.randomBytes(24).toString('hex');
    const id = Number(db.prepare('INSERT INTO join_requests (name, poll_token, created_at) VALUES (?, ?, ?)').run(name, pollToken, now()).lastInsertRowid);
    return { id, pollToken };
  }

  function joinStatus(pollToken) {
    sweepJoins();
    const r = db.prepare('SELECT * FROM join_requests WHERE poll_token = ?').get(String(pollToken ?? ''));
    if (!r) return { status: 'unknown' };
    if (r.status !== 'approved') return { status: r.status };
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(r.user_id);
    return u ? { status: 'approved', token: r.session_token, user: toUser(u) } : { status: 'unknown' };
  }

  function listJoinRequests(actor) {
    if (!actor || !actor.isAdmin) throw new Error('forbidden');
    sweepJoins();
    return db.prepare("SELECT id, name, created_at FROM join_requests WHERE status = 'pending' ORDER BY id").all()
      .map(r => ({ id: r.id, name: r.name, createdAt: r.created_at }));
  }

  function decideJoin(actor, id, approve) {
    if (!actor || !actor.isAdmin) throw new Error('forbidden');
    sweepJoins();
    const r = db.prepare("SELECT * FROM join_requests WHERE id = ? AND status = 'pending'").get(Number(id) || 0);
    if (!r) throw new Error('bad_request');
    if (!approve) {
      db.prepare("UPDATE join_requests SET status = 'rejected', decided_at = ? WHERE id = ?").run(now(), r.id);
      return { name: r.name, approved: false };
    }
    // حاسوب أُعيد تنصيبه يعود إلى حسابه نفسه؛ وإلا يُنشأ له حساب حاسوب بكلمة سر عشوائية لا يحتاجها أحد
    let row = db.prepare("SELECT * FROM users WHERE name = ? AND active = 1").get(r.name);
    if (row && (row.kind !== 'computer' || row.is_admin)) throw new Error('name_taken');
    const userId = row ? row.id : insertUser({ name: r.name, pin: crypto.randomBytes(24).toString('hex'), kind: 'computer', isAdmin: false }).id;
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, last_used) VALUES (?, ?, ?)').run(token, userId, now());
    db.prepare("UPDATE join_requests SET status = 'approved', decided_at = ?, session_token = ?, user_id = ? WHERE id = ?").run(now(), token, userId, r.id);
    return { name: r.name, approved: true, userId };
  }

  function adminIds() {
    return db.prepare('SELECT id FROM users WHERE is_admin = 1 AND active = 1').all().map(r => r.id);
  }

  function listUsers() {
    return db.prepare('SELECT id, name, kind, is_admin FROM users WHERE active = 1 ORDER BY id').all().map(toUser);
  }

  return {
    needsSetup, setup, addUser, login, userFromToken, logout, listUsers,
    setPin, changeOwnPin, removeUser, adminNames, recoverAdmin,
    requestJoin, joinStatus, listJoinRequests, decideJoin, adminIds,
  };
}

module.exports = { createAuth, minSecret };
