// اكتشاف المركز على شبكة المحل: حواسيب العمل تسأل بالبثّ والمركز يجيب بمنفذه
const dgram = require('node:dgram');

const QUESTION = 'SHOPMSG?1';

function startDiscovery({ port = 4801, httpPort }) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const answer = Buffer.from(JSON.stringify({ app: 'shop-messenger', port: httpPort }));
    sock.on('message', (msg, rinfo) => {
      if (msg.length !== QUESTION.length || msg.toString() !== QUESTION) return;
      sock.send(answer, rinfo.port, rinfo.address, () => {});
    });
    sock.once('error', reject);
    sock.bind(port, () => {
      sock.removeListener('error', reject);
      sock.on('error', () => {});
      resolve({ port: sock.address().port, close: () => { try { sock.close(); } catch {} } });
    });
  });
}

module.exports = { startDiscovery, QUESTION };
