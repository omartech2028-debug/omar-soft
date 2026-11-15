const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { startDiscovery } = require('../server/discovery');
const { discover, broadcastTargets } = require('../desktop/lib/discover');

test('a work computer finds the center on the network without typing an address', async () => {
  const d = await startDiscovery({ port: 0, httpPort: 4800 });
  try {
    const found = await discover({ port: d.port, targets: ['127.0.0.1'], timeoutMs: 1000 });
    assert.equal(found, 'http://127.0.0.1:4800');
  } finally { d.close(); }
});

test('discovery answers only the expected question and survives garbage', async () => {
  const d = await startDiscovery({ port: 0, httpPort: 4800 });
  const sock = dgram.createSocket('udp4');
  try {
    const replies = [];
    sock.on('message', m => replies.push(m.toString()));
    await new Promise(r => sock.bind(0, '127.0.0.1', r));
    sock.send(Buffer.from('hello'), d.port, '127.0.0.1');
    sock.send(Buffer.alloc(2000, 1), d.port, '127.0.0.1');
    await new Promise(r => setTimeout(r, 150));
    assert.deepEqual(replies, []);
    sock.send(Buffer.from('SHOPMSG?1'), d.port, '127.0.0.1');
    await new Promise(r => setTimeout(r, 150));
    assert.deepEqual(replies.map(r => JSON.parse(r)), [{ app: 'shop-messenger', port: 4800 }]);
  } finally { sock.close(); d.close(); }
});

test('no center on the network resolves to null after the timeout', async () => {
  const t = Date.now();
  assert.equal(await discover({ port: 49999, targets: ['127.0.0.1'], timeoutMs: 300 }), null);
  assert.ok(Date.now() - t >= 280);
});

test('replies from something that is not our center are ignored', async () => {
  const fake = dgram.createSocket('udp4');
  fake.on('message', (_m, r) => fake.send('{"app":"other","port":80}', r.port, r.address));
  await new Promise(r => fake.bind(0, '127.0.0.1', r));
  try {
    assert.equal(await discover({ port: fake.address().port, targets: ['127.0.0.1'], timeoutMs: 300 }), null);
  } finally { fake.close(); }
});

test('broadcast targets are derived from each network card', () => {
  const t = broadcastTargets({
    wifi: [{ family: 'IPv4', internal: false, address: '192.168.1.37', netmask: '255.255.255.0' }],
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
    v6: [{ family: 'IPv6', internal: false, address: 'fe80::1', netmask: 'ffff::' }],
  });
  assert.deepEqual(t, ['255.255.255.255', '192.168.1.255', '127.0.0.1']);
});
