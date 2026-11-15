// ربط الحسابات والمحادثات بواجهة HTTP وتقديم ملفات الواجهة
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { createAuth } = require('./auth');
const { createChat } = require('./chat');
const { createHub } = require('./events');
const { createPush } = require('./push');

const MAX_BODY = 64 * 1024;
const STATUS = {
  bad_login: 401, unauthorized: 401,
  forbidden: 403, not_member: 403, lan_only: 403, weak_secret: 403,
  not_found: 404,
  name_taken: 409, already_setup: 409, not_ready: 409,
  too_many: 429,
  too_large: 413,
  locked: 429,
};
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function fail(code) { return new Error(code); }

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) over = true; else chunks.push(c);
    });
    req.on('end', () => {
      if (over) return reject(fail('too_large'));
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!v || typeof v !== 'object') throw new Error();
        resolve(v);
      } catch { reject(fail('bad_json')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function serveStatic(webDir, pathname, res) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = null; }
  const root = path.resolve(webDir);
  const file = rel === null ? null : path.resolve(root, '.' + (rel === '/' ? '/index.html' : rel));
  if (!file || (file !== root && !file.startsWith(root + path.sep)) || rel.includes('\0')) {
    return send(res, 404, { error: 'not_found' });
  }
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not_found' });
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    res.end(buf);
  });
}

// الطلبات القادمة عبر بوابة الإنترنت (Tailscale Funnel أو غيرها) تحمل هذه الترويسات؛
// طلبات شبكة المحل تصل مباشرة بدونها.
function isRemote(req) {
  const h = req.headers;
  return !!(h['x-forwarded-for'] || h['x-forwarded-proto'] || h['x-forwarded-host'] || h['forwarded']);
}

function createServer({ dataDir, webDir, pushFetch }) {
  const db = openDb(dataDir);
  const auth = createAuth(db);
  const chat = createChat(db);
  const hub = createHub();
  const push = createPush(db, pushFetch ? { fetch: pushFetch } : {});

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
    const me = () => {
      const user = auth.userFromToken(token);
      if (!user) throw fail('unauthorized');
      return user;
    };

    switch (route) {
      case 'GET /api/state':
        return send(res, 200, { needsSetup: auth.needsSetup(), remote: isRemote(req) });
      case 'POST /api/setup': {
        // حساب صاحب المحل يُنشأ من داخل المحل فقط
        if (isRemote(req)) throw fail('lan_only');
        const { name, pin } = await readJson(req);
        auth.setup(name, pin);
        return send(res, 200, auth.login(name, pin));
      }
      case 'POST /api/login': {
        const { name, pin } = await readJson(req);
        return send(res, 200, auth.login(name, pin, { remote: isRemote(req) }));
      }
      case 'POST /api/logout': {
        const user = auth.userFromToken(token);
        const { endpoint } = await readJson(req).catch(() => ({}));
        if (user && endpoint) push.unsubscribe(user.id, endpoint);
        auth.logout(token);
        return send(res, 200, {});
      }
      case 'POST /api/me/pin': {
        const user = me();
        const { old, pin } = await readJson(req);
        auth.changeOwnPin(user, token, old, pin);
        return send(res, 200, {});
      }
      case 'POST /api/users/pin': {
        const user = me();
        const { userId, pin } = await readJson(req);
        const target = auth.setPin(user, userId, pin);
        hub.kick(target.id);
        return send(res, 200, {});
      }
      case 'POST /api/users/delete': {
        const user = me();
        const { userId } = await readJson(req);
        const target = auth.removeUser(user, userId);
        hub.kick(target.id);
        hub.publish(auth.listUsers().map(u => u.id), 'users', {});
        return send(res, 200, {});
      }
      case 'POST /api/join': {
        // حاسوب جديد يطلب الانضمام باسمه؛ من داخل المحل فقط
        if (isRemote(req)) throw fail('lan_only');
        const { name } = await readJson(req);
        const r = auth.requestJoin(name);
        hub.publish(auth.adminIds(), 'join', {});
        push.notify(auth.adminIds()).catch(() => {});
        return send(res, 200, { pollToken: r.pollToken });
      }
      case 'GET /api/join/status':
        return send(res, 200, auth.joinStatus(url.searchParams.get('token')));
      case 'GET /api/join/requests':
        return send(res, 200, auth.listJoinRequests(me()));
      case 'POST /api/join/decide': {
        const user = me();
        const { id, approve } = await readJson(req);
        const r = auth.decideJoin(user, id, !!approve);
        hub.publish(auth.adminIds(), 'join', {});
        if (r.approved) hub.publish(auth.listUsers().map(u => u.id), 'users', {});
        return send(res, 200, {});
      }
      case 'GET /api/push/key':
        me();
        return send(res, 200, { key: push.publicKey() });
      case 'POST /api/push/subscribe': {
        const user = me();
        push.subscribe(user.id, (await readJson(req)).endpoint);
        return send(res, 200, {});
      }
      case 'POST /api/push/unsubscribe': {
        const user = me();
        push.unsubscribe(user.id, (await readJson(req)).endpoint);
        return send(res, 200, {});
      }
      case 'GET /api/me':
        return send(res, 200, me());
      case 'GET /api/users':
        me();
        return send(res, 200, auth.listUsers());
      case 'POST /api/users': {
        const user = me();
        const created = auth.addUser(user, await readJson(req));
        hub.publish(auth.listUsers().map(u => u.id), 'users', {});
        return send(res, 200, created);
      }
      case 'GET /api/conversations':
        return send(res, 200, chat.listConversations(me()));
      case 'POST /api/direct': {
        const user = me();
        const { userId } = await readJson(req);
        return send(res, 200, { convId: chat.directWith(user, userId) });
      }
      case 'GET /api/messages': {
        const user = me();
        const conv = url.searchParams.get('conv');
        return send(res, 200, {
          messages: chat.messagesAfter(user, conv, url.searchParams.get('after')),
          reads: chat.readState(user, conv),
        });
      }
      case 'POST /api/messages': {
        const user = me();
        const { conv, body } = await readJson(req);
        const msg = chat.send(user, conv, body);
        const members = chat.membersOf(msg.convId);
        hub.publish(members, 'message', msg);
        push.notify(members.filter(id => id !== user.id)).catch(() => {});
        return send(res, 200, msg);
      }
      case 'POST /api/read': {
        const user = me();
        const { conv, upTo } = await readJson(req);
        const r = chat.markRead(user, conv, upTo);
        hub.publish(chat.membersOf(r.convId), 'read', r);
        return send(res, 200, r);
      }
      case 'GET /api/events':
        return hub.subscribe(me().id, res);
      default:
        throw fail('not_found');
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 404, { error: 'not_found' });
      return serveStatic(webDir, url.pathname, res);
    }
    api(req, res, url).catch(err => {
      if (res.headersSent) return res.end();
      const code = err && err.message;
      const known = STATUS[code] || (/^[a-z_]+$/.test(code || '') ? 400 : 0);
      if (!known) console.error(err);
      send(res, known || 500, { error: known ? code : 'server_error' });
    });
  });
  server.on('close', () => db.close());
  return server;
}

module.exports = { createServer };
