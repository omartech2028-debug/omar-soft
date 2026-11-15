// نقطة تشغيل المركز:  node server/main.js
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('./http');
const { startDiscovery } = require('./discovery');

const port = Number(process.env.PORT) || 4800;
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const webDir = path.join(__dirname, '..', 'web');

const server = createServer({ dataDir, webDir });
server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`المنفذ ${port} مستعمل. ربما المركز يعمل مسبقًا.`);
  else console.error(err);
  process.exit(1);
});
server.listen(port, '0.0.0.0', () => {
  console.log('مركز المراسلة يعمل.');
  console.log(`على هذا الحاسوب:   http://localhost:${port}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) console.log(`لباقي الأجهزة:     http://${ni.address}:${port}`);
    }
  }
  console.log('اترك هذه النافذة مفتوحة. لإيقاف المركز اضغط Ctrl+C.');
  // ليجد برنامج الحاسوب المركز وحده على الشبكة (0 يعطّل الخاصية)
  const discoveryPort = process.env.DISCOVERY_PORT === undefined ? 4801 : Number(process.env.DISCOVERY_PORT);
  if (discoveryPort) startDiscovery({ port: discoveryPort, httpPort: port }).catch(() => {});
});
