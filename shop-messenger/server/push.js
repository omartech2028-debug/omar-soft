// إشعارات الهاتف (Web Push) بدون أي مكتبة.
// نرسل إشعارًا فارغًا موقّعًا (VAPID) فقط؛ الهاتف هو الذي يجلب نص الرسالة بعد ذلك.
const crypto = require('node:crypto');

const ALLOWED_HOSTS = [
  'fcm.googleapis.com',                 // Chrome / Android / Edge
  'updates.push.services.mozilla.com',  // Firefox
  'web.push.apple.com',                 // iPhone / Safari
  'notify.windows.com',                 // Edge على ويندوز
];
const JWT_TTL_S = 12 * 3600;

function checkEndpoint(endpoint) {
  let u;
  try { u = new URL(String(endpoint ?? '')); } catch { throw new Error('bad_endpoint'); }
  const ok = u.protocol === 'https:' && !u.username && !u.password &&
    ALLOWED_HOSTS.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`));
  if (!ok || u.href.length > 1000) throw new Error('bad_endpoint');
  return u;
}

function createPush(db, { fetch = globalThis.fetch, now = Date.now, subject = process.env.VAPID_SUBJECT || 'mailto:owner@shop-messenger.invalid' } = {}) {
  const meta = k => (db.prepare('SELECT value FROM meta WHERE key = ?').get(k) || {}).value;

  let privateKey, publicB64;
  {
    let jwk = meta('vapid_jwk');
    if (!jwk) {
      const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      jwk = JSON.stringify(pair.privateKey.export({ format: 'jwk' }));
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('vapid_jwk', jwk);
    }
    const j = JSON.parse(jwk);
    privateKey = crypto.createPrivateKey({ format: 'jwk', key: j });
    publicB64 = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url');
  }

  const publicKey = () => publicB64;

  function subscribe(userId, endpoint) {
    const href = checkEndpoint(endpoint).href;
    db.prepare(`INSERT INTO push_subs (endpoint, user_id) VALUES (?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id`).run(href, userId);
  }

  function unsubscribe(userId, endpoint) {
    db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(String(endpoint ?? ''), userId);
  }

  function authHeader(origin) {
    const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: origin, exp: Math.floor(now() / 1000) + JWT_TTL_S, sub: subject })}`;
    const sig = crypto.sign('sha256', Buffer.from(head), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `vapid t=${head}.${sig}, k=${publicB64}`;
  }

  async function notify(userIds) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    const rows = db.prepare(`SELECT endpoint FROM push_subs WHERE user_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    await Promise.all(rows.map(async ({ endpoint }) => {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { TTL: '300', Urgency: 'high', 'Content-Length': '0', Authorization: authHeader(new URL(endpoint).origin) },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 404 || res.status === 410) db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
      } catch { /* بلا إنترنت: الرسالة محفوظة وستظهر عند فتح التطبيق */ }
    }));
  }

  return { publicKey, subscribe, unsubscribe, notify };
}

module.exports = { createPush };
