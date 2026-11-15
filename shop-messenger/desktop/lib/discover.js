// البحث عن المركز على شبكة المحل (من حاسوب عمل)
const dgram = require('node:dgram');
const os = require('node:os');

const QUESTION = 'SHOPMSG?1';

function broadcastTargets(interfaces = os.networkInterfaces()) {
  const out = ['255.255.255.255'];
  for (const list of Object.values(interfaces)) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const a = ni.address.split('.').map(Number), m = ni.netmask.split('.').map(Number);
      if (a.length !== 4 || m.length !== 4) continue;
      const b = a.map((x, i) => (x | (~m[i] & 255))).join('.');
      if (!out.includes(b)) out.push(b);
    }
  }
  out.push('127.0.0.1');
  return out;
}

// يعيد عنوان المركز مثل http://192.168.1.10:4800 أو null إن لم يجب أحد
function discover({ port = 4801, timeoutMs = 1500, targets = broadcastTargets() } = {}) {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('error', () => finish(null));
    sock.on('message', (msg, rinfo) => {
      try {
        const r = JSON.parse(msg.toString());
        const p = Number(r.port);
        if (r.app === 'shop-messenger' && Number.isInteger(p) && p > 0 && p < 65536) finish(`http://${rinfo.address}:${p}`);
      } catch {}
    });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch {}
      for (const t of targets) sock.send(QUESTION, port, t, () => {});
    });
  });
}

module.exports = { discover, broadcastTargets };
