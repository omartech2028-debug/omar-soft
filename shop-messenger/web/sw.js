// عامل الخدمة: يستقبل إشعار الهاتف ويعرضه. لا يخزّن صفحات.
const AUTH_CACHE = 'messenger-auth';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function summary() {
  // الإشعار يصل فارغًا؛ نجلب نصّه بكلمة الدخول التي حفظتها الصفحة
  try {
    const cache = await caches.open(AUTH_CACHE);
    const saved = await cache.match('/__token');
    const token = saved && (await saved.text());
    if (!token) return null;
    // صاحب المحل: هل هناك حاسوب ينتظر الموافقة؟
    const jr = await fetch('/api/join/requests', { headers: { authorization: `Bearer ${token}` } });
    if (jr.ok) {
      const reqs = await jr.json();
      if (reqs.length) return { title: 'طلب انضمام', body: `🖥 «${reqs[reqs.length - 1].name}» يطلب الانضمام. افتح التطبيق للقبول.` };
    }
    const res = await fetch('/api/conversations', { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const unread = (await res.json()).filter(c => c.unread > 0 && c.last).sort((a, b) => b.last.id - a.last.id);
    if (!unread.length) return { none: true };
    const total = unread.reduce((n, c) => n + c.unread, 0);
    const top = unread[0];
    const who = top.kind === 'group' ? `${top.last.senderName} (المحل)` : top.last.senderName;
    return { title: who, body: total > 1 ? `${top.last.body}\n(${total} رسائل جديدة)` : top.last.body, conv: top.id };
  } catch { return null; }
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some(w => w.focused)) return;          // التطبيق مفتوح أمام المستخدم
    const s = await summary();
    if (s && s.none) return;                            // قُرئت من جهاز آخر في الأثناء
    await self.registration.showNotification((s && s.title) || 'مراسلة المحل', {
      body: (s && s.body) || 'رسالة جديدة',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge.png',
      tag: 'messenger',
      renotify: true,
      dir: 'rtl',
      lang: 'ar',
      data: { conv: s && s.conv },
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const conv = event.notification.data && event.notification.data.conv;
  const url = conv ? `/#conv=${conv}` : '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if ('focus' in w) { await w.focus(); if (conv && 'navigate' in w) await w.navigate(url).catch(() => {}); return; }
    }
    await self.clients.openWindow(url);
  })());
});
