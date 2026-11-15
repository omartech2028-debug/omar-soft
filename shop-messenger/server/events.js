// مركز البث الفوري (Server-Sent Events)
const PING_MS = 25_000;

function createHub() {
  const subs = new Map(); // userId -> Set<res>

  const timer = setInterval(() => {
    for (const set of subs.values()) for (const res of set) res.write(': ping\n\n');
  }, PING_MS);
  timer.unref();

  function subscribe(userId, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    if (!subs.has(userId)) subs.set(userId, new Set());
    subs.get(userId).add(res);
    res.on('close', () => {
      const set = subs.get(userId);
      if (!set) return;
      set.delete(res);
      if (!set.size) subs.delete(userId);
    });
  }

  function publish(userIds, event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const id of new Set(userIds)) {
      const set = subs.get(id);
      if (set) for (const res of set) res.write(frame);
    }
  }

  const count = userId => (subs.get(userId) ? subs.get(userId).size : 0);

  // إنهاء اتصالات حساب (بعد حذفه أو تغيير كلمة سره)
  function kick(userId) {
    const set = subs.get(userId);
    if (set) for (const res of [...set]) res.end();
  }

  return { subscribe, publish, count, kick };
}

module.exports = { createHub };
