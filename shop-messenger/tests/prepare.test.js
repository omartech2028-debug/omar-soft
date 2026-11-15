const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('the build step bundles a center that runs on its own with the bundled runtime', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'));
  execFileSync(process.execPath, [path.join(__dirname, '..', 'desktop', 'scripts', 'prepare.js'), out]);
  const node = path.join(out, process.platform === 'win32' ? 'node.exe' : 'node');
  for (const f of ['server/main.js', 'server/reset-owner.js', 'web/index.html', 'web/sw.js', 'web/icons/icon-192.png']) {
    assert.ok(fs.existsSync(path.join(out, f)), f);
  }
  assert.ok(fs.statSync(node).size > 1_000_000);
  assert.equal(fs.existsSync(path.join(out, 'data')), false);

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-data-'));
  const child = spawn(node, [path.join(out, 'server', 'main.js')],
    { env: { ...process.env, PORT: '48123', DATA_DIR: data, DISCOVERY_PORT: '0' }, stdio: 'ignore' });
  try {
    let json = null;
    for (let i = 0; i < 40 && !json; i++) {
      await new Promise(r => setTimeout(r, 100));
      json = await fetch('http://127.0.0.1:48123/api/state').then(r => r.json()).catch(() => null);
    }
    assert.deepEqual(json, { needsSetup: true, remote: false });
    assert.equal((await fetch('http://127.0.0.1:48123/')).status, 200);
  } finally { child.kill(); }
});
